/**
 * Context 取消树 —— Agent Runtime 的中断传播机制。
 *
 * 为什么需要树：一次 Agent run 会派生多个 step，每个 step 又可能并发调多个 tool。
 * 用户点「停止」时，必须让所有正在飞的请求立刻收到 abort，否则：
 *   - 上游 API 继续消耗配额
 *   - Promise 挂起导致 SSE 连接无法及时关闭
 *   - 定时器/监听器泄漏
 *
 * 设计要点：
 *   1. 每个节点持有独立 AbortController，父节点 abort 时深度优先级联子节点
 *   2. 取消原因（reason）随传播携带，便于区分"用户主动停止"与"超时"与"上游失败"
 *   3. 节点完成后从父节点摘除，避免长会话下 children 集合无限增长
 *   4. 支持挂载外部 AbortSignal（如 HTTP 请求断开）作为根节点的上游触发器
 */

/** 取消原因枚举 */
export const CancelReason = {
  USER_ABORT: 'user_abort',
  TIMEOUT: 'timeout',
  PARENT_CANCELLED: 'parent_cancelled',
  UPSTREAM_ERROR: 'upstream_error',
  LOOP_DETECTED: 'loop_detected'
};

export class CancelNode {
  /**
   * @param {string} id 节点标识（run id / step id / tool call id）
   * @param {CancelNode|null} parent
   */
  constructor(id, parent = null) {
    this.id = id;
    this.parent = parent;
    this.children = new Set();
    this.controller = new AbortController();
    this.reason = null;
    this.cancelledAt = null;
    this.detached = false;

    if (parent) {
      parent.children.add(this);
      // 父节点已经取消了，新建的子节点直接继承取消状态
      if (parent.isCancelled) {
        this.cancel(CancelReason.PARENT_CANCELLED, parent.reason?.detail);
      }
    }
  }

  get signal() {
    return this.controller.signal;
  }

  get isCancelled() {
    return this.controller.signal.aborted;
  }

  /** 派生子节点 */
  child(id) {
    return new CancelNode(id, this);
  }

  /**
   * 取消本节点及其所有后代。
   * @param {string} reasonCode CancelReason 之一
   * @param {string} [detail] 附加说明
   */
  cancel(reasonCode = CancelReason.USER_ABORT, detail = '') {
    if (this.isCancelled) return this.reason;

    this.reason = { code: reasonCode, detail, nodeId: this.id };
    this.cancelledAt = Date.now();

    // 深度优先级联：先取消子树，再取消自己，保证子节点的 onAbort 能看到完整上下文
    for (const child of [...this.children]) {
      child.cancel(CancelReason.PARENT_CANCELLED, detail || `parent ${this.id} cancelled`);
    }

    this.controller.abort(this.reason);
    return this.reason;
  }

  /**
   * 从父节点摘除（正常完成时调用），防止 children 集合无限增长。
   * 摘除后本节点仍可独立使用，但父节点 abort 不再影响它。
   */
  detach() {
    if (this.parent) {
      this.parent.children.delete(this);
    }
    this.detached = true;
  }

  /** 当前子树的节点总数（含自己），用于泄漏检测与调试 */
  size() {
    let total = 1;
    for (const child of this.children) total += child.size();
    return total;
  }

  /** 导出子树结构快照（调试/可视化用） */
  snapshot() {
    return {
      id: this.id,
      cancelled: this.isCancelled,
      reason: this.reason,
      children: [...this.children].map((c) => c.snapshot())
    };
  }

  /**
   * 抛出取消错误（供业务代码在 await 点主动检查）。
   * @throws {CancelledError}
   */
  throwIfCancelled() {
    if (this.isCancelled) {
      throw new CancelledError(this.reason);
    }
  }
}

/** 取消导致的错误，与普通业务错误区分开 */
export class CancelledError extends Error {
  constructor(reason) {
    super(`操作已取消：${reason?.code || 'unknown'}${reason?.detail ? ` (${reason.detail})` : ''}`);
    this.name = 'CancelledError';
    this.code = 'CANCELLED';
    this.reason = reason;
  }
}

/**
 * 创建根节点。
 * @param {string} id
 * @param {AbortSignal} [externalSignal] 外部信号（如 HTTP 请求断开），会作为上游触发器
 */
export function createCancelRoot(id, externalSignal) {
  const root = new CancelNode(id);

  if (externalSignal) {
    if (externalSignal.aborted) {
      root.cancel(CancelReason.USER_ABORT, 'external signal already aborted');
    } else {
      const onAbort = () => root.cancel(CancelReason.USER_ABORT, 'external signal aborted');
      externalSignal.addEventListener('abort', onAbort, { once: true });
      // 根节点取消后解绑监听，避免外部 signal 长期持有引用
      root.signal.addEventListener(
        'abort',
        () => externalSignal.removeEventListener('abort', onAbort),
        { once: true }
      );
    }
  }

  return root;
}
