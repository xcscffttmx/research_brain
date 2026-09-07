import { createCancelRoot, CancelReason, CancelledError } from './cancelTree.js';
import type { CancelNode, CancelNodeReason, CancelReasonCode } from './cancelTree.js';
import { createPlan, createDirectAnswerPlan } from './planner.js';
import type { AgentPlan } from './planner.js';
import { executePlan } from './executor.js';
import type { ExecutePlanResult, ExecutionResultItem, FailedStep } from './executor.js';
import * as agentRunRepo from '../repositories/agentRunRepo.js';

/** 该工具不走 MCP，交给注入的 Agentic RAG 链路执行 */
const RAG_TOOL_NAME = 'retrieve_knowledge';

interface RuntimeEmit {
  status?: (stage: string, detail?: Record<string, unknown>) => boolean;
  send?: (event: string, payload?: Record<string, unknown>) => boolean;
  delta?: (text: string) => boolean;
  error?: (payload: Record<string, unknown>) => boolean;
  toolCall?: (payload: Record<string, unknown>) => boolean;
  toolResult?: (payload: Record<string, unknown>) => boolean;
}

interface MinimalCancelNode {
  signal: AbortSignal;
  readonly isCancelled: boolean;
  throwIfCancelled: () => void;
}

interface RagCitation {
  index?: number;
  [key: string]: unknown;
}

interface RagResult {
  needsRetrieval: boolean;
  citations: RagCitation[];
  hops?: unknown;
  degraded?: boolean;
}

interface GeneratedAnswer {
  answer?: string;
  verification?: unknown;
  citations?: RagCitation[];
}

interface RuntimeDeps {
  qwenFetch: (endpoint: string, body: Record<string, unknown>) => Promise<unknown>;
  callTool: (toolName: string, args: unknown, signal: AbortSignal) => Promise<unknown>;
  runRag?: (params: {
    question: string;
    runId: string;
    emit?: RuntimeEmit;
    cancelNode: MinimalCancelNode;
    persist: boolean;
  }) => Promise<RagResult>;
  generateAnswer: (
    ctx: {
      question: string;
      contextHint: string;
      plan: AgentPlan;
      toolResults: ExecutionResultItem[];
      failedSteps: FailedStep[];
      scratchpad: Record<string, unknown>;
      citations: RagCitation[];
    },
    signal: AbortSignal,
    onDelta: (delta: string) => boolean | undefined,
    meta: { runId: string; emit?: RuntimeEmit; cancelNode: CancelNode; persist: boolean }
  ) => Promise<string | GeneratedAnswer | null | undefined>;
}

export interface RunAgentTurnInput {
  sessionId: string;
  question: string;
  assistantMessageId?: string | null;
  contextHint?: string;
  emit?: RuntimeEmit;
  externalSignal?: AbortSignal;
  deps: RuntimeDeps;
  persist?: boolean;
}

interface RuntimeError extends Error {
  code?: string;
  details?: string;
  reason?: CancelNodeReason;
}

function toRuntimeError(error: unknown): RuntimeError {
  if (error instanceof Error) return error as RuntimeError;
  return new Error(String(error || '未知错误')) as RuntimeError;
}

/**
 * 把 AbortSignal 包成 CancelNode 的最小接口。
 * Executor 只把 signal 传给工具，而 RAG 链路需要 throwIfCancelled 语义。
 */
function nodeFromSignal(signal: AbortSignal): MinimalCancelNode {
  return {
    signal,
    get isCancelled() {
      return Boolean(signal?.aborted);
    },
    throwIfCancelled() {
      if (signal?.aborted) {
        throw new CancelledError({ code: CancelReason.USER_ABORT, detail: '上游已取消', nodeId: 'external-signal' });
      }
    }
  };
}

/**
 * Agent Runtime —— 一次对话轮次的完整生命周期编排。
 *
 * 流程：
 *   createCancelRoot -> startRun(落库)
 *     -> Planner 产出计划 -> updateRunPlan(落库)
 *     -> Executor 逐步执行（Timeout/Retry/取消联动）
 *     -> 把工具结果整理成上下文，交给生成阶段流式产出答案
 *     -> finishRun(落库)
 *
 * 所有阶段都通过 sseWriter 向前端推 status 事件，前端据此渲染 Agent 时间线。
 */

/** 运行中的 run 索引，供「停止」接口按 runId 精确取消 */
const activeRuns = new Map<string, CancelNode>();

/** 按 runId 取消一次运行（HTTP 层的 /api/chat/abort 用） */
export function abortRun(
  runId: string,
  reason: CancelReasonCode = CancelReason.USER_ABORT,
  detail = '用户主动停止'
): boolean {
  const node = activeRuns.get(runId);
  if (!node) return false;
  node.cancel(reason, detail);
  return true;
}

/** 当前活跃 run 数（健康检查/泄漏排查用） */
export function getActiveRunCount(): number {
  return activeRuns.size;
}

/**
 * 执行一次 Agent 轮次。
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.question              用户当轮问题
 * @param {string} [params.assistantMessageId]  预先创建的 assistant 消息 id
 * @param {string} [params.contextHint]         Context Manager 给的上下文摘要
 * @param {object} params.emit                  sseWriter 实例
 * @param {AbortSignal} [params.externalSignal] HTTP 请求断开信号
 * @param {object} params.deps                  依赖注入，便于测试
 * @param {Function} params.deps.qwenFetch
 * @param {Function} params.deps.callTool       (toolName, args, signal) => Promise
 * @param {Function} params.deps.generateAnswer (ctx, signal, onDelta) => Promise<string>
 * @param {boolean} [params.persist]
 */
export async function runAgentTurn({
  sessionId,
  question,
  assistantMessageId = null,
  contextHint = '',
  emit,
  externalSignal,
  deps,
  persist = true
}: RunAgentTurnInput) {
  const { qwenFetch, callTool, generateAnswer, runRag } = deps;

  let run: { id: string } | null = null;
  let cancelRoot: CancelNode | null = null;

  try {
    // ---------- 1. 建立 run 与取消树 ----------
    if (persist) {
      run = agentRunRepo.startRun({ sessionId, messageId: assistantMessageId });
      if (!run) throw new Error('创建 Agent run 失败');
    } else {
      run = { id: `run-local-${Date.now()}` };
    }

    cancelRoot = createCancelRoot(run.id, externalSignal);
    activeRuns.set(run.id, cancelRoot);

    emit?.status?.('run_started', { runId: run.id });

    // ---------- 2. 规划 ----------
    emit?.status?.('planning', {});
    const planNode = cancelRoot.child('planner');

    let plan: AgentPlan;
    try {
      plan = await createPlan({
        question,
        contextHint,
        cancelNode: planNode,
        qwenFetch
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      // 规划失败降级为直接回答，不让整轮挂掉
      plan = createDirectAnswerPlan('规划阶段异常，降级为直接回答');
    } finally {
      planNode.detach();
    }

    if (persist) agentRunRepo.updateRunPlan(run.id, plan);
    emit?.send?.('plan', { runId: run.id, ...plan });

    cancelRoot.throwIfCancelled();

    // ---------- 3. 执行工具链 ----------
    let execution: ExecutePlanResult = {
      scratchpad: {},
      results: [],
      failedSteps: [],
      aborted: false,
      stoppedEarly: null
    };

    if (plan.needsTools && plan.steps.length) {
      emit?.status?.('executing', { totalSteps: plan.steps.length });
      execution = await executePlan({
        plan,
        runId: run.id,
        cancelNode: cancelRoot,
        callTool: buildToolDispatcher({ callTool, runRag, question, runId: run.id, emit, persist }),
        emit,
        persist
      });
    }

    cancelRoot.throwIfCancelled();

    // ---------- 4. 生成答案（流式） ----------
    emit?.status?.('generating', {});
    const answerNode = cancelRoot.child('generator');

    let answer = '';
    let citations = collectRagCitations(execution.results);
    let verification = null;

    try {
      const generated = await generateAnswer(
        {
          question,
          contextHint,
          plan,
          toolResults: execution.results,
          failedSteps: execution.failedSteps,
          scratchpad: execution.scratchpad,
          // 检索链路产出的证据，供生成阶段注入 [^n] 引用
          citations
        },
        answerNode.signal,
        (delta: string) => emit?.delta?.(delta),
        { runId: run.id, emit, cancelNode: answerNode, persist }
      );

      // 生成阶段可能返回纯文本，也可能返回带核查结果的对象
      if (typeof generated === 'string') {
        answer = generated;
      } else {
        answer = generated?.answer ?? '';
        verification = generated?.verification ?? null;
        if (Array.isArray(generated?.citations) && generated.citations.length) {
          citations = generated.citations;
        }
      }
    } finally {
      answerNode.detach();
    }

    // ---------- 5. 收尾 ----------
    if (persist) agentRunRepo.finishRun(run.id, 'succeeded');

    return {
      runId: run.id,
      status: 'succeeded',
      plan,
      answer,
      citations,
      verification,
      toolResults: execution.results,
      failedSteps: execution.failedSteps,
      partial: execution.aborted,
      stoppedEarly: execution.stoppedEarly
    };
  } catch (error: unknown) {
    const err = toRuntimeError(error);
    // 取消树已 abort 时，即使底层抛的是 fetch 的 AbortError，也应记为 cancelled
    const cancelled = isCancellation(error) || Boolean(cancelRoot?.isCancelled);
    const status = cancelled ? 'cancelled' : 'failed';

    if (persist && run) {
      agentRunRepo.finishRun(run.id, status, {
        errorCode: err.code || (cancelled ? 'CANCELLED' : 'UNKNOWN'),
        errorMsg: err.message || ''
      });
    }

    if (cancelled) {
      emit?.status?.('cancelled', {
        runId: run?.id,
        reason: err.reason?.code || cancelRoot?.reason?.code
      });
    } else {
      emit?.error?.({
        code: err.code || 'AGENT_RUN_FAILED',
        message: err.message || 'Agent 执行失败',
        details: err.details || ''
      });
    }

    return {
      runId: run?.id,
      status,
      error: { code: err.code, message: err.message },
      answer: ''
    };
  } finally {
    if (run) activeRuns.delete(run.id);
    // 保险：即使中途异常也确保子树被清理，避免残留 AbortSignal 监听
    if (cancelRoot && !cancelRoot.isCancelled) {
      for (const child of [...cancelRoot.children]) child.detach();
    }
  }
}

function isCancellation(error: unknown): boolean {
  const err = toRuntimeError(error);
  return error instanceof CancelledError || err.code === 'CANCELLED';
}

/**
 * 工具分发：retrieve_knowledge 交给 Agentic RAG，其余走 MCP。
 * 仍然经过 Executor 的 Timeout/Retry 与取消树，行为与普通工具一致。
 */
function buildToolDispatcher({
  callTool,
  runRag,
  question,
  runId,
  emit,
  persist
}: {
  callTool: RuntimeDeps['callTool'];
  runRag?: RuntimeDeps['runRag'];
  question: string;
  runId: string;
  emit?: RuntimeEmit;
  persist: boolean;
}) {
  return async (toolName: string, args: unknown, signal: AbortSignal): Promise<unknown> => {
    const toolArgs = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
    if (runRag && toolName === RAG_TOOL_NAME) {
      const result = await runRag({
        question: typeof toolArgs.query === 'string' ? toolArgs.query : question,
        runId,
        emit,
        cancelNode: nodeFromSignal(signal),
        persist
      });

      // 返回给 scratchpad 的结构保持「工具结果」形状，后续步骤可用 {{step1.citations}}
      return {
        needsRetrieval: result.needsRetrieval,
        citations: result.citations,
        hops: result.hops,
        degraded: result.degraded,
        count: result.citations.length
      };
    }

    return callTool(toolName, args, signal);
  };
}

/** 从工具结果里取出 RAG 证据（带 index 的才是 Agentic RAG 产出） */
function collectRagCitations(results: ExecutionResultItem[] = []): RagCitation[] {
  for (const item of results) {
    if (item.tool !== RAG_TOOL_NAME) continue;
    const result = item.result && typeof item.result === 'object' ? (item.result as { citations?: unknown }) : {};
    const citations = result.citations;
    if (Array.isArray(citations) && citations.length) return citations;
  }
  return [];
}
