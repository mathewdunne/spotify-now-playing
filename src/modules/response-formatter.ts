import type { SpotifyCurrentlyPlayingResponse, SpotifyTrack, TrackInfo } from '../types/spotify';

export function createResponse(data: object, status: number = 200): Response {
	return new Response(JSON.stringify(data), {
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
		},
		status: status,
	});
}

export function formatTrackInfo(spotifyData: SpotifyCurrentlyPlayingResponse): TrackInfo | null {
	if (!spotifyData || !spotifyData.item || !spotifyData.is_playing || spotifyData.currently_playing_type !== 'track') {
		return null;
	}

	const track = spotifyData.item as SpotifyTrack;

	return {
		title: track.name,
		artist: track.artists.map((artist) => artist.name).join(', '),
		album: track.album.name,
		albumImageUrl: track.album.images[0]?.url ?? '',
		url: track.external_urls.spotify,
		isPlaying: true,
	};
}
