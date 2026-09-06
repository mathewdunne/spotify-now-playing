export const KV_KEYS = {
	TOKEN: 'spotify_token',
	SONG_CACHE: 'spotify_song_cache',
	AUTH_PENDING: 'spotify_auth_pending',
	DISCORD_WEBHOOK: 'discord_webhook_url',
	DISCORD_LAST_ALERT: 'discord_last_alert',
} as const;

export const CACHE_CONFIG = {
	FRESH_TTL_MS: 20 * 1000, // 20 seconds
	STALE_TTL_MS: 20 * 60 * 1000, // 20 minutes
	HEARTBEAT_MS: 5 * 60 * 1000, // how often an unchanged track is re-written to KV
	EDGE_TTL_S: 20, // Workers Caching TTL for a now-playing response
} as const;

export const SPOTIFY_API = {
	AUTHORIZE_URL: 'https://accounts.spotify.com/authorize',
	TOKEN_URL: 'https://accounts.spotify.com/api/token',
	NOW_PLAYING_URL: 'https://api.spotify.com/v1/me/player/currently-playing',
} as const;

export const OAUTH = {
	SCOPES: 'user-read-currently-playing',
	STATE_TTL_S: 600, // 10 minutes for the pending auth (state + verifier) in KV
} as const;

export const ALERT = {
	COOLDOWN_MS: 24 * 60 * 60 * 1000, // 24 hours between Discord alerts while down
} as const;
