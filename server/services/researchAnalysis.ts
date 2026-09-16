/**
 * 科研分析服务 —— Paper Schema / Paper Memory / Research Gap / Experiment Spec 的纯计算逻辑。
 *
 * 从 mcp-server.ts 抽出的原因：这些函数不依赖 MCP、也不依赖网络与数据库，
 * 输入输出都是普通对象，抽出后可以直接单测。
 * 唯一有副作用的 generatePaperSchema（要调模型）留在调用方注入。
 */

import { z } from 'zod';
import { createAppError } from '../lib/errors.js';
import { normalizeWhitespace } from '../lib/utils.js';
import type { KnowledgeCitation } from './knowledgeBase.js';

export const paperSchemaShape = z.object({
  title: z.string(),
  problem: z.string(),
  method: z.string(),
  architecture: z.string(),
  dataset: z.array(z.string()),
  metrics: z.array(z.string()),
  conclusion: z.string(),
  limitations: z.array(z.string())
});

export const researchGapShape = z.object({
  opportunity: z.string(),
  rationale: z.string(),
  supportingPaperIds: z.array(z.string()),
  confidence: z.number().min(0).max(1)
});

export const experimentSpecShape = z.object({
  baseline: z.string(),
  proposed_change: z.string(),
  dataset: z.string(),
  metrics: z.array(z.string()),
  training_plan: z.object({
    epochs: z.number().int().positive(),
    optimizer: z.string(),
    learning_rate: z.string(),
    batch_size: z.number().int().positive(),
    notes: z.string()
  }),
  ablation_plan: z.array(z.string()),
  evidenceRefs: z.array(
    z.object({
      paperId: z.string(),
      title: z.string(),
      reason: z.string()
    })
  )
});

export type PaperSchema = z.infer<typeof paperSchemaShape>;
export type ResearchGap = z.infer<typeof researchGapShape>;
export type ExperimentSpec = z.infer<typeof experimentSpecShape>;

export interface PaperSchemaMemoryRecord {
  paperId: string;
  source?: string;
  title: string;
  schema: PaperSchema;
  updatedAt?: number;
}

export interface ScoredPaperSchemaRecord extends PaperSchemaMemoryRecord {
  score: number;
}

/** 从摘要里草拟要点，摘要缺失时给出可执行的下一步提示而不是空数组 */
export function draftFindingsFromAbstract(abstract: string): string[] {
  const parts = normalizeWhitespace(abstract)
    .split(/[.。!?！？]/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!parts.length) {
    return ['缺少摘要信息，建议先补充论文摘要或全文后再分析。'];
  }
  return parts.slice(0, 4).map((line) => `${line}${/[.。]$/.test(line) ? '' : '。'}`);
}

/**
 * 从模型回复里抠出 JSON 对象。
 * 模型经常裹 markdown 代码块或在前后加解释文字，这里先剥围栏再按花括号截取。
 */
export function extractJsonObject(text: string): unknown {
  if (!text) {
    throw createAppError('SCHEMA_EMPTY', '模型返回为空', '请稍后重试。', 502);
  }

  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');

  if (start < 0 || end < 0 || end <= start) {
    throw createAppError('SCHEMA_PARSE_ERROR', '无法解析 Paper Schema', '模型返回结果不包含有效 JSON 对象。', 502);
  }

  const jsonText = candidate.slice(start, end + 1);
  try {
    return JSON.parse(jsonText);
  } catch {
    throw createAppError('SCHEMA_PARSE_ERROR', '无法解析 Paper Schema', '模型返回的 JSON 格式不合法。', 502);
  }
}

/** 把一条 Paper Schema 压平成可做关键词匹配的小写文本 */
export function buildSchemaSearchText(record: PaperSchemaMemoryRecord): string {
  const schema = record?.schema || ({} as PaperSchema);
  return [
    record?.title || '',
    schema.problem || '',
    schema.method || '',
    schema.architecture || '',
    Array.isArray(schema.dataset) ? schema.dataset.join(' ') : '',
    Array.isArray(schema.metrics) ? schema.metrics.join(' ') : '',
    schema.conclusion || '',
    Array.isArray(schema.limitations) ? schema.limitations.join(' ') : ''
  ]
    .join(' ')
    .toLowerCase();
}

/** 按中英文标点切词，过滤单字符噪声 */
export function splitKeywords(query: unknown): string[] {
  return String(query || '')
    .toLowerCase()
    .split(/[\s，。；：！？、,.!?;:/\\|]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
}

export function summarizePaperMemory(matches: PaperSchemaMemoryRecord[], query: string): Record<string, unknown> {
  const methods = new Set<string>();
  const limitations = new Set<string>();
  const datasets = new Set<string>();

  for (const item of matches) {
    const schema = item.schema;
    if (schema.method) methods.add(schema.method);
    for (const dataset of schema.dataset || []) datasets.add(dataset);
    for (const limitation of schema.limitations || []) limitations.add(limitation);
  }

  return {
    query,
    totalMatched: matches.length,
    methods: Array.from(methods).slice(0, 8),
    datasets: Array.from(datasets).slice(0, 8),
    commonLimitations: Array.from(limitations).slice(0, 8)
  };
}

export function buildMemoryCitations(matches: ScoredPaperSchemaRecord[]): KnowledgeCitation[] {
  return matches.slice(0, 6).map((item, index) => ({
    id: `memory-${index + 1}`,
    title: item.title,
    snippet: [item.schema.problem, item.schema.method, (item.schema.limitations || []).join('；')]
      .filter(Boolean)
      .join(' | '),
    source: `PaperMemory / ${item.paperId}`,
    score: Number(item.score.toFixed(4))
  }));
}

/** 统计某个维度（方法/数据集/限制）在语料中的出现次数 */
export function countItems(
  records: PaperSchemaMemoryRecord[],
  picker: (record: PaperSchemaMemoryRecord) => string[]
): Map<string, number> {
  const counter = new Map<string, number>();
  for (const record of records) {
    const values = picker(record).filter(Boolean);
    for (const value of values) {
      counter.set(value, (counter.get(value) || 0) + 1);
    }
  }
  return counter;
}

export function collectSupportingPapers(records: PaperSchemaMemoryRecord[], keyword: string): string[] {
  const key = String(keyword || '').toLowerCase();
  return records
    .filter((record) => buildSchemaSearchText(record).includes(key))
    .map((record) => record.paperId)
    .slice(0, 6);
}

export function normalizeGap(
  opportunity: string,
  rationale: string,
  supportingPaperIds: string[],
  confidence: number
): ResearchGap {
  return researchGapShape.parse({
    opportunity,
    rationale,
    supportingPaperIds: Array.from(new Set(supportingPaperIds)).filter(Boolean).slice(0, 8),
    confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(2))
  });
}

/**
 * 从 Paper Memory 里挖研究空白。
 *
 * 三条启发式规则：只出现一次的方法/数据集视为覆盖不足；
 * 重复出现两次以上的 limitation 视为共性痛点；
 * 命中 focus 关键词的论文达到两篇以上时，建议做定向对照实验。
 */
export function mineResearchGaps(records: PaperSchemaMemoryRecord[], focus = ''): ResearchGap[] {
  const methodCount = countItems(records, (record) => [record.schema.method]);
  const datasetCount = countItems(records, (record) => record.schema.dataset || []);
  const limitationCount = countItems(records, (record) => record.schema.limitations || []);

  const opportunities: ResearchGap[] = [];
  const focusKeywords = splitKeywords(focus);

  const underExploredMethods = Array.from(methodCount.entries())
    .filter(([, count]) => count === 1)
    .slice(0, 2);
  for (const [method] of underExploredMethods) {
    opportunities.push(
      normalizeGap(
        `扩展低覆盖方法：${method}`,
        `当前语料中该方法仅出现 1 次，存在系统性复现与对比不足的空白。`,
        collectSupportingPapers(records, method),
        0.62
      )
    );
  }

  const underExploredDatasets = Array.from(datasetCount.entries())
    .filter(([, count]) => count === 1)
    .slice(0, 2);
  for (const [dataset] of underExploredDatasets) {
    opportunities.push(
      normalizeGap(
        `补充跨数据集验证：${dataset}`,
        `该数据集在当前论文集中覆盖较少，建议纳入统一评测以验证泛化能力。`,
        collectSupportingPapers(records, dataset),
        0.66
      )
    );
  }

  const recurringLimitations = Array.from(limitationCount.entries())
    .filter(([, count]) => count >= 2)
    .slice(0, 2);
  for (const [limitation, count] of recurringLimitations) {
    opportunities.push(
      normalizeGap(
        `针对共性限制设计改进：${limitation}`,
        `该 limitation 在 ${count} 篇论文中重复出现，可作为下一步研究突破口。`,
        collectSupportingPapers(records, limitation),
        0.74
      )
    );
  }

  if (focusKeywords.length) {
    const focusedMatches = records.filter((record) => {
      const text = buildSchemaSearchText(record);
      return focusKeywords.some((keyword) => text.includes(keyword));
    });
    if (focusedMatches.length >= 2) {
      opportunities.push(
        normalizeGap(
          `围绕主题“${focus}”构建定向对照实验`,
          `已命中 ${focusedMatches.length} 篇相关论文，可基于其方法差异设计系统 ablation 与变量控制。`,
          focusedMatches.map((item) => item.paperId),
          0.7
        )
      );
    }
  }

  // 同一机会点可能被多条规则命中，按 opportunity 去重
  return opportunities
    .filter((item, index, array) => array.findIndex((x) => x.opportunity === item.opportunity) === index)
    .slice(0, 6);
}

export function pickPrimaryDataset(records: PaperSchemaMemoryRecord[]): string {
  const counts = countItems(records, (record) => record.schema.dataset || []);
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || '待补充公开数据集';
}

export function pickPrimaryMetric(records: PaperSchemaMemoryRecord[]): string[] {
  const counts = countItems(records, (record) => record.schema.metrics || []);
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 4).map(([name]) => name);
}

export function buildEvidenceRefs(
  records: PaperSchemaMemoryRecord[],
  supportingPaperIds: string[],
  opportunity: string
): ExperimentSpec['evidenceRefs'] {
  const byId = new Map(records.map((record) => [record.paperId, record]));
  return supportingPaperIds.slice(0, 6).map((paperId) => {
    const record = byId.get(paperId);
    return {
      paperId,
      title: record?.title || 'Unknown',
      reason: `该论文支持机会点：${opportunity}`
    };
  });
}

/** 把一个研究空白转成可复现的实验规格；支持文献为空时退回全量语料 */
export function buildExperimentSpecFromGap(
  opportunityItem: ResearchGap,
  records: PaperSchemaMemoryRecord[]
): ExperimentSpec {
  const supportingRecords = records.filter((record) => opportunityItem.supportingPaperIds.includes(record.paperId));
  const candidateRecords = supportingRecords.length ? supportingRecords : records;

  const methods = Array.from(new Set(candidateRecords.map((record) => record.schema.method).filter(Boolean))).slice(
    0,
    3
  );
  const baseline = methods[0] || '当前主流基线方法';
  const dataset = pickPrimaryDataset(candidateRecords);
  const metrics = pickPrimaryMetric(candidateRecords);

  const spec = {
    baseline,
    proposed_change: `围绕“${opportunityItem.opportunity}”进行结构/训练策略改造，并与基线做同预算对照。`,
    dataset,
    metrics: metrics.length ? metrics : ['Accuracy', 'F1'],
    training_plan: {
      epochs: 50,
      optimizer: 'AdamW',
      learning_rate: '2e-4 (cosine decay)',
      batch_size: 32,
      notes: '固定随机种子，至少运行 3 次并报告均值与方差。'
    },
    ablation_plan: [
      '仅替换 proposed_change 的核心模块，其余保持基线一致',
      '去除 proposed_change 的关键子组件，评估性能回退',
      '在不同数据子集上重复实验，观察泛化稳定性'
    ],
    evidenceRefs: buildEvidenceRefs(records, opportunityItem.supportingPaperIds, opportunityItem.opportunity)
  };

  return experimentSpecShape.parse(spec);
}
