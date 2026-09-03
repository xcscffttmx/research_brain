import { z } from 'zod';
import { createAppError } from '../lib/errors.js';
import { qwenConfig } from '../lib/config.js';
import type { CancelNode } from './cancelTree.js';

/**
 * Planner —— 让模型先想清楚"要做什么"，再由 Executor 去做。
 *
 * 与「一把梭 function calling」的区别：
 *   - 计划是显式的、可落库的、可在前端可视化的
 *   - 每一步都带 reason，面试时能讲清 Agent 的决策依据
 *   - 带终止条件，避免无限循环调工具
 */

/**
 * 工具目录。
 * 只暴露科研问答主链路需要的工具 —— MCP 里注册了 38 个，
 * 全塞给模型会显著降低规划准确率。
 */
export const TOOL_CATALOG = [
  {
    name: 'retrieve_knowledge',
    description: '在用户个人知识库中做向量检索，返回相关文档片段',
    whenToUse: '问题可能与用户已上传的资料相关时优先调用',
    args: { query: 'string', topK: 'number?' }
  },
  {
    name: 'search_literature',
    description: '在线检索 arXiv / Semantic Scholar / OpenAlex 学术文献',
    whenToUse: '需要最新研究进展、或知识库中没有相关内容时',
    args: {
      query: 'string',
      source: 'all|arxiv|semantic_scholar|openalex?',
      limit: 'number?',
      sinceYear: 'number?',
      untilYear: 'number?'
    }
  },
  {
    name: 'summarize_literature',
    description: '对已检索到的文献做摘要归纳',
    whenToUse: '文献较多需要提炼共性时',
    args: { paperIds: 'string[]' }
  },
  {
    name: 'extract_paper_schema',
    description: '把单篇论文抽取成结构化字段（问题/方法/架构/数据集/指标/结论/局限）',
    whenToUse: '用户想深入了解某篇具体论文时',
    args: { paperId: 'string' }
  },
  {
    name: 'query_paper_memory',
    description: '跨多篇已抽取论文做聚合分析对比',
    whenToUse: '需要横向比较多篇论文时',
    args: { focus: 'string?' }
  },
  {
    name: 'mine_research_gaps',
    description: '基于已抽取的论文挖掘研究空白',
    whenToUse: '用户询问"还有什么可做的方向"时',
    args: { focus: 'string?' }
  },
  {
    name: 'generate_experiment_spec',
    description: '针对某个研究空白生成实验方案',
    whenToUse: '用户需要具体的实验设计时',
    args: { focus: 'string?', gapIndex: 'number?' }
  },
  {
    name: 'get_current_time',
    description: '获取当前日期时间',
    whenToUse: '问题涉及"最新""今年"等相对时间表述时',
    args: {}
  }
];

const TOOL_NAMES = TOOL_CATALOG.map((t) => t.name);

/** 单个计划步骤 */
const planStepSchema = z.object({
  step: z.number().int().positive(),
  tool: z.enum(TOOL_NAMES),
  args: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().min(1),
  /** 该步失败是否可跳过继续（非关键步骤） */
  optional: z.boolean().default(false)
});

/** 完整计划 */
export const planSchema = z.object({
  /** 是否需要调用工具；false 表示可直接回答 */
  needsTools: z.boolean(),
  /** 对问题的理解，会展示在前端时间线上 */
  intent: z.string().default(''),
  steps: z.array(planStepSchema).default([]),
  /** 终止条件的自然语言描述，供 Executor 判断是否提前结束 */
  stopWhen: z.string().default('所有步骤执行完毕')
});

export type PlanStep = z.infer<typeof planStepSchema>;
export type AgentPlan = z.infer<typeof planSchema>;

interface CreatePlanInput {
  question: string;
  contextHint?: string;
  cancelNode?: CancelNode;
  qwenFetch: (endpoint: string, body: Record<string, unknown>) => Promise<unknown>;
}

const PLANNER_SYSTEM_PROMPT = `你是科研问答 Agent 的规划器。你的任务是把用户问题拆成可执行的工具调用计划。

规则：
1. 只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块。
2. 字段：needsTools(boolean), intent(string), steps(array), stopWhen(string)。
3. steps 每项字段：step(从1开始的整数), tool(工具名), args(对象), reason(为什么这一步), optional(布尔)。
4. 只能使用给定工具列表中的工具名。
5. 步骤数控制在 1-4 步，能少不多。纯常识问答或闲聊时 needsTools 设为 false 且 steps 为空数组。
6. 优先顺序：涉及用户资料先用 retrieve_knowledge；需要最新进展再用 search_literature。
7. args 里的参数值要具体，不要留占位符。`;

function buildToolCatalogText() {
  return TOOL_CATALOG.map(
    (t) => `- ${t.name}: ${t.description}\n  使用时机: ${t.whenToUse}\n  参数: ${JSON.stringify(t.args)}`
  ).join('\n');
}

/** 从模型输出里抠出 JSON 对象（兼容被 markdown 包裹的情况） */
export function extractJsonObject(text: string): unknown {
  if (!text) throw createAppError('PLAN_EMPTY', 'Planner 返回为空', '', 502);

  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');

  if (start < 0 || end <= start) {
    throw createAppError('PLAN_PARSE_ERROR', 'Planner 输出不含 JSON 对象', '', 502);
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw createAppError('PLAN_PARSE_ERROR', 'Planner 输出的 JSON 不合法', '', 502);
  }
}

/** 计划为空时的兜底：直接回答 */
export function createDirectAnswerPlan(intent = '直接回答'): AgentPlan {
  return { needsTools: false, intent, steps: [], stopWhen: '无需工具，直接生成答案' };
}

/**
 * 生成执行计划。
 *
 * @param {object} params
 * @param {string} params.question       用户当轮问题
 * @param {string} [params.contextHint]  已有上下文摘要（来自 Context Manager）
 * @param {import('./cancelTree.js').CancelNode} params.cancelNode
 * @param {(endpoint: string, body: object) => Promise<any>} params.qwenFetch 注入以便测试
 * @returns {Promise<z.infer<typeof planSchema>>}
 */
export async function createPlan({
  question,
  contextHint = '',
  cancelNode,
  qwenFetch
}: CreatePlanInput): Promise<AgentPlan> {
  cancelNode?.throwIfCancelled();

  const userPrompt = [
    `可用工具：\n${buildToolCatalogText()}`,
    contextHint ? `\n已有对话上下文摘要：\n${contextHint}` : '',
    `\n用户问题：\n${question}`,
    '\n请输出计划 JSON。'
  ]
    .filter(Boolean)
    .join('\n');

  const completion = await qwenFetch('/chat/completions', {
    model: qwenConfig.chatModel,
    temperature: 0,
    messages: [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ]
  });

  const raw = readPlannerContent(completion);
  const parsed = extractJsonObject(raw);
  const validated = planSchema.safeParse(parsed);

  if (!validated.success) {
    // 规划失败不应该让整轮对话挂掉，降级为直接回答
    return createDirectAnswerPlan('规划失败，降级为直接回答');
  }

  const plan = validated.data;

  // 归一化：重排 step 序号，保证连续
  plan.steps = plan.steps.map((s, index) => ({ ...s, step: index + 1 }));

  // needsTools 与 steps 自相矛盾时以 steps 为准
  if (plan.needsTools && plan.steps.length === 0) plan.needsTools = false;
  if (!plan.needsTools && plan.steps.length > 0) plan.needsTools = true;

  return plan;
}

function readPlannerContent(completion: unknown): string {
  if (!completion || typeof completion !== 'object' || !('choices' in completion)) return '';
  const choices = (completion as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return '';
  const first = choices[0];
  if (!first || typeof first !== 'object' || !('message' in first)) return '';
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== 'object' || !('content' in message)) return '';
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}
