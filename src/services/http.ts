/**
 * 统一 HTTP 请求封装。
 * 职责：
 *  - 自动从本地存储取 token，拼到 Authorization: Bearer <token>
 *  - 收到 401 时清理登录态并跳转登录页（token 过期 / 未登录的统一处理）
 *  - 让上层（qwen.ts 等）不再手写 header，一处收口
 */

export interface AuthUser {
  id: string;
  username: string;
  createdAt: number;
}

const TOKEN_KEY = 'research_brain_token';
const USER_KEY = 'research_brain_user';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuth(token: string, user: AuthUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** 未登录时统一跳转登录页 */
function redirectToLogin(): void {
  if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.assign('/login');
  }
}

interface ApiFetchOptions extends RequestInit {
  /** 走 GET 等需要 JSON 解析之外的场景可覆盖 */
  skipJson?: boolean;
}

/**
 * 带 token 的 fetch 封装。返回原始 Response，上层自行解析 JSON。
 * 401 时自动清理登录态并跳转登录页。
 */
export async function apiFetch(url: string, options: ApiFetchOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  // 只有发送 JSON body 时才设 Content-Type；FormData 交给浏览器自动设置 multipart
  if (options.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    clearAuth();
    redirectToLogin();
  }
  return response;
}
