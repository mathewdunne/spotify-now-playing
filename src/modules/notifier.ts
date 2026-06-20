import { ALERT, KV_KEYS } from '../constants';

// Sends a Discord alert when the backend is failing. Best-effort and never throws — call it
// fire-and-forget via ctx.waitUntil() so it adds no latency to the response.
//
// - No-op when DISCORD_WEBHOOK_URL is unset in KV (so nothing breaks before it's configured).
// - Throttled to one alert per ALERT.COOLDOWN_MS (a dead refresh token won't self-heal, so
//   without this every request while down would post a message).
export async function notifyServiceDown(kv: KVNamespace, message: string): Promise<void> {
	try {
		const webhookUrl = await kv.get(KV_KEYS.DISCORD_WEBHOOK);
		if (!webhookUrl) {
			return;
		}

		const now = Date.now();
		const last = parseInt((await kv.get(KV_KEYS.DISCORD_LAST_ALERT)) ?? '', 10) || 0;
		if (now - last < ALERT.COOLDOWN_MS) {
			return;
		}

		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: message }),
		});

		// Record the timestamp only after a successful send, so a transient webhook failure
		// doesn't silently swallow the alert for a whole cooldown window.
		if (response.ok) {
			await kv.put(KV_KEYS.DISCORD_LAST_ALERT, now.toString());
		}
	} catch {
		// Alerting must never affect the main request path.
	}
}
