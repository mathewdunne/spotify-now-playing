import { KV_KEYS, SPOTIFY_API } from '../constants';
import type { AccessToken } from '../types/spotify';
import { AuthenticationError, ReauthRequiredError } from '../types/errors';

const TOKEN_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

// Shape of a successful Spotify token response (refresh + authorization_code grants).
export interface SpotifyTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token?: string;
	scope?: string;
}

// Builds our stored AccessToken (with an absolute `expires` timestamp) from a Spotify
// token response. Spotify may omit refresh_token on a refresh, so fall back to the one we
// already have. Shared by the refresh flow and the /callback authorization-code exchange.
export function toAccessToken(data: SpotifyTokenResponse, fallbackRefreshToken?: string): AccessToken {
	const refreshToken = data.refresh_token || fallbackRefreshToken;
	if (!refreshToken) {
		throw new AuthenticationError('No refresh token returned by Spotify');
	}

	return {
		access_token: data.access_token,
		token_type: data.token_type,
		expires_in: data.expires_in,
		refresh_token: refreshToken,
		expires: Date.now() + data.expires_in * 1000,
	};
}

export async function getValidToken(kv: KVNamespace, clientId: string): Promise<AccessToken> {
	const tokenJson = await kv.get(KV_KEYS.TOKEN);
	if (!tokenJson) {
		throw new AuthenticationError('No token found in KV storage');
	}

	const token: AccessToken = JSON.parse(tokenJson);

	const now = Date.now();
	const expiresAt = token.expires || 0;

	if (now < expiresAt - TOKEN_BUFFER_MS) {
		return token;
	}

	let refreshedToken: AccessToken;
	try {
		refreshedToken = await refreshAccessToken(clientId, token.refresh_token);
	} catch (error) {
		// The refresh token is dead (6-month expiry). Discard it so the next request fails
		// cleanly with "no token" until the user re-authenticates via /login.
		if (error instanceof ReauthRequiredError) {
			await kv.delete(KV_KEYS.TOKEN);
		}
		throw error;
	}

	await kv.put(KV_KEYS.TOKEN, JSON.stringify(refreshedToken));

	return refreshedToken;
}

async function refreshAccessToken(clientId: string, refreshToken: string): Promise<AccessToken> {
	const params = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: clientId,
	});

	const response = await fetch(SPOTIFY_API.TOKEN_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: params.toString(),
	});

	if (!response.ok) {
		// invalid_grant means the refresh token expired/was revoked — do NOT retry, the user
		// must re-authenticate. Anything else is a transient/auth failure.
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		if (body?.error === 'invalid_grant') {
			throw new ReauthRequiredError('Spotify refresh token expired — re-authentication required');
		}
		throw new AuthenticationError(`Token refresh failed: ${response.status}`);
	}

	const data = (await response.json()) as SpotifyTokenResponse;

	return toAccessToken(data, refreshToken);
}
