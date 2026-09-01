/**
 * 渲染缓冲队列 —— 把高频流式 token 合并成低频 UI 更新。
 *
 * 问题：SSE 的 delta 事件到达频率远高于屏幕刷新率，
 * 每个 token 直接写响应式状态会触发一次 patch，白白做了大量无法被人眼感知的渲染。
 *
 * 做法：
 *   1. token 先进 Buffer，不碰响应式状态
 *   2. requestAnimationFrame 里一次性 flush 同帧内积累的全部 token
 *   3. 自适应节流：flush 耗时超过帧预算就拉长间隔（跳帧），保证主线程不被渲染打满
 */

export interface RenderBufferOptions {
  /** 两次 flush 的最小间隔，默认 24ms（rAF 的 60 次/s 上限之下再收一档） */
  minFlushIntervalMs?: number;
  /** Buffer 超过该字符数立即 flush，避免长文本积压导致观感卡顿 */
  maxBufferChars?: number;
  /** 单次 flush 的帧预算，超出则拉长间隔 */
  frameBudgetMs?: number;
  /** 自适应节流的间隔上限 */
  maxFlushIntervalMs?: number;
  /** 注入调度器，便于在 node 环境测试 */
  schedule?: (callback: () => void) => number;
  cancel?: (handle: number) => void;
  now?: () => number;
}

export interface RenderBufferStats {
  /** push 进来的次数（等价于 token 数） */
  pushCount: number;
  /** 实际触发的 flush 次数（等价于 UI patch 次数） */
  flushCount: number;
  /** 因未到最小间隔而跳过的帧数 */
  skippedFrames: number;
  /** 当前生效的 flush 间隔 */
  currentIntervalMs: number;
  /** flush 累计耗时 */
  totalFlushMs: number;
}

const DEFAULT_MIN_FLUSH_INTERVAL_MS = 24;
const DEFAULT_MAX_BUFFER_CHARS = 2_000;
const DEFAULT_FRAME_BUDGET_MS = 8;
const DEFAULT_MAX_FLUSH_INTERVAL_MS = 64;

function defaultSchedule(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => callback());
  return setTimeout(callback, 16) as unknown as number;
}

function defaultCancel(handle: number) {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

export function useRenderBuffer(onFlush: (text: string) => void, options: RenderBufferOptions = {}) {
  const {
    minFlushIntervalMs = DEFAULT_MIN_FLUSH_INTERVAL_MS,
    maxBufferChars = DEFAULT_MAX_BUFFER_CHARS,
    frameBudgetMs = DEFAULT_FRAME_BUDGET_MS,
    maxFlushIntervalMs = DEFAULT_MAX_FLUSH_INTERVAL_MS,
    schedule = defaultSchedule,
    cancel = defaultCancel,
    now = () => (typeof performance === 'object' ? performance.now() : Date.now())
  } = options;

  let buffer = '';
  let handle: number | null = null;
  let lastFlushAt = -Infinity;
  let intervalMs = minFlushIntervalMs;

  const stats: RenderBufferStats = {
    pushCount: 0,
    flushCount: 0,
    skippedFrames: 0,
    currentIntervalMs: intervalMs,
    totalFlushMs: 0
  };

  function flushNow() {
    if (!buffer) return;

    const text = buffer;
    buffer = '';

    const startedAt = now();
    onFlush(text);
    const cost = now() - startedAt;

    lastFlushAt = now();
    stats.flushCount++;
    stats.totalFlushMs += cost;

    // 自适应：flush 超预算说明渲染成本高，拉长间隔主动跳帧；恢复后逐步收回
    if (cost > frameBudgetMs) {
      intervalMs = Math.min(maxFlushIntervalMs, Math.round(intervalMs * 2));
    } else if (intervalMs > minFlushIntervalMs) {
      intervalMs = Math.max(minFlushIntervalMs, Math.round(intervalMs / 2));
    }
    stats.currentIntervalMs = intervalMs;
  }

  function onFrame() {
    handle = null;
    if (!buffer) return;

    // 未到最小间隔：本帧跳过，等下一帧再判断
    if (now() - lastFlushAt < intervalMs) {
      stats.skippedFrames++;
      ensureScheduled();
      return;
    }

    flushNow();
    if (buffer) ensureScheduled();
  }

  function ensureScheduled() {
    if (handle === null) handle = schedule(onFrame);
  }

  return {
    /** 追加一段增量文本 */
    push(text: string) {
      if (!text) return;
      stats.pushCount++;
      buffer += text;

      // 积压过多时不等帧，立刻刷一次
      if (buffer.length >= maxBufferChars) {
        flushNow();
        return;
      }
      ensureScheduled();
    },

    /** 立即输出剩余内容（流结束、出错、用户停止时调用） */
    flush() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      flushNow();
    },

    /** 丢弃缓冲内容并复位 */
    reset() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      buffer = '';
      lastFlushAt = -Infinity;
      intervalMs = minFlushIntervalMs;
      stats.pushCount = 0;
      stats.flushCount = 0;
      stats.skippedFrames = 0;
      stats.totalFlushMs = 0;
      stats.currentIntervalMs = intervalMs;
    },

    get pending() {
      return buffer.length;
    },

    get stats(): RenderBufferStats {
      return { ...stats };
    }
  };
}
