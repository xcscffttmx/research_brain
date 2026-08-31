import { getDb } from '../db/client.js';
import { uid } from '../lib/utils.js';
import { touchSession } from './sessionRepo.js';

/** 取会话内下一个 seq */
function nextSeq(sessionId) {
  const row = getDb()
    .prepare('select coalesce(max(seq), 0) as maxSeq from messages where session_id = ?')
    .get(sessionId);
  return row.maxSeq + 1;
}

/**
 * 追加一条消息。
 * tokenCount 由调用方（Context Manager）预先算好，避免重复 tokenize。
 */
export function appendMessage({ sessionId, role, content, tokenCount = 0, status = 'done' }) {
  const db = getDb();
  const id = uid(role);
  const seq = nextSeq(sessionId);
  const now = Date.now();

  db.prepare(
    `insert into messages(id, session_id, seq, role, content, token_count, status, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, sessionId, seq, role, content, tokenCount, status, now);

  touchSession(sessionId);
  return getMessage(id);
}

export function getMessage(id) {
  return getDb().prepare('select * from messages where id = ?').get(id) || null;
}

/** 更新消息内容与 token 数（流式生成结束时回填） */
export function updateMessage(id, { content, tokenCount, status }) {
  const db = getDb();
  const current = getMessage(id);
  if (!current) return null;

  db.prepare('update messages set content = ?, token_count = ?, status = ? where id = ?').run(
    content ?? current.content,
    tokenCount ?? current.token_count,
    status ?? current.status,
    id
  );
  return getMessage(id);
}

/** 按 seq 升序列出会话全部消息 */
export function listMessages(sessionId) {
  return getDb()
    .prepare('select * from messages where session_id = ? order by seq asc')
    .all(sessionId);
}

/**
 * 取最近 N 条消息（Short-Term Context 用），返回结果仍按 seq 升序。
 */
export function listRecentMessages(sessionId, limit = 12) {
  const rows = getDb()
    .prepare('select * from messages where session_id = ? order by seq desc limit ?')
    .all(sessionId, limit);
  return rows.reverse();
}

/**
 * 取 seq 小于给定值的消息（Long-Term Context 压缩时用）。
 */
export function listMessagesBefore(sessionId, beforeSeq) {
  return getDb()
    .prepare('select * from messages where session_id = ? and seq < ? order by seq asc')
    .all(sessionId, beforeSeq);
}

/** 统计会话消息数与总 token 数 */
export function getSessionStats(sessionId) {
  return getDb()
    .prepare(
      `select count(*) as messageCount,
              coalesce(sum(token_count), 0) as totalTokens,
              coalesce(max(seq), 0) as maxSeq
       from messages where session_id = ?`
    )
    .get(sessionId);
}
