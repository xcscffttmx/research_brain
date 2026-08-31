import { getDb } from '../db/client.js';
import { uid } from '../lib/utils.js';

/**
 * 批量写入某一轮检索召回的证据。
 * 每条证据记录向量分与 rerank 分，供面试时展示"召回 -> 精排"的完整链路。
 *
 * @param {string} runId
 * @param {number} hop 第几轮检索（多步检索时递增）
 * @param {Array<{chunkId?: string, paperId?: string, snippet: string, vectorScore?: number, rerankScore?: number}>} items
 */
export function recordEvidence(runId, hop, items) {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `insert into evidence(id, run_id, retrieval_hop, chunk_id, paper_id, snippet, vector_score, rerank_score, cited, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  );

  const run = db.transaction(() => {
    const ids = [];
    for (const item of items) {
      const id = uid('ev');
      stmt.run(
        id,
        runId,
        hop,
        item.chunkId || null,
        item.paperId || null,
        item.snippet || '',
        item.vectorScore ?? null,
        item.rerankScore ?? null,
        now
      );
      ids.push(id);
    }
    return ids;
  });

  return run();
}

/**
 * 标记哪些证据最终被答案引用，并写入引用序号。
 * @param {Array<{evidenceId: string, citationIndex: number}>} citations
 */
export function markCited(citations) {
  const db = getDb();
  const stmt = db.prepare('update evidence set cited = 1, citation_index = ? where id = ?');
  const run = db.transaction(() => {
    for (const c of citations) stmt.run(c.citationIndex, c.evidenceId);
  });
  run();
}

/** 列出某 run 的全部证据，按轮次与 rerank 分排序 */
export function listEvidence(runId) {
  return getDb()
    .prepare(
      `select * from evidence
       where run_id = ?
       order by retrieval_hop asc, coalesce(rerank_score, vector_score, 0) desc`
    )
    .all(runId);
}

/** 只取被引用的证据（前端渲染引用列表用） */
export function listCitedEvidence(runId) {
  return getDb()
    .prepare('select * from evidence where run_id = ? and cited = 1 order by citation_index asc')
    .all(runId);
}
