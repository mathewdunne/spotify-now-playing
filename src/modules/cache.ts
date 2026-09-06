import { KV_KEYS, CACHE_CONFIG } from '../constants';
import type { TrackInfo, CachedTrack } from '../types/spotify';

interface CacheEntry {
	track: TrackInfo;
	ts: number;
}

export async function getCachedTrack(kv: KVNamespace, now: number = Date.now()): Promise<CachedTrack | null> {
	const raw = await kv.get(KV_KEYS.SONG_CACHE);
	if (!raw) {
		return null;
	}

	let entry: CacheEntry;
	try {
		entry = JSON.parse(raw);
	} catch {
		return null;
	}

	// A value from the old two-key format is a bare TrackInfo with no `ts`.
	if (!entry?.track || !entry.ts) {
		return null;
	}

	const age = now - entry.ts;

	if (age < CACHE_CONFIG.FRESH_TTL_MS) {
		return { data: entry.track, ts: entry.ts, isFresh: true };
	}

	if (age < CACHE_CONFIG.STALE_TTL_MS) {
		return { data: entry.track, ts: entry.ts, isFresh: false };
	}

	return null;
}

export async function setCachedTrack(
	kv: KVNamespace,
	trackInfo: TrackInfo,
	now: number = Date.now(),
	previous: CachedTrack | null = null
): Promise<void> {
	// Skip writes that would only move the timestamp — this is what keeps the write rate tied
	// to song changes rather than to polls, and KV writes are capped at 1,000/day.
	if (previous && previous.data.url === trackInfo.url && now - previous.ts < CACHE_CONFIG.HEARTBEAT_MS) {
		return;
	}

	const entry: CacheEntry = { track: trackInfo, ts: now };

	await kv.put(KV_KEYS.SONG_CACHE, JSON.stringify(entry), {
		expirationTtl: CACHE_CONFIG.STALE_TTL_MS / 1000,
	});
}
