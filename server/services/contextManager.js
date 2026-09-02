import { encode } from 'gpt-tokenizer';
import { qwenConfig } from '../lib/config.js';
import { qwenFetch as defaultQwenFetch } from '../lib/apiClients/qwen.js';
import * as messageRepo from '../repositories/messageRepo.js';
import * as sessionRepo from '../repositories/sessionRepo.js';

/**
 * 分层 Context 管理 —— 长会话不超限的关键。
 *
 * 三层划分：
 *   Working    当前轮：system prompt + 用户问题 + 本轮工具结果（不可裁剪）
 *   Short-Term 最近若干轮原文消息（按预算动态决定条数）
 *   Long-Term  更早历史的 LLM 压缩摘要（落库复用，不重复调模型）
 *
 * 预算超限时的降级顺序是 Long -> Short：
 * 摘要信息密度低、可再生，原文近轮对连贯性影响更大，所以先砍摘要。
 */

/** 模型上下文上限，可通过 CONTEXT_MAX_TOKENS 覆盖 */
const DEFAULT_MAX_TOKENS = 32_000;
/** 安全系数：给生成留出输出空间与计数误差余量 */
const SAFETY_RATIO = 0.75;
/** 三层配额比例（占可用预算） */
const LAYER_RATIO = { working: 0.5, shortTerm: 0.35, longTerm: 0.15 };
/** 触发压缩的条件：未被摘要覆盖的历史消息达到该条数 */
const COMPRESS_TRIGGER_MESSAGES = 12;
/** Short-Term 最多回看多少条原文（再多也进不了预算） */
const SHORT_TERM_SCAN_LIMIT = 40;
/** 单条消息注入时的硬截断，避免一条超长消息吃掉整层预算 */
const MESSAGE_CHARS_LIMIT = 2_000;

const COMPRESS_PROMPT = `你是对话历史压缩器。把给定的多轮对话压缩成简洁摘要。

要求：
1. 直接输出摘要正文，不要任何前后缀说明。
2. 保留：用户的研究主题、已确认的结论、已检索到的关键文献名、用户明确的偏好与约束。
3. 丢弃：寒暄、重复确认、已被推翻的中间结论、具体措辞。
4. 使用中文，条目化，200 字以内。
5. 若已有旧摘要，把旧摘要与新对话合并成一份，不要重复叙述。`;

/** 精确 token 计数（gpt-tokenizer 的 cl100k 与 Qwen 有差异，但量级足够做预算控制） */
export function countTokens(text) {
  if (!text) return 0;
  return encode(String(text)).length;
}

/** 按模型上限与安全系数拆出三层配额 */
export function computeBudget(maxTokens = Number(process.env.CONTEXT_MAX_TOKENS) || DEFAULT_MAX_TOKENS) {
  const available = Math.floor(maxTokens * SAFETY_RATIO);
  return {
    maxTokens,
    available,
    working: Math.floor(available * LAYER_RATIO.working),
    shortTerm: Math.floor(available * LAYER_RATIO.shortTerm),
    longTerm: Math.floor(available * LAYER_RATIO.longTerm)
  };
}

/** 消息转成注入文本的统一形状 */
function renderMessage(message) {
  const content = String(message.content || '')
    .replace(/\s+/g, ' ')
    .slice(0, MESSAGE_CHARS_LIMIT);
  return `${message.role}: ${content}`;
}

/**
 * 从最近往前塞消息，直到用满 Short-Term 配额。
 * 返回结果按时间升序，便于模型理解顺序。
 */
export function selectShortTerm(messages, budgetTokens) {
  const selected = [];
  let used = 0;

  for (let index = messages.length - 1; index >= 0; index--) {
    const text = renderMessage(messages[index]);
    const tokens = messages[index].token_count || countTokens(text);
    if (used + tokens > budgetTokens) break;
    used += tokens;
    selected.unshift({ ...messages[index], renderedText: text, tokens });
  }

  return { messages: selected, tokens: used };
}

/** 摘要超配额时按句截断，尽量保留完整语义单元 */
export function fitSummary(summary, budgetTokens) {
  if (!summary) return { text: '', tokens: 0, truncated: false };

  const tokens = countTokens(summary);
  if (tokens <= budgetTokens) return { text: summary, tokens, truncated: false };

  const sentences = summary.split(/(?<=[。；\n])/);
  let text = '';
  for (const sentence of sentences) {
    if (countTokens(text + sentence) > budgetTokens) break;
    text += sentence;
  }

  // 一句话就超预算时按字符硬截
  if (!text) text = summary.slice(0, Math.max(0, budgetTokens * 2));

  return { text, tokens: countTokens(text), truncated: true };
}

/**
 * 压缩「摘要覆盖点之后、Short-Term 之前」的那段历史，并把结果写回 sessions.summary。
 * 已压缩部分用 summary_upto 记录覆盖到的 seq，下次只处理增量。
 *
 * @returns {Promise<{summary: string, summaryUpto: number, compressed: boolean, reason?: string}>}
 */
export async function compressHistory({
  sessionId,
  beforeSeq,
  previousSummary = '',
  summaryUpto = 0,
  qwenFetch = defaultQwenFetch,
  signal,
  persist = true
}) {
  const pending = messageRepo.listMessagesBefore(sessionId, beforeSeq).filter((message) => message.seq > summaryUpto);

  if (pending.length < COMPRESS_TRIGGER_MESSAGES) {
    return { summary: previousSummary, summaryUpto, compressed: false, reason: 'BELOW_TRIGGER' };
  }

  const transcript = pending.map(renderMessage).join('\n');
  const nextUpto = pending[pending.length - 1].seq;

  try {
    const completion = await qwenFetch(
      '/chat/completions',
      {
        model: qwenConfig.chatModel,
        temperature: 0,
        messages: [
          { role: 'system', content: COMPRESS_PROMPT },
          {
            role: 'user',
            content: [previousSummary ? `已有摘要：\n${previousSummary}` : '', `新增对话：\n${transcript}`]
              .filter(Boolean)
              .join('\n\n')
          }
        ]
      },
      { signal }
    );

    const summary = (completion?.choices?.[0]?.message?.content || '').trim();
    if (!summary) {
      return { summary: previousSummary, summaryUpto, compressed: false, reason: 'EMPTY_SUMMARY' };
    }

    if (persist) sessionRepo.updateSessionSummary(sessionId, summary, nextUpto);
    return { summary, summaryUpto: nextUpto, compressed: true };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'CANCELLED') throw error;
    // 压缩失败不能让对话中断，沿用旧摘要
    return { summary: previousSummary, summaryUpto, compressed: false, reason: error?.code || 'COMPRESS_FAILED' };
  }
}

/**
 * 组装本轮的分层上下文。
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.question           当前轮问题（Working 层）
 * @param {number} [params.maxTokens]
 * @param {boolean} [params.allowCompress]   预算不足时是否触发压缩
 * @param {object} [params.deps]
 * @returns {Promise<{contextHint: string, layers: object, budget: object, usage: object}>}
 */
export async function buildContext({
  sessionId,
  question,
  maxTokens,
  allowCompress = true,
  persist = true,
  signal,
  deps = {}
}) {
  const { qwenFetch = defaultQwenFetch } = deps;
  const budget = computeBudget(maxTokens);

  const session = sessionId ? sessionRepo.getSession(sessionId) : null;
  const recent = sessionId ? messageRepo.listRecentMessages(sessionId, SHORT_TERM_SCAN_LIMIT) : [];

  const shortTerm = selectShortTerm(recent, budget.shortTerm);
  // Short-Term 已覆盖的最早 seq，就是 Long-Term 需要压缩的边界
  const boundarySeq = shortTerm.messages[0]?.seq ?? (recent[recent.length - 1]?.seq ?? 0) + 1;

  let summary = session?.summary || '';
  let summaryUpto = session?.summary_upto || 0;
  let compressed = false;

  if (allowCompress && sessionId) {
    const result = await compressHistory({
      sessionId,
      beforeSeq: boundarySeq,
      previousSummary: summary,
      summaryUpto,
      qwenFetch,
      signal,
      persist
    });
    summary = result.summary;
    summaryUpto = result.summaryUpto;
    compressed = result.compressed;
  }

  const longTerm = fitSummary(summary, budget.longTerm);
  const workingTokens = countTokens(question);

  const sections = [];
  if (longTerm.text) sections.push(`【更早历史摘要】\n${longTerm.text}`);
  if (shortTerm.messages.length) {
    sections.push(`【最近对话】\n${shortTerm.messages.map((message) => message.renderedText).join('\n')}`);
  }

  return {
    contextHint: sections.join('\n\n'),
    layers: {
      working: { question, tokens: workingTokens },
      shortTerm: { count: shortTerm.messages.length, tokens: shortTerm.tokens, scanned: recent.length },
      longTerm: { tokens: longTerm.tokens, truncated: longTerm.truncated, compressed, summaryUpto }
    },
    budget,
    usage: {
      total: workingTokens + shortTerm.tokens + longTerm.tokens,
      // 超出即说明 Working 层本身过大，需要调用方裁剪工具结果
      overBudget: workingTokens + shortTerm.tokens + longTerm.tokens > budget.available
    }
  };
}

export const CONTEXT_CONSTANTS = {
  DEFAULT_MAX_TOKENS,
  SAFETY_RATIO,
  LAYER_RATIO,
  COMPRESS_TRIGGER_MESSAGES,
  SHORT_TERM_SCAN_LIMIT,
  MESSAGE_CHARS_LIMIT
};
