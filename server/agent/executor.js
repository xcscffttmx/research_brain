import { CancelledError } from './cancelTree.js';
import { runWithPolicy } from './policy.js';
import * as agentRunRepo from '../repositories/agentRunRepo.js';

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
export function resolveArgs(args, scratchpad) {
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
    const out = {};
    for (const [key, value] of Object.entries(args)) {
      out[key] = resolveArgs(value, scratchpad);
    }
    return out;
  }

  return args;
}

/** 按 a.b[0].c 形式读取嵌套值 */
export function readPath(source, path) {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);

  let current = source;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
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
}) {
  const scratchpad = {};
  const results = [];
  const failedSteps = [];

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
        args: resolvedArgs
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
      const { result, attempts, durationMs } = await runWithPolicy({
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
    } catch (error) {
      stepNode.detach();

      // 取消要立刻向上传播，不能被 optional 吞掉
      if (error instanceof CancelledError || error?.code === 'CANCELLED') {
        if (persist && toolCallId) {
          agentRunRepo.finishToolCall(toolCallId, 'cancelled', { errorMsg: error.message });
        }
        emit?.toolResult?.({
          id: toolCallId || `step-${step.step}`,
          name: step.tool,
          status: 'cancelled',
          stepIndex: step.step
        });
        throw error;
      }

      const status = error?.code === 'TOOL_TIMEOUT' ? 'timeout' : 'failed';
      failedSteps.push({ step: step.step, tool: step.tool, code: error?.code, message: error?.message });

      if (persist && toolCallId) {
        agentRunRepo.finishToolCall(toolCallId, status, { errorMsg: error?.message || '' });
      }

      emit?.toolResult?.({
        id: toolCallId || `step-${step.step}`,
        name: step.tool,
        status,
        errorMsg: error?.message,
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
