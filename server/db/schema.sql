-- 科研问答 Agent 平台 —— SQLite schema
-- 说明：
--   * 向量检索依赖 sqlite-vec 的 vec0 虚拟表，distance_metric=cosine
--   * embedding 维度按 DashScope text-embedding-v3 默认 1024
--   * 所有时间戳统一用 INTEGER 存 epoch 毫秒，避免时区问题

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- 会话与消息（分层 Context 的持久化基础） ----------

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT '新对话',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- Long-Term Context：更早历史的压缩摘要，避免重复调用模型
  summary       TEXT NOT NULL DEFAULT '',
  summary_upto  INTEGER NOT NULL DEFAULT 0  -- 摘要覆盖到第几条消息的 seq
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,            -- 会话内单调递增序号
  role        TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content     TEXT NOT NULL DEFAULT '',
  token_count INTEGER NOT NULL DEFAULT 0,  -- 预计算 token 数，供 Token Budget 用
  status      TEXT NOT NULL DEFAULT 'done',
  created_at  INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);

-- ---------- 个人知识库 ----------

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  mime_type   TEXT NOT NULL DEFAULT '',
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  char_count  INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT 'upload', -- upload | literature
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL,
  text         TEXT NOT NULL,
  token_count  INTEGER NOT NULL DEFAULT 0,
  -- 供证据溯源：该分块在原文中的字符区间
  span_start   INTEGER NOT NULL DEFAULT 0,
  span_end     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

-- vec0 虚拟表：rowid 与 chunk_vec_map.rowid 对应
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
  embedding float[1024] distance_metric=cosine
);

-- vec0 的 rowid 只能是整数，这里做 chunk_id <-> rowid 的映射
CREATE TABLE IF NOT EXISTS chunk_vec_map (
  rowid    INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL UNIQUE REFERENCES chunks(id) ON DELETE CASCADE
);

-- ---------- 文献检索缓存与结构化抽取 ----------

CREATE TABLE IF NOT EXISTS papers (
  paper_id        TEXT NOT NULL,
  source          TEXT NOT NULL,           -- arxiv | semantic_scholar | openalex
  title           TEXT NOT NULL DEFAULT '',
  abstract        TEXT NOT NULL DEFAULT '',
  authors         TEXT NOT NULL DEFAULT '[]',  -- JSON array
  year            INTEGER,
  venue           TEXT NOT NULL DEFAULT '',
  url             TEXT NOT NULL DEFAULT '',
  pdf_url         TEXT NOT NULL DEFAULT '',
  citation_count  INTEGER,
  reference_count INTEGER,
  cached_at       INTEGER NOT NULL,
  PRIMARY KEY (source, paper_id)
);

CREATE TABLE IF NOT EXISTS paper_schemas (
  paper_id    TEXT PRIMARY KEY,
  schema_json TEXT NOT NULL,               -- 结构化抽取结果
  created_at  INTEGER NOT NULL
);

-- 上游检索结果的 TTL 缓存，降低 429 概率
CREATE TABLE IF NOT EXISTS query_cache (
  cache_key   TEXT PRIMARY KEY,            -- hash(query|source|sinceYear|untilYear)
  payload     TEXT NOT NULL,               -- JSON
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_query_cache_expires ON query_cache(expires_at);

-- ---------- Agent Runtime 可观测与回放 ----------

CREATE TABLE IF NOT EXISTS agent_runs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id  TEXT,                        -- 该 run 产出的 assistant 消息
  status      TEXT NOT NULL DEFAULT 'running',
                                           -- running | succeeded | failed | cancelled | interrupted
  plan_json   TEXT NOT NULL DEFAULT '[]',  -- Planner 产出的结构化计划
  error_code  TEXT NOT NULL DEFAULT '',
  error_msg   TEXT NOT NULL DEFAULT '',
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, started_at);

CREATE TABLE IF NOT EXISTS tool_calls (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_index   INTEGER NOT NULL,
  tool_name    TEXT NOT NULL,
  args_json    TEXT NOT NULL DEFAULT '{}',
  result_json  TEXT NOT NULL DEFAULT 'null',
  status       TEXT NOT NULL DEFAULT 'pending',
                                            -- pending | succeeded | failed | timeout | cancelled
  attempt      INTEGER NOT NULL DEFAULT 1,  -- 第几次重试
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  error_msg    TEXT NOT NULL DEFAULT '',
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id, step_index);

-- ---------- Agentic RAG 证据溯源 ----------

CREATE TABLE IF NOT EXISTS evidence (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  retrieval_hop INTEGER NOT NULL DEFAULT 1,   -- 第几轮检索召回的
  chunk_id      TEXT REFERENCES chunks(id) ON DELETE SET NULL,
  paper_id      TEXT,                          -- 来自在线文献时填这里
  snippet       TEXT NOT NULL DEFAULT '',      -- 实际喂给模型的原文片段
  vector_score  REAL,                          -- 向量召回相似度
  rerank_score  REAL,                          -- Reranker 精排分
  cited         INTEGER NOT NULL DEFAULT 0,     -- 是否最终被答案引用
  citation_index INTEGER,                       -- 答案中的 [^n] 序号
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id, retrieval_hop);

-- ---------- 迁移版本记录 ----------

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
