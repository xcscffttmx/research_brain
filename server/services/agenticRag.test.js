import { describe, it, expect, vi } from 'vitest';
import {
  planRetrieval,
  rewriteWithHyde,
  retrieveOnce,
  runAgenticRag,
  planFollowUpQueries,
  buildCitations,
  buildEvidenceBlock,
  verifyGroundedness,
  RAG_CONSTANTS
} from './agenticRag.js';

/** 构造返回固定文本的 qwenFetch */
function fakeQwen(text) {
  return vi.fn(async () => ({ choices: [{ message: { content: typeof text === 'function' ? text() : text } }] }));
}

/** 构造一条向量召回行 */
function row(chunkId, score, documentName = 'doc.md') {
  return {
    chunkId,
    documentId: 'doc-1',
    documentName,
    text: `${chunkId} 的正文内容`,
    spanStart: 0,
    spanEnd: 10,
    score
  };
}

function makeDeps({ rows = [], rerankResult } = {}) {
  return {
    createEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
    searchChunksByVector: vi.fn(() => rows),
    rerank: vi.fn(
      async (_q, documents, { topN }) =>
        rerankResult ?? {
          items: documents.map((_, index) => ({ index, score: 0.9 - index * 0.1 })).slice(0, topN),
          degraded: false
        }
    )
  };
}

const emitStub = () => {
  const events = [];
  return {
    events,
    status: (stage, detail) => events.push({ stage, ...detail })
  };
};

describe('planRetrieval', () => {
  it('解析模型给出的检索计划', async () => {
    const plan = await planRetrieval({
      question: 'RAG 和 reranker 的关系',
      qwenFetch: fakeQwen(
        '{"needsRetrieval":true,"queries":["向量检索原理","重排序模型作用"],"maxHops":2,"reason":"多方面"}'
      )
    });

    expect(plan.needsRetrieval).toBe(true);
    expect(plan.queries).toHaveLength(2);
    expect(plan.maxHops).toBe(2);
  });

  it('闲聊问题不检索且清空 queries', async () => {
    const plan = await planRetrieval({
      question: '你好',
      qwenFetch: fakeQwen('{"needsRetrieval":false,"queries":["你好"],"maxHops":1,"reason":"闲聊"}')
    });

    expect(plan.needsRetrieval).toBe(false);
    expect(plan.queries).toEqual([]);
  });

  it('needsRetrieval 为 true 但 queries 为空时补回原问题', async () => {
    const plan = await planRetrieval({
      question: '原问题',
      qwenFetch: fakeQwen('{"needsRetrieval":true,"queries":[],"maxHops":1,"reason":""}')
    });
    expect(plan.queries).toEqual(['原问题']);
  });

  it('maxHops 被限制在上限内', async () => {
    const plan = await planRetrieval({
      question: 'q',
      qwenFetch: fakeQwen('{"needsRetrieval":true,"queries":["a"],"maxHops":9,"reason":""}')
    });
    expect(plan.maxHops).toBeLessThanOrEqual(RAG_CONSTANTS.MAX_HOPS);
  });

  it('输出不是 JSON 时降级为单轮原问题检索', async () => {
    const plan = await planRetrieval({ question: '原问题', qwenFetch: fakeQwen('我觉得不需要检索') });
    expect(plan).toMatchObject({ needsRetrieval: true, queries: ['原问题'], maxHops: 1 });
  });

  it('上游报错时降级，不抛异常', async () => {
    const plan = await planRetrieval({
      question: '原问题',
      qwenFetch: vi.fn(async () => {
        throw new Error('boom');
      })
    });
    expect(plan.queries).toEqual(['原问题']);
  });

  it('取消要向上抛出', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(
      planRetrieval({
        question: 'q',
        qwenFetch: vi.fn(async () => {
          throw abort;
        })
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('rewriteWithHyde', () => {
  it('把假设性答案拼在原查询之后', async () => {
    const rewritten = await rewriteWithHyde({ query: '什么是重排序', qwenFetch: fakeQwen('重排序是交叉编码器打分。') });
    expect(rewritten).toBe('什么是重排序\n重排序是交叉编码器打分。');
  });

  it('模型返回空时退回原查询', async () => {
    expect(await rewriteWithHyde({ query: 'q', qwenFetch: fakeQwen('   ') })).toBe('q');
  });

  it('上游报错时退回原查询', async () => {
    const rewritten = await rewriteWithHyde({
      query: 'q',
      qwenFetch: vi.fn(async () => {
        throw new Error('boom');
      })
    });
    expect(rewritten).toBe('q');
  });
});

describe('retrieveOnce', () => {
  it('向量召回后按精排结果重排并截断到 topN', async () => {
    const deps = makeDeps({ rows: [row('c1', 0.5), row('c2', 0.4), row('c3', 0.3)] });
    const result = await retrieveOnce({ question: 'q', queries: ['q'], deps, topN: 2 });

    expect(result.items.map((item) => item.chunkId)).toEqual(['c1', 'c2']);
    expect(result.items[0].rerankScore).toBe(0.9);
    expect(result.degraded).toBe(false);
  });

  it('多个子问题召回同一分块时只保留一次且取更高向量分', async () => {
    const deps = makeDeps({ rows: [row('c1', 0.5)] });
    deps.searchChunksByVector = vi
      .fn()
      .mockReturnValueOnce([row('c1', 0.5)])
      .mockReturnValueOnce([row('c1', 0.8)]);

    const result = await retrieveOnce({ question: 'q', queries: ['q1', 'q2'], deps });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].vectorScore).toBe(0.8);
  });

  it('跳过已在前几轮出现过的分块', async () => {
    const deps = makeDeps({ rows: [row('c1', 0.5), row('c2', 0.4)] });
    const result = await retrieveOnce({ question: 'q', queries: ['q'], seenChunkIds: new Set(['c1']), deps });
    expect(result.items.map((item) => item.chunkId)).toEqual(['c2']);
  });

  it('无召回时返回空且不调用精排', async () => {
    const deps = makeDeps({ rows: [] });
    const result = await retrieveOnce({ question: 'q', queries: ['q'], deps });
    expect(result.items).toEqual([]);
    expect(deps.rerank).not.toHaveBeenCalled();
  });

  it('精排始终针对原始问题而非改写后的查询', async () => {
    const deps = makeDeps({ rows: [row('c1', 0.5)] });
    await retrieveOnce({ question: '原始问题', queries: ['改写后的查询'], deps });
    expect(deps.rerank.mock.calls[0][0]).toBe('原始问题');
  });

  it('精排降级时透传 degraded 标记', async () => {
    const deps = makeDeps({
      rows: [row('c1', 0.5)],
      rerankResult: { items: [{ index: 0, score: 0 }], degraded: true, reason: 'RERANK_HTTP_ERROR' }
    });
    const result = await retrieveOnce({ question: 'q', queries: ['q'], deps });
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('RERANK_HTTP_ERROR');
  });
});

describe('runAgenticRag', () => {
  const planText = '{"needsRetrieval":true,"queries":["子问题一"],"maxHops":1,"reason":"需要资料"}';

  it('不需要检索时直接跳过并发 rag_skipped', async () => {
    const emit = emitStub();
    const result = await runAgenticRag({
      question: '你好',
      emit,
      persist: false,
      useHyde: false,
      deps: { ...makeDeps(), qwenFetch: fakeQwen('{"needsRetrieval":false,"queries":[],"maxHops":1,"reason":"闲聊"}') }
    });

    expect(result.needsRetrieval).toBe(false);
    expect(result.citations).toEqual([]);
    expect(emit.events.map((e) => e.stage)).toEqual(['rag_planning', 'rag_skipped']);
  });

  it('单轮命中强相关证据后停止', async () => {
    const emit = emitStub();
    const deps = { ...makeDeps({ rows: [row('c1', 0.6), row('c2', 0.5)] }), qwenFetch: fakeQwen(planText) };

    const result = await runAgenticRag({ question: 'q', emit, persist: false, useHyde: false, deps });

    expect(result.hops).toHaveLength(1);
    expect(result.citations[0].index).toBe(1);
    expect(emit.events.map((e) => e.stage)).toContain('retrieved');
  });

  it('证据不足时按 maxHops 继续检索下一轮', async () => {
    const weakRerank = { items: [{ index: 0, score: 0.05 }], degraded: false };
    const deps = makeDeps({ rerankResult: weakRerank });
    deps.searchChunksByVector = vi
      .fn()
      .mockReturnValueOnce([row('c1', 0.3)])
      .mockReturnValueOnce([row('c2', 0.3)]);

    let call = 0;
    deps.qwenFetch = vi.fn(async () => {
      call += 1;
      // 第 1 次是检索规划，第 2 次是补充检索规划
      const content =
        call === 1 ? '{"needsRetrieval":true,"queries":["q1"],"maxHops":2,"reason":""}' : '{"queries":["q2"]}';
      return { choices: [{ message: { content } }] };
    });

    const result = await runAgenticRag({ question: 'q', persist: false, useHyde: false, deps });

    expect(result.hops).toHaveLength(2);
    expect(result.hops[1].queries).toEqual(['q2']);
    expect(result.evidence.map((item) => item.chunkId)).toEqual(['c1', 'c2']);
  });

  it('补充检索无子问题时提前结束', async () => {
    const deps = makeDeps({
      rows: [row('c1', 0.3)],
      rerankResult: { items: [{ index: 0, score: 0.01 }], degraded: false }
    });
    let call = 0;
    deps.qwenFetch = vi.fn(async () => {
      call += 1;
      const content =
        call === 1 ? '{"needsRetrieval":true,"queries":["q1"],"maxHops":3,"reason":""}' : '{"queries":[]}';
      return { choices: [{ message: { content } }] };
    });

    const result = await runAgenticRag({ question: 'q', persist: false, useHyde: false, deps });
    expect(result.hops).toHaveLength(1);
  });

  it('开启 HyDE 时用改写后的查询做向量召回', async () => {
    const deps = makeDeps({ rows: [row('c1', 0.6)] });
    let call = 0;
    deps.qwenFetch = vi.fn(async () => {
      call += 1;
      const content = call === 1 ? planText : '这是假设性答案。';
      return { choices: [{ message: { content } }] };
    });

    await runAgenticRag({ question: 'q', persist: false, useHyde: true, deps });
    expect(deps.createEmbedding.mock.calls[0][0]).toBe('子问题一\n这是假设性答案。');
  });

  it('取消节点已取消时立即抛出', async () => {
    const cancelNode = {
      signal: undefined,
      throwIfCancelled: () => {
        throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      }
    };

    await expect(
      runAgenticRag({
        question: 'q',
        cancelNode,
        persist: false,
        deps: { ...makeDeps(), qwenFetch: fakeQwen(planText) }
      })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('planFollowUpQueries', () => {
  it('最多返回 2 条子问题', async () => {
    const queries = await planFollowUpQueries({
      question: 'q',
      evidence: [],
      qwenFetch: fakeQwen('{"queries":["a","b","c"]}')
    });
    expect(queries).toEqual(['a', 'b']);
  });

  it('过滤空字符串并容忍非法结构', async () => {
    expect(
      await planFollowUpQueries({ question: 'q', evidence: [], qwenFetch: fakeQwen('{"queries":["  ","x"]}') })
    ).toEqual(['x']);
    expect(await planFollowUpQueries({ question: 'q', evidence: [], qwenFetch: fakeQwen('不是 JSON') })).toEqual([]);
  });
});

describe('buildCitations / buildEvidenceBlock', () => {
  it('按精排分降序编号，[^1] 最相关', () => {
    const citations = buildCitations([
      { chunkId: 'c1', documentName: 'a.md', text: 'A', spanStart: 0, spanEnd: 1, vectorScore: 0.9, rerankScore: 0.2 },
      { chunkId: 'c2', documentName: 'b.md', text: 'B', spanStart: 2, spanEnd: 3, vectorScore: 0.4, rerankScore: 0.8 }
    ]);

    expect(citations.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(citations[0].index).toBe(1);
    expect(citations[0].span).toEqual([2, 3]);
  });

  it('缺少 rerankScore 时回退到向量分排序', () => {
    const citations = buildCitations([
      { chunkId: 'c1', documentName: 'a.md', text: 'A', vectorScore: 0.3 },
      { chunkId: 'c2', documentName: 'b.md', text: 'B', vectorScore: 0.7 }
    ]);
    expect(citations.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(citations[0].score).toBe(0.7);
  });

  it('证据块带 [^n] 标记，空列表返回空串', () => {
    const block = buildEvidenceBlock(
      buildCitations([{ chunkId: 'c1', documentName: 'a.md', text: '正文', vectorScore: 0.5 }])
    );
    expect(block).toContain('[^1]');
    expect(block).toContain('a.md');
    expect(buildEvidenceBlock([])).toBe('');
  });
});

describe('verifyGroundedness', () => {
  const citations = [{ index: 1, title: 'a.md', snippet: '证据正文', score: 0.8 }];

  it('解析核查结果', async () => {
    const result = await verifyGroundedness({
      answer: '答案',
      citations,
      qwenFetch: fakeQwen('{"grounded":false,"score":0.4,"unsupported":["某个论断"],"missingInfo":"缺少实验数据"}')
    });

    expect(result).toMatchObject({ grounded: false, score: 0.4, missingInfo: '缺少实验数据', skipped: false });
    expect(result.unsupported).toEqual(['某个论断']);
  });

  it('没有答案或没有证据时跳过核查', async () => {
    const qwenFetch = fakeQwen('{}');
    expect(await verifyGroundedness({ answer: '   ', citations, qwenFetch })).toMatchObject({
      skipped: true,
      grounded: true
    });
    expect(await verifyGroundedness({ answer: 'a', citations: [], qwenFetch })).toMatchObject({ skipped: true });
    expect(qwenFetch).not.toHaveBeenCalled();
  });

  it('核查上游异常时视为通过并标记 skipped', async () => {
    const result = await verifyGroundedness({
      answer: '答案',
      citations,
      qwenFetch: vi.fn(async () => {
        throw new Error('boom');
      })
    });
    expect(result).toMatchObject({ grounded: true, skipped: true });
  });

  it('输出不是 JSON 时同样跳过', async () => {
    const result = await verifyGroundedness({ answer: '答案', citations, qwenFetch: fakeQwen('无法判断') });
    expect(result.skipped).toBe(true);
  });
});
