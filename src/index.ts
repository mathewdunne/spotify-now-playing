
import { SpotifyApi, Track, AccessToken } from '@spotify/web-api-ts-sdk';

interface TrackInfo {
    title: string;
    artist: string;
    album: string;
    albumImageUrl: string;
    isPlaying: boolean;
    url: string;
}

const KV_TOKEN_KEY = 'spotify_token';
const KV_SONG_CACHE_KEY = 'spotify_song_cache';
const KV_SONG_CACHE_TIMESTAMP_KEY = 'spotify_song_cache_timestamp';

const CACHE_TTL_MS = 20 * 1000; // 20 seconds
const CACHE_INVALID_TIME_MS = 20 * 60 * 1000; // 20 minutes

function sendResponse(data: Object, status: number = 200): Response {
    return new Response(JSON.stringify(data), {
        headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
        },
        status: status,
    });
}

export default {
    async fetch(request, env, ctx): Promise<Response> {
        try {
            // Check for cached song
            const cachedSong = await env.KV.get(KV_SONG_CACHE_KEY);
            const cachedTimestamp = await env.KV.get(KV_SONG_CACHE_TIMESTAMP_KEY);
            const now = Date.now();
            if (cachedSong && cachedTimestamp && (now - parseInt(cachedTimestamp) < CACHE_TTL_MS)) {
                return sendResponse(JSON.parse(cachedSong));
            }

            // No cache or cache expired - fetch new data
			// Initialize SDK with token from KV
			const token = await env.KV.get(KV_TOKEN_KEY) || "";
            const parsedToken = JSON.parse(token) as AccessToken;

			const sdk = SpotifyApi.withAccessToken(env.SPOTIFY_CLIENT_ID, parsedToken);

            // Fetch the data - SDK will automatically refresh token if needed
            const response = await sdk.player.getCurrentlyPlayingTrack();

            // Save the token back to KV (it may have been refreshed during the API call)
            const currentToken = await sdk.getAccessToken();
            if (currentToken) {
                await env.KV.put(KV_TOKEN_KEY, JSON.stringify(currentToken));
            }

            // Handle "Nothing Playing" state
            // Spotify returns null or undefined if the user is offline, private session, or paused for a long time
			// Also check if the currently playing type is not a track (e.g., podcast)
            if (!response || !response.item || !response.is_playing || response.currently_playing_type !== 'track') {
                // If still within invalidation time, return cached song if available
                if (cachedSong && cachedTimestamp && (now - parseInt(cachedTimestamp) < CACHE_INVALID_TIME_MS)) {
                    return sendResponse(JSON.parse(cachedSong));
                } else {
                    // Otherwise, return not playing
                    return sendResponse({ isPlaying: false });
                }
            }

            // We now know it is a Track, so we can safely cast it.
            const trackItem = response.item as Track;

            // Construct Data
            const trackInfo: TrackInfo = {
                title: trackItem.name,
                artist: trackItem.artists.map((artist) => artist.name).join(', '),
                album: trackItem.album.name,
                albumImageUrl: trackItem.album.images[0]?.url ?? '',
                url: trackItem.external_urls.spotify,
                isPlaying: true,
            };

            // Cache the song data and timestamp
            await env.KV.put(KV_SONG_CACHE_KEY, JSON.stringify(trackInfo));
            await env.KV.put(KV_SONG_CACHE_TIMESTAMP_KEY, now.toString());

            // Return Success
            return sendResponse(trackInfo);

        } catch (error) {
            console.error('Spotify Fetch Error:', error);
            // Return a safe fallback so the worker doesn't throw a 500 error
            return sendResponse({ isPlaying: false, error: 'Failed to fetch data' });
        }
    },
} satisfies ExportedHandler<Env>;
