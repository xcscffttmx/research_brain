import { describe, it, expect, vi } from 'vitest';
import {
  buildAnswerMessages,
  consumeQwenStream,
  collectCitations,
  extractCitedIndexes,
  generateAnswerWithGroundedness
} from './answerGenerator.js';

/** 把字符串按固定长度切成多个 chunk，模拟网络分片 */
function toStream(text, chunkSize = 8) {
  const bytes = new TextEncoder().encode(text);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(bytes.slice(i, i + chunkSize));
  }

  let index = 0;
  return {
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length ? { value: chunks[index++], done: false } : { value: undefined, done: true }
      })
    }
  };
}

function sseFrame(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
}

describe('buildAnswerMessages', () => {
  it('无工具结果时提示直接回答', () => {
    const messages = buildAnswerMessages({ question: '你好' });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toContain('本轮未调用工具');
    expect(messages[1].content).toContain('你好');
  });

  it('带上工具结果、意图与失败步骤', () => {
    const messages = buildAnswerMessages({
      question: '找几篇论文',
      contextHint: '用户在做 RAG 研究',
      plan: { intent: '检索文献' },
      toolResults: [{ step: 1, tool: 'search_literature', result: { count: 2 } }],
      failedSteps: [{ step: 2, tool: 'extract_paper_schema', code: 'TOOL_TIMEOUT', message: '超时' }]
    });

    const user = messages[1].content;
    expect(user).toContain('用户在做 RAG 研究');
    expect(user).toContain('检索文献');
    expect(user).toContain('search_literature');
    expect(user).toContain('TOOL_TIMEOUT');
  });

  it('超长工具结果被截断', () => {
    const messages = buildAnswerMessages({
      question: 'q',
      toolResults: [{ step: 1, tool: 'retrieve_knowledge', result: 'x'.repeat(9000) }]
    });
    expect(messages[1].content).toContain('已截断');
    expect(messages[1].content.length).toBeLessThan(6000);
  });
});

describe('consumeQwenStream', () => {
  it('聚合增量并逐段回调', async () => {
    const onDelta = vi.fn();
    const answer = await consumeQwenStream(toStream(`${sseFrame('你好')}${sseFrame('世界')}data: [DONE]\n\n`), onDelta);

    expect(answer).toBe('你好世界');
    expect(onDelta.mock.calls.map((c) => c[0])).toEqual(['你好', '世界']);
  });

  it('中文被切在 chunk 之间也能正确解码', async () => {
    const onDelta = vi.fn();
    // chunkSize=1 会把每个中文字符的 3 个字节切开
    const answer = await consumeQwenStream(toStream(sseFrame('科研问答'), 1), onDelta);
    expect(answer).toBe('科研问答');
  });

  it('遇到 [DONE] 立即结束，忽略后续帧', async () => {
    const answer = await consumeQwenStream(toStream(`${sseFrame('a')}data: [DONE]\n\n${sseFrame('b')}`));
    expect(answer).toBe('a');
  });

  it('非 JSON 帧被忽略而不中断', async () => {
    const answer = await consumeQwenStream(toStream(`: keep-alive\n\ndata: not-json\n\n${sseFrame('ok')}`));
    expect(answer).toBe('ok');
  });

  it('流提前结束时返回已累积内容', async () => {
    const answer = await consumeQwenStream(toStream(sseFrame('半句')));
    expect(answer).toBe('半句');
  });
});

describe('collectCitations', () => {
  it('跨工具去重合并 citations', () => {
    const citations = collectCitations([
      {
        result: {
          citations: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' }
          ]
        }
      },
      {
        result: {
          citations: [
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' }
          ]
        }
      }
    ]);
    expect(citations.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('结果里没有 citations 时返回空数组', () => {
    expect(collectCitations([{ result: { count: 1 } }, { result: null }])).toEqual([]);
    expect(collectCitations()).toEqual([]);
  });
});

describe('证据注入', () => {
  const citations = [
    { index: 1, title: 'a.md', snippet: '证据一', score: 0.8 },
    { index: 2, title: 'b.md', snippet: '证据二', score: 0.5 }
  ];

  it('带证据时注入【检索证据】并要求 [^n] 角标', () => {
    const messages = buildAnswerMessages({ question: 'q', citations });
    expect(messages[0].content).toContain('[^n]');
    expect(messages[1].content).toContain('【检索证据】');
    expect(messages[1].content).toContain('[^2]');
  });

  it('有证据时不重复注入 retrieve_knowledge 的原始结果', () => {
    const messages = buildAnswerMessages({
      question: 'q',
      citations,
      toolResults: [
        { step: 1, tool: 'retrieve_knowledge', result: { citations } },
        { step: 2, tool: 'get_current_time', result: { iso: 'x' } }
      ]
    });

    expect(messages[1].content).toContain('get_current_time');
    expect(messages[1].content).not.toContain('retrieve_knowledge（step 1）');
  });
});

describe('extractCitedIndexes', () => {
  it('抽取答案中出现的角标序号', () => {
    expect(extractCitedIndexes('结论 A[^1]，结论 B[^3][^1]。')).toEqual(new Set([1, 3]));
    expect(extractCitedIndexes('没有角标')).toEqual(new Set());
  });
});

describe('generateAnswerWithGroundedness', () => {
  const citations = [{ index: 1, title: 'a.md', snippet: '证据', score: 0.8 }];

  it('无证据时不做核查', async () => {
    const verify = vi.fn();
    const result = await generateAnswerWithGroundedness({
      ctx: { question: 'q' },
      deps: { generate: async () => '答案', verify }
    });

    expect(result).toMatchObject({ answer: '答案', verification: null, supplemented: false });
    expect(verify).not.toHaveBeenCalled();
  });

  it('核查通过则不补充检索', async () => {
    const retrieveMore = vi.fn();
    const result = await generateAnswerWithGroundedness({
      ctx: { question: 'q', citations },
      deps: {
        generate: async () => '答案[^1]',
        verify: async () => ({ grounded: true, score: 1, unsupported: [], missingInfo: '', skipped: false }),
        retrieveMore
      }
    });

    expect(result.supplemented).toBe(false);
    expect(retrieveMore).not.toHaveBeenCalled();
  });

  it('核查被跳过时也不触发补充检索', async () => {
    const retrieveMore = vi.fn();
    await generateAnswerWithGroundedness({
      ctx: { question: 'q', citations },
      deps: {
        generate: async () => '答案',
        verify: async () => ({ grounded: false, score: 0, unsupported: [], missingInfo: '缺东西', skipped: true }),
        retrieveMore
      }
    });
    expect(retrieveMore).not.toHaveBeenCalled();
  });

  it('不达标时按缺失信息补充检索并追加输出', async () => {
    const deltas = [];
    const emit = { status: vi.fn() };
    let call = 0;

    const result = await generateAnswerWithGroundedness({
      ctx: { question: 'q', citations },
      emit,
      onDelta: (text) => deltas.push(text),
      deps: {
        generate: async (ctx, _signal, onDelta) => {
          call += 1;
          const text = call === 1 ? '初版答案' : '补充答案';
          onDelta?.(text);
          return text;
        },
        verify: async () => ({
          grounded: false,
          score: 0.2,
          unsupported: ['x'],
          missingInfo: '缺少实验数据',
          skipped: false
        }),
        retrieveMore: async () => ({ citations: [{ index: 1, title: 'b.md', snippet: '新证据', score: 0.7 }] })
      }
    });

    expect(result.supplemented).toBe(true);
    expect(result.answer).toContain('初版答案');
    expect(result.answer).toContain('补充答案');
    // 补充证据接着前面的序号编号，避免撞号
    expect(result.citations.map((c) => c.index)).toEqual([1, 2]);
    expect(deltas.some((text) => text.includes('补充（基于追加检索）'))).toBe(true);
    expect(emit.status).toHaveBeenCalledWith('verifying', {});
    expect(emit.status).toHaveBeenCalledWith('supplementing', { missingInfo: '缺少实验数据' });
  });

  it('补充检索没查到新证据时保持原答案', async () => {
    const result = await generateAnswerWithGroundedness({
      ctx: { question: 'q', citations },
      deps: {
        generate: async () => '初版答案',
        verify: async () => ({ grounded: false, score: 0.2, unsupported: [], missingInfo: '缺东西', skipped: false }),
        retrieveMore: async () => ({ citations: [] })
      }
    });

    expect(result.answer).toBe('初版答案');
    expect(result.supplemented).toBe(false);
  });
});
