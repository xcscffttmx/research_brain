import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rerankDocuments, rerankOrFallback } from './rerank.js';

const DOCS = ['文档 A', '文档 B', '文档 C'];

function mockResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.QWEN_API_KEY = 'test-key';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('rerankDocuments', () => {
  it('按 relevance_score 降序返回 index/score', async () => {
    globalThis.fetch = vi.fn(async () =>
      mockResponse({
        output: {
          results: [
            { index: 0, relevance_score: 0.1 },
            { index: 2, relevance_score: 0.9 }
          ]
        }
      })
    );

    const items = await rerankDocuments('q', DOCS, { topN: 2 });
    expect(items).toEqual([
      { index: 2, score: 0.9 },
      { index: 0, score: 0.1 }
    ]);
  });

  it('请求体使用原生接口的 input/parameters 结构', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ output: { results: [] } }));
    globalThis.fetch = fetchMock;

    await rerankDocuments('什么是重排序', DOCS, { topN: 2 }).catch(() => undefined);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.input.query).toBe('什么是重排序');
    expect(body.input.documents).toEqual(DOCS);
    expect(body.parameters).toEqual({ return_documents: false, top_n: 2 });
  });

  it('兼容模式的 results 结构也能解析', async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({ results: [{ index: 1, relevance_score: 0.5 }] }));
    expect(await rerankDocuments('q', DOCS)).toEqual([{ index: 1, score: 0.5 }]);
  });

  it('过滤越界与非法 index', async () => {
    globalThis.fetch = vi.fn(async () =>
      mockResponse({
        output: {
          results: [
            { index: 99, relevance_score: 1 },
            { index: 1, relevance_score: 0.2 }
          ]
        }
      })
    );
    expect(await rerankDocuments('q', DOCS)).toEqual([{ index: 1, score: 0.2 }]);
  });

  it('query 或 documents 为空时不发请求', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    expect(await rerankDocuments('', DOCS)).toEqual([]);
    expect(await rerankDocuments('q', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('候选文本超长时被截断到 2000 字', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ output: { results: [] } }));
    globalThis.fetch = fetchMock;

    await rerankDocuments('q', ['x'.repeat(5000)]).catch(() => undefined);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.input.documents[0].length).toBe(2000);
  });

  it('HTTP 失败抛 RERANK_HTTP_ERROR', async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({ code: 'AccessDenied' }, false, 403));
    await expect(rerankDocuments('q', DOCS)).rejects.toMatchObject({ code: 'RERANK_HTTP_ERROR' });
  });

  it('结构异常抛 RERANK_EMPTY', async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({ unexpected: true }));
    await expect(rerankDocuments('q', DOCS)).rejects.toMatchObject({ code: 'RERANK_EMPTY' });
  });

  it('缺少 API Key 时抛 MISSING_API_KEY', async () => {
    delete process.env.QWEN_API_KEY;
    await expect(rerankDocuments('q', DOCS)).rejects.toMatchObject({ code: 'MISSING_API_KEY' });
  });
});

describe('rerankOrFallback', () => {
  it('成功时不降级', async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({ output: { results: [{ index: 1, relevance_score: 0.7 }] } }));
    const result = await rerankOrFallback('q', DOCS);
    expect(result.degraded).toBe(false);
    expect(result.items).toEqual([{ index: 1, score: 0.7 }]);
  });

  it('上游失败时保持向量顺序并标记降级', async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({}, false, 500));
    const result = await rerankOrFallback('q', DOCS, { topN: 2 });
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('RERANK_HTTP_ERROR');
    expect(result.items).toEqual([
      { index: 0, score: 0 },
      { index: 1, score: 0 }
    ]);
  });

  it('返回空结果时也降级', async () => {
    globalThis.fetch = vi.fn(async () => mockResponse({ output: { results: [] } }));
    const result = await rerankOrFallback('q', DOCS, { topN: 1 });
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('RERANK_EMPTY');
    expect(result.items).toEqual([{ index: 0, score: 0 }]);
  });

  it('取消不被降级逻辑吞掉', async () => {
    globalThis.fetch = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });
    await expect(rerankOrFallback('q', DOCS)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
