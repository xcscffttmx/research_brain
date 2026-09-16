import { createAppError, isAbortError } from '../errors.js';
import { qwenConfig } from '../config.js';

/** DashScope 单条 embedding 的经验安全上限 */
const EMBEDDING_MAX_CHARS = 6_000;

export interface QwenRequestOptions {
  signal?: AbortSignal;
}

/**
 * Qwen 通用 POST 请求，返回原始 Response。
 * 错误分类与状态码保持与最初 mcp-server 实现一致。
 */
async function postQwen(
  endpoint: string,
  body: Record<string, unknown>,
  { signal }: QwenRequestOptions = {}
): Promise<Response> {
  if (!qwenConfig.apiKey) {
    throw createAppError(
      'MISSING_API_KEY',
      '缺少 Qwen API Key',
      '请检查服务端 `.env.local` 中的 `QWEN_API_KEY` 配置。',
      500
    );
  }

  let response: Response;
  try {
    response = await fetch(`${qwenConfig.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${qwenConfig.apiKey}`
      },
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    // 取消要原样抛出，否则会被误判成网络故障并触发重试
    if (isAbortError(error)) throw error;
    throw createAppError(
      'NETWORK_UNREACHABLE',
      '无法连接到 Qwen 服务',
      '当前运行环境访问 DashScope 失败。请检查网络、代理、VPN 或防火墙设置。',
      502
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 401) {
      throw createAppError(
        'INVALID_API_KEY',
        'Qwen API Key 无效或已过期',
        text || '请检查 `QWEN_API_KEY` 是否正确。',
        401
      );
    }

    if (response.status === 429) {
      throw createAppError('RATE_LIMITED', 'Qwen 请求过于频繁', text || '请稍后重试，或检查账户配额是否充足。', 429);
    }

    throw createAppError(
      'QWEN_HTTP_ERROR',
      `Qwen 请求失败（${response.status}）`,
      text || '上游模型服务返回异常响应。',
      502
    );
  }

  return response;
}

/** 非流式调用，直接返回 JSON */
export async function qwenFetch<T = any>(
  endpoint: string,
  body: Record<string, unknown>,
  options?: QwenRequestOptions
): Promise<T> {
  const response = await postQwen(endpoint, body, options);
  return response.json() as Promise<T>;
}

/** 流式调用，返回原始 Response，由调用方消费 SSE */
export async function qwenStream(
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Response> {
  const response = await postQwen(endpoint, { ...body, stream: true }, { signal });
  if (!response.body) {
    throw createAppError('QWEN_STREAM_EMPTY', 'Qwen 流式响应为空', '上游未返回可读流。', 502);
  }
  return response;
}

/** 基于 Qwen embedding 模型生成向量 */
export async function createEmbedding(text: string): Promise<number[]> {
  const result = await qwenFetch<{ data?: Array<{ embedding?: number[] }> }>('/embeddings', {
    model: qwenConfig.embeddingModel,
    input: text.slice(0, EMBEDDING_MAX_CHARS)
  });

  const vector = result.data?.[0]?.embedding;
  if (!vector) {
    throw createAppError('EMBEDDING_EMPTY', 'Embedding 生成失败', '模型返回为空，无法建立向量索引。', 502);
  }

  return vector;
}
