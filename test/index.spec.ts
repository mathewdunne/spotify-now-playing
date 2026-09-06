import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import worker from '../src/index';
import { notifyServiceDown, markServiceRecovered } from '../src/modules/notifier';
import { getValidToken } from '../src/modules/token-manager';
import { getCachedTrack, setCachedTrack } from '../src/modules/cache';
import { KV_KEYS, CACHE_CONFIG } from '../src/constants';
import type { TrackInfo } from '../src/types/spotify';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// `fetchMock` was removed from `cloudflare:test` in the Vitest 4 pool. Unrouted requests throw,
// which several tests rely on to prove a code path made no request.
interface Route {
	prefix: string;
	method: string;
	respond: () => Response;
}

let routes: Route[] = [];
let calls: { url: string; method: string; body: string }[] = [];

function route(prefix: string, method: string, respond: () => Response): void {
	routes.push({ prefix, method, respond });
}

function callsTo(prefix: string) {
	return calls.filter((call) => call.url.startsWith(prefix));
}

// waitOnExecutionContext() drains only the gateway's context, not the NowPlaying entrypoint's.
async function waitForCall(prefix: string, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && callsTo(prefix).length === 0) {
		await scheduler.wait(10);
	}
	return callsTo(prefix);
}

beforeAll(() => {
	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input as RequestInfo, init);
		const body = request.method === 'POST' ? new TextDecoder().decode(await request.clone().arrayBuffer()) : '';
		calls.push({ url: request.url, method: request.method, body });

		const match = routes.find((r) => r.method === request.method && request.url.startsWith(r.prefix));
		if (!match) {
			throw new Error(`Unmocked fetch: ${request.method} ${request.url}`);
		}
		return match.respond();
	});
});

beforeEach(() => {
	routes = [];
	calls = [];
});

const NOW_PLAYING = 'https://api.spotify.com/v1/me/player/currently-playing';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const WEBHOOK = 'https://discord.example/webhook';

function validToken() {
	return JSON.stringify({
		access_token: 'at',
		token_type: 'Bearer',
		expires_in: 3600,
		refresh_token: 'rt',
		expires: Date.now() + 3600_000,
	});
}

function trackPayload(url = 'http://track') {
	return {
		is_playing: true,
		currently_playing_type: 'track',
		item: {
			name: 'Song',
			artists: [{ name: 'Artist' }],
			album: { name: 'Album', images: [{ url: 'http://img' }] },
			external_urls: { spotify: url },
		},
	};
}

function track(url = 'http://track'): TrackInfo {
	return { title: 'Song', artist: 'Artist', album: 'Album', albumImageUrl: 'http://img', url, isPlaying: true };
}

describe('auth routes', () => {
	it('GET /login redirects to Spotify authorize with PKCE + state, and stores pending auth', async () => {
		const request = new IncomingRequest('https://spotify.example/login');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(302);

		const location = new URL(response.headers.get('Location')!);
		expect(location.origin + location.pathname).toBe('https://accounts.spotify.com/authorize');
		expect(location.searchParams.get('response_type')).toBe('code');
		expect(location.searchParams.get('code_challenge_method')).toBe('S256');
		expect(location.searchParams.get('code_challenge')).toBeTruthy();
		expect(location.searchParams.get('redirect_uri')).toBe('https://spotify.example/callback');

		const state = location.searchParams.get('state');
		expect(state).toBeTruthy();

		const pending = JSON.parse((await env.KV.get(KV_KEYS.AUTH_PENDING))!);
		expect(pending.state).toBe(state);
		expect(pending.codeVerifier).toBeTruthy();
	});

	it('GET /callback rejects a mismatched state with 403', async () => {
		await env.KV.put(KV_KEYS.AUTH_PENDING, JSON.stringify({ state: 'good', codeVerifier: 'v' }));

		const request = new IncomingRequest('https://spotify.example/callback?code=abc&state=wrong');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(403);
	});

	it('never marks a /login redirect as cacheable', async () => {
		const request = new IncomingRequest('https://spotify.example/login');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		const cacheControl = response.headers.get('Cache-Control');
		expect(cacheControl === null || cacheControl.includes('no-store')).toBe(true);
	});
});

describe('now-playing route', () => {
	beforeEach(async () => {
		await env.KV.delete(KV_KEYS.SONG_CACHE);
		await env.KV.delete(KV_KEYS.DISCORD_WEBHOOK);
		await env.KV.delete(KV_KEYS.DISCORD_LAST_ALERT);
	});

	it('GET / returns the current track as JSON with the CORS header', async () => {
		await env.KV.put(KV_KEYS.TOKEN, validToken());
		route(NOW_PLAYING, 'GET', () => Response.json(trackPayload()));

		const request = new IncomingRequest('https://spotify.example/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(await response.json()).toMatchObject({ title: 'Song', artist: 'Artist', isPlaying: true });
	});

	it('does not re-write KV when a poll finds the same song still playing', async () => {
		// Guards the wiring: if index.ts stopped passing the entry it read into setCachedTrack,
		// every cache.ts test would still pass and the write-per-poll regression would be back.
		await env.KV.put(KV_KEYS.TOKEN, validToken());
		route(NOW_PLAYING, 'GET', () => Response.json(trackPayload()));

		// Past FRESH_TTL_MS (so it reaches Spotify) but inside HEARTBEAT_MS.
		const seededTs = Date.now() - (CACHE_CONFIG.FRESH_TTL_MS + 10_000);
		await env.KV.put(KV_KEYS.SONG_CACHE, JSON.stringify({ track: track(), ts: seededTs }));

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('https://spotify.example/'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(callsTo(NOW_PLAYING)).toHaveLength(1);
		expect(JSON.parse((await env.KV.get(KV_KEYS.SONG_CACHE))!).ts).toBe(seededTs);
	});

	it('marks a successful response cacheable at the edge', async () => {
		await env.KV.put(KV_KEYS.TOKEN, validToken());
		route(NOW_PLAYING, 'GET', () => Response.json(trackPayload()));

		const request = new IncomingRequest('https://spotify.example/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.headers.get('Cache-Control')).toBe(`public, max-age=${CACHE_CONFIG.EDGE_TTL_S}`);
	});

	it('never marks a failure cacheable (a stored 401 would outlive the re-auth that fixes it)', async () => {
		await env.KV.delete(KV_KEYS.TOKEN); // → AuthenticationError → 401

		const request = new IncomingRequest('https://spotify.example/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	it('does not alert on a transient Spotify API error (only auth failures are actionable)', async () => {
		await env.KV.put(KV_KEYS.DISCORD_WEBHOOK, WEBHOOK);
		await env.KV.put(KV_KEYS.TOKEN, validToken());
		route(NOW_PLAYING, 'GET', () => new Response(null, { status: 503 }));

		const request = new IncomingRequest('https://spotify.example/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(503);
		expect(callsTo(WEBHOOK)).toHaveLength(0);
		expect(await env.KV.get(KV_KEYS.DISCORD_LAST_ALERT)).toBeNull();
	});
});

describe('cache', () => {
	beforeEach(async () => {
		await env.KV.delete(KV_KEYS.SONG_CACHE);
	});

	it('skips the write when the same track is still within the heartbeat window', async () => {
		const now = Date.now();
		await setCachedTrack(env.KV, track(), now, null);

		const first = await getCachedTrack(env.KV, now);
		expect(first?.ts).toBe(now);

		await setCachedTrack(env.KV, track(), now + 60_000, first);

		const after = await getCachedTrack(env.KV, now + 60_000);
		expect(after?.ts).toBe(now); // unchanged — no write happened
	});

	it('writes when the track changes', async () => {
		const now = Date.now();
		await setCachedTrack(env.KV, track('http://a'), now, null);
		const first = await getCachedTrack(env.KV, now);

		await setCachedTrack(env.KV, track('http://b'), now + 1000, first);

		const after = await getCachedTrack(env.KV, now + 1000);
		expect(after?.data.url).toBe('http://b');
		expect(after?.ts).toBe(now + 1000);
	});

	it('re-writes an unchanged track past the heartbeat, so it never ages out of the stale window', async () => {
		const now = Date.now();
		await setCachedTrack(env.KV, track(), now, null);
		const first = await getCachedTrack(env.KV, now);

		const later = now + CACHE_CONFIG.HEARTBEAT_MS + 1000;
		await setCachedTrack(env.KV, track(), later, first);

		const after = await getCachedTrack(env.KV, later);
		expect(after?.ts).toBe(later);
	});

	it('serves a stale entry inside the stale window and nothing past it', async () => {
		const now = Date.now();
		await setCachedTrack(env.KV, track(), now, null);

		expect((await getCachedTrack(env.KV, now + 1000))?.isFresh).toBe(true);
		expect((await getCachedTrack(env.KV, now + CACHE_CONFIG.FRESH_TTL_MS + 1))?.isFresh).toBe(false);
		expect(await getCachedTrack(env.KV, now + CACHE_CONFIG.STALE_TTL_MS + 1)).toBeNull();
	});

	it('treats a value left over from the two-key format as a miss', async () => {
		await env.KV.put(KV_KEYS.SONG_CACHE, JSON.stringify(track()));

		expect(await getCachedTrack(env.KV, Date.now())).toBeNull();
	});
});

describe('routing', () => {
	it('returns 404 for non-root paths without running the backend or alerting', async () => {
		// A bot scanning for secrets. Any outbound fetch throws here, and the notifier claims the
		// cooldown timestamp before it posts, so if the notifier had run DISCORD_LAST_ALERT would
		// be set. Neither happens for a 404.
		await env.KV.put(KV_KEYS.DISCORD_WEBHOOK, WEBHOOK);
		await env.KV.delete(KV_KEYS.DISCORD_LAST_ALERT);

		const request = new IncomingRequest('https://spotify.example/.env');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(calls).toHaveLength(0);
		expect(await env.KV.get(KV_KEYS.DISCORD_LAST_ALERT)).toBeNull();
	});
});

describe('token manager', () => {
	it('does not delete the token on invalid_grant if a concurrent request already refreshed it', async () => {
		const expired = { access_token: 'a0', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT0', expires: Date.now() - 1000 };
		const refreshedBySibling = { access_token: 'a1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT1', expires: Date.now() + 3600_000 };

		// First read returns the stale token (triggers a refresh); the catch's re-read returns the
		// token a sibling already rotated in, so the guard should keep it instead of deleting.
		let getCount = 0;
		let deleted = false;
		const kv = {
			get: async (key: string) => {
				if (key !== KV_KEYS.TOKEN) return null;
				getCount += 1;
				return JSON.stringify(getCount === 1 ? expired : refreshedBySibling);
			},
			put: async () => {},
			delete: async (key: string) => {
				if (key === KV_KEYS.TOKEN) deleted = true;
			},
		} as unknown as KVNamespace;

		// The loser's refresh (with RT0) gets invalid_grant because the sibling already rotated it.
		route(TOKEN_URL, 'POST', () => Response.json({ error: 'invalid_grant' }, { status: 400 }));

		const result = await getValidToken(kv, 'client-id');

		expect(result.refresh_token).toBe('RT1');
		expect(result.access_token).toBe('a1');
		expect(deleted).toBe(false);
	});

	it('deletes the token on invalid_grant when the refresh token is genuinely dead', async () => {
		const expired = { access_token: 'a0', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT0', expires: Date.now() - 1000 };

		// Both reads return the same refresh token, so nothing else refreshed it — a real expiry,
		// and the dead token should be discarded.
		let deleted = false;
		const kv = {
			get: async (key: string) => (key === KV_KEYS.TOKEN ? JSON.stringify(expired) : null),
			put: async () => {},
			delete: async (key: string) => {
				if (key === KV_KEYS.TOKEN) deleted = true;
			},
		} as unknown as KVNamespace;

		route(TOKEN_URL, 'POST', () => Response.json({ error: 'invalid_grant' }, { status: 400 }));

		await expect(getValidToken(kv, 'client-id')).rejects.toThrow('re-authentication required');

		expect(deleted).toBe(true);
	});
});

describe('discord notifier', () => {
	beforeEach(async () => {
		await env.KV.delete(KV_KEYS.DISCORD_WEBHOOK);
		await env.KV.delete(KV_KEYS.DISCORD_LAST_ALERT);
	});

	it('is a no-op when DISCORD_WEBHOOK_URL is unset', async () => {
		await notifyServiceDown(env.KV, 'down');
		expect(calls).toHaveLength(0);
		expect(await env.KV.get(KV_KEYS.DISCORD_LAST_ALERT)).toBeNull();
	});

	it('posts to the webhook and records the alert time', async () => {
		await env.KV.put(KV_KEYS.DISCORD_WEBHOOK, WEBHOOK);
		route(WEBHOOK, 'POST', () => new Response(null, { status: 204 }));

		await notifyServiceDown(env.KV, 'down');

		expect(callsTo(WEBHOOK)).toHaveLength(1);
		expect(await env.KV.get(KV_KEYS.DISCORD_LAST_ALERT)).not.toBeNull();
	});

	it('tags the alert with the request hostname', async () => {
		await env.KV.put(KV_KEYS.DISCORD_WEBHOOK, WEBHOOK);
		await env.KV.delete(KV_KEYS.TOKEN);
		route(WEBHOOK, 'POST', () => new Response(null, { status: 204 }));

		// No token in KV → AuthenticationError → alert fires from the catch block.
		const request = new IncomingRequest('https://spotify.example/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect((await waitForCall(WEBHOOK))[0]?.body).toContain('spotify.example');
	});

	it('claims the cooldown window before sending, so a failed POST still throttles', async () => {
		await env.KV.put(KV_KEYS.DISCORD_WEBHOOK, WEBHOOK);
		route(WEBHOOK, 'POST', () => new Response(null, { status: 500 }));

		await notifyServiceDown(env.KV, 'down');

		// Timestamp is written before the POST, so even a 500 leaves the window claimed.
		expect(await env.KV.get(KV_KEYS.DISCORD_LAST_ALERT)).not.toBeNull();
	});

	it('markServiceRecovered clears an active outage marker (and is a no-op otherwise)', async () => {
		await markServiceRecovered(env.KV); // no-op when nothing is set
		expect(await env.KV.get(KV_KEYS.DISCORD_LAST_ALERT)).toBeNull();

		await env.KV.put(KV_KEYS.DISCORD_LAST_ALERT, Date.now().toString());
		await markServiceRecovered(env.KV);
		expect(await env.KV.get(KV_KEYS.DISCORD_LAST_ALERT)).toBeNull();
	});

	it('alerts again on a new outage after recovery, even within the cooldown window', async () => {
		await env.KV.put(KV_KEYS.DISCORD_WEBHOOK, WEBHOOK);
		route(WEBHOOK, 'POST', () => new Response(null, { status: 204 }));

		await notifyServiceDown(env.KV, 'down');
		expect(await env.KV.get(KV_KEYS.DISCORD_LAST_ALERT)).not.toBeNull();

		// Service comes back → marker cleared.
		await markServiceRecovered(env.KV);
		expect(await env.KV.get(KV_KEYS.DISCORD_LAST_ALERT)).toBeNull();

		// A brand-new outage seconds later still alerts (not swallowed by the 24h cooldown).
		await notifyServiceDown(env.KV, 'down again');
		expect(callsTo(WEBHOOK)).toHaveLength(2);
		expect(await env.KV.get(KV_KEYS.DISCORD_LAST_ALERT)).not.toBeNull();
	});

	it('skips sending within the cooldown window', async () => {
		await env.KV.put(KV_KEYS.DISCORD_WEBHOOK, WEBHOOK);
		const seeded = (Date.now() - 1000).toString();
		await env.KV.put(KV_KEYS.DISCORD_LAST_ALERT, seeded);
		route(WEBHOOK, 'POST', () => new Response(null, { status: 204 }));

		await notifyServiceDown(env.KV, 'down');

		expect(callsTo(WEBHOOK)).toHaveLength(0);
		expect(await env.KV.get(KV_KEYS.DISCORD_LAST_ALERT)).toBe(seeded);
	});
});
