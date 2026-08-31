/**
 * LLM Stream Adapter —— 统一处理服务端 SSE 推流。
 *
 * 职责：
 *   1. 基于 ReadableStream + TextDecoder 做分块解码，正确处理跨块的多字节 UTF-8
 *   2. 把原始 SSE 帧归一化成统一事件模型，屏蔽后端协议细节
 *   3. 输出 Gate：拦截异常中断、重复内容、乱序帧，保证下游拿到的是干净流
 */

/** 统一事件模型 */
export type StreamEventType =
  | 'delta'
  | 'tool_call'
  | 'tool_result'
  | 'status'
  | 'usage'
  | 'error'
  | 'done';

export interface StreamDeltaEvent {
  type: 'delta';
  text: string;
}

export interface StreamToolCallEvent {
  type: 'tool_call';
  id: string;
  name: string;
  args: Record<string, unknown>;
  stepIndex?: number;
}

export interface StreamToolResultEvent {
  type: 'tool_result';
  id: string;
  name: string;
  status: 'succeeded' | 'failed' | 'timeout' | 'cancelled';
  result?: unknown;
  errorMsg?: string;
  durationMs?: number;
}

export interface StreamStatusEvent {
  type: 'status';
  stage: string;
  detail?: Record<string, unknown>;
}

export interface StreamUsageEvent {
  type: 'usage';
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface StreamErrorEvent {
  type: 'error';
  code: string;
  message: string;
  details?: string;
  /** 是否由 Gate 判定的本地错误（而非服务端下发） */
  local?: boolean;
}

export interface StreamDoneEvent {
  type: 'done';
  reason: 'complete' | 'interrupted' | 'aborted' | 'error';
  citations?: unknown[];
  tools?: unknown[];
}

export type StreamEvent =
  | StreamDeltaEvent
  | StreamToolCallEvent
  | StreamToolResultEvent
  | StreamStatusEvent
  | StreamUsageEvent
  | StreamErrorEvent
  | StreamDoneEvent;

export interface GateOptions {
  /** 多久没收到任何帧（含心跳）就判定连接假死，默认 30s */
  stallTimeoutMs?: number;
  /** 重复内容检测的滑动窗口长度（字符数），默认 80 */
  dedupeWindowSize?: number;
  /** 同一指纹重复多少次就判定模型进入 loop，默认 3 */
  dedupeThreshold?: number;
  /** 是否启用 seq 单调递增校验，默认 true */
  enforceSeqOrder?: boolean;
}

export interface StreamAdapterOptions extends GateOptions {
  signal?: AbortSignal;
  /** 覆盖 fetch 实现，便于测试注入 */
  fetchImpl?: typeof fetch;
}

export interface GateStats {
  receivedFrames: number;
  droppedOutOfOrder: number;
  droppedDuplicate: number;
  malformedFrames: number;
}

interface ParsedFrame {
  id: number | null;
  event: string;
  data: string;
}

const DEFAULT_GATE: Required<GateOptions> = {
  stallTimeoutMs: 30_000,
  dedupeWindowSize: 80,
  dedupeThreshold: 3,
  enforceSeqOrder: true
};

/**
 * 解析单个 SSE 帧。
 * 支持多行 data（按 SSE 规范用 \n 拼接），忽略注释行（以 : 开头）。
 */
export function parseSseFrame(raw: string): ParsedFrame | null {
  const lines = raw.split('\n');
  let id: number | null = null;
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colonIndex = line.indexOf(':');
    if (colonIndex < 0) continue;

    const field = line.slice(0, colonIndex).trim();
    // SSE 规范：冒号后若有一个空格需去掉，其余保留
    let value = line.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'id') {
      const parsed = Number(value.trim());
      id = Number.isFinite(parsed) ? parsed : null;
    } else if (field === 'event') {
      event = value.trim() || 'message';
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (!dataLines.length) return null;
  return { id, event, data: dataLines.join('\n') };
}

/**
 * 输出 Gate —— 流的守门人。
 *
 * 三类拦截：
 *   1. 乱序/重放：seq 必须单调递增，否则丢弃
 *   2. 重复内容：滑动窗口指纹连续命中阈值时判定模型 loop，触发中断
 *   3. 连接假死：超过 stallTimeout 未收到任何帧（含心跳）则判定 interrupted
 */
export class OutputGate {
  private options: Required<GateOptions>;
  private lastSeq = 0;
  private window = '';
  private fingerprintHits = new Map<string, number>();
  private stats: GateStats = {
    receivedFrames: 0,
    droppedOutOfOrder: 0,
    droppedDuplicate: 0,
    malformedFrames: 0
  };

  constructor(options: GateOptions = {}) {
    this.options = { ...DEFAULT_GATE, ...options };
  }

  /** seq 校验：返回 false 表示应丢弃该帧 */
  acceptSeq(id: number | null): boolean {
    this.stats.receivedFrames++;
    if (!this.options.enforceSeqOrder || id === null) return true;
    if (id <= this.lastSeq) {
      this.stats.droppedOutOfOrder++;
      return false;
    }
    this.lastSeq = id;
    return true;
  }

  /**
   * 重复内容检测。
   * 把增量文本推入滑动窗口，对窗口内容取指纹；同一指纹命中次数达到阈值即判定 loop。
   * 返回 true 表示检测到 loop，调用方应中断流。
   */
  detectLoop(text: string): boolean {
    if (!text) return false;
    const { dedupeWindowSize, dedupeThreshold } = this.options;

    this.window = (this.window + text).slice(-dedupeWindowSize);
    // 窗口未填满时不做判断，避免开头的短重复误伤
    if (this.window.length < dedupeWindowSize) return false;

    const fingerprint = hashString(this.window);
    const hits = (this.fingerprintHits.get(fingerprint) || 0) + 1;
    this.fingerprintHits.set(fingerprint, hits);

    if (hits >= dedupeThreshold) {
      this.stats.droppedDuplicate++;
      return true;
    }
    return false;
  }

  markMalformed() {
    this.stats.malformedFrames++;
  }

  get stallTimeoutMs() {
    return this.options.stallTimeoutMs;
  }

  getStats(): GateStats {
    return { ...this.stats };
  }
}

/** 轻量字符串哈希（FNV-1a 变体），够用于指纹去重 */
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** 把 SSE 帧的 event + data 映射成统一事件；无法识别时返回 null */
export function normalizeFrame(event: string, data: string): StreamEvent | null {
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }

  switch (event) {
    case 'delta':
      // 兼容旧协议的 token 字段
      return { type: 'delta', text: String(payload.text ?? payload.token ?? '') };
    case 'token':
      return { type: 'delta', text: String(payload.token ?? payload.text ?? '') };
    case 'tool_call':
      return {
        type: 'tool_call',
        id: String(payload.id ?? ''),
        name: String(payload.name ?? ''),
        args: payload.args ?? {},
        stepIndex: payload.stepIndex
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        id: String(payload.id ?? ''),
        name: String(payload.name ?? ''),
        status: payload.status ?? 'succeeded',
        result: payload.result,
        errorMsg: payload.errorMsg,
        durationMs: payload.durationMs
      };
    case 'status': {
      const { stage, ...detail } = payload;
      return { type: 'status', stage: String(stage ?? 'unknown'), detail };
    }
    case 'usage':
      return {
        type: 'usage',
        promptTokens: payload.promptTokens,
        completionTokens: payload.completionTokens,
        totalTokens: payload.totalTokens
      };
    case 'error':
      return {
        type: 'error',
        code: String(payload.code ?? 'UNKNOWN'),
        message: String(payload.message ?? '请求失败'),
        details: payload.details
      };
    case 'done':
      return {
        type: 'done',
        reason: 'complete',
        citations: payload.citations ?? [],
        tools: payload.tools ?? []
      };
    case 'ping':
      // 心跳只用于刷新 stall 计时，不向下游透出
      return null;
    default:
      return null;
  }
}

/**
 * 消费一个 SSE 字节流，产出统一事件。
 *
 * 为什么用 AsyncGenerator 而不是回调：调用方可以用 for await 自然地处理背压，
 * 也更容易在测试里逐个断言事件。
 *
 * @param body      响应体流
 * @param options   Gate 参数与 AbortSignal
 */
export async function* consumeSseStream(
  body: ReadableStream<Uint8Array>,
  options: StreamAdapterOptions = {}
): AsyncGenerator<StreamEvent, GateStats, void> {
  const gate = new OutputGate(options);
  const reader = body.getReader();
  // stream: true 是关键 —— 保证跨块的多字节 UTF-8 字符不会被截断成乱码
  const decoder = new TextDecoder('utf-8');

  let buffer = '';
  let finished = false;

  /** 竞速：要么读到数据，要么 stall 超时 */
  async function readWithStallGuard() {
    const stallMs = gate.stallTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stall = new Promise<'stalled'>((resolve) => {
      timer = setTimeout(() => resolve('stalled'), stallMs);
    });
    try {
      return await Promise.race([reader.read(), stall]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  try {
    while (!finished) {
      if (options.signal?.aborted) {
        await reader.cancel().catch(() => {});
        yield { type: 'done', reason: 'aborted' };
        break;
      }

      const outcome = await readWithStallGuard();

      // Gate 拦截 1：连接假死
      if (outcome === 'stalled') {
        await reader.cancel().catch(() => {});
        yield {
          type: 'error',
          code: 'STREAM_STALLED',
          message: `连接假死：${gate.stallTimeoutMs}ms 未收到任何数据`,
          local: true
        };
        yield { type: 'done', reason: 'interrupted' };
        break;
      }

      const { value, done } = outcome as ReadableStreamReadResult<Uint8Array>;

      if (done) {
        // flush 解码器残留字节
        buffer += decoder.decode();
        const tail = extractFrames(buffer);
        buffer = tail.rest;
        for (const frame of tail.frames) {
          const event = processFrame(frame, gate);
          if (event) yield event;
        }
        // 服务端未发 done 就断了，视为中断
        yield { type: 'done', reason: 'interrupted' };
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = extractFrames(buffer);
      buffer = rest;

      for (const frame of frames) {
        const event = processFrame(frame, gate);
        if (!event) continue;

        // Gate 拦截 2：模型 loop
        if (event.type === 'delta' && gate.detectLoop(event.text)) {
          await reader.cancel().catch(() => {});
          yield {
            type: 'error',
            code: 'STREAM_LOOP_DETECTED',
            message: '检测到模型重复输出，已主动中断',
            local: true
          };
          yield { type: 'done', reason: 'interrupted' };
          finished = true;
          break;
        }

        yield event;

        if (event.type === 'done') {
          finished = true;
          break;
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  return gate.getStats();
}

/** 从缓冲里切出完整帧（以空行分隔），剩余部分留在 buffer 等下一块 */
function extractFrames(buffer: string): { frames: string[]; rest: string } {
  // 同时兼容 \n\n 与 \r\n\r\n
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';
  return { frames: parts.filter((p) => p.trim().length > 0), rest };
}

/** 单帧处理：解析 -> seq 校验 -> 归一化 */
function processFrame(raw: string, gate: OutputGate): StreamEvent | null {
  const parsed = parseSseFrame(raw);
  if (!parsed) {
    gate.markMalformed();
    return null;
  }

  // Gate 拦截 3：乱序/重放帧
  if (!gate.acceptSeq(parsed.id)) return null;

  const event = normalizeFrame(parsed.event, parsed.data);
  if (!event) {
    // ping 等已知的非透出事件不算 malformed
    if (parsed.event !== 'ping') gate.markMalformed();
    return null;
  }
  return event;
}

/**
 * 面向业务的入口：发起请求并返回统一事件流。
 */
export async function* streamAgentChat(
  payload: Record<string, unknown>,
  options: StreamAdapterOptions = {}
): AsyncGenerator<StreamEvent, GateStats | void, void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options.signal
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    yield {
      type: 'error',
      code: 'HTTP_ERROR',
      message: text || `请求失败：${response.status}`,
      local: true
    };
    yield { type: 'done', reason: 'error' };
    return;
  }

  return yield* consumeSseStream(response.body, options);
}
