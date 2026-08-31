import { getDb } from '../db/client.js';
import { uid } from '../lib/utils.js';

/** 开启一次 Agent run */
export function startRun({ sessionId, messageId = null, plan = [] }) {
  const db = getDb();
  const id = uid('run');
  db.prepare(
    `insert into agent_runs(id, session_id, message_id, status, plan_json, started_at)
     values (?, ?, ?, 'running', ?, ?)`
  ).run(id, sessionId, messageId, JSON.stringify(plan), Date.now());
  return getRun(id);
}

export function getRun(id) {
  const row = getDb().prepare('select * from agent_runs where id = ?').get(id);
  if (!row) return null;
  return { ...row, plan: safeParse(row.plan_json, []) };
}

/** Planner 产出计划后回填 */
export function updateRunPlan(id, plan) {
  getDb().prepare('update agent_runs set plan_json = ? where id = ?').run(JSON.stringify(plan), id);
  return getRun(id);
}

/** 关联该 run 产出的 assistant 消息 */
export function attachRunMessage(id, messageId) {
  getDb().prepare('update agent_runs set message_id = ? where id = ?').run(messageId, id);
}

/**
 * 结束一次 run。
 * @param {'succeeded'|'failed'|'cancelled'|'interrupted'} status
 */
export function finishRun(id, status, { errorCode = '', errorMsg = '' } = {}) {
  getDb()
    .prepare('update agent_runs set status = ?, error_code = ?, error_msg = ?, ended_at = ? where id = ?')
    .run(status, errorCode, errorMsg, Date.now(), id);
  return getRun(id);
}

/** 列出某会话的历史 run（用于前端回放） */
export function listRunsBySession(sessionId, limit = 20) {
  return getDb()
    .prepare('select * from agent_runs where session_id = ? order by started_at desc limit ?')
    .all(sessionId, limit)
    .map((row) => ({ ...row, plan: safeParse(row.plan_json, []) }));
}

// ---------- tool_calls ----------

/** 记录一次工具调用的开始 */
export function startToolCall({ runId, stepIndex, toolName, args = {}, attempt = 1 }) {
  const db = getDb();
  const id = uid('tool');
  db.prepare(
    `insert into tool_calls(id, run_id, step_index, tool_name, args_json, status, attempt, started_at)
     values (?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, runId, stepIndex, toolName, JSON.stringify(args), attempt, Date.now());
  return id;
}

/**
 * 结束一次工具调用。
 * @param {'succeeded'|'failed'|'timeout'|'cancelled'} status
 */
export function finishToolCall(id, status, { result = null, errorMsg = '' } = {}) {
  const db = getDb();
  const row = db.prepare('select started_at from tool_calls where id = ?').get(id);
  const endedAt = Date.now();
  const durationMs = row ? endedAt - row.started_at : 0;

  db.prepare(
    `update tool_calls
     set status = ?, result_json = ?, error_msg = ?, duration_ms = ?, ended_at = ?
     where id = ?`
  ).run(status, JSON.stringify(result), errorMsg, durationMs, endedAt, id);

  return { id, status, durationMs };
}

/** 列出某 run 的所有工具调用（回放用） */
export function listToolCalls(runId) {
  return getDb()
    .prepare('select * from tool_calls where run_id = ? order by step_index asc, started_at asc')
    .all(runId)
    .map((row) => ({
      ...row,
      args: safeParse(row.args_json, {}),
      result: safeParse(row.result_json, null)
    }));
}

function safeParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
