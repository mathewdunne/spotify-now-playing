# spotify-now-playing

Cloudflare Worker to show my currently playing song from the Spotify API.

- Public: `GET /` → now-playing JSON (CORS `*`)
- Admin (behind Cloudflare Access): `GET /login`, `GET /callback`

See [CLAUDE.md](CLAUDE.md) for architecture details. This README is just my setup reminder.

## Setup / redeploy checklist

> Order matters: set up Cloudflare Access **before** deploying, or `/login` is briefly exposed
> (workers.dev/preview URLs are disabled, so the custom domain is the only entrypoint).

### 1. KV values (namespace `KV`, id `275d13a658b84a098a91a7679210b963`)

Set manually before first run:

- `discord_webhook_url` — Discord webhook for down-alerts. Optional (silent no-op if unset).

```bash
npx wrangler kv key put --namespace-id 275d13a658b84a098a91a7679210b963 \
  discord_webhook_url "https://discord.com/api/webhooks/..."
```

Created automatically by the worker — don't set these by hand: `spotify_token` (minted by
`/login`), `spotify_auth_pending`, `discord_last_alert`, `spotify_song_cache`,
`spotify_song_cache_timestamp`.

### 2. Spotify Developer Dashboard

- Add Redirect URI: `https://spotify.mathewdunne.ca/callback` (and
  `http://127.0.0.1:8787/callback` if testing the flow locally).
- Scope: `user-read-currently-playing`.

### 3. Cloudflare Access (Zero Trust)

- Dashboard → **Zero Trust** → pick a team name → **Free** plan.
- Login method: the default **One-time PIN** (emailed code) is enough, or add Google as an IdP.
- **Access → Applications → Add → Self-hosted**:
  - Add two hostname+path entries: `spotify.mathewdunne.ca/login` and
    `spotify.mathewdunne.ca/callback`. Leave `/` unprotected.
  - Session duration: whatever (e.g. 1 week).
- Add a policy: Action **Allow**, Include **Emails → mathewdd3@gmail.com**.

### 4. Deploy + bootstrap the token

```bash
npm run deploy
```

Then visit `https://spotify.mathewdunne.ca/login` → Access login → Spotify → token is written
to KV. Confirm `GET /` returns the current song.

## Reminder

Spotify refresh tokens expire **6 months after authorization** (refreshing doesn't reset the
clock). Re-visit `/login` ~every 5 months to keep the widget from going dark — the Discord
alert will also nag you with a `/login` link if it lapses.
