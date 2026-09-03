/**
 * 数据库行类型。
 *
 * 字段名与 schema.sql 的列名严格一致（snake_case），
 * 由 better-sqlite3 直接映射，不做驼峰转换，避免多一层心智负担。
 */

export interface SessionRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  /** Long-Term Context：更早历史的压缩摘要 */
  summary: string;
  /** 摘要已覆盖到第几条消息的 seq */
  summary_upto: number;
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: MessageRole;
  content: string;
  token_count: number;
  status: string;
  created_at: number;
}

export interface DocumentRow {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  char_count: number;
  source: string;
  content: string;
  created_at: number;
}

export interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  token_count: number;
  span_start: number;
  span_end: number;
  created_at: number;
}

export interface PaperRow {
  paper_id: string;
  source: string;
  title: string;
  abstract: string;
  /** JSON array 字符串 */
  authors: string;
  year: number | null;
  venue: string;
  url: string;
  pdf_url: string;
  citation_count: number | null;
  reference_count: number | null;
  cached_at: number;
}

export type AgentRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface AgentRunRow {
  id: string;
  session_id: string;
  message_id: string | null;
  status: AgentRunStatus | string;
  plan_json: string;
  error_code: string;
  error_msg: string;
  started_at: number;
  ended_at: number | null;
}

export type ToolCallStatus = 'pending' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';

export interface ToolCallRow {
  id: string;
  run_id: string;
  step_index: number;
  tool_name: string;
  args_json: string;
  result_json: string;
  status: ToolCallStatus | string;
  attempt: number;
  duration_ms: number;
  error_msg: string;
  started_at: number;
  ended_at: number | null;
}

export interface EvidenceRow {
  id: string;
  run_id: string;
  retrieval_hop: number;
  chunk_id: string | null;
  paper_id: string | null;
  snippet: string;
  vector_score: number | null;
  rerank_score: number | null;
  /** SQLite 无布尔类型，0/1 */
  cited: number;
  citation_index: number | null;
  created_at: number;
}

export interface QueryCacheRow {
  cache_key: string;
  payload: string;
  created_at: number;
  expires_at: number;
}
