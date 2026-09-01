import { describe, it, expect, vi } from 'vitest';
import { useRenderBuffer } from './useRenderBuffer';

/**
 * 用虚拟时钟 + 虚拟 rAF 驱动 Buffer：
 * 时间只在显式 advance 时前进，测试结果稳定不受机器性能影响。
 */
function createHarness({ frameIntervalMs = 16 } = {}) {
  let current = 0;
  const frames: Array<{ handle: number; callback: () => void; dueAt: number }> = [];
  let nextHandle = 1;

  return {
    now: () => current,
    schedule: (callback: () => void) => {
      const handle = nextHandle++;
      frames.push({ handle, callback, dueAt: current + frameIntervalMs });
      return handle;
    },
    cancel: (handle: number) => {
      const index = frames.findIndex((frame) => frame.handle === handle);
      if (index >= 0) frames.splice(index, 1);
    },
    /** 推进时间并触发到期的帧回调 */
    advance(ms: number) {
      const target = current + ms;
      while (true) {
        const next = frames.filter((frame) => frame.dueAt <= target).sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!next) break;
        frames.splice(frames.indexOf(next), 1);
        current = next.dueAt;
        next.callback();
      }
      current = target;
    }
  };
}

describe('useRenderBuffer', () => {
  it('同一帧内的多个 token 合并成一次 flush', () => {
    const harness = createHarness();
    const onFlush = vi.fn();
    const buffer = useRenderBuffer(onFlush, { ...harness, minFlushIntervalMs: 0 });

    buffer.push('a');
    buffer.push('b');
    buffer.push('c');
    expect(onFlush).not.toHaveBeenCalled();

    harness.advance(16);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('abc');
  });

  it('未到最小间隔的帧被跳过', () => {
    const harness = createHarness({ frameIntervalMs: 16 });
    const onFlush = vi.fn();
    const buffer = useRenderBuffer(onFlush, { ...harness, minFlushIntervalMs: 48 });

    buffer.push('1');
    harness.advance(16); // 第一次 flush（lastFlushAt 初始为 -Infinity）
    expect(onFlush).toHaveBeenCalledTimes(1);

    buffer.push('2');
    harness.advance(16); // 距上次仅 16ms，跳帧
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(buffer.stats.skippedFrames).toBeGreaterThan(0);

    harness.advance(48);
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenLastCalledWith('2');
  });

  it('积压超过上限时立即 flush，不等帧', () => {
    const harness = createHarness();
    const onFlush = vi.fn();
    const buffer = useRenderBuffer(onFlush, { ...harness, maxBufferChars: 10 });

    buffer.push('x'.repeat(9));
    expect(onFlush).not.toHaveBeenCalled();
    buffer.push('yy');
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].length).toBe(11);
  });

  it('flush() 立刻输出剩余内容并取消挂起的帧', () => {
    const harness = createHarness();
    const onFlush = vi.fn();
    const buffer = useRenderBuffer(onFlush, { ...harness, minFlushIntervalMs: 1_000 });

    buffer.push('尾巴');
    buffer.flush();

    expect(onFlush).toHaveBeenCalledWith('尾巴');
    harness.advance(1_000);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('空 buffer 时 flush 不产生回调', () => {
    const harness = createHarness();
    const onFlush = vi.fn();
    const buffer = useRenderBuffer(onFlush, harness);

    buffer.flush();
    buffer.push('');
    harness.advance(100);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('flush 超帧预算时拉长间隔，恢复后收回', () => {
    const harness = createHarness();
    // flush 内部通过 extraCost 模拟渲染耗时，直接叠加到虚拟时钟上
    let extraCost = 20;
    let injected = 0;
    const now = () => harness.now() + injected;

    const buffer = useRenderBuffer(
      () => {
        injected += extraCost;
      },
      { schedule: harness.schedule, cancel: harness.cancel, now, minFlushIntervalMs: 16, frameBudgetMs: 8, maxFlushIntervalMs: 64 }
    );

    buffer.push('a');
    harness.advance(16);
    // 单次 flush 耗时 20ms > 8ms 预算，间隔应被拉长
    expect(buffer.stats.currentIntervalMs).toBeGreaterThan(16);

    extraCost = 0;
    for (let index = 0; index < 10; index++) {
      buffer.push('b');
      harness.advance(64);
    }
    // 渲染恢复轻量后间隔收回到最小值
    expect(buffer.stats.currentIntervalMs).toBe(16);
  });

  it('reset 清空缓冲与统计', () => {
    const harness = createHarness();
    const onFlush = vi.fn();
    const buffer = useRenderBuffer(onFlush, harness);

    buffer.push('abc');
    expect(buffer.pending).toBe(3);

    buffer.reset();
    expect(buffer.pending).toBe(0);
    expect(buffer.stats).toMatchObject({ pushCount: 0, flushCount: 0, skippedFrames: 0 });

    harness.advance(100);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('统计 push 与 flush 次数，体现合并效果', () => {
    const harness = createHarness();
    const buffer = useRenderBuffer(() => undefined, { ...harness, minFlushIntervalMs: 24 });

    // 每 4ms 来一个 token，共 100 个
    for (let index = 0; index < 100; index++) {
      buffer.push('t');
      harness.advance(4);
    }
    buffer.flush();

    expect(buffer.stats.pushCount).toBe(100);
    expect(buffer.stats.flushCount).toBeLessThan(100);
    // 400ms 内按 24ms 间隔最多 ~17 次
    expect(buffer.stats.flushCount).toBeLessThanOrEqual(18);
  });
});
