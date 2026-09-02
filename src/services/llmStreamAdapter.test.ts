import { describe, it, expect } from 'vitest';
import { parseSseFrame, normalizeFrame, OutputGate, consumeSseStream, type StreamEvent } from './llmStreamAdapter';

// ---------- 测试工具 ----------

/** 构造一个 SSE 帧字符串 */
function frame(id: number, event: string, data: unknown) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 把字符串按指定字节长度切块，返回 ReadableStream —— 用于模拟网络分块 */
function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]);
    }
  });
}

/** 按固定字节数硬切，可能切断多字节字符——这是我们要验证的场景 */
function splitBytes(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.slice(i, i + size));
  }
  return out;
}

async function collect(stream: ReadableStream<Uint8Array>, options = {}) {
  const events: StreamEvent[] = [];
  const iterator = consumeSseStream(stream, options);
  let result = await iterator.next();
  while (!result.done) {
    events.push(result.value);
    result = await iterator.next();
  }
  return { events, stats: result.value };
}

// ---------- parseSseFrame ----------

describe('parseSseFrame', () => {
  it('解析标准三字段帧', () => {
    const parsed = parseSseFrame('id: 7\nevent: delta\ndata: {"text":"hi"}');
    expect(parsed).toEqual({ id: 7, event: 'delta', data: '{"text":"hi"}' });
  });

  it('支持多行 data 按 SSE 规范拼接', () => {
    const parsed = parseSseFrame('event: delta\ndata: line1\ndata: line2');
    expect(parsed?.data).toBe('line1\nline2');
  });

  it('忽略注释行', () => {
    const parsed = parseSseFrame(': this is a comment\nevent: ping\ndata: {}');
    expect(parsed?.event).toBe('ping');
  });

  it('只去掉冒号后的第一个空格，保留其余空格', () => {
    const parsed = parseSseFrame('event: delta\ndata:   leading');
    expect(parsed?.data).toBe('  leading');
  });

  it('没有 data 字段时返回 null', () => {
    expect(parseSseFrame('event: delta')).toBeNull();
  });

  it('id 非数字时置为 null 而不是 NaN', () => {
    const parsed = parseSseFrame('id: abc\nevent: delta\ndata: {}');
    expect(parsed?.id).toBeNull();
  });
});

// ---------- normalizeFrame ----------

describe('normalizeFrame', () => {
  it('delta 事件归一化', () => {
    expect(normalizeFrame('delta', '{"text":"你好"}')).toEqual({ type: 'delta', text: '你好' });
  });

  it('兼容旧协议的 token 事件', () => {
    expect(normalizeFrame('token', '{"token":"abc"}')).toEqual({ type: 'delta', text: 'abc' });
  });

  it('tool_call 归一化并补默认值', () => {
    const event = normalizeFrame('tool_call', '{"id":"t1","name":"search"}');
    expect(event).toEqual({ type: 'tool_call', id: 't1', name: 'search', args: {}, stepIndex: undefined });
  });

  it('status 事件把额外字段收进 detail', () => {
    const event = normalizeFrame('status', '{"stage":"retrieving","hop":2}');
    expect(event).toEqual({ type: 'status', stage: 'retrieving', detail: { hop: 2 } });
  });

  it('ping 不向下游透出', () => {
    expect(normalizeFrame('ping', '{"t":1}')).toBeNull();
  });

  it('data 不是合法 JSON 时返回 null 而不抛异常', () => {
    expect(normalizeFrame('delta', '{broken')).toBeNull();
  });

  it('未知事件类型返回 null', () => {
    expect(normalizeFrame('mystery', '{}')).toBeNull();
  });
});

// ---------- OutputGate ----------

describe('OutputGate seq 校验', () => {
  it('接受单调递增的 seq', () => {
    const gate = new OutputGate();
    expect(gate.acceptSeq(1)).toBe(true);
    expect(gate.acceptSeq(2)).toBe(true);
    expect(gate.acceptSeq(3)).toBe(true);
  });

  it('丢弃回退的 seq（重放帧）', () => {
    const gate = new OutputGate();
    gate.acceptSeq(5);
    expect(gate.acceptSeq(3)).toBe(false);
    expect(gate.getStats().droppedOutOfOrder).toBe(1);
  });

  it('丢弃重复的 seq', () => {
    const gate = new OutputGate();
    gate.acceptSeq(1);
    expect(gate.acceptSeq(1)).toBe(false);
  });

  it('允许跳号（中间帧丢失时不阻塞后续）', () => {
    const gate = new OutputGate();
    gate.acceptSeq(1);
    expect(gate.acceptSeq(10)).toBe(true);
  });

  it('关闭校验后不做 seq 检查', () => {
    const gate = new OutputGate({ enforceSeqOrder: false });
    gate.acceptSeq(5);
    expect(gate.acceptSeq(1)).toBe(true);
  });

  it('id 为 null 时放行（后端未带 id 的兼容路径）', () => {
    const gate = new OutputGate();
    gate.acceptSeq(5);
    expect(gate.acceptSeq(null)).toBe(true);
  });
});

describe('OutputGate 重复内容检测', () => {
  it('窗口未填满时不误判', () => {
    const gate = new OutputGate({ dedupeWindowSize: 20, dedupeThreshold: 2 });
    expect(gate.detectLoop('短文本')).toBe(false);
  });

  it('检测到重复循环输出', () => {
    const gate = new OutputGate({ dedupeWindowSize: 10, dedupeThreshold: 3 });
    const loop = '0123456789';
    // 每次推入完整窗口长度的相同内容，指纹会稳定命中
    expect(gate.detectLoop(loop)).toBe(false); // hits = 1
    expect(gate.detectLoop(loop)).toBe(false); // hits = 2
    expect(gate.detectLoop(loop)).toBe(true); // hits = 3 -> 触发
  });

  it('正常递进的文本不会误判为循环', () => {
    const gate = new OutputGate({ dedupeWindowSize: 10, dedupeThreshold: 3 });
    let triggered = false;
    for (const ch of 'abcdefghijklmnopqrstuvwxyz0123456789') {
      if (gate.detectLoop(ch)) triggered = true;
    }
    expect(triggered).toBe(false);
  });

  it('空文本直接放行', () => {
    const gate = new OutputGate({ dedupeWindowSize: 4, dedupeThreshold: 1 });
    expect(gate.detectLoop('')).toBe(false);
  });
});

// ---------- 跨块 UTF-8 解码（核心场景） ----------

describe('分块解码', () => {
  it('中文被硬切成多块时仍能正确还原', async () => {
    // "你好世界" 每个字 3 字节，按 1 字节切块必然切断字符
    const payload = frame(1, 'delta', { text: '你好世界' }) + frame(2, 'done', {});
    const chunks = splitBytes(payload, 1);

    const { events } = await collect(streamFromChunks(chunks));
    const delta = events.find((e) => e.type === 'delta');
    expect(delta).toEqual({ type: 'delta', text: '你好世界' });
  });

  it('emoji（4 字节字符）跨块也不乱码', async () => {
    const payload = frame(1, 'delta', { text: '搞定啦🎉🚀' }) + frame(2, 'done', {});
    const { events } = await collect(streamFromChunks(splitBytes(payload, 3)));
    const delta = events.find((e) => e.type === 'delta');
    expect(delta).toEqual({ type: 'delta', text: '搞定啦🎉🚀' });
  });

  it('一个帧跨多个 chunk 时能正确重组', async () => {
    const payload = frame(1, 'delta', { text: 'A'.repeat(200) }) + frame(2, 'done', {});
    const { events } = await collect(streamFromChunks(splitBytes(payload, 7)));
    const delta = events.find((e) => e.type === 'delta');
    expect((delta as any).text).toHaveLength(200);
  });

  it('多个帧挤在同一个 chunk 里能全部解出', async () => {
    const payload =
      frame(1, 'delta', { text: 'a' }) +
      frame(2, 'delta', { text: 'b' }) +
      frame(3, 'delta', { text: 'c' }) +
      frame(4, 'done', {});
    const { events } = await collect(streamFromChunks([new TextEncoder().encode(payload)]));
    const deltas = events.filter((e) => e.type === 'delta').map((e) => (e as any).text);
    expect(deltas).toEqual(['a', 'b', 'c']);
  });

  it('兼容 CRLF 分隔符', async () => {
    const payload =
      'id: 1\r\nevent: delta\r\ndata: {"text":"crlf"}\r\n\r\n' + 'id: 2\r\nevent: done\r\ndata: {}\r\n\r\n';
    const { events } = await collect(streamFromChunks([new TextEncoder().encode(payload)]));
    expect(events.find((e) => e.type === 'delta')).toEqual({ type: 'delta', text: 'crlf' });
  });
});

// ---------- Gate 在真实流里的行为 ----------

describe('Gate 集成行为', () => {
  it('乱序帧被丢弃，正常帧照常透出', async () => {
    const payload =
      frame(1, 'delta', { text: 'first' }) +
      frame(1, 'delta', { text: 'replay' }) + // 重复 seq，应丢弃
      frame(2, 'delta', { text: 'second' }) +
      frame(3, 'done', {});

    const { events, stats } = await collect(streamFromChunks([new TextEncoder().encode(payload)]));
    const texts = events.filter((e) => e.type === 'delta').map((e) => (e as any).text);
    expect(texts).toEqual(['first', 'second']);
    expect(stats?.droppedOutOfOrder).toBe(1);
  });

  it('检测到 loop 时主动中断并给出本地错误', async () => {
    const loop = 'x'.repeat(40);
    const payload =
      frame(1, 'delta', { text: loop }) +
      frame(2, 'delta', { text: loop }) +
      frame(3, 'delta', { text: loop }) +
      frame(4, 'delta', { text: '不该出现' }) +
      frame(5, 'done', {});

    const { events } = await collect(streamFromChunks([new TextEncoder().encode(payload)]), {
      dedupeWindowSize: 40,
      dedupeThreshold: 3
    });

    const error = events.find((e) => e.type === 'error') as any;
    expect(error?.code).toBe('STREAM_LOOP_DETECTED');
    expect(error?.local).toBe(true);

    const done = events.find((e) => e.type === 'done') as any;
    expect(done?.reason).toBe('interrupted');

    // loop 之后的内容不应透出
    expect(events.some((e) => e.type === 'delta' && (e as any).text === '不该出现')).toBe(false);
  });

  it('服务端未发 done 就断流，标记为 interrupted', async () => {
    const payload = frame(1, 'delta', { text: 'partial' });
    const { events } = await collect(streamFromChunks([new TextEncoder().encode(payload)]));
    const done = events.at(-1) as any;
    expect(done.type).toBe('done');
    expect(done.reason).toBe('interrupted');
  });

  it('正常收到 done 时标记为 complete', async () => {
    const payload = frame(1, 'delta', { text: 'ok' }) + frame(2, 'done', { citations: [{ id: 'c1' }] });
    const { events } = await collect(streamFromChunks([new TextEncoder().encode(payload)]));
    const done = events.at(-1) as any;
    expect(done.reason).toBe('complete');
    expect(done.citations).toHaveLength(1);
  });

  it('ping 心跳不透出但也不算 malformed', async () => {
    const payload = frame(1, 'ping', { t: 1 }) + frame(2, 'delta', { text: 'hi' }) + frame(3, 'done', {});
    const { events, stats } = await collect(streamFromChunks([new TextEncoder().encode(payload)]));
    expect(events.filter((e) => e.type === 'delta')).toHaveLength(1);
    expect(stats?.malformedFrames).toBe(0);
  });

  it('坏帧被计数但不中断整个流', async () => {
    const payload =
      frame(1, 'delta', { text: 'good' }) +
      'id: 2\nevent: delta\ndata: {broken json\n\n' +
      frame(3, 'delta', { text: 'still good' }) +
      frame(4, 'done', {});

    const { events, stats } = await collect(streamFromChunks([new TextEncoder().encode(payload)]));
    const texts = events.filter((e) => e.type === 'delta').map((e) => (e as any).text);
    expect(texts).toEqual(['good', 'still good']);
    expect(stats?.malformedFrames).toBe(1);
  });

  it('AbortSignal 触发时立刻停止并标记 aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const payload = frame(1, 'delta', { text: 'never' }) + frame(2, 'done', {});
    const { events } = await collect(streamFromChunks([new TextEncoder().encode(payload)]), {
      signal: controller.signal
    });
    expect(events).toEqual([{ type: 'done', reason: 'aborted' }]);
  });

  it('stall 超时被判定为 interrupted', async () => {
    // 构造一个永远不产出数据的流
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        // 永不 enqueue、永不 close
        return new Promise(() => {});
      }
    });

    const { events } = await collect(stalled, { stallTimeoutMs: 50 });
    const error = events.find((e) => e.type === 'error') as any;
    expect(error?.code).toBe('STREAM_STALLED');
    expect((events.at(-1) as any).reason).toBe('interrupted');
  });
});

// ---------- 统计口径 ----------

describe('Gate 统计', () => {
  it('统计接收帧数与各类丢弃数', async () => {
    const payload = frame(1, 'delta', { text: 'a' }) + frame(1, 'delta', { text: 'replay' }) + frame(2, 'done', {});
    const { stats } = await collect(streamFromChunks([new TextEncoder().encode(payload)]));
    expect(stats?.receivedFrames).toBe(3);
    expect(stats?.droppedOutOfOrder).toBe(1);
  });
});
