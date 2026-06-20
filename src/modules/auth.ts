import { KV_KEYS, OAUTH, SPOTIFY_API } from '../constants';
import { toAccessToken, type SpotifyTokenResponse } from './token-manager';

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

interface PendingAuth {
	state: string;
	codeVerifier: string;
}

// --- PKCE helpers (Workers runtime: crypto.getRandomValues + crypto.subtle) ---

function randomString(length: number): string {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = '';
	for (const byte of bytes) {
		out += UNRESERVED[byte % UNRESERVED.length];
	}
	return out;
}

function base64UrlEncode(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Base64Url(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return base64UrlEncode(digest);
}

function htmlResponse(body: string, status = 200): Response {
	return new Response(`<!doctype html><meta charset="utf-8"><title>Spotify now playing</title>${body}`, {
		status,
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	});
}

// --- Route handlers ---

// GET /login — start the Authorization Code + PKCE flow. Access-protected at the edge.
export async function handleLogin(request: Request, env: Env): Promise<Response> {
	const redirectUri = `${new URL(request.url).origin}/callback`;
	const codeVerifier = randomString(64);
	const codeChallenge = await sha256Base64Url(codeVerifier);
	const state = randomString(16);

	const pending: PendingAuth = { state, codeVerifier };
	await env.KV.put(KV_KEYS.AUTH_PENDING, JSON.stringify(pending), { expirationTtl: OAUTH.STATE_TTL_S });

	const params = new URLSearchParams({
		response_type: 'code',
		client_id: env.SPOTIFY_CLIENT_ID,
		scope: OAUTH.SCOPES,
		redirect_uri: redirectUri,
		state,
		code_challenge_method: 'S256',
		code_challenge: codeChallenge,
	});

	return Response.redirect(`${SPOTIFY_API.AUTHORIZE_URL}?${params.toString()}`, 302);
}

// GET /callback — Spotify redirects the browser here with ?code&state. Access-protected at
// the edge; the state check is the CSRF guard (we can't require a header on a redirect).
export async function handleCallback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const error = url.searchParams.get('error');

	if (error) {
		return htmlResponse(`<h1>Authorization denied</h1><p>Spotify returned: ${error}</p>`, 400);
	}

	const pendingJson = await env.KV.get(KV_KEYS.AUTH_PENDING);
	if (!pendingJson) {
		return htmlResponse('<h1>No pending login</h1><p>Start again at <a href="/login">/login</a>.</p>', 400);
	}

	const pending: PendingAuth = JSON.parse(pendingJson);
	if (!state || !code || state !== pending.state) {
		return htmlResponse('<h1>Invalid state</h1><p>Possible CSRF. Start again at <a href="/login">/login</a>.</p>', 403);
	}

	const redirectUri = `${url.origin}/callback`;
	const params = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri,
		client_id: env.SPOTIFY_CLIENT_ID,
		code_verifier: pending.codeVerifier,
	});

	const response = await fetch(SPOTIFY_API.TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params.toString(),
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		return htmlResponse(`<h1>Token exchange failed</h1><p>${response.status} ${detail}</p>`, 502);
	}

	const data = (await response.json()) as SpotifyTokenResponse;
	const token = toAccessToken(data);

	await env.KV.put(KV_KEYS.TOKEN, JSON.stringify(token));
	await env.KV.delete(KV_KEYS.AUTH_PENDING);

	return htmlResponse('<h1>Authenticated ✅</h1><p>Your Spotify token has been refreshed. You can close this tab.</p>');
}
