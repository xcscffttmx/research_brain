import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { useRenderBuffer } from './useRenderBuffer';
import { useTypewriter } from './useTypewriter';
import { createRenderProfiler, formatComparison } from '@/utils/renderProfiler';

/**
 * 渲染频率基准：同一条 token 到达时间线经过打字机拆字后，
 * 分别用「逐字直写」和「Buffer + rAF」驱动，统计两者的 UI 刷新次数。
 *
 * 为什么要带打字机：上游（DashScope）在服务端已经攒批，一个 delta 带 5~10 个字符、
 * 约 100ms 到一个，直接按 delta 计数只有 10 次/s，缓冲没有合并空间。
 * 真实产品链路是「拆字逐字输出」，写入频率被放大到字符量级，缓冲才有意义。
 *
 * 数据来源优先级：
 *   1. bench/stream-timeline.json —— 由 scripts/recordStreamTimeline.mjs 从真实 SSE 录制
 *   2. 合成时间线 —— 无录制数据时使用，报告里会标注 SYNTHETIC，不可当作实测数字引用
 */

const TIMELINE_FILE = path.resolve('bench/stream-timeline.json');
/** 合成时间线的到达间隔（毫秒），仅在没有录制数据时使用 */
const SYNTHETIC_INTERVAL_MS = 8;
const SYNTHETIC_TOKEN_COUNT = 600;
/** 打字机参数需与 src/stores/chat.ts 的线上配置保持一致，否则基准没有参考价值 */
const TYPEWRITER_CHARS_PER_SECOND = 120;
const TYPEWRITER_TICK_MS = 8;

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

/** 虚拟时钟：同时承载 rAF 帧（默认间隔）与打字机定时器（显式 delay） */
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
    schedule: (callback: () => void, delayMs = frameIntervalMs) => {
      const handle = nextHandle++;
      frames.push({ handle, callback, dueAt: current + delayMs });
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
  const totalChars = items.reduce((sum, item) => sum + item.chars, 0);

  it('Buffer + rAF 的刷新频率显著低于逐字直写', () => {
    // 基线：打字机每吐一次就直接写响应式状态，一个字符一次 patch
    const baselineClock = createReplayClock();
    const baseline = createRenderProfiler(`逐字直写（${source}）`, baselineClock.now);
    const baselineTypewriter = useTypewriter(() => baseline.mark(), {
      schedule: baselineClock.schedule,
      cancel: baselineClock.cancel,
      now: baselineClock.now,
      charsPerSecond: TYPEWRITER_CHARS_PER_SECOND,
      tickIntervalMs: TYPEWRITER_TICK_MS
    });
    for (const item of items) {
      baselineClock.seek(item.atMs);
      baselineTypewriter.push('x'.repeat(item.chars));
    }
    baselineClock.drain();
    baselineTypewriter.flush();

    // 优化：打字机吐出的字符进 Buffer，rAF 内批量 flush，附带最小间隔节流
    const bufferedClock = createReplayClock();
    const buffered = createRenderProfiler(`Buffer + rAF（${source}）`, bufferedClock.now);
    let renderedText = '';
    const renderBuffer = useRenderBuffer(
      (text) => {
        renderedText += text;
        buffered.mark();
      },
      {
        schedule: bufferedClock.schedule,
        cancel: bufferedClock.cancel,
        now: bufferedClock.now,
        minFlushIntervalMs: 24
      }
    );
    const bufferedTypewriter = useTypewriter((text) => renderBuffer.push(text), {
      schedule: bufferedClock.schedule,
      cancel: bufferedClock.cancel,
      now: bufferedClock.now,
      charsPerSecond: TYPEWRITER_CHARS_PER_SECOND,
      tickIntervalMs: TYPEWRITER_TICK_MS
    });

    for (const item of items) {
      bufferedClock.seek(item.atMs);
      bufferedTypewriter.push('x'.repeat(item.chars));
    }
    bufferedClock.drain();
    bufferedTypewriter.flush();
    renderBuffer.flush();

    const before = baseline.report();
    const after = buffered.report();

    // 基准结果直接打印，便于抄进 README / 面试材料
    console.log(
      [
        '',
        `样本来源: ${source === 'recorded' ? 'bench/stream-timeline.json（真实 SSE 录制）' : 'SYNTHETIC 合成时间线（非实测，仅供联调）'}`,
        `样本规模: ${items.length} 个 delta / ${totalChars} 个字符 / ${Math.round(durationMs)}ms`,
        `上游 delta 到达频率: ${(items.length / (durationMs / 1000)).toFixed(1)} 次/s（服务端已攒批，平均 ${(totalChars / items.length).toFixed(1)} 字符/delta）`,
        formatComparison(before, after),
        `合并比: ${(renderBuffer.stats.pushCount / Math.max(renderBuffer.stats.flushCount, 1)).toFixed(1)} 个字符/次刷新`,
        `跳帧次数: ${renderBuffer.stats.skippedFrames}`,
        ''
      ].join('\n')
    );

    // 拆字后写入次数应当被放大到字符量级，缓冲才有合并空间
    expect(renderBuffer.stats.pushCount).toBeGreaterThan(items.length);
    // 全链路不能丢字
    expect(renderedText).toHaveLength(totalChars);
    expect(after.perSecond).toBeLessThan(before.perSecond);
    // 24ms 最小间隔意味着刷新上限约 41 次/s
    expect(after.perSecond).toBeLessThanOrEqual(42);
  });
});
