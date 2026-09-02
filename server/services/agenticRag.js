import { z } from 'zod';
import { qwenConfig } from '../lib/config.js';
import { qwenFetch as defaultQwenFetch, createEmbedding as defaultCreateEmbedding } from '../lib/apiClients/qwen.js';
import { rerankOrFallback as defaultRerank } from '../lib/apiClients/rerank.js';
import * as chunkRepo from '../repositories/chunkRepo.js';
import * as evidenceRepo from '../repositories/evidenceRepo.js';

/**
 * Agentic RAG —— 由 Agent 自主规划的多步检索链路。
 *
 * 与「一次向量检索塞给模型」的区别：
 *   1. 检索前先规划：要不要检索、拆成哪几个子问题、最多查几轮
 *   2. 每轮召回后做精排，并判断证据是否够用，不够就带着「缺什么」再查一轮
 *   3. 每条证据落库（原文 span + 向量分 + 精排分），答案里按 [^n] 挂引用
 *   4. 生成后做 groundedness 验证，不达标可触发补充检索
 */

/** 向量召回条数：宽召回交给精排收敛 */
const VECTOR_TOP_K = 50;
/** 精排后进入 prompt 的条数 */
const RERANK_TOP_N = 5;
/** 最大检索轮数上限（防止 Agent 自己规划出无限轮） */
const MAX_HOPS = 3;
/** 精排分达到该值即认为本轮已找到强相关证据 */
const SUFFICIENT_RERANK_SCORE = 0.35;
/** 注入 prompt 的单条证据长度上限 */
const EVIDENCE_SNIPPET_CHARS = 800;

const retrievalPlanSchema = z.object({
  needsRetrieval: z.boolean(),
  /** 子问题列表，一轮一个批次 */
  queries: z.array(z.string().min(1)).default([]),
  maxHops: z.number().int().min(1).max(MAX_HOPS).default(1),
  reason: z.string().default('')
});

const RETRIEVAL_PLANNER_PROMPT = `你是科研问答系统的检索规划器。判断回答用户问题需要怎样检索个人知识库。

规则：
1. 只输出一个 JSON 对象，不要解释文字，不要 markdown 代码块。
2. 字段：needsRetrieval(boolean), queries(string数组), maxHops(1-3的整数), reason(string)。
3. 纯闲聊、纯常识、纯格式转换类问题，needsRetrieval 为 false，queries 为空数组。
4. 需要检索时，把问题拆成 1-3 个互补的检索式子问题，每个子问题聚焦一个方面，避免互相重复。
5. 问题涉及多跳推理（需要先查 A 再根据 A 查 B）时，maxHops 设为 2 或 3；单点事实查询设为 1。
6. 子问题要写成适合语义检索的陈述式关键词短句，不要写成对话口语。`;

const HYDE_PROMPT = `你是检索查询改写器。请针对用户的问题，写出一段「假设性答案」（HyDE）。

要求：
1. 直接输出这段文本，不要任何前后缀说明。
2. 100 字以内，使用与问题同语言的书面语。
3. 尽量包含该领域的专业术语，因为这段文本会被用于向量检索，术语能提高召回命中率。
4. 不确定的事实用领域内常见表述占位即可，不需要真实准确。`;

const GROUNDEDNESS_PROMPT = `你是答案核查器。判断给定答案的每个关键论断是否有证据支撑。

规则：
1. 只输出一个 JSON 对象，不要解释文字。
2. 字段：grounded(boolean), score(0到1的小数), unsupported(string数组), missingInfo(string)。
3. score 表示有证据支撑的论断比例。
4. unsupported 列出缺乏证据支撑的论断（原文摘录，最多 3 条）。
5. missingInfo 用一句话说明「还缺什么信息」，若无则留空字符串。
6. 答案中明确说明「知识库没有相关内容」不算幻觉，视为 grounded。`;

/** 从模型输出里抠出 JSON（兼容被 markdown 包裹） */
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function firstMessageContent(completion) {
  return completion?.choices?.[0]?.message?.content ?? '';
}

/**
 * 规划检索策略。规划失败时降级为「单轮、用原问题检索」，不让整条链路挂掉。
 */
export async function planRetrieval({ question, contextHint = '', qwenFetch = defaultQwenFetch, signal }) {
  const fallback = { needsRetrieval: true, queries: [question], maxHops: 1, reason: '规划失败，按原问题单轮检索' };

  try {
    const completion = await qwenFetch(
      '/chat/completions',
      {
        model: qwenConfig.chatModel,
        temperature: 0,
        messages: [
          { role: 'system', content: RETRIEVAL_PLANNER_PROMPT },
          {
            role: 'user',
            content: [
              contextHint ? `已有上下文摘要：\n${contextHint}` : '',
              `用户问题：\n${question}`,
              '请输出检索计划 JSON。'
            ]
              .filter(Boolean)
              .join('\n\n')
          }
        ]
      },
      { signal }
    );

    const parsed = retrievalPlanSchema.safeParse(extractJson(firstMessageContent(completion)));
    if (!parsed.success) return fallback;

    const plan = parsed.data;
    if (plan.needsRetrieval && !plan.queries.length) plan.queries = [question];
    if (!plan.needsRetrieval) plan.queries = [];
    // 轮数不能超过子问题数，否则最后几轮无查询可用
    plan.maxHops = Math.min(plan.maxHops, MAX_HOPS);
    return plan;
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'CANCELLED') throw error;
    return fallback;
  }
}

/**
 * HyDE 查询改写：用「假设性答案」替代原始问题去做向量检索。
 * 问题与文档在向量空间里往往不同构（问句 vs 陈述句），HyDE 能显著提升召回率。
 * 失败时退回原查询。
 */
export async function rewriteWithHyde({ query, qwenFetch = defaultQwenFetch, signal }) {
  try {
    const completion = await qwenFetch(
      '/chat/completions',
      {
        model: qwenConfig.chatModel,
        temperature: 0.3,
        messages: [
          { role: 'system', content: HYDE_PROMPT },
          { role: 'user', content: query }
        ]
      },
      { signal }
    );

    const text = firstMessageContent(completion).trim();
    return text ? `${query}\n${text}` : query;
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'CANCELLED') throw error;
    return query;
  }
}

/**
 * 单轮检索：向量宽召回 -> 去重 -> 精排收敛。
 *
 * @returns {Promise<{items: Array, degraded: boolean, reason?: string}>}
 */
export async function retrieveOnce({
  question,
  queries,
  seenChunkIds = new Set(),
  topK = VECTOR_TOP_K,
  topN = RERANK_TOP_N,
  deps = {},
  signal
}) {
  const {
    createEmbedding = defaultCreateEmbedding,
    searchChunksByVector = chunkRepo.searchChunksByVector,
    rerank = defaultRerank
  } = deps;

  const recalled = [];
  for (const query of queries) {
    const embedding = await createEmbedding(query);
    for (const row of searchChunksByVector(embedding, topK)) {
      // 跨子问题、跨轮次去重：同一分块只保留最高向量分那次
      if (seenChunkIds.has(row.chunkId)) continue;
      const existing = recalled.find((item) => item.chunkId === row.chunkId);
      if (existing) {
        if (row.score > existing.vectorScore) existing.vectorScore = row.score;
        continue;
      }
      recalled.push({
        chunkId: row.chunkId,
        documentId: row.documentId,
        documentName: row.documentName,
        text: row.text,
        spanStart: row.spanStart,
        spanEnd: row.spanEnd,
        vectorScore: row.score,
        query
      });
    }
  }

  if (!recalled.length) {
    return { items: [], degraded: false };
  }

  // 精排始终针对「用户原始问题」，而不是改写后的子问题
  const {
    items: ranked,
    degraded,
    reason
  } = await rerank(
    question,
    recalled.map((item) => item.text),
    { topN, signal }
  );

  const items = ranked
    .map(({ index, score }) => (recalled[index] ? { ...recalled[index], rerankScore: score } : null))
    .filter(Boolean)
    .slice(0, topN);

  return { items, degraded, reason };
}

/** 证据是否已足够回答问题 */
function isEvidenceSufficient(items, degraded) {
  if (!items.length) return false;
  // 精排降级时分数不可信，只要有召回就先用，避免无意义地多查几轮
  if (degraded) return true;
  return items.some((item) => (item.rerankScore ?? 0) >= SUFFICIENT_RERANK_SCORE);
}

/**
 * 多步检索主链路。
 *
 * @param {object} params
 * @param {string} params.question         用户原始问题
 * @param {string} [params.contextHint]
 * @param {string} [params.runId]          落 evidence 表用
 * @param {object} [params.emit]           sseWriter
 * @param {object} [params.cancelNode]
 * @param {boolean} [params.persist]
 * @param {boolean} [params.useHyde]       是否开启 HyDE 改写
 * @param {object} [params.deps]           依赖注入，便于测试
 * @returns {Promise<{needsRetrieval, hops, evidence, citations, degraded, plan}>}
 */
export async function runAgenticRag({
  question,
  contextHint = '',
  runId = null,
  emit,
  cancelNode,
  persist = true,
  useHyde = true,
  deps = {}
}) {
  const { qwenFetch = defaultQwenFetch } = deps;
  const signal = cancelNode?.signal;

  cancelNode?.throwIfCancelled();
  emit?.status?.('rag_planning', {});

  const plan = await planRetrieval({ question, contextHint, qwenFetch, signal });

  if (!plan.needsRetrieval) {
    emit?.status?.('rag_skipped', { reason: plan.reason });
    return { needsRetrieval: false, hops: [], evidence: [], citations: [], degraded: false, plan };
  }

  const seenChunkIds = new Set();
  const hops = [];
  const evidence = [];
  let degraded = false;
  let queries = plan.queries.length ? plan.queries : [question];

  for (let hop = 1; hop <= plan.maxHops; hop++) {
    cancelNode?.throwIfCancelled();

    const effectiveQueries = useHyde
      ? await Promise.all(queries.map((query) => rewriteWithHyde({ query, qwenFetch, signal })))
      : queries;

    emit?.status?.('retrieving', { hop, queryCount: effectiveQueries.length });

    const result = await retrieveOnce({
      question,
      queries: effectiveQueries,
      seenChunkIds,
      deps,
      signal
    });

    degraded = degraded || result.degraded;
    for (const item of result.items) seenChunkIds.add(item.chunkId);

    const hopRecord = {
      hop,
      queries,
      itemCount: result.items.length,
      degraded: result.degraded,
      reason: result.reason
    };
    hops.push(hopRecord);

    if (result.items.length && persist && runId) {
      const ids = evidenceRepo.recordEvidence(
        runId,
        hop,
        result.items.map((item) => ({
          chunkId: item.chunkId,
          snippet: item.text.slice(0, EVIDENCE_SNIPPET_CHARS),
          vectorScore: item.vectorScore,
          rerankScore: item.rerankScore
        }))
      );
      result.items.forEach((item, index) => {
        item.evidenceId = ids[index];
      });
    }

    evidence.push(...result.items);

    emit?.status?.('retrieved', {
      hop,
      itemCount: result.items.length,
      topScore: result.items[0]?.rerankScore ?? result.items[0]?.vectorScore ?? 0,
      degraded: result.degraded
    });

    if (isEvidenceSufficient(result.items, result.degraded) || hop === plan.maxHops) {
      break;
    }

    // 证据不够：让模型基于已有证据决定下一轮查什么
    const followUp = await planFollowUpQueries({ question, evidence, qwenFetch, signal });
    if (!followUp.length) break;
    queries = followUp;
  }

  // 引用序号按最终排序分配，[^1] 对应最相关的一条
  const citations = buildCitations(evidence);
  if (persist && runId && citations.length) {
    evidenceRepo.markCited(
      citations
        .filter((citation) => citation.evidenceId)
        .map((citation) => ({ evidenceId: citation.evidenceId, citationIndex: citation.index }))
    );
  }

  return { needsRetrieval: true, hops, evidence, citations, degraded, plan };
}

/** 基于已召回证据规划补充检索的子问题 */
export async function planFollowUpQueries({ question, evidence, qwenFetch = defaultQwenFetch, signal }) {
  const digest = evidence
    .slice(0, RERANK_TOP_N)
    .map((item, index) => `[${index + 1}] ${item.text.slice(0, 200)}`)
    .join('\n');

  try {
    const completion = await qwenFetch(
      '/chat/completions',
      {
        model: qwenConfig.chatModel,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              '你是检索补全规划器。已有证据不足以回答问题时，输出下一轮要检索的子问题。只输出 JSON：{"queries":["...","..."]}，最多 2 条，写成适合语义检索的陈述式短句。若已有证据已足够，输出 {"queries":[]}。'
          },
          { role: 'user', content: `用户问题：\n${question}\n\n已召回证据：\n${digest || '（无）'}` }
        ]
      },
      { signal }
    );

    const parsed = extractJson(firstMessageContent(completion));
    const queries = Array.isArray(parsed?.queries)
      ? parsed.queries.filter((q) => typeof q === 'string' && q.trim())
      : [];
    return queries.slice(0, 2);
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'CANCELLED') throw error;
    return [];
  }
}

/** 把证据整理成带 [^n] 序号的引用列表 */
export function buildCitations(evidence) {
  return evidence
    .slice()
    .sort((a, b) => (b.rerankScore ?? b.vectorScore ?? 0) - (a.rerankScore ?? a.vectorScore ?? 0))
    .map((item, index) => ({
      index: index + 1,
      id: item.chunkId,
      evidenceId: item.evidenceId,
      title: item.documentName,
      snippet: item.text.slice(0, EVIDENCE_SNIPPET_CHARS),
      source: `向量知识库 / ${item.documentName}`,
      span: [item.spanStart, item.spanEnd],
      score: Number((item.rerankScore ?? item.vectorScore ?? 0).toFixed(4)),
      vectorScore: item.vectorScore,
      rerankScore: item.rerankScore
    }));
}

/**
 * 把引用列表渲染成注入 prompt 的证据块。
 * 模型据此在答案里写 [^n]，序号与 citations 一一对应。
 */
export function buildEvidenceBlock(citations) {
  if (!citations.length) return '';
  return citations
    .map((citation) => `[^${citation.index}] 来源：${citation.title}（相关度 ${citation.score}）\n${citation.snippet}`)
    .join('\n\n');
}

/**
 * 生成后的 groundedness 动态验证。
 * 验证本身失败时返回 grounded=true 并标记 skipped，避免因核查不可用而误判答案有问题。
 */
export async function verifyGroundedness({ answer, citations, qwenFetch = defaultQwenFetch, signal }) {
  if (!answer.trim() || !citations.length) {
    return { grounded: true, score: 1, unsupported: [], missingInfo: '', skipped: true };
  }

  try {
    const completion = await qwenFetch(
      '/chat/completions',
      {
        model: qwenConfig.chatModel,
        temperature: 0,
        messages: [
          { role: 'system', content: GROUNDEDNESS_PROMPT },
          { role: 'user', content: `证据：\n${buildEvidenceBlock(citations)}\n\n答案：\n${answer}` }
        ]
      },
      { signal }
    );

    const parsed = extractJson(firstMessageContent(completion));
    if (!parsed) {
      return { grounded: true, score: 1, unsupported: [], missingInfo: '', skipped: true };
    }

    return {
      grounded: Boolean(parsed.grounded),
      score: Number.isFinite(parsed.score) ? parsed.score : 0,
      unsupported: Array.isArray(parsed.unsupported) ? parsed.unsupported.slice(0, 3) : [],
      missingInfo: typeof parsed.missingInfo === 'string' ? parsed.missingInfo : '',
      skipped: false
    };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'CANCELLED') throw error;
    return { grounded: true, score: 1, unsupported: [], missingInfo: '', skipped: true };
  }
}

export const RAG_CONSTANTS = {
  VECTOR_TOP_K,
  RERANK_TOP_N,
  MAX_HOPS,
  SUFFICIENT_RERANK_SCORE,
  EVIDENCE_SNIPPET_CHARS
};
