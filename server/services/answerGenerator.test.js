import { describe, it, expect, vi } from 'vitest';
import { buildAnswerMessages, consumeQwenStream, collectCitations } from './answerGenerator.js';

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
        read: async () => (index < chunks.length ? { value: chunks[index++], done: false } : { value: undefined, done: true })
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
      { result: { citations: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] } },
      { result: { citations: [{ id: 'b', title: 'B' }, { id: 'c', title: 'C' }] } }
    ]);
    expect(citations.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('结果里没有 citations 时返回空数组', () => {
    expect(collectCitations([{ result: { count: 1 } }, { result: null }])).toEqual([]);
    expect(collectCitations()).toEqual([]);
  });
});
