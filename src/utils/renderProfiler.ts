/**
 * 渲染频率探针 —— 统计单位时间内的 UI 刷新次数。
 *
 * 用途：给「流式输出把渲染频率从 X 次/s 降到 Y 次/s」这类结论提供实测数据，
 * 而不是凭感觉写数字。可在浏览器里直接挂到组件更新钩子上。
 */

export interface RenderSample {
  /** 采样窗口起点（相对首次 mark 的毫秒数） */
  atMs: number;
  /** 该窗口内的刷新次数 */
  count: number;
}

export interface RenderProfileReport {
  label: string;
  /** 总刷新次数 */
  total: number;
  /** 统计时长（毫秒） */
  durationMs: number;
  /** 平均每秒刷新次数 */
  perSecond: number;
  /** 单秒峰值 */
  peakPerSecond: number;
  /** 逐秒采样，便于画图 */
  samples: RenderSample[];
}

const WINDOW_MS = 1_000;

export function createRenderProfiler(label: string, now: () => number = () => (typeof performance === 'object' ? performance.now() : Date.now())) {
  let startedAt: number | null = null;
  let lastAt = 0;
  let total = 0;
  const buckets = new Map<number, number>();

  return {
    /** 每次真实渲染/patch 调用一次 */
    mark() {
      const at = now();
      if (startedAt === null) startedAt = at;
      lastAt = at;
      total++;

      const bucket = Math.floor((at - startedAt) / WINDOW_MS);
      buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
    },

    report(): RenderProfileReport {
      const durationMs = startedAt === null ? 0 : Math.max(lastAt - startedAt, 0);
      const samples: RenderSample[] = [...buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([bucket, count]) => ({ atMs: bucket * WINDOW_MS, count }));

      // 统计时长不足 1s 时按实际时长折算，避免样本太短把频率算低
      const seconds = durationMs > 0 ? durationMs / WINDOW_MS : 0;

      return {
        label,
        total,
        durationMs: Math.round(durationMs),
        perSecond: seconds > 0 ? Number((total / seconds).toFixed(1)) : 0,
        peakPerSecond: samples.reduce((max, sample) => Math.max(max, sample.count), 0),
        samples
      };
    },

    reset() {
      startedAt = null;
      lastAt = 0;
      total = 0;
      buckets.clear();
    }
  };
}

/** 把两次测量结果格式化成对比文本，便于写进 README */
export function formatComparison(before: RenderProfileReport, after: RenderProfileReport) {
  const drop = before.perSecond > 0 ? Math.round((1 - after.perSecond / before.perSecond) * 100) : 0;
  return [
    `${before.label}: ${before.perSecond} 次/s（共 ${before.total} 次 / ${before.durationMs}ms，峰值 ${before.peakPerSecond}）`,
    `${after.label}: ${after.perSecond} 次/s（共 ${after.total} 次 / ${after.durationMs}ms，峰值 ${after.peakPerSecond}）`,
    `降幅: ${drop}%`
  ].join('\n');
}
