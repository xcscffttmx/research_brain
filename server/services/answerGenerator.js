import { qwenStream } from '../lib/apiClients/qwen.js';
import { qwenConfig } from '../lib/config.js';

/**
 * 答案生成阶段 —— Agent Runtime 的最后一环。
 *
 * 与 Planner/Executor 的分工：
 *   Planner 决定做什么、Executor 拿到证据，本模块只负责把证据组织成回答并流式吐出。
 */

/** 单个工具结果注入 prompt 的最大字符数，避免长结果挤爆上下文 */
const MAX_RESULT_CHARS = 4_000;

const ANSWER_SYSTEM_PROMPT = [
  '你是一个中文科研助手。请基于给定的工具执行结果回答用户问题。',
  '要求：',
  '1. 只使用工具结果中出现的事实，不要编造文献标题、作者或数据。',
  '2. 工具结果为空或失败时，如实说明缺少哪些信息，并给出可行的下一步建议。',
  '3. 引用具体文献时标注标题与年份。',
  '4. 回答结构清晰、简洁，优先使用分点。'
].join('\n');

/** 结果体积裁剪：保留结构信息，超长部分截断 */
function stringifyResult(result) {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}…（已截断）`;
}

/** 把一轮执行的产物拼成生成阶段的 messages */
export function buildAnswerMessages({ question, contextHint = '', plan, toolResults = [], failedSteps = [] }) {
  const sections = [];

  if (contextHint) {
    sections.push(`【历史上下文摘要】\n${contextHint}`);
  }

  if (plan?.intent) {
    sections.push(`【本轮规划意图】\n${plan.intent}`);
  }

  if (toolResults.length) {
    const body = toolResults
      .map((item) => `- ${item.tool}（step ${item.step}）:\n${stringifyResult(item.result)}`)
      .join('\n');
    sections.push(`【工具执行结果】\n${body}`);
  } else {
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
