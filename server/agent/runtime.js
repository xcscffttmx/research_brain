import { createCancelRoot, CancelReason, CancelledError } from './cancelTree.js';
import { createPlan, createDirectAnswerPlan } from './planner.js';
import { executePlan } from './executor.js';
import * as agentRunRepo from '../repositories/agentRunRepo.js';

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
const activeRuns = new Map();

/** 按 runId 取消一次运行（HTTP 层的 /api/chat/abort 用） */
export function abortRun(runId, reason = CancelReason.USER_ABORT, detail = '用户主动停止') {
  const node = activeRuns.get(runId);
  if (!node) return false;
  node.cancel(reason, detail);
  return true;
}

/** 当前活跃 run 数（健康检查/泄漏排查用） */
export function getActiveRunCount() {
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
}) {
  const { qwenFetch, callTool, generateAnswer } = deps;

  let run = null;
  let cancelRoot = null;

  try {
    // ---------- 1. 建立 run 与取消树 ----------
    if (persist) {
      run = agentRunRepo.startRun({ sessionId, messageId: assistantMessageId });
    } else {
      run = { id: `run-local-${Date.now()}` };
    }

    cancelRoot = createCancelRoot(run.id, externalSignal);
    activeRuns.set(run.id, cancelRoot);

    emit?.status?.('run_started', { runId: run.id });

    // ---------- 2. 规划 ----------
    emit?.status?.('planning', {});
    const planNode = cancelRoot.child('planner');

    let plan;
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
    let execution = { scratchpad: {}, results: [], failedSteps: [], aborted: false };

    if (plan.needsTools && plan.steps.length) {
      emit?.status?.('executing', { totalSteps: plan.steps.length });
      execution = await executePlan({
        plan,
        runId: run.id,
        cancelNode: cancelRoot,
        callTool,
        emit,
        persist
      });
    }

    cancelRoot.throwIfCancelled();

    // ---------- 4. 生成答案（流式） ----------
    emit?.status?.('generating', {});
    const answerNode = cancelRoot.child('generator');

    let answer = '';
    try {
      answer = await generateAnswer(
        {
          question,
          contextHint,
          plan,
          toolResults: execution.results,
          failedSteps: execution.failedSteps,
          scratchpad: execution.scratchpad
        },
        answerNode.signal,
        (delta) => emit?.delta?.(delta)
      );
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
      toolResults: execution.results,
      failedSteps: execution.failedSteps,
      partial: execution.aborted
    };
  } catch (error) {
    // 取消树已 abort 时，即使底层抛的是 fetch 的 AbortError，也应记为 cancelled
    const cancelled = isCancellation(error) || Boolean(cancelRoot?.isCancelled);
    const status = cancelled ? 'cancelled' : 'failed';

    if (persist && run) {
      agentRunRepo.finishRun(run.id, status, {
        errorCode: error?.code || (cancelled ? 'CANCELLED' : 'UNKNOWN'),
        errorMsg: error?.message || ''
      });
    }

    if (cancelled) {
      emit?.status?.('cancelled', {
        runId: run?.id,
        reason: error?.reason?.code || cancelRoot?.reason?.code
      });
    } else {
      emit?.error?.({
        code: error?.code || 'AGENT_RUN_FAILED',
        message: error?.message || 'Agent 执行失败',
        details: error?.details || ''
      });
    }

    return {
      runId: run?.id,
      status,
      error: { code: error?.code, message: error?.message },
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

function isCancellation(error) {
  return error instanceof CancelledError || error?.code === 'CANCELLED';
}
