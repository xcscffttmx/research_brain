import { describe, it, expect, vi } from 'vitest';
import { createCancelRoot, CancelReason, CancelledError } from './cancelTree.js';
import {
  runWithPolicy,
  withTimeout,
  isRetryableError,
  computeBackoff,
  TOOL_TIMEOUTS
} from './policy.js';
import { createAppError } from '../lib/errors.js';

describe('isRetryableError', () => {
  it('超时与限流可重试', () => {
    expect(isRetryableError(createAppError('UPSTREAM_TIMEOUT', 'x'))).toBe(true);
    expect(isRetryableError(createAppError('RATE_LIMITED', 'x'))).toBe(true);
    expect(isRetryableError(createAppError('TOOL_TIMEOUT', 'x'))).toBe(true);
  });

  it('上游各数据源失败可重试', () => {
    expect(isRetryableError(createAppError('ARXIV_FETCH_FAILED', 'x'))).toBe(true);
    expect(isRetryableError(createAppError('OPENALEX_FETCH_FAILED', 'x'))).toBe(true);
  });

  it('鉴权与参数错误不重试', () => {
    expect(isRetryableError(createAppError('INVALID_API_KEY', 'x'))).toBe(false);
    expect(isRetryableError(createAppError('PAPER_NOT_FOUND', 'x'))).toBe(false);
    expect(isRetryableError(createAppError('GAP_DATA_INSUFFICIENT', 'x'))).toBe(false);
  });

  it('取消不重试', () => {
    expect(isRetryableError(new CancelledError({ code: CancelReason.USER_ABORT }))).toBe(false);
  });

  it('5xx 兜底判定为可重试', () => {
    expect(isRetryableError(createAppError('UNKNOWN_X', 'x', '', 503))).toBe(true);
  });

  it('4xx 不重试', () => {
    expect(isRetryableError(createAppError('UNKNOWN_Y', 'x', '', 400))).toBe(false);
  });
});

describe('computeBackoff', () => {
  const policy = { baseDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 };

  it('按 2 的幂次增长', () => {
    expect(computeBackoff(0, policy)).toBe(100);
    expect(computeBackoff(1, policy)).toBe(200);
    expect(computeBackoff(2, policy)).toBe(400);
  });

  it('不超过上限', () => {
    expect(computeBackoff(10, policy)).toBe(1000);
  });

  it('jitter 让延迟落在预期区间内', () => {
    const withJitter = { baseDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0.3 };
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoff(1, withJitter);
      expect(delay).toBeGreaterThanOrEqual(200);
      expect(delay).toBeLessThanOrEqual(260);
    }
  });
});

describe('withTimeout', () => {
  it('任务在超时前完成则正常返回', async () => {
    const root = createCancelRoot('run');
    const node = root.child('t');
    const result = await withTimeout(async () => 'ok', 1000, node);
    expect(result).toBe('ok');
  });

  it('超时抛 TOOL_TIMEOUT 并取消节点', async () => {
    const root = createCancelRoot('run');
    const node = root.child('t');

    await expect(
      withTimeout(() => new Promise(() => {}), 30, node)
    ).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' });

    expect(node.isCancelled).toBe(true);
    expect(node.reason.code).toBe(CancelReason.TIMEOUT);
  });

  it('超时时任务能收到 abort 信号做清理', async () => {
    const root = createCancelRoot('run');
    const node = root.child('t');
    const cleanup = vi.fn();

    const task = (signal) =>
      new Promise(() => {
        signal.addEventListener('abort', cleanup, { once: true });
      });

    await expect(withTimeout(task, 30, node)).rejects.toThrow();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('runWithPolicy 重试行为', () => {
  it('首次成功不重试', async () => {
    const root = createCancelRoot('run');
    const task = vi.fn(async () => 'value');

    const out = await runWithPolicy({ toolName: 'search_knowledge', task, parentNode: root });

    expect(out.result).toBe('value');
    expect(out.attempts).toBe(1);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('可重试错误会重试到成功', async () => {
    const root = createCancelRoot('run');
    let calls = 0;
    const task = vi.fn(async () => {
      calls++;
      if (calls < 3) throw createAppError('RATE_LIMITED', '限流');
      return 'finally ok';
    });

    const out = await runWithPolicy({
      toolName: 'search_knowledge',
      task,
      parentNode: root,
      policy: { retries: 3, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 }
    });

    expect(out.result).toBe('finally ok');
    expect(out.attempts).toBe(3);
  });

  it('不可重试错误立刻抛出', async () => {
    const root = createCancelRoot('run');
    const task = vi.fn(async () => {
      throw createAppError('INVALID_API_KEY', 'key 无效');
    });

    await expect(
      runWithPolicy({ toolName: 'search_knowledge', task, parentNode: root })
    ).rejects.toMatchObject({ code: 'INVALID_API_KEY' });

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('重试次数耗尽后抛最后一次的错误', async () => {
    const root = createCancelRoot('run');
    const task = vi.fn(async () => {
      throw createAppError('RATE_LIMITED', '一直限流');
    });

    await expect(
      runWithPolicy({
        toolName: 'search_knowledge',
        task,
        parentNode: root,
        policy: { retries: 2, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 }
      })
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    expect(task).toHaveBeenCalledTimes(3); // 1 次 + 2 次重试
  });

  it('onAttempt 回调能观察到每次尝试与退避', async () => {
    const root = createCancelRoot('run');
    const events = [];
    let calls = 0;
    const task = async () => {
      calls++;
      if (calls < 2) throw createAppError('RATE_LIMITED', 'x');
      return 'ok';
    };

    await runWithPolicy({
      toolName: 'search_knowledge',
      task,
      parentNode: root,
      policy: { retries: 2, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
      onAttempt: (info) => events.push(info)
    });

    // 第 1 次尝试、第 1 次失败带 delay、第 2 次尝试
    expect(events.filter((e) => !e.error)).toHaveLength(2);
    expect(events.find((e) => e.error)?.delayMs).toBeGreaterThan(0);
  });
});

describe('runWithPolicy 与取消树联动', () => {
  it('父节点已取消时直接抛 CancelledError，不执行任务', async () => {
    const root = createCancelRoot('run');
    root.cancel(CancelReason.USER_ABORT);
    const task = vi.fn(async () => 'never');

    await expect(
      runWithPolicy({ toolName: 'search_knowledge', task, parentNode: root })
    ).rejects.toBeInstanceOf(CancelledError);

    expect(task).not.toHaveBeenCalled();
  });

  it('重试等待期间被取消则立刻中断', async () => {
    const root = createCancelRoot('run');
    const task = vi.fn(async () => {
      throw createAppError('RATE_LIMITED', 'x');
    });

    const promise = runWithPolicy({
      toolName: 'search_knowledge',
      task,
      parentNode: root,
      policy: { retries: 5, baseDelayMs: 200, maxDelayMs: 200, jitterRatio: 0 }
    });

    // 等第一次失败进入退避后取消
    await new Promise((r) => setTimeout(r, 30));
    root.cancel(CancelReason.USER_ABORT, '用户停止');

    await expect(promise).rejects.toBeInstanceOf(CancelledError);
    // 只跑了第一次，没有跑完 5 次重试
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('每次重试派生独立子节点，成功后全部 detach 不留残留', async () => {
    const root = createCancelRoot('run');
    let calls = 0;
    const task = async () => {
      calls++;
      if (calls < 3) throw createAppError('RATE_LIMITED', 'x');
      return 'ok';
    };

    await runWithPolicy({
      toolName: 'search_knowledge',
      task,
      parentNode: root,
      policy: { retries: 3, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 }
    });

    expect(root.children.size).toBe(0);
    expect(root.size()).toBe(1);
  });

  it('失败路径也会 detach，不泄漏节点', async () => {
    const root = createCancelRoot('run');
    const task = async () => {
      throw createAppError('RATE_LIMITED', 'x');
    };

    await expect(
      runWithPolicy({
        toolName: 'search_knowledge',
        task,
        parentNode: root,
        policy: { retries: 2, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 }
      })
    ).rejects.toThrow();

    expect(root.children.size).toBe(0);
  });

  it('超时后重试，最终成功', async () => {
    const root = createCancelRoot('run');
    let calls = 0;
    const task = (signal) => {
      calls++;
      if (calls === 1) {
        // 第一次永不返回，触发超时
        return new Promise(() => {
          signal.addEventListener('abort', () => {}, { once: true });
        });
      }
      return Promise.resolve('recovered');
    };

    const out = await runWithPolicy({
      toolName: 'search_knowledge',
      task,
      parentNode: root,
      timeoutMs: 30,
      policy: { retries: 2, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 }
    });

    expect(out.result).toBe('recovered');
    expect(out.attempts).toBe(2);
    // 父节点不应因子节点超时而被取消
    expect(root.isCancelled).toBe(false);
  });
});

describe('工具超时配置', () => {
  it('已知工具用专属超时', () => {
    expect(TOOL_TIMEOUTS.search_literature).toBe(20_000);
    expect(TOOL_TIMEOUTS.extract_paper_schema).toBe(45_000);
  });

  it('未知工具落到 default', async () => {
    const root = createCancelRoot('run');
    const out = await runWithPolicy({
      toolName: 'some_unknown_tool',
      task: async () => 'ok',
      parentNode: root
    });
    expect(out.result).toBe('ok');
  });

  it('显式 timeoutMs 优先于配置表', async () => {
    const root = createCancelRoot('run');
    await expect(
      runWithPolicy({
        toolName: 'search_literature',
        task: () => new Promise(() => {}),
        parentNode: root,
        timeoutMs: 20,
        policy: { retries: 0 }
      })
    ).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' });
  });
});
