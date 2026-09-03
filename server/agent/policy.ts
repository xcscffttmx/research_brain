/**
 * 工具调用策略层 —— 为每次 Tool/MCP 调用套上 Timeout 与 Retry。
 *
 * 与 lib/fetchWithRetry.js 的分工：
 *   - fetchWithRetry 面向 HTTP，处理状态码语义
 *   - 本模块面向"任意异步任务"，且与取消树联动：超时/取消都走同一套 CancelNode
 */
import { CancelReason, CancelledError } from './cancelTree.js';
import type { CancelNode } from './cancelTree.js';
import { createAppError } from '../lib/errors.js';

/** 不同工具的默认超时（毫秒）。检索类慢、本地类快 */
export const TOOL_TIMEOUTS: Record<string, number> = {
  search_literature: 20_000,
  search_knowledge: 10_000,
  extract_paper_schema: 45_000,
  mine_research_gaps: 45_000,
  generate_experiment_spec: 45_000,
  ingest_literature: 60_000,
  default: 15_000
};

const DEFAULT_POLICY = {
  retries: 2,
  baseDelayMs: 400,
  maxDelayMs: 4_000,
  jitterRatio: 0.3
};

export interface RetryPolicy {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface RunWithPolicyInput<T> {
  toolName: string;
  task: (signal: AbortSignal) => Promise<T>;
  parentNode: CancelNode;
  timeoutMs?: number;
  policy?: Partial<RetryPolicy>;
  onAttempt?: (info: { attempt: number; error?: ErrorWithCode; delayMs?: number }) => void;
}

export interface RunWithPolicyResult<T> {
  result: T;
  attempts: number;
  durationMs: number;
}

interface ErrorWithCode extends Error {
  code?: string;
  status?: number;
}

function toErrorWithCode(error: unknown): ErrorWithCode {
  if (error instanceof Error) return error as ErrorWithCode;
  return createAppError('UNKNOWN_ERROR', String(error || '未知错误'));
}

/** 判断一个错误是否值得重试 */
export function isRetryableError(error: unknown): boolean {
  const err = toErrorWithCode(error);
  if (error instanceof CancelledError) return false;
  // 用户主动取消不重试
  if (err.code === 'CANCELLED') return false;

  const retryableCodes = new Set([
    'UPSTREAM_TIMEOUT',
    'TOOL_TIMEOUT',
    'RATE_LIMITED',
    'NETWORK_UNREACHABLE',
    'UPSTREAM_RETRYABLE_STATUS',
    'ARXIV_FETCH_FAILED',
    'SEMANTIC_SCHOLAR_FETCH_FAILED',
    'OPENALEX_FETCH_FAILED',
    'QWEN_HTTP_ERROR'
  ]);
  if (err.code && retryableCodes.has(err.code)) return true;

  // 参数错误、鉴权错误、数据不足等不重试
  const nonRetryableCodes = new Set([
    'MISSING_API_KEY',
    'INVALID_API_KEY',
    'PAPER_NOT_FOUND',
    'SCHEMA_VALIDATE_ERROR',
    'GAP_DATA_INSUFFICIENT',
    'SPEC_DATA_INSUFFICIENT'
  ]);
  if (err.code && nonRetryableCodes.has(err.code)) return false;

  // 5xx 视为可重试
  return typeof err.status === 'number' && err.status >= 500;
}

/** 指数退避 + jitter */
export function computeBackoff(attempt: number, { baseDelayMs, maxDelayMs, jitterRatio }: RetryPolicy): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  const jitter = Math.random() * exp * jitterRatio;
  return Math.floor(exp + jitter);
}

/** 可被取消打断的 sleep */
function sleep(ms: number, cancelNode?: CancelNode): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!cancelNode) return;
    cancelNode.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new CancelledError(cancelNode.reason));
      },
      { once: true }
    );
  });
}

/**
 * 给一个异步任务套上超时。超时会通过取消树 abort，让任务内部有机会清理。
 *
 * @param {(signal: AbortSignal) => Promise<any>} task
 * @param {number} timeoutMs
 * @param {import('./cancelTree.js').CancelNode} cancelNode
 */
export async function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  cancelNode: CancelNode
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cancelNode.cancel(CancelReason.TIMEOUT, `超过 ${timeoutMs}ms`);
      reject(createAppError('TOOL_TIMEOUT', `工具调用超时（>${timeoutMs}ms）`, '', 504));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task(cancelNode.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 执行一次工具调用，带 Timeout + Retry + 取消联动。
 *
 * 每次重试都派生独立的子取消节点：上一次超时的节点已被 abort，不能复用。
 *
 * @param {object}   params
 * @param {string}   params.toolName
 * @param {(signal: AbortSignal) => Promise<any>} params.task
 * @param {import('./cancelTree.js').CancelNode} params.parentNode
 * @param {number}   [params.timeoutMs]
 * @param {object}   [params.policy]
 * @param {(info: {attempt: number, error?: Error, delayMs?: number}) => void} [params.onAttempt]
 * @returns {Promise<{result: any, attempts: number, durationMs: number}>}
 */
export async function runWithPolicy<T>({
  toolName,
  task,
  parentNode,
  timeoutMs,
  policy = {},
  onAttempt
}: RunWithPolicyInput<T>): Promise<RunWithPolicyResult<T>> {
  const merged = { ...DEFAULT_POLICY, ...policy };
  const effectiveTimeout = timeoutMs ?? TOOL_TIMEOUTS[toolName] ?? TOOL_TIMEOUTS.default;
  const startedAt = Date.now();

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= merged.retries; attempt++) {
    // 父节点已取消，直接放弃
    parentNode.throwIfCancelled();

    const attemptNode = parentNode.child(`${toolName}#${attempt + 1}`);
    onAttempt?.({ attempt: attempt + 1 });

    try {
      const result = await withTimeout(task, effectiveTimeout, attemptNode);
      attemptNode.detach();
      return { result, attempts: attempt + 1, durationMs: Date.now() - startedAt };
    } catch (error: unknown) {
      attemptNode.detach();
      lastError = error;
      const err = toErrorWithCode(error);

      // 取消不重试，直接向上抛
      if (error instanceof CancelledError || err.code === 'CANCELLED') throw error;
      // 父节点在本次尝试期间被取消（例如用户点停止），也不再重试
      if (parentNode.isCancelled) throw new CancelledError(parentNode.reason);

      const canRetry = attempt < merged.retries && isRetryableError(error);
      if (!canRetry) break;

      const delayMs = computeBackoff(attempt, merged);
      onAttempt?.({ attempt: attempt + 1, error: err, delayMs });
      await sleep(delayMs, parentNode);
    }
  }

  throw lastError || createAppError('TOOL_FAILED', `工具 ${toolName} 调用失败`);
}
