import { SPOTIFY_API } from '../constants';
import type { SpotifyCurrentlyPlayingResponse } from '../types/spotify';

export async function getCurrentlyPlaying(accessToken: string): Promise<SpotifyCurrentlyPlayingResponse | null> {
	const response = await fetch(SPOTIFY_API.NOW_PLAYING_URL, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});

	if (response.status === 204) {
		return null;
	}

	if (!response.ok) {
		throw new Error(`Spotify API error: ${response.status}`);
	}

	return await response.json();
}
