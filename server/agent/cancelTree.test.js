import { describe, it, expect, vi } from 'vitest';
import {
  CancelNode,
  CancelReason,
  CancelledError,
  createCancelRoot
} from './cancelTree.js';

describe('取消树基础结构', () => {
  it('根节点初始未取消', () => {
    const root = createCancelRoot('run-1');
    expect(root.isCancelled).toBe(false);
    expect(root.signal.aborted).toBe(false);
  });

  it('派生子节点后建立双向关系', () => {
    const root = createCancelRoot('run-1');
    const step = root.child('step-1');
    expect(step.parent).toBe(root);
    expect(root.children.has(step)).toBe(true);
  });

  it('size 统计整棵子树节点数', () => {
    const root = createCancelRoot('run-1');
    const s1 = root.child('step-1');
    const s2 = root.child('step-2');
    s1.child('tool-1');
    s1.child('tool-2');
    s2.child('tool-3');
    expect(root.size()).toBe(6); // root + 2 step + 3 tool
  });
});

describe('取消级联', () => {
  it('父节点取消时所有后代同时取消', () => {
    const root = createCancelRoot('run-1');
    const step = root.child('step-1');
    const tool1 = step.child('tool-1');
    const tool2 = step.child('tool-2');

    root.cancel(CancelReason.USER_ABORT, '用户点了停止');

    expect(root.isCancelled).toBe(true);
    expect(step.isCancelled).toBe(true);
    expect(tool1.isCancelled).toBe(true);
    expect(tool2.isCancelled).toBe(true);
  });

  it('子节点取消不影响父节点与兄弟节点', () => {
    const root = createCancelRoot('run-1');
    const step1 = root.child('step-1');
    const step2 = root.child('step-2');

    step1.cancel(CancelReason.TIMEOUT);

    expect(step1.isCancelled).toBe(true);
    expect(step2.isCancelled).toBe(false);
    expect(root.isCancelled).toBe(false);
  });

  it('级联时子节点原因标记为 parent_cancelled', () => {
    const root = createCancelRoot('run-1');
    const step = root.child('step-1');

    root.cancel(CancelReason.USER_ABORT, '停止按钮');

    expect(root.reason.code).toBe(CancelReason.USER_ABORT);
    expect(step.reason.code).toBe(CancelReason.PARENT_CANCELLED);
    expect(step.reason.detail).toBe('停止按钮');
  });

  it('取消原因里带上节点 id，便于定位', () => {
    const root = createCancelRoot('run-1');
    root.cancel(CancelReason.TIMEOUT, '30s 超时');
    expect(root.reason.nodeId).toBe('run-1');
  });

  it('重复取消是幂等的，保留首次原因', () => {
    const root = createCancelRoot('run-1');
    root.cancel(CancelReason.TIMEOUT, 'first');
    root.cancel(CancelReason.USER_ABORT, 'second');
    expect(root.reason.code).toBe(CancelReason.TIMEOUT);
    expect(root.reason.detail).toBe('first');
  });

  it('取消后新建的子节点直接继承取消状态', () => {
    const root = createCancelRoot('run-1');
    root.cancel(CancelReason.USER_ABORT, '已停止');
    const late = root.child('step-late');
    expect(late.isCancelled).toBe(true);
    expect(late.reason.code).toBe(CancelReason.PARENT_CANCELLED);
  });

  it('AbortSignal 能被 fetch 之类的 API 正常消费', async () => {
    const root = createCancelRoot('run-1');
    const tool = root.child('tool-1');

    const onAbort = vi.fn();
    tool.signal.addEventListener('abort', onAbort);

    root.cancel(CancelReason.USER_ABORT);

    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(tool.signal.reason.code).toBe(CancelReason.PARENT_CANCELLED);
  });
});

describe('泄漏防护', () => {
  it('detach 后从父节点摘除', () => {
    const root = createCancelRoot('run-1');
    const step = root.child('step-1');
    expect(root.size()).toBe(2);

    step.detach();

    expect(root.size()).toBe(1);
    expect(root.children.has(step)).toBe(false);
    expect(step.detached).toBe(true);
  });

  it('detach 后父节点取消不再影响该节点', () => {
    const root = createCancelRoot('run-1');
    const step = root.child('step-1');
    step.detach();

    root.cancel(CancelReason.USER_ABORT);

    expect(root.isCancelled).toBe(true);
    expect(step.isCancelled).toBe(false);
  });

  it('长会话下反复 detach 不会让 children 膨胀', () => {
    const root = createCancelRoot('run-1');
    for (let i = 0; i < 1000; i++) {
      const step = root.child(`step-${i}`);
      step.detach();
    }
    expect(root.children.size).toBe(0);
    expect(root.size()).toBe(1);
  });
});

describe('外部 signal 挂载', () => {
  it('外部 signal abort 时根节点级联取消', () => {
    const external = new AbortController();
    const root = createCancelRoot('run-1', external.signal);
    const tool = root.child('tool-1');

    external.abort();

    expect(root.isCancelled).toBe(true);
    expect(tool.isCancelled).toBe(true);
    expect(root.reason.code).toBe(CancelReason.USER_ABORT);
  });

  it('外部 signal 已经 abort 时立刻取消', () => {
    const external = new AbortController();
    external.abort();
    const root = createCancelRoot('run-1', external.signal);
    expect(root.isCancelled).toBe(true);
  });

  it('根节点自行取消后解绑外部监听，避免外部持有引用', () => {
    const external = new AbortController();
    const removeSpy = vi.spyOn(external.signal, 'removeEventListener');

    const root = createCancelRoot('run-1', external.signal);
    root.cancel(CancelReason.TIMEOUT);

    expect(removeSpy).toHaveBeenCalled();
  });
});

describe('throwIfCancelled', () => {
  it('未取消时不抛异常', () => {
    const root = createCancelRoot('run-1');
    expect(() => root.throwIfCancelled()).not.toThrow();
  });

  it('已取消时抛 CancelledError 并带原因', () => {
    const root = createCancelRoot('run-1');
    root.cancel(CancelReason.USER_ABORT, '用户停止');

    try {
      root.throwIfCancelled();
      expect.unreachable('应该抛异常');
    } catch (error) {
      expect(error).toBeInstanceOf(CancelledError);
      expect(error.code).toBe('CANCELLED');
      expect(error.reason.code).toBe(CancelReason.USER_ABORT);
      expect(error.message).toContain('用户停止');
    }
  });
});

describe('snapshot 快照', () => {
  it('导出完整子树结构', () => {
    const root = createCancelRoot('run-1');
    const step = root.child('step-1');
    step.child('tool-1');

    const snap = root.snapshot();
    expect(snap.id).toBe('run-1');
    expect(snap.children).toHaveLength(1);
    expect(snap.children[0].id).toBe('step-1');
    expect(snap.children[0].children[0].id).toBe('tool-1');
  });

  it('快照反映取消状态', () => {
    const root = createCancelRoot('run-1');
    root.child('step-1');
    root.cancel(CancelReason.USER_ABORT);

    const snap = root.snapshot();
    expect(snap.cancelled).toBe(true);
    expect(snap.children[0].cancelled).toBe(true);
  });
});

describe('并发场景', () => {
  it('取消能让并发中的 3 个 tool 全部立刻中断', async () => {
    const root = createCancelRoot('run-1');
    const step = root.child('step-1');

    /** 模拟一个可被 abort 的长任务 */
    function longTask(node, ms) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve('completed'), ms);
        node.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new CancelledError(node.reason));
          },
          { once: true }
        );
      });
    }

    const tasks = [
      longTask(step.child('tool-1'), 5000),
      longTask(step.child('tool-2'), 5000),
      longTask(step.child('tool-3'), 5000)
    ];

    // 立刻取消
    root.cancel(CancelReason.USER_ABORT, '用户停止');

    const results = await Promise.allSettled(tasks);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(results.every((r) => r.reason instanceof CancelledError)).toBe(true);
  });

  it('只取消其中一个 step 时，另一个 step 的 tool 继续运行', async () => {
    const root = createCancelRoot('run-1');
    const stepA = root.child('step-a');
    const stepB = root.child('step-b');

    function task(node, ms, value) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(value), ms);
        node.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new CancelledError(node.reason));
          },
          { once: true }
        );
      });
    }

    const promiseA = task(stepA.child('tool-a'), 5000, 'A');
    const promiseB = task(stepB.child('tool-b'), 10, 'B');

    stepA.cancel(CancelReason.TIMEOUT);

    const [resultA, resultB] = await Promise.allSettled([promiseA, promiseB]);
    expect(resultA.status).toBe('rejected');
    expect(resultB.status).toBe('fulfilled');
    expect(resultB.value).toBe('B');
  });
});

describe('CancelNode 直接构造', () => {
  it('无父节点时可独立使用', () => {
    const node = new CancelNode('standalone');
    expect(node.parent).toBeNull();
    expect(node.isCancelled).toBe(false);
    node.cancel(CancelReason.UPSTREAM_ERROR);
    expect(node.isCancelled).toBe(true);
  });
});
