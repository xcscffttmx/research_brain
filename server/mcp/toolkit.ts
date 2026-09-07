/**
 * MCP 工具边界的公共辅助。
 *
 * 每个工具模块都要把业务返回值包成 MCP 的 content/structuredContent 结构，
 * 并把抛出的异常转成带 code 的错误响应，这里统一收口，避免各模块各写一份。
 */

import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export interface McpTextResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export interface AppErrorLike extends Error {
  code?: string;
  details?: string;
}

/**
 * 工具注册所需的最小服务端接口。
 *
 * MCP SDK 的 registerTool 泛型很重（要同时推导 input/output schema），
 * 直接用会让每个工具模块都被迫写一堆类型体操。这里只保留注册与连接两个方法，
 * 动态 payload 收敛在这一处 any。
 */
export interface McpToolServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTool: (name: string, config: unknown, handler: (args: any, extra?: any) => unknown) => void;
  connect: (transport: StdioServerTransport) => Promise<void>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

export function toAppError(error: unknown, fallbackMessage = '未知错误'): AppErrorLike {
  if (error instanceof Error) return error as AppErrorLike;
  return new Error(String(error || fallbackMessage)) as AppErrorLike;
}

/** 成功响应：文本用于人读，structuredContent 供调用方解析 */
export function toTextContent(value: unknown): McpTextResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: isRecord(value) ? value : { value }
  };
}

/** 失败响应：保留 code/details，供上层 HTTP 层映射成用户可见提示 */
export function toErrorContent(error: unknown): McpTextResult {
  const payload = toAppError(error);
  return {
    content: [
      {
        type: 'text',
        text: payload.details ? `${payload.message}\n${payload.details}` : payload.message
      }
    ],
    structuredContent: {
      code: payload.code || 'UNKNOWN_ERROR',
      message: payload.message,
      details: payload.details || ''
    },
    isError: true
  };
}
