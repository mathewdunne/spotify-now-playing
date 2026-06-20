import { getCachedTrack, setCachedTrack } from './modules/cache';
import { getValidToken } from './modules/token-manager';
import { getCurrentlyPlaying } from './modules/spotify-client';
import { createResponse, formatTrackInfo } from './modules/response-formatter';
import { handleLogin, handleCallback } from './modules/auth';
import { notifyServiceDown } from './modules/notifier';
import { AuthenticationError, ReauthRequiredError, SpotifyApiError } from './types/errors';

// Builds the Discord message for a caught backend error. Each message is tagged with the
// request's hostname so multiple deployments self-identify in a shared channel. Auth
// failures include the /login URL so the fix is one click away.
function buildAlertMessage(error: unknown, request: Request): string {
	const url = new URL(request.url);
	const host = url.hostname;
	const loginUrl = `${url.origin}/login`;

	if (error instanceof ReauthRequiredError) {
		return `⚠️ [${host}] Spotify now-playing: refresh token expired. Re-authenticate: ${loginUrl}`;
	}
	if (error instanceof AuthenticationError) {
		return `⚠️ [${host}] Spotify now-playing auth error: ${error.message}. Re-authenticate: ${loginUrl}`;
	}
	if (error instanceof SpotifyApiError) {
		return `⚠️ [${host}] Spotify now-playing: ${error.message}`;
	}
	return `⚠️ [${host}] Spotify now-playing: ${error instanceof Error ? error.message : 'Failed to fetch data'}`;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname } = new URL(request.url);

		// Access-protected admin routes for (re-)authentication.
		if (pathname === '/login') {
			return handleLogin(request, env);
		}
		if (pathname === '/callback') {
			return handleCallback(request, env);
		}

		// Default route: public now-playing endpoint.
		try {
			const now = Date.now();

			// Check for fresh cache (< 20s)
			const cached = await getCachedTrack(env.KV, now);
			if (cached?.isFresh) {
				return createResponse(cached.data);
			}

			// Get valid token (will auto-refresh if needed)
			const token = await getValidToken(env.KV, env.SPOTIFY_CLIENT_ID);

			// Fetch from Spotify API
			const spotifyData = await getCurrentlyPlaying(token.access_token);

			// Handle "Nothing Playing" state
			// If nothing playing, try to return stale cache (< 20min)
			if (!spotifyData) {
				if (cached && !cached.isFresh) {
					return createResponse(cached.data);
				}
				return createResponse({ isPlaying: false });
			}

			// Format track data (returns null for non-tracks like podcasts)
			const trackInfo = formatTrackInfo(spotifyData);
			if (!trackInfo) {
				// Not a track - try to return stale cache
				if (cached && !cached.isFresh) {
					return createResponse(cached.data);
				}
				return createResponse({ isPlaying: false });
			}

			// Cache and return the track
			await setCachedTrack(env.KV, trackInfo, now);
			return createResponse(trackInfo);
		} catch (error) {
			console.error('Spotify Fetch Error:', error);

			// Alert on any backend failure (fire-and-forget, throttled inside the notifier).
			ctx.waitUntil(notifyServiceDown(env.KV, buildAlertMessage(error, request)));

			// Handle authentication errors (401)
			if (error instanceof AuthenticationError) {
				return createResponse({ isPlaying: false, error: error.message }, 401);
			}

			// Handle Spotify API errors (503 for service issues)
			if (error instanceof SpotifyApiError) {
				return createResponse({ isPlaying: false, error: error.message }, 503);
			}

			// Handle all other errors (500)
			return createResponse(
				{
					isPlaying: false,
					error: error instanceof Error ? error.message : 'Failed to fetch data',
				},
				500
			);
		}
	},
} satisfies ExportedHandler<Env>;
