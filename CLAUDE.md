# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Cloudflare Worker that exposes a Spotify "now playing" API endpoint. Returns currently playing track information with a two-tier caching system to minimize API calls while maintaining fresh data.

The worker also hosts a self-service re-authentication flow (`/login` + `/callback`) so a fresh Spotify token can be minted from the browser without hand-editing KV, and fires Discord alerts when the backend is failing. These admin routes are protected at the edge by Cloudflare Access.

## Development Commands

```bash
# Local development server
npm run dev
# or
npm start

# Deploy to Cloudflare
npm run deploy

# Run tests (uses Cloudflare Workers test pool)
npm test

# Type check
npx tsc --noEmit

# Generate Cloudflare Worker types
npm run cf-typegen
```

## Architecture

### Modular Structure

The codebase is organized into distinct modules for separation of concerns:

- **`src/index.ts`**: Main worker orchestration layer. Routes requests (`/login`, `/callback`, default now-playing) and coordinates caching, token management, API calls, and alerting.
- **`src/modules/cache.ts`**: Two-tier caching system implementation.
- **`src/modules/token-manager.ts`**: Manual token refresh logic (no SDK dependency), including `invalid_grant` handling and the shared `toAccessToken` helper.
- **`src/modules/spotify-client.ts`**: Direct Spotify API communication.
- **`src/modules/response-formatter.ts`**: Response construction and data transformation.
- **`src/modules/auth.ts`**: OAuth Authorization Code + PKCE login/callback handlers (self-service re-authentication).
- **`src/modules/notifier.ts`**: Discord webhook "service down" alerts (throttled, best-effort).
- **`src/constants.ts`**: Centralized configuration (KV keys, TTLs, API URLs, OAuth scopes, alert cooldown).
- **`src/types/spotify.ts`**: TypeScript type definitions.
- **`src/types/errors.ts`**: Custom error classes for proper HTTP status codes.

### Token Management (Manual Implementation)

The worker implements manual OAuth token refresh without using the Spotify SDK:

1. **Token Storage**: Access tokens stored in Cloudflare KV with the key `spotify_token`.
2. **Token Structure**: Includes `access_token`, `refresh_token`, `expires` (absolute timestamp), `expires_in`, and `token_type`.
3. **Expiry Check**: Before each API call, checks if `token.expires < now + 5min` (5-minute buffer prevents edge cases).
4. **Refresh Flow**: When expired, POSTs to `https://accounts.spotify.com/api/token` with `grant_type=refresh_token`.
5. **Token Persistence**: Immediately saves refreshed token to KV (refresh_token may or may not be updated by Spotify).
6. **Expired Refresh Token (`invalid_grant`)**: Spotify refresh tokens have a 6-month lifetime (enforced for existing apps from 2026-07-20). When the token endpoint returns `invalid_grant`, the worker throws `ReauthRequiredError`, **discards the dead token from KV**, and does **not** retry. The user must re-authenticate via `/login`. **Concurrency guard**: before discarding, it re-reads KV and, if the stored `refresh_token` has changed (a sibling request already refreshed — possible when Spotify rotates refresh tokens), returns that token instead of deleting, so a refresh race can't nuke a healthy token. See `toAccessToken` for the shared token-shaping helper used by both refresh and the `/callback` exchange.

See `src/modules/token-manager.ts` for implementation details.

### Re-authentication Flow (`/login` + `/callback`)

Self-service OAuth Authorization Code + PKCE flow (public client — `client_id` only, no secret), implemented in `src/modules/auth.ts`:

1. **`GET /login`**: Generates a PKCE `code_verifier` + `code_challenge` and a random `state`, stores `{ state, codeVerifier }` in KV under `spotify_auth_pending` (10-minute TTL), then 302-redirects to `https://accounts.spotify.com/authorize`.
2. **`GET /callback`**: Spotify redirects the browser back with `code` + `state`. The handler validates `state` against the stored pending value (CSRF guard — the callback can't require a custom header), exchanges the code at the token endpoint, writes the fresh token to `spotify_token`, deletes `spotify_auth_pending`, and returns a small success page.
3. **`redirect_uri`** is derived at runtime from the request origin (`${url.origin}/callback`), so it works on both prod and local dev. Each registered `redirect_uri` must be added in the Spotify Developer Dashboard.
4. **Scope**: `user-read-currently-playing` (see `OAUTH.SCOPES` in `src/constants.ts`).

**Protection**: `/login` and `/callback` are protected by **Cloudflare Access** (Zero Trust) at the edge — there is no in-worker auth for them, so the worker is exposed only on the Access-protected custom domain (`workers_dev`/`preview_urls` are disabled in `wrangler.jsonc` to close the bypass). The `state` check still runs regardless, as CSRF protection. The default `/` endpoint stays public; every **other** path (e.g. bot scans for `/.env`) returns a cheap `404` *before* any KV/token/Spotify work, so junk traffic can't drive backend errors or alert storms.

### Down Alerts (Discord)

`src/modules/notifier.ts` posts a Discord webhook message when the backend fails:

- **Webhook URL**: read from the KV value `discord_webhook_url`. If unset, alerting is a silent no-op.
- **Trigger**: any error caught in the main handler (auth/reauth, Spotify API, or unexpected). The two-tier cache absorbs transient blips before they reach the error path, keeping noise low.
- **Throttle**: alerts on the healthy→down transition, then at most once per 24h (`ALERT.COOLDOWN_MS`) while the outage persists, tracked via the KV value `discord_last_alert`. The timestamp is claimed **before** the webhook POST (not after a successful send): KV has no atomic test-and-set, so writing first collapses the check→send→write race that previously let a burst of concurrent failures each post an alert. `markServiceRecovered` (called on the next healthy response) deletes `discord_last_alert`, so a brand-new outage alerts immediately instead of being swallowed by the cooldown. A rare duplicate is still possible under exact-simultaneous failures (the accepted trade-off for not using a Durable Object); the root-only routing is what removes the main source of concurrent failures.
- **Fire-and-forget**: dispatched via `ctx.waitUntil(...)` so it adds no latency; the notifier never throws into the request path.
- **Hostname tagging**: each message is prefixed with the request hostname (e.g. `⚠️ [spotify.mathewdunne.ca] ...`) so multiple deployments self-identify in a shared channel. Re-auth/auth messages include the `/login` URL.

### Two-Tier Caching Strategy

**CRITICAL**: This caching logic must be preserved exactly as-is. It prevents showing "not playing" during brief pauses or network issues.

**Fresh Cache (< 20 seconds)**:
- Returns cached data immediately without hitting Spotify API.
- Minimizes API calls and improves response time.

**Stale Cache (20 seconds - 20 minutes)**:
- Attempts fresh API call.
- If Spotify returns "nothing playing" OR non-track content (podcast) → returns stale cache.
- Prevents showing "not playing" during brief pauses, private sessions, or network issues.

**Expired Cache (> 20 minutes)**:
- Attempts fresh API call.
- If nothing playing → returns `{isPlaying: false}`.
- If error → returns `{isPlaying: false, error: '...'}`.

Implementation in `src/modules/cache.ts`. Main logic orchestrated in `src/index.ts`.

### Cloudflare Worker Environment

**KV Namespace Binding**: `env.KV`
- Bound to KV namespace ID: `275d13a658b84a098a91a7679210b963`
- Stores (keys centralized in `src/constants.ts` `KV_KEYS`):
  - `spotify_token`: the access/refresh token object
  - `spotify_song_cache` / `spotify_song_cache_timestamp`: cached track data + timestamp
  - `spotify_auth_pending`: short-lived PKCE state + verifier during the `/login` flow
  - `discord_webhook_url`: Discord webhook URL for alerts (**set manually**; no-op if absent)
  - `discord_last_alert`: timestamp of the last Discord alert (written by the worker, for throttling)

**Environment Variables**:
- `SPOTIFY_CLIENT_ID`: Public Spotify OAuth client ID (safe to commit)

**Configuration**: `wrangler.jsonc` (JSONC format, not JSON)
- `workers_dev: false` and `preview_urls: false`: the worker is reachable only on the Cloudflare Access-protected custom domain, so `/login` and `/callback` can't be hit via an unprotected `*.workers.dev` URL.

**Testing**: Uses `@cloudflare/vitest-pool-workers` to run tests in Cloudflare Workers environment with access to KV bindings.

## Response Format

The public now-playing endpoint is served only at `/`; `/login` and `/callback` are the Access-protected admin routes, and any other path returns `404` (`{ "error": "Not found" }`) without touching the backend. A `GET /` returns:

```typescript
{
  title: string;
  artist: string;
  album: string;
  albumImageUrl: string;
  isPlaying: boolean;
  url: string;
}
```

Or when nothing is playing:
```typescript
{ isPlaying: false }
```

All responses include CORS header `Access-Control-Allow-Origin: *`.

## HTTP Status Codes

The API returns appropriate HTTP status codes:

- **200 OK**: Successful response (track playing or nothing playing)
- **404 Not Found**: Any path other than `/` (e.g. bot scans) — returned before any backend work
- **401 Unauthorized**: Authentication/token errors (no token found, token refresh failed)
- **500 Internal Server Error**: Unexpected errors (parsing errors, network failures)
- **503 Service Unavailable**: Spotify API errors (API is down or returning errors)

## Error Handling

All errors are caught in the main handler and return graceful JSON responses:

**Authentication Errors (401)**:
```typescript
{ isPlaying: false, error: "No token found in KV storage" }
{ isPlaying: false, error: "Token refresh failed: 400" }
{ isPlaying: false, error: "Spotify refresh token expired — re-authentication required" }
```

**Spotify API Errors (503)**:
```typescript
{ isPlaying: false, error: "Spotify API error: 429" }
```

**Other Errors (500)**:
```typescript
{ isPlaying: false, error: "Failed to fetch data" }
```

Error types defined in `src/types/errors.ts`:
- `AuthenticationError`: Token-related failures (maps to 401)
- `ReauthRequiredError`: Refresh token expired/revoked (`invalid_grant`); extends `AuthenticationError`, so it also maps to 401 but signals that re-authentication via `/login` is needed
- `SpotifyApiError`: Spotify API communication issues (maps to 503)

## Important Notes

- **No Spotify SDK**: This project implements manual token refresh to avoid SDK dependency.
- **Podcast Filtering**: Only returns track data; podcasts/episodes are treated as "not playing".
- **Private Sessions**: Users in private mode trigger the stale cache fallback.
- **204 No Content**: Spotify API returns 204 when nothing is playing (handled in `spotify-client.ts`).
- **6-Month Refresh Token Lifetime**: Re-authorizing (via `/login`) resets the clock; refreshing an access token does **not**. Visit `/login` periodically (≈every 5 months) to keep the widget from going dark.
- **Manual prerequisites** (outside the code): register the `/callback` redirect URI in the Spotify Developer Dashboard; create a Cloudflare Access app covering `/login` + `/callback`; set the `discord_webhook_url` KV value.
- **Multi-instance**: alerts are tagged with the request hostname, so a second deployment on another domain self-identifies with no extra config.
