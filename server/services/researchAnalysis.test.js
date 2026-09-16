import { describe, it, expect } from 'vitest';
import {
  buildExperimentSpecFromGap,
  buildMemoryCitations,
  buildSchemaSearchText,
  collectSupportingPapers,
  countItems,
  draftFindingsFromAbstract,
  extractJsonObject,
  mineResearchGaps,
  normalizeGap,
  pickPrimaryDataset,
  pickPrimaryMetric,
  splitKeywords,
  summarizePaperMemory
} from './researchAnalysis.js';

/** 构造一条 Paper Memory 记录 */
function record(paperId, overrides = {}) {
  return {
    paperId,
    title: `${paperId} 的标题`,
    schema: {
      title: `${paperId} 的标题`,
      problem: '问题描述',
      method: 'BaseMethod',
      architecture: 'Transformer',
      dataset: ['DatasetA'],
      metrics: ['Accuracy'],
      conclusion: '结论',
      limitations: ['算力开销大'],
      ...overrides
    }
  };
}

describe('draftFindingsFromAbstract', () => {
  it('按句号切分并补回标点，最多 4 条', () => {
    const findings = draftFindingsFromAbstract('第一点。第二点。第三点。第四点。第五点。');
    expect(findings).toHaveLength(4);
    expect(findings[0]).toBe('第一点。');
  });

  it('摘要为空时给出可执行提示而不是空数组', () => {
    expect(draftFindingsFromAbstract('')).toEqual(['缺少摘要信息，建议先补充论文摘要或全文后再分析。']);
    expect(draftFindingsFromAbstract('   ')).toHaveLength(1);
  });

  it('没有结尾标点时补上句号', () => {
    expect(draftFindingsFromAbstract('只有一句话')).toEqual(['只有一句话。']);
  });
});

describe('extractJsonObject', () => {
  it('解析裸 JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('剥掉 markdown 代码围栏', () => {
    expect(extractJsonObject('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJsonObject('```\n{"a":3}\n```')).toEqual({ a: 3 });
  });

  it('忽略 JSON 前后的解释文字', () => {
    expect(extractJsonObject('好的，结果如下：{"a":4} 以上。')).toEqual({ a: 4 });
  });

  it('空输入抛 SCHEMA_EMPTY', () => {
    // message 是概要，具体原因在 details 里，所以两者分开断言
    expect(() => extractJsonObject('')).toThrow(/模型返回为空/);
    try {
      extractJsonObject('');
    } catch (error) {
      expect(error.code).toBe('SCHEMA_EMPTY');
      expect(error.status).toBe(502);
    }
  });

  it('不含 JSON 对象时抛 SCHEMA_PARSE_ERROR，details 说明缺少对象', () => {
    try {
      extractJsonObject('没有花括号');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.code).toBe('SCHEMA_PARSE_ERROR');
      expect(error.message).toBe('无法解析 Paper Schema');
      expect(error.details).toContain('不包含有效 JSON 对象');
    }
  });

  it('JSON 格式非法时 details 说明格式问题', () => {
    try {
      extractJsonObject('{不是合法 JSON}');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.code).toBe('SCHEMA_PARSE_ERROR');
      expect(error.details).toContain('JSON 格式不合法');
    }
  });
});

describe('splitKeywords', () => {
  it('按中英文标点切词并转小写', () => {
    expect(splitKeywords('Agentic RAG，证据 溯源')).toEqual(['agentic', 'rag', '证据', '溯源']);
  });

  it('过滤单字符与空值', () => {
    expect(splitKeywords('a bb c ddd')).toEqual(['bb', 'ddd']);
    expect(splitKeywords(null)).toEqual([]);
    expect(splitKeywords(undefined)).toEqual([]);
  });
});

describe('buildSchemaSearchText', () => {
  it('把各字段压平成小写文本', () => {
    const text = buildSchemaSearchText(record('p1', { method: 'HyDE', dataset: ['MMLU', 'GSM8K'] }));
    expect(text).toContain('hyde');
    expect(text).toContain('mmlu');
    expect(text).toContain('gsm8k');
  });

  it('schema 缺失时不抛错', () => {
    expect(() => buildSchemaSearchText({ paperId: 'x', title: 't', schema: undefined })).not.toThrow();
  });
});

describe('countItems', () => {
  it('统计维度出现次数并过滤空值', () => {
    const records = [record('p1'), record('p2', { dataset: ['DatasetA', 'DatasetB'] }), record('p3', { dataset: [] })];
    const counts = countItems(records, (item) => item.schema.dataset || []);
    expect(counts.get('DatasetA')).toBe(2);
    expect(counts.get('DatasetB')).toBe(1);
  });
});

describe('collectSupportingPapers', () => {
  it('按关键词匹配返回 paperId，最多 6 条', () => {
    const records = Array.from({ length: 8 }, (_, index) => record(`p${index}`, { method: 'SharedMethod' }));
    expect(collectSupportingPapers(records, 'sharedmethod')).toHaveLength(6);
  });

  it('无命中时返回空数组', () => {
    expect(collectSupportingPapers([record('p1')], 'nonexistent')).toEqual([]);
  });
});

describe('normalizeGap', () => {
  it('去重支撑文献并把置信度夹到 [0,1]', () => {
    const gap = normalizeGap('机会', '理由', ['p1', 'p1', 'p2', ''], 1.8);
    expect(gap.supportingPaperIds).toEqual(['p1', 'p2']);
    expect(gap.confidence).toBe(1);
  });

  it('负置信度归零', () => {
    expect(normalizeGap('机会', '理由', [], -3).confidence).toBe(0);
  });
});

describe('mineResearchGaps', () => {
  it('只出现一次的方法被识别为低覆盖', () => {
    const records = [record('p1', { method: 'RareMethod' }), record('p2', { method: 'Common' })];
    const gaps = mineResearchGaps(records);
    expect(gaps.some((gap) => gap.opportunity.includes('RareMethod'))).toBe(true);
  });

  it('重复出现两次以上的 limitation 被识别为共性痛点', () => {
    const records = [
      record('p1', { limitations: ['标注成本高'] }),
      record('p2', { limitations: ['标注成本高'] }),
      record('p3', { limitations: ['标注成本高'] })
    ];
    const gaps = mineResearchGaps(records);
    const hit = gaps.find((gap) => gap.opportunity.includes('标注成本高'));
    expect(hit).toBeDefined();
    expect(hit.rationale).toContain('3 篇');
  });

  it('focus 命中两篇以上时产出定向对照实验建议', () => {
    const records = [record('p1', { method: 'RAG pipeline' }), record('p2', { method: 'RAG pipeline' })];
    const gaps = mineResearchGaps(records, 'rag');
    expect(gaps.some((gap) => gap.opportunity.includes('定向对照实验'))).toBe(true);
  });

  it('focus 只命中一篇时不产出定向建议', () => {
    const gaps = mineResearchGaps([record('p1', { method: 'unique rag' })], 'rag');
    expect(gaps.some((gap) => gap.opportunity.includes('定向对照实验'))).toBe(false);
  });

  it('空语料返回空数组，且结果最多 6 条', () => {
    expect(mineResearchGaps([])).toEqual([]);
    const many = Array.from({ length: 20 }, (_, index) =>
      record(`p${index}`, { method: `M${index}`, dataset: [`D${index}`], limitations: [`L${index}`] })
    );
    expect(mineResearchGaps(many, 'm1').length).toBeLessThanOrEqual(6);
  });
});

describe('pickPrimaryDataset / pickPrimaryMetric', () => {
  it('取出现次数最多的数据集', () => {
    const records = [record('p1'), record('p2'), record('p3', { dataset: ['DatasetB'] })];
    expect(pickPrimaryDataset(records)).toBe('DatasetA');
  });

  it('语料为空时给出占位数据集', () => {
    expect(pickPrimaryDataset([])).toBe('待补充公开数据集');
  });

  it('指标最多取 4 个', () => {
    const records = [record('p1', { metrics: ['A', 'B', 'C', 'D', 'E'] })];
    expect(pickPrimaryMetric(records)).toHaveLength(4);
  });
});

describe('buildMemoryCitations', () => {
  it('生成带序号的引用并保留四位小数', () => {
    const citations = buildMemoryCitations([{ ...record('p1'), score: 0.123456 }]);
    expect(citations[0].id).toBe('memory-1');
    expect(citations[0].source).toBe('PaperMemory / p1');
    expect(citations[0].score).toBe(0.1235);
  });

  it('最多 6 条', () => {
    const matches = Array.from({ length: 9 }, (_, index) => ({ ...record(`p${index}`), score: 0.5 }));
    expect(buildMemoryCitations(matches)).toHaveLength(6);
  });
});

describe('summarizePaperMemory', () => {
  it('聚合方法、数据集与共性限制并去重', () => {
    const summary = summarizePaperMemory([record('p1'), record('p2')], 'q');
    expect(summary.totalMatched).toBe(2);
    expect(summary.methods).toEqual(['BaseMethod']);
    expect(summary.datasets).toEqual(['DatasetA']);
    expect(summary.commonLimitations).toEqual(['算力开销大']);
  });
});

describe('buildExperimentSpecFromGap', () => {
  it('用支撑文献的方法作为基线，并带上证据引用', () => {
    const records = [record('p1', { method: 'SupportMethod' }), record('p2', { method: 'OtherMethod' })];
    const gap = normalizeGap('提升鲁棒性', '理由', ['p1'], 0.7);
    const spec = buildExperimentSpecFromGap(gap, records);

    expect(spec.baseline).toBe('SupportMethod');
    expect(spec.proposed_change).toContain('提升鲁棒性');
    expect(spec.evidenceRefs).toEqual([{ paperId: 'p1', title: 'p1 的标题', reason: '该论文支持机会点：提升鲁棒性' }]);
  });

  it('没有支撑文献时退回全量语料', () => {
    const records = [record('p1', { method: 'FallbackMethod' })];
    const gap = normalizeGap('机会', '理由', [], 0.5);
    expect(buildExperimentSpecFromGap(gap, records).baseline).toBe('FallbackMethod');
  });

  it('语料无方法与指标时给出兜底值', () => {
    const gap = normalizeGap('机会', '理由', [], 0.5);
    const spec = buildExperimentSpecFromGap(gap, []);
    expect(spec.baseline).toBe('当前主流基线方法');
    expect(spec.metrics).toEqual(['Accuracy', 'F1']);
    expect(spec.dataset).toBe('待补充公开数据集');
  });
});
