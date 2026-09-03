import { getDb } from '../db/client.js';
import { uid } from '../lib/utils.js';
import type { AgentRunRow, AgentRunStatus, ToolCallRow, ToolCallStatus } from '../db/types.js';

export interface AgentRun extends AgentRunRow {
  /** plan_json 解析后的结构化计划 */
  plan: unknown[];
}

export interface ToolCall extends ToolCallRow {
  args: Record<string, unknown>;
  result: unknown;
}

export interface StartRunInput {
  sessionId: string;
  messageId?: string | null;
  plan?: unknown[];
}

export interface StartToolCallInput {
  runId: string;
  stepIndex: number;
  toolName: string;
  args?: Record<string, unknown>;
  attempt?: number;
}

/** 开启一次 Agent run */
export function startRun({ sessionId, messageId = null, plan = [] }: StartRunInput): AgentRun | null {
  const db = getDb();
  const id = uid('run');
  db.prepare(
    `insert into agent_runs(id, session_id, message_id, status, plan_json, started_at)
     values (?, ?, ?, 'running', ?, ?)`
  ).run(id, sessionId, messageId, JSON.stringify(plan), Date.now());
  return getRun(id);
}

export function getRun(id: string): AgentRun | null {
  const row = getDb().prepare('select * from agent_runs where id = ?').get(id) as AgentRunRow | undefined;
  if (!row) return null;
  return { ...row, plan: safeParse<unknown[]>(row.plan_json, []) };
}

/** Planner 产出计划后回填 */
export function updateRunPlan(id: string, plan: unknown[]): AgentRun | null {
  getDb().prepare('update agent_runs set plan_json = ? where id = ?').run(JSON.stringify(plan), id);
  return getRun(id);
}

/** 关联该 run 产出的 assistant 消息 */
export function attachRunMessage(id: string, messageId: string): void {
  getDb().prepare('update agent_runs set message_id = ? where id = ?').run(messageId, id);
}

/** 结束一次 run */
export function finishRun(
  id: string,
  status: AgentRunStatus,
  { errorCode = '', errorMsg = '' }: { errorCode?: string; errorMsg?: string } = {}
): AgentRun | null {
  getDb()
    .prepare('update agent_runs set status = ?, error_code = ?, error_msg = ?, ended_at = ? where id = ?')
    .run(status, errorCode, errorMsg, Date.now(), id);
  return getRun(id);
}

/** 列出某会话的历史 run（用于前端回放） */
export function listRunsBySession(sessionId: string, limit = 20): AgentRun[] {
  return (
    getDb()
      .prepare('select * from agent_runs where session_id = ? order by started_at desc limit ?')
      .all(sessionId, limit) as AgentRunRow[]
  ).map((row) => ({ ...row, plan: safeParse<unknown[]>(row.plan_json, []) }));
}

// ---------- tool_calls ----------

/** 记录一次工具调用的开始 */
export function startToolCall({ runId, stepIndex, toolName, args = {}, attempt = 1 }: StartToolCallInput): string {
  const db = getDb();
  const id = uid('tool');
  db.prepare(
    `insert into tool_calls(id, run_id, step_index, tool_name, args_json, status, attempt, started_at)
     values (?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, runId, stepIndex, toolName, JSON.stringify(args), attempt, Date.now());
  return id;
}

/** 结束一次工具调用 */
export function finishToolCall(
  id: string,
  status: ToolCallStatus,
  { result = null, errorMsg = '' }: { result?: unknown; errorMsg?: string } = {}
): { id: string; status: ToolCallStatus; durationMs: number } {
  const db = getDb();
  const row = db.prepare('select started_at from tool_calls where id = ?').get(id) as
    | { started_at: number }
    | undefined;
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
export function listToolCalls(runId: string): ToolCall[] {
  return (
    getDb()
      .prepare('select * from tool_calls where run_id = ? order by step_index asc, started_at asc')
      .all(runId) as ToolCallRow[]
  ).map((row) => ({
    ...row,
    args: safeParse<Record<string, unknown>>(row.args_json, {}),
    result: safeParse<unknown>(row.result_json, null)
  }));
}

function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
