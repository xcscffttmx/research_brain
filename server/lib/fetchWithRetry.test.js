import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithTimeout, fetchWithRetry } from './fetchWithRetry.js';

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** 模拟一个永不返回、只响应 abort 的请求 */
function hangingFetch() {
  return vi.fn(
    (_url, options) =>
      new Promise((_, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true }
        );
      })
  );
}

describe('fetchWithTimeout', () => {
  it('超时转成可重试的 UPSTREAM_TIMEOUT', async () => {
    globalThis.fetch = hangingFetch();
    await expect(fetchWithTimeout('https://example.com', {}, 20)).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
      status: 504
    });
  });

  it('调用方主动取消时原样抛 AbortError，不伪装成超时', async () => {
    globalThis.fetch = hangingFetch();
    const controller = new AbortController();
    const promise = fetchWithTimeout('https://example.com', { signal: controller.signal }, 5_000);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('正常响应直接返回', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const response = await fetchWithTimeout('https://example.com');
    expect(response.status).toBe(200);
  });
});

describe('fetchWithRetry', () => {
  it('5xx 会重试并最终返回最后一次响应', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
    globalThis.fetch = fetchMock;

    const response = await fetchWithRetry('https://example.com', {}, { retries: 2, baseDelayMs: 1 });
    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('2xx 不重试', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    globalThis.fetch = fetchMock;

    await fetchWithRetry('https://example.com', {}, { retries: 2, baseDelayMs: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('调用方取消时立即失败，不消耗重试次数', async () => {
    const fetchMock = hangingFetch();
    globalThis.fetch = fetchMock;

    const controller = new AbortController();
    const promise = fetchWithRetry(
      'https://example.com',
      { signal: controller.signal },
      { retries: 3, baseDelayMs: 1, timeoutMs: 5_000 }
    );
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
