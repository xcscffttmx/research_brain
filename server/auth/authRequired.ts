/**
 * JWT 鉴权中间件。
 * 从 Authorization: Bearer <token> 取 token -> 校验签名与过期 -> 挂到 req.user -> next。
 * 校验失败统一返回 401，不泄露具体原因（避免被枚举攻击面）。
 */

import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type JwtPayload } from './jwt.js';
import { getJwtSecret } from './authService.js';

export interface AuthedRequest extends Request {
  user?: { userId: string; username: string };
}

export function authRequired(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: '未提供登录凭证', code: 'UNAUTHORIZED' });
    return;
  }
  try {
    const payload: JwtPayload = verifyToken(token, getJwtSecret());
    req.user = { userId: payload.sub, username: payload.username };
    next();
  } catch {
    res.status(401).json({ error: '登录凭证无效或已过期', code: 'UNAUTHORIZED' });
  }
}
