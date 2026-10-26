/**
 * 用户仓储层：users 表的读写。
 * 纯数据访问，不含业务/密码逻辑（密码哈希在 auth/password.ts，业务在 authService）。
 */

import { getDb } from '../db/client.js';
import { uid } from '../lib/utils.js';
import type { UserRow } from '../db/types.js';

export function createUser(username: string, passwordHash: string): UserRow {
  const id = uid('user');
  const now = Date.now();
  getDb()
    .prepare(`insert into users(id, username, password_hash, created_at) values (?, ?, ?, ?)`)
    .run(id, username, passwordHash, now);
  return { id, username, password_hash: passwordHash, created_at: now };
}

export function findByUsername(username: string): UserRow | undefined {
  return getDb().prepare('select * from users where username = ?').get(username) as UserRow | undefined;
}

export function findById(id: string): UserRow | undefined {
  return getDb().prepare('select * from users where id = ?').get(id) as UserRow | undefined;
}
