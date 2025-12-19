import { KV_KEYS, SPOTIFY_API } from '../constants';
import type { AccessToken } from '../types/spotify';

const TOKEN_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export async function getValidToken(kv: KVNamespace, clientId: string): Promise<AccessToken> {
	const tokenJson = await kv.get(KV_KEYS.TOKEN);
	if (!tokenJson) {
		throw new Error('No token found in KV storage');
	}

	const token: AccessToken = JSON.parse(tokenJson);

	const now = Date.now();
	const expiresAt = token.expires || 0;

	if (now < expiresAt - TOKEN_BUFFER_MS) {
		return token;
	}

	const refreshedToken = await refreshAccessToken(clientId, token.refresh_token);

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
		throw new Error(`Token refresh failed: ${response.status}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		token_type: string;
		expires_in: number;
		refresh_token?: string;
		scope?: string;
	};

	const now = Date.now();
	const expiresIn = data.expires_in * 1000;

	return {
		access_token: data.access_token,
		token_type: data.token_type,
		expires_in: data.expires_in,
		refresh_token: data.refresh_token || refreshToken,
		expires: now + expiresIn,
	};
}
