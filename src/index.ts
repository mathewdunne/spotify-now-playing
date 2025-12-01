
import { SpotifyApi, Track, AccessToken, Scopes } from '@spotify/web-api-ts-sdk';

interface TrackInfo {
    title: string;
    artist: string;
    album: string;
    albumImageUrl: string;
    isPlaying: boolean;
    url: string;
}

const KV_TOKEN_KEY = 'spotify_token';

function sendResponse(data: any, status: number = 200): Response {
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
			// Initialize SDK with token from KV
			const token = await env.KV.get(KV_TOKEN_KEY) || "";
            const parsedToken = JSON.parse(token) as AccessToken;

			const sdk = SpotifyApi.withAccessToken(env.SPOTIFY_CLIENT_ID, parsedToken);
			
			// Save new token to KV
			const newToken = await sdk.getAccessToken();
            if (newToken != null && newToken !== parsedToken) {
                await env.KV.put(KV_TOKEN_KEY, JSON.stringify(newToken));
                console.log(JSON.stringify(newToken));
            }

            // Fetch the data
            const response = await sdk.player.getCurrentlyPlayingTrack();

            // Handle "Nothing Playing" state
            // Spotify returns null or undefined if the user is offline, private session, or paused for a long time
			// Also check if the currently playing type is not a track (e.g., podcast)
            if (!response || !response.item || !response.is_playing || response.currently_playing_type !== 'track') {
                return sendResponse({ isPlaying: false });
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

            // Return Success
            return sendResponse(trackInfo);

        } catch (error) {
            console.error('Spotify Fetch Error:', error);
            // Return a safe fallback so the worker doesn't throw a 500 error
            return sendResponse({ isPlaying: false, error: 'Failed to fetch data' });
        }
    },
} satisfies ExportedHandler<Env>;
