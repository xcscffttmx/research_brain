/**
 * 密码哈希：使用 Node 内置 crypto.scrypt + 随机盐。
 *
 * 为什么用 scrypt / 为什么加盐（面试常问）：
 *  - 绝不能明文存密码；登录时是"校验哈希"，不是"解出密码"。
 *  - scrypt 是内存+CPU 双重代价的 KDF，抗暴力破解，比简单 SHA256 安全得多。
 *  - 加盐：每个用户独立随机盐，避免相同密码产出相同哈希（彩虹表失效）。
 *  - 校验用 timingSafeEqual，防时序侧信道。
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LEN = 64;
const SALT_LEN = 16;

/** 生成 hash 字符串，格式：`盐:哈希`（均 hex） */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN).toString('hex');
  const hash = scryptSync(password, salt, KEY_LEN).toString('hex');
  return `${salt}:${hash}`;
}

/** 校验密码：解析盐 -> 重算 -> 常数时间比较 */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, KEY_LEN);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
