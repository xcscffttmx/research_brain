/**
 * 认证业务：注册 / 登录 / 当前用户。
 * 与协议层（Express 路由）和仓储层（userRepo）解耦，方便单测。
 */

import { createAppError } from '../lib/errors.js';
import * as userRepo from '../repositories/userRepo.js';
import { hashPassword, verifyPassword } from './password.js';
import { signToken } from './jwt.js';

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  // 仅本地开发兜底；生产环境必须显式配置
  if (process.env.NODE_ENV !== 'production') {
    console.warn('[auth] 未配置 JWT_SECRET，使用本地开发默认值，生产环境请务必设置。');
    return 'dev-only-insecure-secret';
  }
  throw createAppError('AUTH_CONFIG', '缺少 JWT_SECRET', '请在 .env.local 配置 JWT_SECRET。', 500);
}

export interface PublicUser {
  id: string;
  username: string;
  createdAt: number;
}

function toPublic(row: { id: string; username: string; created_at: number }): PublicUser {
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

/** 注册：校验 -> 查重 -> 哈希 -> 落库。用户名不可重复 */
export function register(username: string, password: string): PublicUser {
  const name = String(username || '').trim();
  const pwd = String(password || '');
  if (name.length < 2 || name.length > 32) {
    throw createAppError('INVALID_USERNAME', '用户名不合法', '用户名长度需在 2-32 个字符之间。', 400);
  }
  if (pwd.length < 6) {
    throw createAppError('INVALID_PASSWORD', '密码过短', '密码至少 6 位。', 400);
  }
  if (userRepo.findByUsername(name)) {
    throw createAppError('USER_EXISTS', '用户名已存在', '请换一个用户名。', 409);
  }
  const user = userRepo.createUser(name, hashPassword(pwd));
  return toPublic(user);
}

/** 登录：查用户 -> 校验密码 -> 签发 JWT */
export function login(username: string, password: string): { access_token: string; user: PublicUser } {
  const user = userRepo.findByUsername(String(username || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    throw createAppError('INVALID_CREDENTIALS', '用户名或密码错误', '', 401);
  }
  const token = signToken({ sub: user.id, username: user.username }, getJwtSecret());
  return { access_token: token, user: toPublic(user) };
}

/** 根据 token 中的 sub 取当前用户（供 /api/auth/me 与受保护接口使用） */
export function me(userId: string): PublicUser | undefined {
  const user = userRepo.findById(userId);
  return user ? toPublic(user) : undefined;
}
