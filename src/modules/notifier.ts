import { ALERT, KV_KEYS } from '../constants';

// Sends a Discord alert when the backend is failing. Best-effort and never throws — call it
// fire-and-forget via ctx.waitUntil() so it adds no latency to the response.
//
// - No-op when DISCORD_WEBHOOK_URL is unset in KV (so nothing breaks before it's configured).
// - Alerts on the healthy→down transition, then at most once per ALERT.COOLDOWN_MS while the
//   outage persists. markServiceRecovered() clears the marker on the next healthy response, so a
//   brand-new outage always alerts immediately instead of being swallowed by the cooldown.
// - Concurrency: KV has no atomic test-and-set, so the cooldown can't be a true lock. We claim
//   the window (write the timestamp) *before* sending instead of after a successful POST, which
//   collapses the check→send→write race from a full Discord round-trip down to two back-to-back
//   KV ops. That, together with the root-only routing in index.ts (which keeps bot scans off this
//   path entirely), is what prevents the alert storms a burst of concurrent failures used to
//   cause. A rare duplicate is still possible if two requests fail in the same instant — the
//   accepted trade-off for not standing up a Durable Object.
export async function notifyServiceDown(kv: KVNamespace, message: string): Promise<void> {
	try {
		const webhookUrl = await kv.get(KV_KEYS.DISCORD_WEBHOOK);
		if (!webhookUrl) {
			return;
		}

		const now = Date.now();
		const last = parseInt((await kv.get(KV_KEYS.DISCORD_LAST_ALERT)) ?? '', 10) || 0;
		if (last && now - last < ALERT.COOLDOWN_MS) {
			return;
		}

		// Claim the cooldown window before sending (see note above). If the POST then fails we've
		// still consumed the window and skip until it lapses — fine, since a down backend keeps
		// erroring and the next window will alert anyway.
		await kv.put(KV_KEYS.DISCORD_LAST_ALERT, now.toString());

		await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: message }),
		});
	} catch {
		// Alerting must never affect the main request path.
	}
}

// Clears the active-outage marker after a healthy response so the next failure is treated as a
// fresh healthy→down transition (and alerts immediately rather than waiting out the cooldown).
// Read-then-delete keeps the common healthy case write-free; only an actual recovery writes.
export async function markServiceRecovered(kv: KVNamespace): Promise<void> {
	try {
		const last = await kv.get(KV_KEYS.DISCORD_LAST_ALERT);
		if (last !== null) {
			await kv.delete(KV_KEYS.DISCORD_LAST_ALERT);
		}
	} catch {
		// Recovery bookkeeping must never affect the main request path.
	}
}
