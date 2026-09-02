import { qwenStream, qwenFetch as defaultQwenFetch } from '../lib/apiClients/qwen.js';
import { qwenConfig } from '../lib/config.js';
import {
  buildEvidenceBlock,
  verifyGroundedness as defaultVerify,
  runAgenticRag as defaultRetrieveMore
} from './agenticRag.js';

/**
 * 答案生成阶段 —— Agent Runtime 的最后一环。
 *
 * 与 Planner/Executor 的分工：
 *   Planner 决定做什么、Executor 拿到证据，本模块只负责把证据组织成回答并流式吐出。
 * 带证据时还负责：注入 [^n] 引用要求 -> 生成 -> groundedness 校验 -> 必要时补充检索。
 */

/** 单个工具结果注入 prompt 的最大字符数，避免长结果挤爆上下文 */
const MAX_RESULT_CHARS = 4_000;

const ANSWER_SYSTEM_PROMPT = [
  '你是一个中文科研助手。请基于给定的工具执行结果回答用户问题。',
  '要求：',
  '1. 只使用工具结果中出现的事实，不要编造文献标题、作者或数据。',
  '2. 工具结果为空或失败时，如实说明缺少哪些信息，并给出可行的下一步建议。',
  '3. 引用具体文献时标注标题与年份。',
  '4. 回答结构清晰、简洁，优先使用分点。',
  '5. 若提供了【检索证据】，每个来自证据的论断后面必须紧跟对应的 [^n] 角标，n 为证据编号；证据之外的内容不要加角标。'
].join('\n');

/** 结果体积裁剪：保留结构信息，超长部分截断 */
function stringifyResult(result) {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}…（已截断）`;
}

/** 把一轮执行的产物拼成生成阶段的 messages */
export function buildAnswerMessages({
  question,
  contextHint = '',
  plan,
  toolResults = [],
  failedSteps = [],
  citations = []
}) {
  const sections = [];

  if (contextHint) {
    sections.push(`【历史上下文摘要】\n${contextHint}`);
  }

  if (plan?.intent) {
    sections.push(`【本轮规划意图】\n${plan.intent}`);
  }

  if (citations.length) {
    sections.push(`【检索证据】\n${buildEvidenceBlock(citations)}`);
  }

  // 证据已单独成块时，检索工具的原始结果不再重复注入
  const injectableResults = citations.length
    ? toolResults.filter((item) => item.tool !== 'retrieve_knowledge')
    : toolResults;

  if (injectableResults.length) {
    const body = injectableResults
      .map((item) => `- ${item.tool}（step ${item.step}）:\n${stringifyResult(item.result)}`)
      .join('\n');
    sections.push(`【工具执行结果】\n${body}`);
  } else if (!citations.length) {
    sections.push('【工具执行结果】\n本轮未调用工具，请基于常识与上下文直接回答。');
  }

  if (failedSteps.length) {
    const body = failedSteps.map((item) => `- ${item.tool}: ${item.code || 'ERROR'} ${item.message || ''}`).join('\n');
    sections.push(`【失败的步骤（需在回答中说明局限）】\n${body}`);
  }

  sections.push(`【用户问题】\n${question}`);

  return [
    { role: 'system', content: ANSWER_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') }
  ];
}

/**
 * 消费 Qwen 的 SSE 流，逐 token 回调。
 *
 * TextDecoder 必须开 stream 模式：中文 token 可能被切在两个 chunk 之间。
 */
export async function consumeQwenStream(response, onDelta) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let answer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const raw = trimmed.slice(5).trim();
        if (raw === '[DONE]') return answer;

        try {
          const json = JSON.parse(raw);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            answer += delta;
            onDelta?.(delta);
          }
        } catch {
          // 忽略非 JSON 的心跳/注释帧
        }
      }
    }
  }

  return answer;
}

/**
 * 生成最终答案（流式）。
 * 签名与 runAgentTurn 的 deps.generateAnswer 约定一致。
 *
 * @param {object} ctx
 * @param {AbortSignal} signal
 * @param {(delta: string) => void} onDelta
 * @returns {Promise<string>} 完整答案文本
 */
export async function generateAnswer(ctx, signal, onDelta) {
  const response = await qwenStream(
    '/chat/completions',
    {
      model: qwenConfig.chatModel,
      temperature: 0.4,
      messages: buildAnswerMessages(ctx)
    },
    signal
  );

  return consumeQwenStream(response, onDelta);
}

/** 从工具结果里汇总 citations，供前端渲染引用列表 */
export function collectCitations(toolResults = []) {
  const seen = new Set();
  const citations = [];

  for (const item of toolResults) {
    const list = Array.isArray(item?.result?.citations) ? item.result.citations : [];
    for (const citation of list) {
      const key = citation?.id || citation?.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      citations.push(citation);
    }
  }

  return citations;
}

/** 答案里实际出现的 [^n] 角标序号 */
export function extractCitedIndexes(answer) {
  const indexes = new Set();
  for (const match of answer.matchAll(/\[\^(\d+)\]/g)) {
    indexes.add(Number(match[1]));
  }
  return indexes;
}

/**
 * 带 groundedness 验证的答案生成。
 *
 * 链路：生成 -> 核查每个论断是否有证据支撑 -> 不达标则按「缺什么」补充检索并追加说明。
 * 补充部分以追加形式流出，不重写已经吐给用户的内容。
 *
 * @returns {Promise<{answer: string, verification: object|null, supplemented: boolean, citations: Array}>}
 */
export async function generateAnswerWithGroundedness({
  ctx,
  signal,
  onDelta,
  emit,
  cancelNode,
  runId = null,
  persist = true,
  deps = {}
}) {
  const {
    qwenFetch = defaultQwenFetch,
    verify = defaultVerify,
    retrieveMore = defaultRetrieveMore,
    generate = generateAnswer
  } = deps;

  const citations = ctx.citations || [];
  let answer = await generate(ctx, signal, onDelta);

  if (!citations.length) {
    return { answer, verification: null, supplemented: false, citations };
  }

  emit?.status?.('verifying', {});
  const verification = await verify({ answer, citations, qwenFetch, signal });

  if (verification.grounded || verification.skipped || !verification.missingInfo) {
    return { answer, verification, supplemented: false, citations };
  }

  emit?.status?.('supplementing', { missingInfo: verification.missingInfo });
  const extra = await retrieveMore({
    question: verification.missingInfo,
    runId,
    emit,
    cancelNode,
    persist,
    deps
  });

  const extraCitations = renumberCitations(extra.citations || [], citations.length);
  if (!extraCitations.length) {
    return { answer, verification, supplemented: false, citations };
  }

  const header = '\n\n---\n\n**补充（基于追加检索）**\n\n';
  onDelta?.(header);

  const supplement = await generate(
    {
      ...ctx,
      citations: extraCitations,
      question: `${ctx.question}\n\n仅回答此前缺失的部分：${verification.missingInfo}`
    },
    signal,
    onDelta
  );

  return {
    answer: `${answer}${header}${supplement}`,
    verification,
    supplemented: true,
    citations: [...citations, ...extraCitations]
  };
}

/** 补充检索的证据要接着前面的序号编号，避免 [^1] 撞号 */
function renumberCitations(citations, offset) {
  return citations.map((citation, position) => ({ ...citation, index: offset + position + 1 }));
}
