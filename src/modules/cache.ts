import { KV_KEYS, CACHE_CONFIG } from '../constants';
import type { TrackInfo, CachedTrack } from '../types/spotify';

export async function getCachedTrack(kv: KVNamespace, now: number = Date.now()): Promise<CachedTrack | null> {
	const cachedSong = await kv.get(KV_KEYS.SONG_CACHE);
	const cachedTimestamp = await kv.get(KV_KEYS.SONG_CACHE_TIMESTAMP);

	if (!cachedSong || !cachedTimestamp) {
		return null;
	}

	const age = now - parseInt(cachedTimestamp);

	if (age < CACHE_CONFIG.FRESH_TTL_MS) {
		return {
			data: JSON.parse(cachedSong),
			isFresh: true,
		};
	}

	if (age < CACHE_CONFIG.STALE_TTL_MS) {
		return {
			data: JSON.parse(cachedSong),
			isFresh: false,
		};
	}

	return null;
}

export async function setCachedTrack(kv: KVNamespace, trackInfo: TrackInfo, now: number = Date.now()): Promise<void> {
	await kv.put(KV_KEYS.SONG_CACHE, JSON.stringify(trackInfo));
	await kv.put(KV_KEYS.SONG_CACHE_TIMESTAMP, now.toString());
}
