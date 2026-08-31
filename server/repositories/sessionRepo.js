import { getDb } from '../db/client.js';
import { uid } from '../lib/utils.js';

/** 新建会话 */
export function createSession(title = '新对话') {
  const db = getDb();
  const now = Date.now();
  const id = uid('session');
  db.prepare(
    `insert into sessions(id, title, created_at, updated_at, summary, summary_upto)
     values (?, ?, ?, ?, '', 0)`
  ).run(id, title, now, now);
  return getSession(id);
}

/**
 * 幂等创建：会话 id 由前端生成时使用。
 * agent_runs / messages 都有 session_id 外键，落库前必须先保证会话行存在。
 */
export function ensureSession(id, title = '新对话') {
  const existing = getSession(id);
  if (existing) return existing;

  const now = Date.now();
  getDb()
    .prepare(
      `insert into sessions(id, title, created_at, updated_at, summary, summary_upto)
       values (?, ?, ?, ?, '', 0)`
    )
    .run(id, title, now, now);
  return getSession(id);
}

/** 按 id 取会话 */
export function getSession(id) {
  return getDb().prepare('select * from sessions where id = ?').get(id) || null;
}

/** 列出所有会话，最近更新的在前 */
export function listSessions(limit = 50) {
  return getDb()
    .prepare('select * from sessions order by updated_at desc limit ?')
    .all(limit);
}

/** 更新标题并刷新 updated_at */
export function renameSession(id, title) {
  getDb()
    .prepare('update sessions set title = ?, updated_at = ? where id = ?')
    .run(title, Date.now(), id);
  return getSession(id);
}

/** 仅刷新 updated_at（有新消息时调用） */
export function touchSession(id) {
  getDb().prepare('update sessions set updated_at = ? where id = ?').run(Date.now(), id);
}

/**
 * 写入 Long-Term Context 的压缩摘要。
 * summaryUpto 表示该摘要已覆盖到第几条消息的 seq，便于增量压缩时跳过已处理部分。
 */
export function updateSessionSummary(id, summary, summaryUpto) {
  getDb()
    .prepare('update sessions set summary = ?, summary_upto = ?, updated_at = ? where id = ?')
    .run(summary, summaryUpto, Date.now(), id);
  return getSession(id);
}

/** 删除会话（messages / agent_runs 通过外键级联删除） */
export function deleteSession(id) {
  const info = getDb().prepare('delete from sessions where id = ?').run(id);
  return info.changes > 0;
}
