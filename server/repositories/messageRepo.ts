import { getDb } from '../db/client.js';
import { uid } from '../lib/utils.js';
import { touchSession } from './sessionRepo.js';
import type { MessageRole, MessageRow } from '../db/types.js';

export interface AppendMessageInput {
  sessionId: string;
  role: MessageRole;
  content: string;
  /** 由调用方（Context Manager）预先算好，避免重复 tokenize */
  tokenCount?: number;
  status?: string;
}

export interface UpdateMessageInput {
  content?: string;
  tokenCount?: number;
  status?: string;
}

export interface SessionStats {
  messageCount: number;
  totalTokens: number;
  maxSeq: number;
}

/** 取会话内下一个 seq */
function nextSeq(sessionId: string): number {
  const row = getDb()
    .prepare('select coalesce(max(seq), 0) as maxSeq from messages where session_id = ?')
    .get(sessionId) as { maxSeq: number };
  return row.maxSeq + 1;
}

/** 追加一条消息 */
export function appendMessage({
  sessionId,
  role,
  content,
  tokenCount = 0,
  status = 'done'
}: AppendMessageInput): MessageRow | null {
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

export function getMessage(id: string): MessageRow | null {
  return (getDb().prepare('select * from messages where id = ?').get(id) as MessageRow | undefined) || null;
}

/** 更新消息内容与 token 数（流式生成结束时回填） */
export function updateMessage(id: string, { content, tokenCount, status }: UpdateMessageInput): MessageRow | null {
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
export function listMessages(sessionId: string): MessageRow[] {
  return getDb().prepare('select * from messages where session_id = ? order by seq asc').all(sessionId) as MessageRow[];
}

/** 取最近 N 条消息（Short-Term Context 用），返回结果仍按 seq 升序 */
export function listRecentMessages(sessionId: string, limit = 12): MessageRow[] {
  const rows = getDb()
    .prepare('select * from messages where session_id = ? order by seq desc limit ?')
    .all(sessionId, limit) as MessageRow[];
  return rows.reverse();
}

/** 取 seq 小于给定值的消息（Long-Term Context 压缩时用） */
export function listMessagesBefore(sessionId: string, beforeSeq: number): MessageRow[] {
  return getDb()
    .prepare('select * from messages where session_id = ? and seq < ? order by seq asc')
    .all(sessionId, beforeSeq) as MessageRow[];
}

/** 统计会话消息数与总 token 数 */
export function getSessionStats(sessionId: string): SessionStats {
  return getDb()
    .prepare(
      `select count(*) as messageCount,
              coalesce(sum(token_count), 0) as totalTokens,
              coalesce(max(seq), 0) as maxSeq
       from messages where session_id = ?`
    )
    .get(sessionId) as SessionStats;
}
