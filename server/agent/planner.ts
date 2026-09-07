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

/**
 * 结构化终止条件。
 *
 * 为什么不用自然语言让 Executor 判断：那需要每步后再调一次模型，
 * 既加延迟又让成本不可控。改成可机械求值的三元组（path / op / value），
 * Executor 直接读 scratchpad 判断，零额外开销。
 */
const stopConditionSchema = z.object({
  /** 只在该步之后检查；不填则每步之后都检查 */
  afterStep: z.number().int().positive().optional(),
  /** scratchpad 路径，如 step1.count、step1.citations */
  path: z.string().min(1),
  op: z.enum(['exists', 'nonEmpty', 'gte', 'gt', 'eq']),
  /** gte/gt/eq 需要的比较值 */
  value: z.union([z.number(), z.string(), z.boolean()]).optional()
});

/** 完整计划 */
export const planSchema = z.object({
  /** 是否需要调用工具；false 表示可直接回答 */
  needsTools: z.boolean(),
  /** 对问题的理解，会展示在前端时间线上 */
  intent: z.string().default(''),
  steps: z.array(planStepSchema).default([]),
  /** 终止条件的自然语言描述，仅用于前端展示 */
  stopWhen: z.string().default('所有步骤执行完毕'),
  /** 可机械求值的终止条件；满足任一条即提前结束，跳过剩余步骤 */
  stopConditions: z.array(stopConditionSchema).default([])
});

export type PlanStep = z.infer<typeof planStepSchema>;
export type StopCondition = z.infer<typeof stopConditionSchema>;
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
2. 字段：needsTools(boolean), intent(string), steps(array), stopWhen(string), stopConditions(array)。
3. steps 每项字段：step(从1开始的整数), tool(工具名), args(对象), reason(为什么这一步), optional(布尔)。
4. 只能使用给定工具列表中的工具名。
5. 步骤数控制在 1-4 步，能少不多。纯常识问答或闲聊时 needsTools 设为 false 且 steps 为空数组。
6. 优先顺序：涉及用户资料先用 retrieve_knowledge；需要最新进展再用 search_literature。
7. args 里的参数值要具体，不要留占位符。
8. stopConditions 用于「前面步骤已拿到足够结果就跳过后面步骤」，每项字段：
   afterStep(在第几步之后检查，可省略表示每步都查), path(前序结果路径，如 step1.count), op(exists|nonEmpty|gte|gt|eq), value(op 为 gte/gt/eq 时必填)。
   没有可提前结束的场景就给空数组。
   示例：先查知识库再查文献时，可写 [{"afterStep":1,"path":"step1.count","op":"gte","value":3}]，
   含义是第 1 步已检索到 3 条以上证据，就不必再联网检索。`;

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
  return { needsTools: false, intent, steps: [], stopWhen: '无需工具，直接生成答案', stopConditions: [] };
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

  plan.stopConditions = normalizeStopConditions(plan.stopConditions, plan.steps.length);

  return plan;
}

/**
 * 过滤无效终止条件：
 *   1. 无工具步骤时终止条件没有意义
 *   2. afterStep 超出实际步数的条件永远不会被触发，直接丢弃
 *   3. gte/gt/eq 缺少比较值时无法求值
 *   4. 最后一步之后没有剩余步骤可跳过，留着只会产生误导性的提前结束
 */
export function normalizeStopConditions(conditions: StopCondition[], stepCount: number): StopCondition[] {
  if (!stepCount) return [];

  return conditions.filter((condition) => {
    // afterStep 等于总步数时后面已无步骤可跳过，同样丢弃
    if (condition.afterStep !== undefined && condition.afterStep >= stepCount) return false;
    if (['gte', 'gt', 'eq'].includes(condition.op) && condition.value === undefined) return false;
    return true;
  });
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
