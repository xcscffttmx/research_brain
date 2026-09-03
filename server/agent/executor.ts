import { CancelledError } from './cancelTree.js';
import type { CancelNode } from './cancelTree.js';
import { runWithPolicy } from './policy.js';
import type { RetryPolicy } from './policy.js';
import type { AgentPlan } from './planner.js';
import * as agentRunRepo from '../repositories/agentRunRepo.js';
import type { ToolCallStatus } from '../db/types.js';

type JsonLike = unknown;
type Scratchpad = Record<string, unknown>;

interface ErrorWithCode extends Error {
  code?: string;
}

interface AgentEmit {
  toolCall?: (payload: Record<string, unknown>) => boolean;
  toolResult?: (payload: Record<string, unknown>) => boolean;
  status?: (stage: string, detail?: Record<string, unknown>) => boolean;
}

interface ExecutePlanInput {
  plan: AgentPlan;
  runId: string;
  cancelNode: CancelNode;
  callTool: (toolName: string, args: JsonLike, signal: AbortSignal) => Promise<unknown>;
  emit?: AgentEmit;
  persist?: boolean;
  timeoutMs?: number;
  policy?: Partial<RetryPolicy>;
}

export interface ExecutionResultItem {
  step: number;
  tool: string;
  status: 'succeeded';
  result: unknown;
  attempts: number;
  durationMs: number;
}

export interface FailedStep {
  step: number;
  tool: string;
  code?: string;
  message?: string;
}

export interface ExecutePlanResult {
  scratchpad: Scratchpad;
  results: ExecutionResultItem[];
  failedSteps: FailedStep[];
  aborted: boolean;
}

function toErrorWithCode(error: unknown): ErrorWithCode {
  if (error instanceof Error) return error as ErrorWithCode;
  return new Error(String(error || '未知错误')) as ErrorWithCode;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Executor —— 逐步执行 Planner 产出的计划。
 *
 * 核心职责：
 *   1. 按顺序执行每个 step，通过策略层套上 Timeout + Retry
 *   2. 把每步结果「回填」到共享的 scratchpad，让后续步骤能用到前面的产出
 *   3. 全过程落库到 tool_calls，支持前端回放
 *   4. 与取消树联动：任一环节被取消，整个执行链立刻停止
 */

/**
 * 参数插值：允许 Planner 在 args 里用 {{step1.paperIds}} 引用前序步骤结果。
 * 这是「结果回填」的具体实现。
 */
export function resolveArgs(args: JsonLike, scratchpad: Scratchpad): JsonLike {
  if (args === null || args === undefined) return args;

  if (typeof args === 'string') {
    const match = args.match(/^\{\{\s*([\w.[\]]+)\s*\}\}$/);
    if (match) return readPath(scratchpad, match[1]);
    // 内联插值（保持字符串类型）
    return args.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_, path) => {
      const value = readPath(scratchpad, path);
      return value === undefined ? '' : String(value);
    });
  }

  if (Array.isArray(args)) return args.map((item) => resolveArgs(item, scratchpad));

  if (typeof args === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      out[key] = resolveArgs(value, scratchpad);
    }
    return out;
  }

  return args;
}

/** 按 a.b[0].c 形式读取嵌套值 */
export function readPath(source: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);

  let current: unknown = source;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * 执行整个计划。
 *
 * @param {object} params
 * @param {import('./planner.js').planSchema} params.plan
 * @param {string} params.runId
 * @param {import('./cancelTree.js').CancelNode} params.cancelNode
 * @param {(toolName: string, args: object, signal: AbortSignal) => Promise<any>} params.callTool
 * @param {object} [params.emit] SSE 事件发射器（sseWriter 实例）
 * @param {boolean} [params.persist] 是否落库，测试时可关掉
 * @param {number} [params.timeoutMs] 覆盖所有步骤的超时（不传则用 TOOL_TIMEOUTS 表）
 * @param {object} [params.policy] 覆盖重试策略
 * @returns {Promise<{scratchpad: object, results: Array, failedSteps: Array}>}
 */
export async function executePlan({
  plan,
  runId,
  cancelNode,
  callTool,
  emit,
  persist = true,
  timeoutMs,
  policy
}: ExecutePlanInput): Promise<ExecutePlanResult> {
  const scratchpad: Scratchpad = {};
  const results: ExecutionResultItem[] = [];
  const failedSteps: FailedStep[] = [];

  for (const step of plan.steps) {
    cancelNode.throwIfCancelled();

    const stepNode = cancelNode.child(`step-${step.step}`);
    const resolvedArgs = resolveArgs(step.args, scratchpad);

    let toolCallId = null;
    if (persist) {
      toolCallId = agentRunRepo.startToolCall({
        runId,
        stepIndex: step.step,
        toolName: step.tool,
        args: toRecord(resolvedArgs)
      });
    }

    emit?.toolCall?.({
      id: toolCallId || `step-${step.step}`,
      name: step.tool,
      args: resolvedArgs,
      stepIndex: step.step,
      reason: step.reason
    });

    try {
      const { result, attempts, durationMs } = await runWithPolicy<unknown>({
        toolName: step.tool,
        parentNode: stepNode,
        timeoutMs,
        policy,
        task: (signal) => callTool(step.tool, resolvedArgs, signal),
        onAttempt: ({ attempt, error, delayMs }) => {
          if (error) {
            emit?.status?.('tool_retry', {
              tool: step.tool,
              stepIndex: step.step,
              attempt,
              delayMs,
              errorCode: error.code
            });
          }
        }
      });

      // 结果回填：后续步骤可用 {{step1.xxx}} 引用
      scratchpad[`step${step.step}`] = result;
      scratchpad[step.tool] = result;

      results.push({ step: step.step, tool: step.tool, status: 'succeeded', result, attempts, durationMs });

      if (persist && toolCallId) {
        agentRunRepo.finishToolCall(toolCallId, 'succeeded', { result });
      }

      emit?.toolResult?.({
        id: toolCallId || `step-${step.step}`,
        name: step.tool,
        status: 'succeeded',
        result,
        durationMs,
        stepIndex: step.step
      });

      stepNode.detach();
    } catch (error: unknown) {
      stepNode.detach();
      const err = toErrorWithCode(error);

      // 取消要立刻向上传播，不能被 optional 吞掉
      if (error instanceof CancelledError || err.code === 'CANCELLED') {
        if (persist && toolCallId) {
          agentRunRepo.finishToolCall(toolCallId, 'cancelled', { errorMsg: err.message });
        }
        emit?.toolResult?.({
          id: toolCallId || `step-${step.step}`,
          name: step.tool,
          status: 'cancelled',
          stepIndex: step.step
        });
        throw error;
      }

      const status: ToolCallStatus = err.code === 'TOOL_TIMEOUT' ? 'timeout' : 'failed';
      failedSteps.push({ step: step.step, tool: step.tool, code: err.code, message: err.message });

      if (persist && toolCallId) {
        agentRunRepo.finishToolCall(toolCallId, status, { errorMsg: err.message || '' });
      }

      emit?.toolResult?.({
        id: toolCallId || `step-${step.step}`,
        name: step.tool,
        status,
        errorMsg: err.message,
        stepIndex: step.step
      });

      // 关键步骤失败则终止整个计划；可选步骤失败则继续
      if (!step.optional) {
        return { scratchpad, results, failedSteps, aborted: true };
      }
    }
  }

  return { scratchpad, results, failedSteps, aborted: false };
}
