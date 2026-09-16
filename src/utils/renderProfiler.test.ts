import { describe, it, expect } from 'vitest';
import { createRenderProfiler, formatComparison } from './renderProfiler';

/** 可控时钟，保证统计结果可复现 */
function clock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    }
  };
}

describe('createRenderProfiler', () => {
  it('未采样时报告全零', () => {
    const profiler = createRenderProfiler('空', clock().now);
    expect(profiler.report()).toMatchObject({ total: 0, durationMs: 0, perSecond: 0, peakPerSecond: 0 });
  });

  it('按实际时长折算每秒频率', () => {
    const time = clock();
    const profiler = createRenderProfiler('测试', time.now);

    // 2 秒内均匀打 120 次 -> 60 次/s
    for (let index = 0; index < 120; index++) {
      profiler.mark();
      time.advance(2_000 / 119);
    }

    const report = profiler.report();
    expect(report.total).toBe(120);
    expect(report.durationMs).toBe(2_000);
    expect(report.perSecond).toBe(60);
  });

  it('逐秒采样并给出峰值', () => {
    const time = clock();
    const profiler = createRenderProfiler('峰值', time.now);

    // 第 1 秒 10 次
    for (let index = 0; index < 10; index++) {
      profiler.mark();
      time.advance(50);
    }
    // 推进到第 2 秒，只打 3 次
    time.advance(600);
    for (let index = 0; index < 3; index++) {
      profiler.mark();
      time.advance(50);
    }

    const report = profiler.report();
    expect(report.samples.length).toBe(2);
    expect(report.samples[0]).toEqual({ atMs: 0, count: 10 });
    expect(report.peakPerSecond).toBe(10);
  });

  it('reset 后重新开始统计', () => {
    const time = clock();
    const profiler = createRenderProfiler('重置', time.now);
    profiler.mark();
    time.advance(100);
    profiler.mark();

    profiler.reset();
    expect(profiler.report().total).toBe(0);
  });
});

describe('formatComparison', () => {
  it('输出带降幅的对比文本', () => {
    const before = { label: '直写', total: 120, durationMs: 1_000, perSecond: 120, peakPerSecond: 130, samples: [] };
    const after = { label: '缓冲', total: 40, durationMs: 1_000, perSecond: 40, peakPerSecond: 42, samples: [] };

    const text = formatComparison(before, after);
    expect(text).toContain('直写: 120 次/s');
    expect(text).toContain('缓冲: 40 次/s');
    expect(text).toContain('降幅: 67%');
  });

  it('基准为 0 时降幅按 0 处理', () => {
    const zero = { label: 'a', total: 0, durationMs: 0, perSecond: 0, peakPerSecond: 0, samples: [] };
    expect(formatComparison(zero, zero)).toContain('降幅: 0%');
  });
});
