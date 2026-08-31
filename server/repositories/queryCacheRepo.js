import { createHash } from 'node:crypto';
import { getDb } from '../db/client.js';

/** 默认 TTL：6 小时。文献检索结果变化慢，缓存能显著降低上游 429 概率 */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/** 由检索参数生成稳定的缓存 key */
export function buildCacheKey(parts) {
  const normalized = JSON.stringify(parts, Object.keys(parts).sort());
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/** 读缓存，过期返回 null */
export function getCached(cacheKey) {
  const row = getDb().prepare('select * from query_cache where cache_key = ?').get(cacheKey);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    getDb().prepare('delete from query_cache where cache_key = ?').run(cacheKey);
    return null;
  }
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

/** 写缓存 */
export function setCached(cacheKey, payload, ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  getDb()
    .prepare(
      `insert into query_cache(cache_key, payload, created_at, expires_at) values (?, ?, ?, ?)
       on conflict(cache_key) do update set
         payload = excluded.payload,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`
    )
    .run(cacheKey, JSON.stringify(payload), now, now + ttlMs);
}

/** 清理所有已过期条目（可挂定时任务） */
export function pruneExpired() {
  return getDb().prepare('delete from query_cache where expires_at < ?').run(Date.now()).changes;
}
