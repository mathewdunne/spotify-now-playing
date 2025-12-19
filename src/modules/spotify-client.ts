import { SPOTIFY_API } from '../constants';
import type { SpotifyCurrentlyPlayingResponse } from '../types/spotify';
import { SpotifyApiError } from '../types/errors';

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
		throw new SpotifyApiError(`Spotify API error: ${response.status}`, response.status);
	}

	return await response.json();
}
