/**
 * 统一的应用错误对象工厂。
 *
 * 字段与 mcp-server 最初的实现保持一致：
 *   - code:    上层可识别的错误码（如 'RATE_LIMITED'）
 *   - details: 面向用户的补充说明
 *   - status:  对应的 HTTP 状态码
 */

export interface AppError extends Error {
  code: string;
  details: string;
  status: number;
}

export function createAppError(code: string, message: string, details = '', status = 500): AppError {
  const error = new Error(message) as AppError;
  error.code = code;
  error.details = details;
  error.status = status;
  return error;
}

/** unknown 异常里安全读取 name，用于区分取消与真实故障 */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

/** unknown 异常里安全读取自定义 code */
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : '';
  }
  return '';
}

export function isAbortError(error: unknown): boolean {
  return errorName(error) === 'AbortError';
}
