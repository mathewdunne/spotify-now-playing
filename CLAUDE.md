# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Cloudflare Worker that exposes a Spotify "now playing" API endpoint. Returns currently playing track information with a two-tier caching system to minimize API calls while maintaining fresh data.

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

- **`src/index.ts`**: Main worker orchestration layer. Coordinates caching, token management, and API calls.
- **`src/modules/cache.ts`**: Two-tier caching system implementation.
- **`src/modules/token-manager.ts`**: Manual token refresh logic (no SDK dependency).
- **`src/modules/spotify-client.ts`**: Direct Spotify API communication.
- **`src/modules/response-formatter.ts`**: Response construction and data transformation.
- **`src/constants.ts`**: Centralized configuration (KV keys, TTLs, API URLs).
- **`src/types/spotify.ts`**: TypeScript type definitions.

### Token Management (Manual Implementation)

The worker implements manual OAuth token refresh without using the Spotify SDK:

1. **Token Storage**: Access tokens stored in Cloudflare KV with the key `spotify_token`.
2. **Token Structure**: Includes `access_token`, `refresh_token`, `expires` (absolute timestamp), `expires_in`, and `token_type`.
3. **Expiry Check**: Before each API call, checks if `token.expires < now + 5min` (5-minute buffer prevents edge cases).
4. **Refresh Flow**: When expired, POSTs to `https://accounts.spotify.com/api/token` with `grant_type=refresh_token`.
5. **Token Persistence**: Immediately saves refreshed token to KV (refresh_token may or may not be updated by Spotify).

See `src/modules/token-manager.ts` for implementation details.

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
- Stores: access tokens, cached track data, cache timestamps

**Environment Variables**:
- `SPOTIFY_CLIENT_ID`: Public Spotify OAuth client ID (safe to commit)

**Configuration**: `wrangler.jsonc` (JSONC format, not JSON)

**Testing**: Uses `@cloudflare/vitest-pool-workers` to run tests in Cloudflare Workers environment with access to KV bindings.

## Response Format

The worker exposes a single GET endpoint (default `/`) returning:

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

All responses include CORS header `Access-Control-Allow-Origin: *` and return HTTP 200 (even on errors to avoid breaking clients).

## Error Handling

All errors are caught in the main handler and return graceful fallbacks:
- Returns `{isPlaying: false, error: 'Failed to fetch data'}`
- Always returns HTTP 200 (never throws 500 errors)
- Logs errors to console for debugging

## Important Notes

- **No Spotify SDK**: This project implements manual token refresh to avoid SDK dependency.
- **Podcast Filtering**: Only returns track data; podcasts/episodes are treated as "not playing".
- **Private Sessions**: Users in private mode trigger the stale cache fallback.
- **204 No Content**: Spotify API returns 204 when nothing is playing (handled in `spotify-client.ts`).
