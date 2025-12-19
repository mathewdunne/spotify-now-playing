export interface AccessToken {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token: string;
	expires?: number;
}

export interface SpotifyArtist {
	name: string;
}

export interface SpotifyImage {
	url: string;
}

export interface SpotifyAlbum {
	name: string;
	images: SpotifyImage[];
}

export interface SpotifyTrack {
	name: string;
	artists: SpotifyArtist[];
	album: SpotifyAlbum;
	external_urls: {
		spotify: string;
	};
}

export interface SpotifyEpisode {
	name: string;
}

export interface SpotifyCurrentlyPlayingResponse {
	is_playing: boolean;
	currently_playing_type?: string;
	item?: SpotifyTrack | SpotifyEpisode;
}

export interface TrackInfo {
	title: string;
	artist: string;
	album: string;
	albumImageUrl: string;
	isPlaying: boolean;
	url: string;
}

export interface CachedTrack {
	data: TrackInfo;
	isFresh: boolean;
}
