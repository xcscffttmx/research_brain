import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgentTurn, abortRun, getActiveRunCount } from './runtime.js';
import { CancelReason, CancelledError } from './cancelTree.js';
import { createAppError } from '../lib/errors.js';

/** 收集 SSE 事件的假 writer */
function makeEmitter() {
  const events = [];
  return {
    events,
    delta: (text) => events.push({ type: 'delta', text }),
    toolCall: (p) => events.push({ type: 'tool_call', ...p }),
    toolResult: (p) => events.push({ type: 'tool_result', ...p }),
    status: (stage, detail) => events.push({ type: 'status', stage, detail }),
    error: (p) => events.push({ type: 'error', ...p }),
    send: (event, p) => events.push({ type: event, ...p }),
    done: (p) => events.push({ type: 'done', ...p })
  };
}

function planResponse(plan) {
  return vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(plan) } }] }));
}

const noToolPlan = { needsTools: false, intent: '直接答', steps: [], stopWhen: 'x' };

const twoStepPlan = {
  needsTools: true,
  intent: '查资料',
  steps: [
    { step: 1, tool: 'retrieve_knowledge', args: { query: 'a' }, reason: '查知识库' },
    { step: 2, tool: 'search_literature', args: { query: 'b' }, reason: '查文献' }
  ],
  stopWhen: '都查完'
};

describe('runAgentTurn 基础流程', () => {
  it('无工具场景：规划 -> 生成', async () => {
    const emit = makeEmitter();
    const generateAnswer = vi.fn(async (ctx, signal, onDelta) => {
      onDelta('你好');
      onDelta('！');
      return '你好！';
    });

    const result = await runAgentTurn({
      sessionId: 's1',
      question: '你好',
      emit,
      persist: false,
      deps: { qwenFetch: planResponse(noToolPlan), callTool: vi.fn(), generateAnswer }
    });

    expect(result.status).toBe('succeeded');
    expect(result.answer).toBe('你好！');

    const stages = emit.events.filter((e) => e.type === 'status').map((e) => e.stage);
    expect(stages).toEqual(['run_started', 'planning', 'generating']);
    expect(emit.events.filter((e) => e.type === 'delta')).toHaveLength(2);
  });

  it('有工具场景：规划 -> 执行 -> 生成', async () => {
    const emit = makeEmitter();
    const callTool = vi.fn(async (name) => ({ from: name }));
    const generateAnswer = async () => '综合回答';

    const result = await runAgentTurn({
      sessionId: 's1',
      question: '遥感分割进展',
      emit,
      persist: false,
      deps: { qwenFetch: planResponse(twoStepPlan), callTool, generateAnswer }
    });

    expect(result.status).toBe('succeeded');
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(result.toolResults).toHaveLength(2);

    const stages = emit.events.filter((e) => e.type === 'status').map((e) => e.stage);
    expect(stages).toEqual(['run_started', 'planning', 'executing', 'generating']);
  });

  it('把计划通过 plan 事件推给前端', async () => {
    const emit = makeEmitter();
    await runAgentTurn({
      sessionId: 's1',
      question: 'q',
      emit,
      persist: false,
      deps: {
        qwenFetch: planResponse(twoStepPlan),
        callTool: async () => ({}),
        generateAnswer: async () => 'a'
      }
    });

    const planEvent = emit.events.find((e) => e.type === 'plan');
    expect(planEvent).toBeTruthy();
    expect(planEvent.steps).toHaveLength(2);
    expect(planEvent.intent).toBe('查资料');
  });

  it('工具结果被带进生成阶段的上下文', async () => {
    const captured = [];
    const generateAnswer = async (ctx) => {
      captured.push(ctx);
      return 'answer';
    };

    await runAgentTurn({
      sessionId: 's1',
      question: 'q',
      contextHint: '历史摘要',
      emit: makeEmitter(),
      persist: false,
      deps: {
        qwenFetch: planResponse(twoStepPlan),
        callTool: async (name) => ({ payload: name }),
        generateAnswer
      }
    });

    const ctx = captured[0];
    expect(ctx.question).toBe('q');
    expect(ctx.contextHint).toBe('历史摘要');
    expect(ctx.toolResults).toHaveLength(2);
    expect(ctx.scratchpad.step1).toEqual({ payload: 'retrieve_knowledge' });
    expect(ctx.plan.steps).toHaveLength(2);
  });
});

describe('runAgentTurn 降级与容错', () => {
  it('Planner 抛异常时降级为直接回答，不中断整轮', async () => {
    const emit = makeEmitter();
    const qwenFetch = vi.fn(async () => {
      throw createAppError('QWEN_HTTP_ERROR', '模型挂了');
    });

    const result = await runAgentTurn({
      sessionId: 's1',
      question: 'q',
      emit,
      persist: false,
      deps: { qwenFetch, callTool: vi.fn(), generateAnswer: async () => '降级答案' }
    });

    expect(result.status).toBe('succeeded');
    expect(result.answer).toBe('降级答案');
    expect(result.plan.needsTools).toBe(false);
    expect(result.plan.intent).toContain('降级');
  });

  it('关键步骤失败时仍尝试生成答案并标记 partial', async () => {
    const callTool = vi.fn(async (name) => {
      if (name === 'retrieve_knowledge') throw createAppError('INVALID_API_KEY', '失败');
      return {};
    });

    const result = await runAgentTurn({
      sessionId: 's1',
      question: 'q',
      emit: makeEmitter(),
      persist: false,
      deps: { qwenFetch: planResponse(twoStepPlan), callTool, generateAnswer: async () => '部分答案' }
    });

    expect(result.status).toBe('succeeded');
    expect(result.partial).toBe(true);
    expect(result.failedSteps).toHaveLength(1);
  });

  it('生成阶段抛异常时返回 failed 并发 error 事件', async () => {
    const emit = makeEmitter();
    const result = await runAgentTurn({
      sessionId: 's1',
      question: 'q',
      emit,
      persist: false,
      deps: {
        qwenFetch: planResponse(noToolPlan),
        callTool: vi.fn(),
        generateAnswer: async () => {
          throw createAppError('QWEN_HTTP_ERROR', '生成失败');
        }
      }
    });

    expect(result.status).toBe('failed');
    expect(result.error.code).toBe('QWEN_HTTP_ERROR');
    expect(emit.events.some((e) => e.type === 'error')).toBe(true);
  });
  it('生成阶段抛 AbortError 且已取消时记为 cancelled', async () => {
    const controller = new AbortController();
    const emit = makeEmitter();

    const result = await runAgentTurn({
      sessionId: 's1',
      question: 'q',
      emit,
      externalSignal: controller.signal,
      persist: false,
      deps: {
        qwenFetch: planResponse(noToolPlan),
        callTool: vi.fn(),
        generateAnswer: async () => {
          // 模拟 fetch 被 abort：错误 name 是 AbortError，没有 code
          controller.abort();
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          throw error;
        }
      }
    });

    expect(result.status).toBe('cancelled');
    expect(emit.events.some((e) => e.type === 'status' && e.stage === 'cancelled')).toBe(true);
  });
});

describe('runAgentTurn 取消', () => {
  it('外部 signal abort 时返回 cancelled', async () => {
    const controller = new AbortController();
    const emit = makeEmitter();

    const promise = runAgentTurn({
      sessionId: 's1',
      question: 'q',
      emit,
      externalSignal: controller.signal,
      persist: false,
      deps: {
        qwenFetch: planResponse(twoStepPlan),
        callTool: (name, args, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new CancelledError({ code: 'x' })), { once: true });
          }),
        generateAnswer: async () => 'never'
      }
    });

    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    const result = await promise;
    expect(result.status).toBe('cancelled');
    expect(emit.events.some((e) => e.type === 'status' && e.stage === 'cancelled')).toBe(true);
  });

  it('abortRun 能按 runId 精确取消', async () => {
    const emit = makeEmitter();
    let capturedRunId = null;

    const promise = runAgentTurn({
      sessionId: 's1',
      question: 'q',
      emit,
      persist: false,
      deps: {
        qwenFetch: planResponse(twoStepPlan),
        callTool: (name, args, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new CancelledError({ code: 'x' })), { once: true });
          }),
        generateAnswer: async () => 'never'
      }
    });

    // 等 run_started 事件拿到 runId
    await new Promise((r) => setTimeout(r, 20));
    capturedRunId = emit.events.find((e) => e.stage === 'run_started')?.detail?.runId;
    expect(capturedRunId).toBeTruthy();

    expect(abortRun(capturedRunId)).toBe(true);

    const result = await promise;
    expect(result.status).toBe('cancelled');
  });

  it('abortRun 对不存在的 runId 返回 false', () => {
    expect(abortRun('nonexistent-run')).toBe(false);
  });

  it('run 结束后从活跃表移除，不泄漏', async () => {
    const before = getActiveRunCount();
    await runAgentTurn({
      sessionId: 's1',
      question: 'q',
      emit: makeEmitter(),
      persist: false,
      deps: {
        qwenFetch: planResponse(noToolPlan),
        callTool: vi.fn(),
        generateAnswer: async () => 'a'
      }
    });
    expect(getActiveRunCount()).toBe(before);
  });

  it('失败路径也会从活跃表移除', async () => {
    const before = getActiveRunCount();
    await runAgentTurn({
      sessionId: 's1',
      question: 'q',
      emit: makeEmitter(),
      persist: false,
      deps: {
        qwenFetch: planResponse(noToolPlan),
        callTool: vi.fn(),
        generateAnswer: async () => {
          throw new Error('boom');
        }
      }
    });
    expect(getActiveRunCount()).toBe(before);
  });

  it('取消时生成阶段的 signal 也被 abort', async () => {
    const controller = new AbortController();
    let generatorSignal = null;

    const promise = runAgentTurn({
      sessionId: 's1',
      question: 'q',
      emit: makeEmitter(),
      externalSignal: controller.signal,
      persist: false,
      deps: {
        qwenFetch: planResponse(noToolPlan),
        callTool: vi.fn(),
        generateAnswer: (ctx, signal) =>
          new Promise((_, reject) => {
            generatorSignal = signal;
            signal.addEventListener('abort', () => reject(new CancelledError({ code: 'x' })), { once: true });
          })
      }
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(generatorSignal?.aborted).toBe(false);
    controller.abort();

    const result = await promise;
    expect(result.status).toBe('cancelled');
    expect(generatorSignal.aborted).toBe(true);
  });
});
