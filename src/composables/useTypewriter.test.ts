import { describe, it, expect, vi } from 'vitest';
import { useTypewriter } from './useTypewriter';

/** 虚拟定时器：时间只在显式 advance 时前进，结果不受机器性能影响 */
function createHarness() {
  let current = 0;
  const timers: Array<{ handle: number; callback: () => void; dueAt: number }> = [];
  let nextHandle = 1;

  return {
    now: () => current,
    schedule: (callback: () => void, delayMs: number) => {
      const handle = nextHandle++;
      timers.push({ handle, callback, dueAt: current + delayMs });
      return handle;
    },
    cancel: (handle: number) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms: number) {
      const target = current + ms;
      while (true) {
        const next = timers.filter((timer) => timer.dueAt <= target).sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        current = next.dueAt;
        next.callback();
      }
      current = target;
    }
  };
}

describe('useTypewriter', () => {
  it('把整块 delta 拆成多次逐字输出', () => {
    const harness = createHarness();
    const onChars = vi.fn();
    const typewriter = useTypewriter(onChars, { ...harness, charsPerSecond: 125, tickIntervalMs: 8 });

    typewriter.push('abcdefghij');
    harness.advance(200);

    // 125 字/s、8ms 一跳 -> 每跳 1 个字符，10 个字符拆成 10 次
    expect(onChars).toHaveBeenCalledTimes(10);
    expect(onChars.mock.calls.map(([text]) => text).join('')).toBe('abcdefghij');
    expect(typewriter.pending).toBe(0);
    expect(typewriter.stats).toMatchObject({ pushCount: 1, tickCount: 10, emittedChars: 10 });
  });

  it('输出速度受 charsPerSecond 约束', () => {
    const harness = createHarness();
    const received: string[] = [];
    const typewriter = useTypewriter((text) => received.push(text), {
      ...harness,
      charsPerSecond: 125,
      tickIntervalMs: 16
    });

    typewriter.push('0123456789');
    harness.advance(16);

    // 16ms * 125 字/s = 2 个字符
    expect(received).toEqual(['01']);
    expect(typewriter.pending).toBe(8);
  });

  it('积压超过上限时补上差额，不会越落越远', () => {
    const harness = createHarness();
    const received: string[] = [];
    const typewriter = useTypewriter((text) => received.push(text), {
      ...harness,
      charsPerSecond: 125,
      tickIntervalMs: 8,
      maxPendingChars: 10
    });

    typewriter.push('x'.repeat(100));
    harness.advance(8);

    // 单跳预算只有 1 个字符，但积压 100 > 10，本跳直接吐到只剩 10
    expect(received[0]).toHaveLength(90);
    expect(typewriter.pending).toBe(10);
  });

  it('flush 立即吐出剩余内容', () => {
    const harness = createHarness();
    const received: string[] = [];
    const typewriter = useTypewriter((text) => received.push(text), {
      ...harness,
      charsPerSecond: 10,
      tickIntervalMs: 8
    });

    typewriter.push('hello');
    typewriter.flush();

    expect(received).toEqual(['hello']);
    expect(typewriter.pending).toBe(0);

    // flush 已取消定时器，继续推进时间不应再触发输出
    harness.advance(500);
    expect(received).toEqual(['hello']);
  });

  it('reset 丢弃队列并清空统计', () => {
    const harness = createHarness();
    const onChars = vi.fn();
    const typewriter = useTypewriter(onChars, { ...harness, charsPerSecond: 10, tickIntervalMs: 8 });

    typewriter.push('abcdef');
    typewriter.reset();
    harness.advance(500);

    expect(onChars).not.toHaveBeenCalled();
    expect(typewriter.pending).toBe(0);
    expect(typewriter.stats).toMatchObject({ pushCount: 0, tickCount: 0, emittedChars: 0 });
  });

  it('不会把代理对从中间切开', () => {
    const harness = createHarness();
    const received: string[] = [];
    const typewriter = useTypewriter((text) => received.push(text), {
      ...harness,
      charsPerSecond: 125,
      tickIntervalMs: 8
    });

    // 每个 emoji 占 2 个 code unit，单跳预算 1 个字符
    typewriter.push('😀😀');
    harness.advance(8);

    expect(received).toEqual(['😀']);
    expect(typewriter.pending).toBe(2);
  });
});
