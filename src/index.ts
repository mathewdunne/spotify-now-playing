import { WorkerEntrypoint } from 'cloudflare:workers';
import { getCachedTrack, setCachedTrack } from './modules/cache';
import { getValidToken } from './modules/token-manager';
import { getCurrentlyPlaying } from './modules/spotify-client';
import { createResponse, formatTrackInfo } from './modules/response-formatter';
import { handleLogin, handleCallback } from './modules/auth';
import { notifyServiceDown, markServiceRecovered } from './modules/notifier';
import { AuthenticationError, ReauthRequiredError, SpotifyApiError } from './types/errors';
import { CACHE_CONFIG } from './constants';

// Builds the Discord message for an actionable auth failure (the only error we alert on — see
// the NowPlaying entrypoint below). Each message is tagged with the request's hostname so
// multiple deployments self-identify in a shared channel, and includes the /login URL so the
// fix is one click away.
function buildAlertMessage(error: AuthenticationError, request: Request): string {
	const url = new URL(request.url);
	const host = url.hostname;
	const loginUrl = `${url.origin}/login`;

	if (error instanceof ReauthRequiredError) {
		return `⚠️ [${host}] Spotify now-playing: refresh token expired. Re-authenticate: ${loginUrl}`;
	}
	return `⚠️ [${host}] Spotify now-playing auth error: ${error.message}. Re-authenticate: ${loginUrl}`;
}

// The public now-playing pipeline: serve fresh cache, otherwise fetch from Spotify (refreshing
// the token if needed) with the two-tier cache fallback. Returns a ready Response on success and
// throws on any backend failure, so the caller can alert and map the error to a status code.
async function handleNowPlaying(env: Env): Promise<Response> {
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

	// Passing `cached` lets setCachedTrack skip the write when the song hasn't changed.
	await setCachedTrack(env.KV, trackInfo, now, cached);
	return createResponse(trackInfo);
}

// Workers Caching is enabled for this entrypoint only (see `exports` in wrangler.jsonc). It
// can't be scoped by path, hence the split: a cached /login would leak one visitor's PKCE state.
export class NowPlaying extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		try {
			const response = await handleNowPlaying(this.env);

			// A clean response means the backend is healthy; clear any active-outage marker so
			// the next failure alerts as a fresh transition (fire-and-forget, never throws).
			this.ctx.waitUntil(markServiceRecovered(this.env.KV));

			response.headers.set('Cache-Control', `public, max-age=${CACHE_CONFIG.EDGE_TTL_S}`);
			return response;
		} catch (error) {
			console.error('Spotify Fetch Error:', error);

			// Only alert on auth failures — those are actionable (re-authenticate via /login).
			// Spotify API errors (429/502/503) and other transient failures are one-off blips the
			// two-tier cache already absorbs; they need no intervention, so they don't alert.
			if (error instanceof AuthenticationError) {
				// Fire-and-forget, throttled inside the notifier.
				this.ctx.waitUntil(notifyServiceDown(this.env.KV, buildAlertMessage(error, request)));

				return uncacheable(createResponse({ isPlaying: false, error: error.message }, 401));
			}

			// Handle Spotify API errors (503 for service issues)
			if (error instanceof SpotifyApiError) {
				return uncacheable(createResponse({ isPlaying: false, error: error.message }, 503));
			}

			// Handle all other errors (500)
			return uncacheable(
				createResponse(
					{
						isPlaying: false,
						error: error instanceof Error ? error.message : 'Failed to fetch data',
					},
					500
				)
			);
		}
	}
}

// A cached 401 would outlive the re-auth that fixes it.
function uncacheable(response: Response): Response {
	response.headers.set('Cache-Control', 'no-store');
	return response;
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

		// The now-playing API lives only at the root. Anything else (bot scans for /.env,
		// /.git, wp-login, …) gets a cheap 404 *before* any KV/token/Spotify work — this is
		// what stops junk traffic from turning into backend errors and Discord alert storms
		// when the token is unhealthy. /login and /callback are handled above.
		if (pathname !== '/') {
			return createResponse({ error: 'Not found' }, 404);
		}

		// The forwarded request *is* the cache key, so rebuild it from a fixed URL: a `?t=<now>`
		// cache-buster would otherwise miss every time, and Authorization forces a bypass.
		const key = new Request(new URL('/', request.url).toString(), { method: 'GET' });
		return ctx.exports.NowPlaying.fetch(key);
	},
} satisfies ExportedHandler<Env>;
