import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { useRenderBuffer } from './useRenderBuffer';
import { createRenderProfiler, formatComparison } from '@/utils/renderProfiler';

/**
 * 渲染频率基准：同一条 token 到达时间线，分别用「直写」和「Buffer + rAF」驱动，
 * 统计两者的 UI 刷新次数。
 *
 * 数据来源优先级：
 *   1. bench/stream-timeline.json —— 由 scripts/recordStreamTimeline.mjs 从真实 SSE 录制
 *   2. 合成时间线 —— 无录制数据时使用，报告里会标注 SYNTHETIC，不可当作实测数字引用
 */

const TIMELINE_FILE = path.resolve('bench/stream-timeline.json');
/** 合成时间线的到达间隔（毫秒），仅在没有录制数据时使用 */
const SYNTHETIC_INTERVAL_MS = 8;
const SYNTHETIC_TOKEN_COUNT = 600;

interface TimelineItem {
  atMs: number;
  chars: number;
}

function loadTimeline(): { items: TimelineItem[]; source: 'recorded' | 'synthetic' } {
  if (fs.existsSync(TIMELINE_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(TIMELINE_FILE, 'utf-8'));
      if (Array.isArray(parsed) && parsed.length > 10) {
        return { items: parsed, source: 'recorded' };
      }
    } catch {
      // 落到合成时间线
    }
  }

  const items = Array.from({ length: SYNTHETIC_TOKEN_COUNT }, (_, index) => ({
    atMs: index * SYNTHETIC_INTERVAL_MS,
    chars: 4
  }));
  return { items, source: 'synthetic' };
}

/** 固定 60fps 的虚拟帧调度器 + 虚拟时钟 */
function createReplayClock(frameIntervalMs = 1000 / 60) {
  let current = 0;
  const frames: Array<{ handle: number; callback: () => void; dueAt: number }> = [];
  let nextHandle = 1;

  function runDueFrames(target: number) {
    while (true) {
      const next = frames.filter((frame) => frame.dueAt <= target).sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!next) break;
      frames.splice(frames.indexOf(next), 1);
      current = next.dueAt;
      next.callback();
    }
  }

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
    /** 把虚拟时钟推进到指定时刻，途中触发所有到期帧 */
    seek(atMs: number) {
      runDueFrames(atMs);
      current = Math.max(current, atMs);
    },
    drain(extraMs = 1_000) {
      runDueFrames(current + extraMs);
    }
  };
}

describe('流式渲染频率基准', () => {
  const { items, source } = loadTimeline();
  const durationMs = items.at(-1)!.atMs;

  it('Buffer + rAF 的刷新频率显著低于直写', () => {
    // 基线：每个 delta 直接写响应式状态，一次 delta 一次 patch
    const baselineClock = createReplayClock();
    const baseline = createRenderProfiler(`直写（${source}）`, baselineClock.now);
    for (const item of items) {
      baselineClock.seek(item.atMs);
      baseline.mark();
    }

    // 优化：delta 进 Buffer，rAF 内批量 flush，附带最小间隔节流
    const bufferedClock = createReplayClock();
    const buffered = createRenderProfiler(`Buffer + rAF（${source}）`, bufferedClock.now);
    const renderBuffer = useRenderBuffer(() => buffered.mark(), {
      schedule: bufferedClock.schedule,
      cancel: bufferedClock.cancel,
      now: bufferedClock.now,
      minFlushIntervalMs: 24
    });

    for (const item of items) {
      bufferedClock.seek(item.atMs);
      renderBuffer.push('x'.repeat(item.chars));
    }
    bufferedClock.drain();
    renderBuffer.flush();

    const before = baseline.report();
    const after = buffered.report();

    // 基准结果直接打印，便于抄进 README / 面试材料
    console.log(
      [
        '',
        `样本来源: ${source === 'recorded' ? 'bench/stream-timeline.json（真实 SSE 录制）' : 'SYNTHETIC 合成时间线（非实测，仅供联调）'}`,
        `样本规模: ${items.length} 个 delta / ${Math.round(durationMs)}ms`,
        formatComparison(before, after),
        `合并比: ${(renderBuffer.stats.pushCount / Math.max(renderBuffer.stats.flushCount, 1)).toFixed(1)} 个 token/次刷新`,
        `跳帧次数: ${renderBuffer.stats.skippedFrames}`,
        ''
      ].join('\n')
    );

    expect(after.perSecond).toBeLessThan(before.perSecond);
    // 24ms 最小间隔意味着上限约 41 次/s
    expect(after.perSecond).toBeLessThanOrEqual(42);
    expect(renderBuffer.stats.pushCount).toBe(items.length);
  });
});
