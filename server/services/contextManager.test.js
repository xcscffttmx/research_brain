import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// 必须在导入仓储层之前指定内存库，getDb 首次调用即固化路径
process.env.SQLITE_PATH = ':memory:';
process.env.CONTEXT_MAX_TOKENS = '4000';

const { migrate } = await import('../db/migrate.js');
const { getDb } = await import('../db/client.js');
const sessionRepo = await import('../repositories/sessionRepo.js');
const messageRepo = await import('../repositories/messageRepo.js');
const {
  countTokens,
  computeBudget,
  selectShortTerm,
  fitSummary,
  compressHistory,
  buildContext,
  CONTEXT_CONSTANTS
} = await import('./contextManager.js');

function fakeQwen(text) {
  return vi.fn(async () => ({ choices: [{ message: { content: text } }] }));
}

/** 造一个带 n 条消息的会话 */
function seedSession(messageCount, { contentPrefix = '内容' } = {}) {
  const session = sessionRepo.createSession('测试会话');
  for (let index = 1; index <= messageCount; index++) {
    messageRepo.appendMessage({
      sessionId: session.id,
      role: index % 2 === 1 ? 'user' : 'assistant',
      content: `${contentPrefix}${index}`,
      tokenCount: 5
    });
  }
  return session;
}

beforeAll(() => {
  migrate({ verbose: false });
});

beforeEach(() => {
  const db = getDb();
  db.prepare('delete from sessions').run();
});

describe('countTokens', () => {
  it('空值算 0，中英文都能计数', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens(null)).toBe(0);
    expect(countTokens('hello world')).toBeGreaterThan(0);
    // 中文单字通常占多个 token，应明显多于同长度英文
    expect(countTokens('科研问答智能体')).toBeGreaterThan(countTokens('agent'));
  });
});

describe('computeBudget', () => {
  it('按安全系数与层级比例拆配额', () => {
    const budget = computeBudget(10_000);
    expect(budget.available).toBe(7_500);
    expect(budget.working).toBe(3_750);
    expect(budget.shortTerm).toBe(2_625);
    expect(budget.longTerm).toBe(1_125);
    expect(budget.working + budget.shortTerm + budget.longTerm).toBeLessThanOrEqual(budget.available);
  });

  it('不传参数时读环境变量', () => {
    expect(computeBudget().maxTokens).toBe(4_000);
  });
});

describe('selectShortTerm', () => {
  const messages = [
    { seq: 1, role: 'user', content: 'a', token_count: 10 },
    { seq: 2, role: 'assistant', content: 'b', token_count: 10 },
    { seq: 3, role: 'user', content: 'c', token_count: 10 }
  ];

  it('从最近往前塞，结果保持时间升序', () => {
    const result = selectShortTerm(messages, 25);
    expect(result.messages.map((m) => m.seq)).toEqual([2, 3]);
    expect(result.tokens).toBe(20);
  });

  it('预算充足时全部选中', () => {
    expect(selectShortTerm(messages, 1_000).messages).toHaveLength(3);
  });

  it('预算不足一条时返回空', () => {
    expect(selectShortTerm(messages, 1).messages).toEqual([]);
  });

  it('没有预存 token_count 时现场计数', () => {
    const result = selectShortTerm([{ seq: 1, role: 'user', content: '一段中文内容' }], 1_000);
    expect(result.tokens).toBeGreaterThan(0);
  });

  it('超长消息按字符上限截断', () => {
    const result = selectShortTerm([{ seq: 1, role: 'user', content: 'x'.repeat(5_000), token_count: 1 }], 1_000);
    expect(result.messages[0].renderedText.length).toBeLessThanOrEqual(CONTEXT_CONSTANTS.MESSAGE_CHARS_LIMIT + 10);
  });
});

describe('fitSummary', () => {
  it('预算够时原样返回', () => {
    const result = fitSummary('一句摘要。', 1_000);
    expect(result).toMatchObject({ text: '一句摘要。', truncated: false });
  });

  it('超预算时按句截断', () => {
    const summary = '第一句内容。第二句内容。第三句内容。';
    const result = fitSummary(summary, countTokens('第一句内容。') + 1);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('第一句内容。');
  });

  it('空摘要返回空', () => {
    expect(fitSummary('', 100)).toMatchObject({ text: '', tokens: 0 });
  });
});

describe('compressHistory', () => {
  it('未达触发条数时不压缩', async () => {
    const session = seedSession(4);
    const qwenFetch = fakeQwen('摘要');

    const result = await compressHistory({ sessionId: session.id, beforeSeq: 99, qwenFetch });
    expect(result).toMatchObject({ compressed: false, reason: 'BELOW_TRIGGER' });
    expect(qwenFetch).not.toHaveBeenCalled();
  });

  it('达到条数后压缩并落库 summary_upto', async () => {
    const session = seedSession(14);
    const result = await compressHistory({
      sessionId: session.id,
      beforeSeq: 15,
      qwenFetch: fakeQwen('- 用户在研究 RAG')
    });

    expect(result.compressed).toBe(true);
    expect(result.summaryUpto).toBe(14);
    expect(sessionRepo.getSession(session.id).summary).toBe('- 用户在研究 RAG');
    expect(sessionRepo.getSession(session.id).summary_upto).toBe(14);
  });

  it('只压缩 summary_upto 之后的增量', async () => {
    const session = seedSession(30);
    const qwenFetch = fakeQwen('新摘要');

    await compressHistory({ sessionId: session.id, beforeSeq: 31, summaryUpto: 15, qwenFetch });

    const prompt = qwenFetch.mock.calls[0][1].messages[1].content;
    expect(prompt).not.toContain('内容15');
    expect(prompt).toContain('内容16');
  });

  it('已有摘要会一并交给模型合并', async () => {
    const session = seedSession(14);
    const qwenFetch = fakeQwen('合并后摘要');

    await compressHistory({ sessionId: session.id, beforeSeq: 15, previousSummary: '旧摘要', qwenFetch });
    expect(qwenFetch.mock.calls[0][1].messages[1].content).toContain('旧摘要');
  });

  it('模型返回空时沿用旧摘要', async () => {
    const session = seedSession(14);
    const result = await compressHistory({
      sessionId: session.id,
      beforeSeq: 15,
      previousSummary: '旧摘要',
      qwenFetch: fakeQwen('   ')
    });

    expect(result).toMatchObject({ summary: '旧摘要', compressed: false, reason: 'EMPTY_SUMMARY' });
  });

  it('压缩失败不打断对话', async () => {
    const session = seedSession(14);
    const result = await compressHistory({
      sessionId: session.id,
      beforeSeq: 15,
      previousSummary: '旧摘要',
      qwenFetch: vi.fn(async () => {
        throw Object.assign(new Error('boom'), { code: 'QWEN_HTTP_ERROR' });
      })
    });

    expect(result).toMatchObject({ compressed: false, reason: 'QWEN_HTTP_ERROR', summary: '旧摘要' });
  });

  it('取消要向上抛出', async () => {
    const session = seedSession(14);
    await expect(
      compressHistory({
        sessionId: session.id,
        beforeSeq: 15,
        qwenFetch: vi.fn(async () => {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        })
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('persist 为 false 时不写库', async () => {
    const session = seedSession(14);
    await compressHistory({ sessionId: session.id, beforeSeq: 15, qwenFetch: fakeQwen('摘要'), persist: false });
    expect(sessionRepo.getSession(session.id).summary).toBe('');
  });
});

describe('buildContext', () => {
  it('新会话没有历史时 contextHint 为空', async () => {
    const session = sessionRepo.createSession();
    const result = await buildContext({ sessionId: session.id, question: '第一个问题', deps: { qwenFetch: fakeQwen('x') } });

    expect(result.contextHint).toBe('');
    expect(result.layers.shortTerm.count).toBe(0);
    expect(result.layers.working.tokens).toBeGreaterThan(0);
  });

  it('短会话只有【最近对话】段', async () => {
    const session = seedSession(4);
    const result = await buildContext({ sessionId: session.id, question: 'q', deps: { qwenFetch: fakeQwen('x') } });

    expect(result.contextHint).toContain('【最近对话】');
    expect(result.contextHint).not.toContain('【更早历史摘要】');
    expect(result.layers.shortTerm.count).toBe(4);
  });

  it('长会话触发压缩并同时给出摘要与近轮', async () => {
    const session = seedSession(60, { contentPrefix: '这是一段比较长的对话内容用于占用预算 ' });
    const result = await buildContext({
      sessionId: session.id,
      question: 'q',
      maxTokens: 2_000,
      deps: { qwenFetch: fakeQwen('- 用户在讨论向量检索') }
    });

    expect(result.layers.longTerm.compressed).toBe(true);
    expect(result.contextHint).toContain('【更早历史摘要】');
    expect(result.contextHint).toContain('【最近对话】');
    // Short-Term 受预算限制，不可能装下全部 60 条
    expect(result.layers.shortTerm.count).toBeLessThan(60);
  });

  it('各层用量不超过对应配额', async () => {
    const session = seedSession(40, { contentPrefix: '内容内容内容内容内容内容内容内容 ' });
    const result = await buildContext({
      sessionId: session.id,
      question: 'q',
      maxTokens: 3_000,
      deps: { qwenFetch: fakeQwen('摘要'.repeat(200)) }
    });

    expect(result.layers.shortTerm.tokens).toBeLessThanOrEqual(result.budget.shortTerm);
    expect(result.layers.longTerm.tokens).toBeLessThanOrEqual(result.budget.longTerm);
  });

  it('allowCompress 为 false 时不调用模型', async () => {
    const session = seedSession(30);
    const qwenFetch = fakeQwen('摘要');
    await buildContext({ sessionId: session.id, question: 'q', allowCompress: false, deps: { qwenFetch } });
    expect(qwenFetch).not.toHaveBeenCalled();
  });

  it('复用已落库的摘要，无新增历史时不再调模型', async () => {
    const session = seedSession(14);
    sessionRepo.updateSessionSummary(session.id, '已有摘要', 14);

    const qwenFetch = fakeQwen('不应被调用');
    const result = await buildContext({ sessionId: session.id, question: 'q', maxTokens: 4_000, deps: { qwenFetch } });

    expect(qwenFetch).not.toHaveBeenCalled();
    expect(result.contextHint).toContain('已有摘要');
  });

  it('没有 sessionId 时退化为只有 Working 层', async () => {
    const result = await buildContext({ sessionId: '', question: 'q', deps: { qwenFetch: fakeQwen('x') } });
    expect(result.contextHint).toBe('');
    expect(result.layers.shortTerm.scanned).toBe(0);
  });
});
