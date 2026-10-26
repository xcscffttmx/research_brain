/**
 * 极简 JWT（HS256）签发与校验，基于 Node 内置 crypto，零依赖。
 *
 * JWT 结构（面试必背）：
 *   header.payload.signature  三部分用 `.` 连接，各自 base64url 编码
 *   - header  : { "alg": "HS256", "typ": "JWT" }
 *   - payload : 业务声明 + 标准字段（sub 主体 / iat 签发时间 / exp 过期时间）
 *   - signature: HMAC-SHA256( base64url(header) + "." + base64url(payload), 密钥 )
 *
 * 为什么无状态：服务端不存会话，凭签名验 token 真伪，天然支持分布式。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const ALG = 'HS256';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function encode(segment: object): string {
  return base64url(JSON.stringify(segment));
}

function decode<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
}

export interface JwtPayload {
  /** 用户唯一标识 */
  sub: string;
  username: string;
  /** 签发时间（秒） */
  iat: number;
  /** 过期时间（秒） */
  exp: number;
}

/** 签发 token。expiresIn 单位秒，默认 7 天 */
export function signToken(
  payload: { sub: string; username: string },
  secret: string,
  expiresInSec = 7 * 24 * 3600
): string {
  const header = { alg: ALG, typ: 'JWT' };
  const body: JwtPayload = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSec
  };
  const signingInput = `${encode(header)}.${encode(body)}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

/** 校验 token：验签名 + 验过期，成功返回 payload，失败抛错 */
export function verifyToken(token: string, secret: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('INVALID_TOKEN');
  const [headerSeg, payloadSeg, signatureSeg] = parts;

  const expected = createHmac('sha256', secret).update(`${headerSeg}.${payloadSeg}`).digest('base64url');
  const a = Buffer.from(signatureSeg);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('INVALID_SIGNATURE');
  }

  const payload = decode<JwtPayload>(payloadSeg);
  if (payload.exp * 1000 < Date.now()) {
    throw new Error('TOKEN_EXPIRED');
  }
  return payload;
}
