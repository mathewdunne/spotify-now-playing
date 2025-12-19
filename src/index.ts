import { getCachedTrack, setCachedTrack } from './modules/cache';
import { getValidToken } from './modules/token-manager';
import { getCurrentlyPlaying } from './modules/spotify-client';
import { createResponse, formatTrackInfo } from './modules/response-formatter';
import { AuthenticationError, SpotifyApiError } from './types/errors';

export default {
	async fetch(_request, env, _ctx): Promise<Response> {
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