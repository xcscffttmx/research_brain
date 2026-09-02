import { createAppError } from '../errors.js';
import { qwenConfig } from '../config.js';
import { fetchWithRetry } from '../fetchWithRetry.js';

/**
 * Reranker 精排客户端（DashScope 原生 text-rerank 接口，模型默认 gte-rerank-v2）。
 *
 * 两阶段检索的第二阶段：向量召回负责「不漏」，Reranker 负责「排得准」。
 * 交叉编码器把 query 与候选拼在一起编码，精度高于双塔向量模型，但开销大，
 * 因此只对 top-N 候选做精排。
 */

const RERANK_TIMEOUT_MS = 15_000;
/** 单次请求的候选上限，超出会被截断（上游也有限制） */
const MAX_DOCUMENTS = 100;
/** 单条候选文本上限，过长会拖慢精排且收益递减 */
const MAX_DOCUMENT_CHARS = 2_000;

/**
 * 对候选文档做精排。
 *
 * @param {string} query
 * @param {string[]} documents
 * @param {object} [options]
 * @param {number} [options.topN] 返回条数，默认全部
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Array<{index: number, score: number}>>} 按分数降序，index 指向入参 documents 下标
 */
export async function rerankDocuments(query, documents, { topN, signal } = {}) {
  if (!qwenConfig.apiKey) {
    throw createAppError(
      'MISSING_API_KEY',
      '缺少 Qwen API Key',
      '请检查服务端 `.env.local` 中的 `QWEN_API_KEY` 配置。',
      500
    );
  }

  const candidates = documents.slice(0, MAX_DOCUMENTS).map((text) => String(text ?? '').slice(0, MAX_DOCUMENT_CHARS));
  if (!query || !candidates.length) {
    return [];
  }

  const response = await fetchWithRetry(
    qwenConfig.rerankUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${qwenConfig.apiKey}`
      },
      body: JSON.stringify({
        model: qwenConfig.rerankModel,
        input: { query, documents: candidates },
        // 不要回传原文，节省带宽；原文由调用方按 index 取回
        parameters: { return_documents: false, top_n: topN ?? candidates.length }
      }),
      signal
    },
    { timeoutMs: RERANK_TIMEOUT_MS, retries: 1 }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw createAppError('RERANK_HTTP_ERROR', `Reranker 请求失败（${response.status}）`, text, 502);
  }

  const payload = await response.json();
  // 原生接口返回 output.results；兼容模式（若账号已开放）返回 results
  const results = payload?.output?.results ?? payload?.results;
  if (!Array.isArray(results)) {
    throw createAppError('RERANK_EMPTY', 'Reranker 返回结果为空', JSON.stringify(payload ?? null).slice(0, 500), 502);
  }

  return results
    .filter((item) => Number.isInteger(item?.index) && item.index < candidates.length)
    .map((item) => ({ index: item.index, score: Number(item.relevance_score ?? 0) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * 精排的降级包装：上游不可用时保持向量召回的原有顺序，
 * 让检索链路「变差但不中断」。
 *
 * @returns {Promise<{items: Array<{index: number, score: number}>, degraded: boolean, reason?: string}>}
 */
export async function rerankOrFallback(query, documents, options = {}) {
  try {
    const items = await rerankDocuments(query, documents, options);
    if (!items.length) {
      return { items: keepOriginalOrder(documents, options.topN), degraded: true, reason: 'RERANK_EMPTY' };
    }
    return { items, degraded: false };
  } catch (error) {
    // 取消要向上传播，不能被降级逻辑吞掉
    if (error?.name === 'AbortError' || error?.code === 'CANCELLED') throw error;
    return {
      items: keepOriginalOrder(documents, options.topN),
      degraded: true,
      reason: error?.code || 'RERANK_FAILED'
    };
  }
}

/** 降级时的顺序：沿用向量距离顺序，分数置 0 表示「未精排」 */
function keepOriginalOrder(documents, topN) {
  return documents.slice(0, topN ?? documents.length).map((_, index) => ({ index, score: 0 }));
}
