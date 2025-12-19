export const KV_KEYS = {
	TOKEN: 'spotify_token',
	SONG_CACHE: 'spotify_song_cache',
	SONG_CACHE_TIMESTAMP: 'spotify_song_cache_timestamp',
} as const;

export const CACHE_CONFIG = {
	FRESH_TTL_MS: 20 * 1000, // 20 seconds
	STALE_TTL_MS: 20 * 60 * 1000, // 20 minutes
} as const;

export const SPOTIFY_API = {
	TOKEN_URL: 'https://accounts.spotify.com/api/token',
	NOW_PLAYING_URL: 'https://api.spotify.com/v1/me/player/currently-playing',
} as const;
