/**
 * 统一的应用错误对象工厂。
 *
 * 保持与 mcp-server.js 原始实现完全一致的字段：
 *   - code:    上层可识别的错误码（如 'RATE_LIMITED'）
 *   - details: 面向用户的补充说明
 *   - status:  对应的 HTTP 状态码
 */
export function createAppError(code, message, details = '', status = 500) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.status = status;
  return error;
}
