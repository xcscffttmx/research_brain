/**
 * 认证接口：注册 / 登录 / 当前用户。
 * 对应后端 /api/auth/register | login | me。
 */

import { apiFetch, setAuth, clearAuth, type AuthUser } from './http';

export interface LoginResult {
  access_token: string;
  user: AuthUser;
}

interface ErrorPayload {
  error?: string;
  details?: string;
}

function formatError(payload: ErrorPayload, fallback: string): string {
  const message = payload.error || fallback;
  return payload.details ? `${message}\n${payload.details}` : message;
}

export async function register(username: string, password: string): Promise<AuthUser> {
  const response = await apiFetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(formatError(data, '注册失败'));
  }
  return data.user as AuthUser;
}

/** 登录成功即写入 token 与用户信息到本地存储 */
export async function login(username: string, password: string): Promise<LoginResult> {
  const response = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(formatError(data, '登录失败'));
  }
  setAuth(data.access_token, data.user as AuthUser);
  return { access_token: data.access_token, user: data.user as AuthUser };
}

/** 拉取当前用户（用于刷新时校验 token 是否仍有效） */
export async function fetchMe(): Promise<AuthUser> {
  const response = await apiFetch('/api/auth/me');
  const data = await response.json();
  if (!response.ok) {
    clearAuth();
    throw new Error(formatError(data, '登录已过期'));
  }
  return data.user as AuthUser;
}
