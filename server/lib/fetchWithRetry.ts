import { createAppError, errorCode, errorName, isAbortError } from './errors.js';

export interface RetryConfig {
  /** 单次请求超时 */
  timeoutMs?: number;
  /** 最大重试次数（不含首次） */
  retries?: number;
  /** 首次退避基准值 */
  baseDelayMs?: number;
  /** 单次退避上限 */
  maxDelayMs?: number;
  shouldRetry?: (response: Response | null, error: unknown) => boolean;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 5_000;
/** 退避抖动比例，避免多个客户端同步重试造成风暴 */
const JITTER_RATIO = 0.3;

/**
 * 带超时的 fetch。
 *
 * 两点容易踩的坑，这里都处理了：
 *   1. 调用方传入的 signal 不能被内部 controller 覆盖，否则外部取消失效 —— 用 AbortSignal.any 合并
 *   2. 超时 abort 与调用方取消都表现为 AbortError，必须区分：
 *      超时转成可重试的 UPSTREAM_TIMEOUT，取消则原样抛出，避免把用户的「停止」当成网络抖动去重试
 */
export async function fetchWithTimeout(
  url: string | URL,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

  try {
    return await fetch(url, { ...options, signal });
  } catch (error) {
    if (isAbortError(error)) {
      if (!timedOut) throw error;
      throw createAppError('UPSTREAM_TIMEOUT', `上游请求超时（>${timeoutMs}ms）`, '请稍后重试或切换数据源。', 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 在 fetchWithTimeout 之上增加指数退避 + jitter 的重试机制。
 * 默认对网络错误、超时、429、5xx 触发重试。
 */
export async function fetchWithRetry(
  url: string | URL,
  options: RequestInit = {},
  retryConfig: RetryConfig = {}
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    shouldRetry = defaultShouldRetry
  } = retryConfig;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (!shouldRetry(response, null) || attempt === retries) {
        return response;
      }
      lastError = createAppError(
        'UPSTREAM_RETRYABLE_STATUS',
        `上游返回可重试状态码 ${response.status}`,
        '',
        response.status
      );
    } catch (error) {
      lastError = error;
      if (!shouldRetry(null, error) || attempt === retries) {
        throw error;
      }
    }
    await sleep(computeBackoffDelay(attempt, baseDelayMs, maxDelayMs));
  }
  // 理论上到不了这一行，兜底
  throw lastError || createAppError('UPSTREAM_UNKNOWN', '未知上游错误');
}

function defaultShouldRetry(response: Response | null, error: unknown): boolean {
  if (error) {
    // AbortError 已被 fetchWithTimeout 转成 UPSTREAM_TIMEOUT，视为可重试
    return errorCode(error) === 'UPSTREAM_TIMEOUT' || errorName(error) === 'TypeError';
  }
  if (!response) return false;
  return response.status === 429 || response.status >= 500;
}

function computeBackoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  const jitter = Math.random() * exp * JITTER_RATIO;
  return Math.floor(exp + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
