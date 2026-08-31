import { createAppError } from './errors.js';

/**
 * 带超时的 fetch。
 *
 * 两点容易踩的坑，这里都处理了：
 *   1. 调用方传入的 signal 不能被内部 controller 覆盖，否则外部取消失效 —— 用 AbortSignal.any 合并
 *   2. 超时 abort 与调用方取消都表现为 AbortError，必须区分：
 *      超时转成可重试的 UPSTREAM_TIMEOUT，取消则原样抛出，避免把用户的「停止」当成网络抖动去重试
 *
 * @param {string|URL} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
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
    if (error?.name === 'AbortError') {
      if (!timedOut) throw error;
      throw createAppError('UPSTREAM_TIMEOUT', `上游请求超时（>${timeoutMs}ms）`, '请稍后重试或切换数据源。', 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 增强版：在 fetchWithTimeout 之上增加指数退避 + jitter 的重试机制。
 * 默认对网络错误、超时、429、5xx 触发重试。
 *
 * @param {string|URL} url
 * @param {RequestInit} [options]
 * @param {object}  [retryConfig]
 * @param {number}  [retryConfig.timeoutMs=8000]   单次请求超时
 * @param {number}  [retryConfig.retries=2]        最大重试次数（不含首次）
 * @param {number}  [retryConfig.baseDelayMs=500]  首次退避基准值
 * @param {number}  [retryConfig.maxDelayMs=5000]  单次退避上限
 * @param {(response: Response|null, error: Error|null) => boolean} [retryConfig.shouldRetry]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}, retryConfig = {}) {
  const {
    timeoutMs = 8000,
    retries = 2,
    baseDelayMs = 500,
    maxDelayMs = 5000,
    shouldRetry = defaultShouldRetry
  } = retryConfig;

  let lastError = null;
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

function defaultShouldRetry(response, error) {
  if (error) {
    // AbortError 已被 fetchWithTimeout 转成 UPSTREAM_TIMEOUT，视为可重试
    return error.code === 'UPSTREAM_TIMEOUT' || error.name === 'TypeError';
  }
  if (!response) return false;
  return response.status === 429 || response.status >= 500;
}

function computeBackoffDelay(attempt, baseDelayMs, maxDelayMs) {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  const jitter = Math.random() * exp * 0.3; // 最多 30% 的随机扰动，避免同步风暴
  return Math.floor(exp + jitter);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
