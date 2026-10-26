/**
 * Redis 缓存客户端（可选依赖）。
 *
 * 设计目标：把"缓存"当基础设施抽象出来——
 *  - 配了 REDIS_URL 就走真实 Redis（ioredis）
 *  - 没配则回退到进程内 Map 实现（带 TTL），保证本地/无 Redis 环境也能跑
 *
 * 面试讲解点（见 docs/AUTH_REDIS_LEARNING.md）：
 *  - 为什么用缓存：热点数据命中时跳过数据库，降低延迟与 DB 压力
 *  - 缓存穿透 / 击穿 / 雪崩：三种典型故障及解法
 *  - 缓存一致性：写操作后主动删除缓存（Cache-Aside 模式）
 */

import Redis from 'ioredis';

export interface CacheLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
}

/** 进程内内存缓存（无 Redis 时的兜底），带 TTL 与懒删除 */
class InMemoryCache implements CacheLike {
  private store = new Map<string, { value: string; expireAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expireAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    this.store.set(key, { value, expireAt: Date.now() + ttlSec * 1000 });
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }
}

let cache: CacheLike | null = null;

/**
 * 获取缓存实例。首次调用时根据环境变量决定用 Redis 还是内存。
 * Redis 连接失败也静默回退内存，避免缓存故障拖垮主流程。
 */
export function getCache(): CacheLike {
  if (cache) return cache;

  const url = process.env.REDIS_URL;
  if (url) {
    const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    // 监听错误但不抛出，主流程不受缓存影响
    client.on('error', () => {
      /* 忽略，回退逻辑见下 */
    });
    // 包一层：Redis 可用时用 Redis，否则降级内存
    const redisCache: CacheLike = {
      async get(key) {
        try {
          const value = await client.get(key);
          return value;
        } catch {
          return memory.get(key);
        }
      },
      async set(key, value, ttlSec) {
        try {
          await client.set(key, value, 'EX', ttlSec);
        } catch {
          await memory.set(key, value, ttlSec);
        }
      },
      async del(...keys) {
        try {
          if (keys.length) await client.del(keys);
        } catch {
          await memory.del(...keys);
        }
      }
    };
    cache = redisCache;
  } else {
    cache = memory;
  }
  return cache;
}

/** 供无 Redis 时的兜底与测试 */
export const memory: InMemoryCache = new InMemoryCache();
