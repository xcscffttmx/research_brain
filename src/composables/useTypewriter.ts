/**
 * 打字机输出队列 —— 把服务端攒批下发的整块 delta 拆成逐字输出。
 *
 * 背景：DashScope 这类网关会在服务端合并 token，一个 delta 常带 5~10 个字符，
 * 直接整块写入会让文字一跳一跳地出现，观感差；逐字输出才是流式对话该有的节奏。
 *
 * 代价：拆字之后写入频率被放大到「字符到达频率」这一量级，
 * 若每个字符都直接改响应式状态就是每字一次 patch —— 这正是 useRenderBuffer 要解决的问题。
 * 因此正常链路是 push -> 打字机拆字 -> Buffer 合并 -> rAF 刷新。
 */

export interface TypewriterOptions {
  /** 目标输出速度（字符/秒），实际速度受上游到达速度限制 */
  charsPerSecond?: number;
  /** 定时器间隔，默认 8ms（约 125 次/s，高于屏幕刷新率以便 Buffer 有合并空间） */
  tickIntervalMs?: number;
  /** 队列积压上限：超出则本次多吐一些，避免打字机越落越远 */
  maxPendingChars?: number;
  /** 注入调度器，便于在 node 环境测试 */
  schedule?: (callback: () => void, delayMs: number) => number;
  cancel?: (handle: number) => void;
  now?: () => number;
}

export interface TypewriterStats {
  /** push 进来的 delta 次数 */
  pushCount: number;
  /** 定时器实际触发次数（等价于下游收到的写入次数） */
  tickCount: number;
  /** 已输出字符数 */
  emittedChars: number;
}

const DEFAULT_CHARS_PER_SECOND = 120;
const DEFAULT_TICK_INTERVAL_MS = 8;
const DEFAULT_MAX_PENDING_CHARS = 120;

function defaultSchedule(callback: () => void, delayMs: number): number {
  return setTimeout(callback, delayMs) as unknown as number;
}

/** 避免把一个代理对（emoji 等）从中间切开 */
function safeSliceLength(text: string, length: number): number {
  if (length >= text.length) return text.length;
  const code = text.charCodeAt(length - 1);
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  return isHighSurrogate ? length + 1 : length;
}

export function useTypewriter(onChars: (text: string) => void, options: TypewriterOptions = {}) {
  const {
    charsPerSecond = DEFAULT_CHARS_PER_SECOND,
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    maxPendingChars = DEFAULT_MAX_PENDING_CHARS,
    schedule = defaultSchedule,
    cancel = (handle: number) => clearTimeout(handle),
    now = () => (typeof performance === 'object' ? performance.now() : Date.now())
  } = options;

  let queue = '';
  let handle: number | null = null;
  let lastTickAt = -1;

  const stats: TypewriterStats = { pushCount: 0, tickCount: 0, emittedChars: 0 };

  function emit(text: string) {
    if (!text) return;
    stats.tickCount++;
    stats.emittedChars += text.length;
    onChars(text);
  }

  function tick() {
    handle = null;
    if (!queue) return;

    const current = now();
    const elapsed = lastTickAt < 0 ? tickIntervalMs : Math.max(current - lastTickAt, 1);
    lastTickAt = current;

    let budget = Math.max(1, Math.round((charsPerSecond * elapsed) / 1000));
    // 积压太多说明上游比打字机快，补上差额，保证不会无限拖长收尾时间
    if (queue.length - budget > maxPendingChars) budget = queue.length - maxPendingChars;

    const take = safeSliceLength(queue, budget);
    emit(queue.slice(0, take));
    queue = queue.slice(take);

    if (queue) ensureTicking();
  }

  function ensureTicking() {
    if (handle === null) handle = schedule(tick, tickIntervalMs);
  }

  return {
    /** 追加一段服务端下发的增量文本 */
    push(text: string) {
      if (!text) return;
      stats.pushCount++;
      // 队列空转期间不积累速度额度，否则下一个 delta 到达时会被整块吐出，失去逐字效果
      if (!queue) lastTickAt = now();
      queue += text;
      ensureTicking();
    },

    /** 立即吐出剩余内容（流结束、出错、用户停止时调用） */
    flush() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      const rest = queue;
      queue = '';
      emit(rest);
    },

    /** 丢弃队列并复位 */
    reset() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      queue = '';
      lastTickAt = -1;
      stats.pushCount = 0;
      stats.tickCount = 0;
      stats.emittedChars = 0;
    },

    get pending() {
      return queue.length;
    },

    get stats(): TypewriterStats {
      return { ...stats };
    }
  };
}
