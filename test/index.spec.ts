import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
import { notifyServiceDown } from '../src/modules/notifier';
import { KV_KEYS } from '../src/constants';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

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
});

describe('now-playing route', () => {
	it('GET / returns the current track as JSON with the CORS header', async () => {
		await env.KV.put(
			KV_KEYS.TOKEN,
			JSON.stringify({
				access_token: 'at',
				token_type: 'Bearer',
				expires_in: 3600,
				refresh_token: 'rt',
				expires: Date.now() + 3600_000,
			})
		);

		fetchMock
			.get('https://api.spotify.com')
			.intercept({ path: '/v1/me/player/currently-playing', method: 'GET' })
			.reply(200, {
				is_playing: true,
				currently_playing_type: 'track',
				item: {
					name: 'Song',
					artists: [{ name: 'Artist' }],
					album: { name: 'Album', images: [{ url: 'http://img' }] },
					external_urls: { spotify: 'http://track' },
				},
			});

		const request = new IncomingRequest('https://spotify.example/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(await response.json()).toMatchObject({ title: 'Song', artist: 'Artist', isPlaying: true });
		fetchMock.assertNoPendingInterceptors();
	});
});

describe('discord notifier', () => {
	it('is a no-op when DISCORD_WEBHOOK_URL is unset', async () => {
		await notifyServiceDown(env.KV, 'down');
		expect(await env.KV.get(KV_KEYS.DISCORD_LAST_ALERT)).toBeNull();
	});

	it('posts to the webhook and records the alert time', async () => {
		await env.KV.put(KV_KEYS.DISCORD_WEBHOOK, 'https://discord.example/webhook');
		fetchMock.get('https://discord.example').intercept({ path: '/webhook', method: 'POST' }).reply(204, '');

		await notifyServiceDown(env.KV, 'down');

		expect(await env.KV.get(KV_KEYS.DISCORD_LAST_ALERT)).not.toBeNull();
		fetchMock.assertNoPendingInterceptors();
	});

	it('tags the alert with the request hostname', async () => {
		await env.KV.put(KV_KEYS.DISCORD_WEBHOOK, 'https://discord.example/webhook');

		// This interceptor only matches if the posted body contains the hostname, so a
		// consumed (non-pending) interceptor proves the alert was tagged with it.
		fetchMock
			.get('https://discord.example')
			.intercept({
				path: '/webhook',
				method: 'POST',
				body: (raw) => typeof raw === 'string' && raw.includes('spotify.example'),
			})
			.reply(204, '');

		// No token in KV → AuthenticationError → alert fires from the catch block.
		const request = new IncomingRequest('https://spotify.example/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		fetchMock.assertNoPendingInterceptors();
	});

	it('skips sending within the cooldown window', async () => {
		await env.KV.put(KV_KEYS.DISCORD_WEBHOOK, 'https://discord.example/webhook');
		const seeded = (Date.now() - 1000).toString();
		await env.KV.put(KV_KEYS.DISCORD_LAST_ALERT, seeded);

		// If the cooldown were broken, this interceptor would be consumed and the timestamp
		// would change. Since it isn't, it stays pending and the timestamp is untouched.
		fetchMock.get('https://discord.example').intercept({ path: '/webhook', method: 'POST' }).reply(204, '');

		await notifyServiceDown(env.KV, 'down');

		expect(await env.KV.get(KV_KEYS.DISCORD_LAST_ALERT)).toBe(seeded);
		expect(() => fetchMock.assertNoPendingInterceptors()).toThrow();
	});
});
