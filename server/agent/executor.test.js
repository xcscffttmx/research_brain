import { describe, it, expect, vi } from 'vitest';
import { createCancelRoot, CancelReason, CancelledError } from './cancelTree.js';
import { executePlan, resolveArgs, readPath, matchStopCondition, evaluateStopConditions } from './executor.js';
import { createAppError } from '../lib/errors.js';

// ---------- 参数插值与结果回填 ----------

describe('readPath', () => {
  it('读取一层属性', () => {
    expect(readPath({ a: 1 }, 'a')).toBe(1);
  });

  it('读取嵌套属性', () => {
    expect(readPath({ a: { b: { c: 'deep' } } }, 'a.b.c')).toBe('deep');
  });

  it('支持数组下标', () => {
    expect(readPath({ list: [{ id: 'x' }, { id: 'y' }] }, 'list[1].id')).toBe('y');
  });

  it('路径不存在时返回 undefined 而不报错', () => {
    expect(readPath({ a: 1 }, 'a.b.c')).toBeUndefined();
  });
});

describe('resolveArgs 结果回填', () => {
  const scratchpad = {
    step1: { papers: [{ paperId: 'p1' }, { paperId: 'p2' }], count: 2 },
    search_literature: { query: 'ViT' }
  };

  it('整体替换时保留原始类型', () => {
    const out = resolveArgs({ ids: '{{step1.papers}}' }, scratchpad);
    expect(out.ids).toEqual([{ paperId: 'p1' }, { paperId: 'p2' }]);
  });

  it('数字类型不被转成字符串', () => {
    const out = resolveArgs({ limit: '{{step1.count}}' }, scratchpad);
    expect(out.limit).toBe(2);
  });

  it('内联插值拼接成字符串', () => {
    const out = resolveArgs({ q: '关于 {{search_literature.query}} 的综述' }, scratchpad);
    expect(out.q).toBe('关于 ViT 的综述');
  });

  it('引用不存在的路径时内联插值降级为空串', () => {
    const out = resolveArgs({ q: 'x{{step9.nothing}}y' }, scratchpad);
    expect(out.q).toBe('xy');
  });

  it('递归处理嵌套对象与数组', () => {
    const out = resolveArgs({ nested: { arr: ['{{step1.count}}', 'literal'] } }, scratchpad);
    expect(out.nested.arr).toEqual([2, 'literal']);
  });

  it('非模板值原样返回', () => {
    expect(resolveArgs({ a: 1, b: true, c: null }, scratchpad)).toEqual({ a: 1, b: true, c: null });
  });
});

// ---------- 计划执行 ----------

function makePlan(steps, stopConditions = []) {
  return { needsTools: true, intent: 'test', steps, stopWhen: 'done', stopConditions };
}

describe('executePlan 正常流程', () => {
  it('顺序执行所有步骤', async () => {
    const root = createCancelRoot('run');
    const order = [];
    const callTool = vi.fn(async (name) => {
      order.push(name);
      return { ok: name };
    });

    const plan = makePlan([
      { step: 1, tool: 'retrieve_knowledge', args: { query: 'a' }, reason: 'r1', optional: false },
      { step: 2, tool: 'search_literature', args: { query: 'b' }, reason: 'r2', optional: false }
    ]);

    const out = await executePlan({ plan, runId: 'run', cancelNode: root, callTool, persist: false });

    expect(order).toEqual(['retrieve_knowledge', 'search_literature']);
    expect(out.aborted).toBe(false);
    expect(out.results).toHaveLength(2);
  });

  it('前一步结果可被后一步引用', async () => {
    const root = createCancelRoot('run');
    const seen = [];
    const callTool = async (name, args) => {
      seen.push({ name, args });
      if (name === 'search_literature') return { papers: [{ paperId: 'p1' }, { paperId: 'p2' }] };
      return { summarized: true };
    };

    const plan = makePlan([
      { step: 1, tool: 'search_literature', args: { query: 'x' }, reason: 'r1', optional: false },
      { step: 2, tool: 'summarize_literature', args: { paperIds: '{{step1.papers}}' }, reason: 'r2', optional: false }
    ]);

    await executePlan({ plan, runId: 'run', cancelNode: root, callTool, persist: false });

    expect(seen[1].args.paperIds).toEqual([{ paperId: 'p1' }, { paperId: 'p2' }]);
  });

  it('scratchpad 同时按 stepN 和工具名索引', async () => {
    const root = createCancelRoot('run');
    const callTool = async () => ({ value: 42 });
    const plan = makePlan([{ step: 1, tool: 'get_current_time', args: {}, reason: 'r', optional: false }]);

    const out = await executePlan({ plan, runId: 'run', cancelNode: root, callTool, persist: false });

    expect(out.scratchpad.step1).toEqual({ value: 42 });
    expect(out.scratchpad.get_current_time).toEqual({ value: 42 });
  });

  it('空计划直接返回', async () => {
    const root = createCancelRoot('run');
    const callTool = vi.fn();
    const out = await executePlan({
      plan: makePlan([]),
      runId: 'run',
      cancelNode: root,
      callTool,
      persist: false
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(out.results).toHaveLength(0);
  });
});

describe('executePlan 失败处理', () => {
  it('关键步骤失败时终止后续步骤', async () => {
    const root = createCancelRoot('run');
    const callTool = vi.fn(async (name) => {
      if (name === 'retrieve_knowledge') throw createAppError('INVALID_API_KEY', '挂了');
      return { ok: true };
    });

    const plan = makePlan([
      { step: 1, tool: 'retrieve_knowledge', args: {}, reason: 'r1', optional: false },
      { step: 2, tool: 'search_literature', args: {}, reason: 'r2', optional: false }
    ]);

    const out = await executePlan({ plan, runId: 'run', cancelNode: root, callTool, persist: false });

    expect(out.aborted).toBe(true);
    expect(out.failedSteps).toHaveLength(1);
    expect(callTool).toHaveBeenCalledTimes(1); // 第二步没执行
  });

  it('可选步骤失败时继续执行后续步骤', async () => {
    const root = createCancelRoot('run');
    const called = [];
    const callTool = async (name) => {
      called.push(name);
      if (name === 'retrieve_knowledge') throw createAppError('INVALID_API_KEY', '知识库空');
      return { ok: true };
    };

    const plan = makePlan([
      { step: 1, tool: 'retrieve_knowledge', args: {}, reason: 'r1', optional: true },
      { step: 2, tool: 'search_literature', args: {}, reason: 'r2', optional: false }
    ]);

    const out = await executePlan({ plan, runId: 'run', cancelNode: root, callTool, persist: false });

    expect(out.aborted).toBe(false);
    expect(called).toEqual(['retrieve_knowledge', 'search_literature']);
    expect(out.failedSteps).toHaveLength(1);
    expect(out.results).toHaveLength(1);
  });

  it('超时被标记为 timeout 状态', async () => {
    const root = createCancelRoot('run');
    const callTool = (name, args, signal) =>
      new Promise(() => {
        signal.addEventListener('abort', () => {}, { once: true });
      });

    const emitted = [];
    const emit = { toolResult: (p) => emitted.push(p), toolCall: () => {}, status: () => {} };

    const plan = makePlan([{ step: 1, tool: 'retrieve_knowledge', args: {}, reason: 'r', optional: true }]);

    const out = await executePlan({
      plan,
      runId: 'run',
      cancelNode: root,
      callTool,
      emit,
      persist: false,
      timeoutMs: 30,
      policy: { retries: 0 }
    });

    expect(out.failedSteps).toHaveLength(1);
    expect(out.failedSteps[0].code).toBe('TOOL_TIMEOUT');
    expect(emitted.some((e) => e.status === 'timeout')).toBe(true);
  });

  it('超时后可选步骤不阻塞后续步骤', async () => {
    const root = createCancelRoot('run');
    const completed = [];
    const callTool = (name, args, signal) => {
      if (name === 'retrieve_knowledge') {
        return new Promise(() => {
          signal.addEventListener('abort', () => {}, { once: true });
        });
      }
      completed.push(name);
      return Promise.resolve({ ok: true });
    };

    const plan = makePlan([
      { step: 1, tool: 'retrieve_knowledge', args: {}, reason: 'r1', optional: true },
      { step: 2, tool: 'search_literature', args: {}, reason: 'r2', optional: false }
    ]);

    const out = await executePlan({
      plan,
      runId: 'run',
      cancelNode: root,
      callTool,
      persist: false,
      timeoutMs: 30,
      policy: { retries: 0 }
    });

    expect(completed).toEqual(['search_literature']);
    expect(out.aborted).toBe(false);
  });
});

describe('executePlan 取消联动', () => {
  it('执行中被取消时抛 CancelledError', async () => {
    const root = createCancelRoot('run');
    const callTool = (name, args, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new CancelledError({ code: 'x' })), { once: true });
      });

    const plan = makePlan([{ step: 1, tool: 'retrieve_knowledge', args: {}, reason: 'r', optional: false }]);

    const promise = executePlan({ plan, runId: 'run', cancelNode: root, callTool, persist: false });
    await new Promise((r) => setTimeout(r, 20));
    root.cancel(CancelReason.USER_ABORT, '用户停止');

    await expect(promise).rejects.toBeInstanceOf(CancelledError);
  });

  it('取消不会被 optional 吞掉', async () => {
    const root = createCancelRoot('run');
    const callTool = (name, args, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new CancelledError({ code: 'x' })), { once: true });
      });

    const plan = makePlan([{ step: 1, tool: 'retrieve_knowledge', args: {}, reason: 'r', optional: true }]);

    const promise = executePlan({ plan, runId: 'run', cancelNode: root, callTool, persist: false });
    await new Promise((r) => setTimeout(r, 20));
    root.cancel(CancelReason.USER_ABORT);

    await expect(promise).rejects.toBeInstanceOf(CancelledError);
  });

  it('已取消的节点不执行任何步骤', async () => {
    const root = createCancelRoot('run');
    root.cancel(CancelReason.USER_ABORT);
    const callTool = vi.fn();

    const plan = makePlan([{ step: 1, tool: 'retrieve_knowledge', args: {}, reason: 'r', optional: false }]);

    await expect(
      executePlan({ plan, runId: 'run', cancelNode: root, callTool, persist: false })
    ).rejects.toBeInstanceOf(CancelledError);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('执行完成后不留残余取消节点', async () => {
    const root = createCancelRoot('run');
    const callTool = async () => ({ ok: true });
    const plan = makePlan([
      { step: 1, tool: 'retrieve_knowledge', args: {}, reason: 'r1', optional: false },
      { step: 2, tool: 'search_literature', args: {}, reason: 'r2', optional: false }
    ]);

    await executePlan({ plan, runId: 'run', cancelNode: root, callTool, persist: false });

    expect(root.children.size).toBe(0);
  });
});

describe('executePlan 事件发射', () => {
  it('每步都发出 tool_call 与 tool_result', async () => {
    const root = createCancelRoot('run');
    const calls = [];
    const resultsEmitted = [];
    const emit = {
      toolCall: (p) => calls.push(p),
      toolResult: (p) => resultsEmitted.push(p),
      status: () => {}
    };

    const plan = makePlan([
      { step: 1, tool: 'retrieve_knowledge', args: { query: 'q' }, reason: '查知识库', optional: false }
    ]);

    await executePlan({
      plan,
      runId: 'run',
      cancelNode: root,
      callTool: async () => ({ hits: 3 }),
      emit,
      persist: false
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].reason).toBe('查知识库');
    expect(calls[0].stepIndex).toBe(1);
    expect(resultsEmitted[0].status).toBe('succeeded');
    expect(resultsEmitted[0].result).toEqual({ hits: 3 });
  });

  it('重试时发出 tool_retry 状态事件', async () => {
    const root = createCancelRoot('run');
    const statuses = [];
    const emit = { toolCall: () => {}, toolResult: () => {}, status: (s, d) => statuses.push({ s, d }) };

    let calls = 0;
    const callTool = async () => {
      calls++;
      if (calls < 2) throw createAppError('RATE_LIMITED', '限流');
      return { ok: true };
    };

    const plan = makePlan([{ step: 1, tool: 'retrieve_knowledge', args: {}, reason: 'r', optional: false }]);

    await executePlan({ plan, runId: 'run', cancelNode: root, callTool, emit, persist: false });

    const retryEvent = statuses.find((x) => x.s === 'tool_retry');
    expect(retryEvent).toBeTruthy();
    expect(retryEvent.d.errorCode).toBe('RATE_LIMITED');
  });
});

// ---------- 终止条件 ----------

describe('matchStopCondition', () => {
  const scratchpad = { step1: { count: 3, citations: ['a', 'b'], title: '  ', done: true, empty: [] } };

  it('exists 只看有没有值', () => {
    expect(matchStopCondition({ path: 'step1.count', op: 'exists' }, scratchpad)).toBe(true);
    expect(matchStopCondition({ path: 'step1.missing', op: 'exists' }, scratchpad)).toBe(false);
  });

  it('nonEmpty 对数组/字符串/对象分别判空', () => {
    expect(matchStopCondition({ path: 'step1.citations', op: 'nonEmpty' }, scratchpad)).toBe(true);
    expect(matchStopCondition({ path: 'step1.empty', op: 'nonEmpty' }, scratchpad)).toBe(false);
    // 纯空白字符串按空处理
    expect(matchStopCondition({ path: 'step1.title', op: 'nonEmpty' }, scratchpad)).toBe(false);
  });

  it('gte/gt 支持数组取长度比较', () => {
    expect(matchStopCondition({ path: 'step1.count', op: 'gte', value: 3 }, scratchpad)).toBe(true);
    expect(matchStopCondition({ path: 'step1.count', op: 'gt', value: 3 }, scratchpad)).toBe(false);
    expect(matchStopCondition({ path: 'step1.citations', op: 'gte', value: 2 }, scratchpad)).toBe(true);
  });

  it('eq 严格相等，路径不存在时不命中', () => {
    expect(matchStopCondition({ path: 'step1.done', op: 'eq', value: true }, scratchpad)).toBe(true);
    expect(matchStopCondition({ path: 'step1.missing', op: 'eq', value: true }, scratchpad)).toBe(false);
  });
});

describe('evaluateStopConditions', () => {
  const scratchpad = { step1: { count: 5 } };

  it('afterStep 只在指定步之后生效', () => {
    const conditions = [{ afterStep: 2, path: 'step1.count', op: 'gte', value: 1 }];
    expect(evaluateStopConditions(conditions, scratchpad, 1)).toBeNull();
    expect(evaluateStopConditions(conditions, scratchpad, 2)).toEqual(conditions[0]);
  });

  it('afterStep 缺省表示每步都检查', () => {
    const conditions = [{ path: 'step1.count', op: 'gte', value: 5 }];
    expect(evaluateStopConditions(conditions, scratchpad, 1)).toEqual(conditions[0]);
  });

  it('没有条件时返回 null', () => {
    expect(evaluateStopConditions([], scratchpad, 1)).toBeNull();
    expect(evaluateStopConditions(undefined, scratchpad, 1)).toBeNull();
  });
});

describe('executePlan 提前结束', () => {
  const twoSteps = [
    { step: 1, tool: 'retrieve_knowledge', args: {}, reason: 'r1', optional: false },
    { step: 2, tool: 'search_literature', args: {}, reason: 'r2', optional: false }
  ];

  it('命中条件时跳过剩余步骤并上报 status', async () => {
    const root = createCancelRoot('run');
    const callTool = vi.fn(async () => ({ count: 4 }));
    const statuses = [];
    const emit = { toolCall: () => {}, toolResult: () => {}, status: (s, d) => statuses.push({ s, d }) };
    const plan = makePlan(twoSteps, [{ afterStep: 1, path: 'step1.count', op: 'gte', value: 3 }]);

    const out = await executePlan({ plan, runId: 'run', cancelNode: root, callTool, emit, persist: false });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(out.results).toHaveLength(1);
    expect(out.aborted).toBe(false);
    expect(out.stoppedEarly).toEqual({
      afterStep: 1,
      condition: plan.stopConditions[0],
      skippedSteps: [2]
    });
    expect(statuses.find((x) => x.s === 'plan_stopped_early').d.skippedSteps).toEqual([2]);
  });

  it('条件未满足时照常走完所有步骤', async () => {
    const root = createCancelRoot('run');
    const callTool = vi.fn(async () => ({ count: 1 }));
    const plan = makePlan(twoSteps, [{ afterStep: 1, path: 'step1.count', op: 'gte', value: 3 }]);

    const out = await executePlan({ plan, runId: 'run', cancelNode: root, callTool, persist: false });

    expect(callTool).toHaveBeenCalledTimes(2);
    expect(out.stoppedEarly).toBeNull();
  });

  it('最后一步命中不算提前结束（没有步骤可跳过）', async () => {
    const root = createCancelRoot('run');
    const callTool = vi.fn(async () => ({ count: 9 }));
    const plan = makePlan([twoSteps[0]], [{ path: 'step1.count', op: 'gte', value: 1 }]);

    const out = await executePlan({ plan, runId: 'run', cancelNode: root, callTool, persist: false });

    expect(out.stoppedEarly).toBeNull();
    expect(out.results).toHaveLength(1);
  });
});
