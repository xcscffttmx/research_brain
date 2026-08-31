/**
 * SSE 帧写入器 —— 规范化服务端推流格式。
 *
 * 帧格式约定：
 *   id: <seq>            单调递增序号，前端据此丢弃乱序/重放帧
 *   event: <type>        事件类型
 *   data: <json>         单行 JSON（内部换行已转义，避免多行 data 解析歧义）
 *
 * 统一事件类型：
 *   delta        增量文本
 *   tool_call    工具开始调用
 *   tool_result  工具返回结果
 *   status       状态变更（planning / retrieving / generating / verifying …）
 *   usage        token 用量
 *   error        错误
 *   done         结束
 *   ping         心跳（前端用于判断连接是否假死）
 */

/** 心跳间隔：需小于前端 Gate 的 stallTimeout，否则会被误判为中断 */
const HEARTBEAT_INTERVAL_MS = 10_000;

export function createSseWriter(res, { heartbeatMs = HEARTBEAT_INTERVAL_MS } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 关闭 Nginx 等反代的缓冲，否则流式会被攒批
    'X-Accel-Buffering': 'no'
  });

  let seq = 0;
  let closed = false;

  const heartbeat = setInterval(() => {
    if (closed) return;
    send('ping', { t: Date.now() });
  }, heartbeatMs);

  function send(event, payload) {
    if (closed) return false;
    seq += 1;
    // JSON.stringify 已转义换行，保证 data 恒为单行
    const line = `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    try {
      res.write(line);
      return true;
    } catch {
      // 客户端已断开
      close();
      return false;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      res.end();
    } catch {
      // 忽略重复 end
    }
  }

  // 客户端主动断开时清理心跳，避免定时器泄漏
  res.on?.('close', close);

  return {
    /** 增量文本 */
    delta: (text) => send('delta', { text }),
    /** 工具开始调用 */
    toolCall: (payload) => send('tool_call', payload),
    /** 工具返回 */
    toolResult: (payload) => send('tool_result', payload),
    /** 状态变更 */
    status: (stage, detail = {}) => send('status', { stage, ...detail }),
    /** token 用量 */
    usage: (payload) => send('usage', payload),
    /** 错误（发送后不自动 close，由调用方决定是否继续） */
    error: (payload) => send('error', payload),
    /** 结束并关闭连接 */
    done: (payload = {}) => {
      send('done', payload);
      close();
    },
    /** 通用发送（自定义事件） */
    send,
    close,
    get seq() {
      return seq;
    },
    get closed() {
      return closed;
    }
  };
}
