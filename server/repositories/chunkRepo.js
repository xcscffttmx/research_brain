import { getDb, toVectorBlob } from '../db/client.js';
import { uid } from '../lib/utils.js';

/** 新建文档记录 */
export function createDocument({ name, mimeType = '', sizeBytes = 0, charCount = 0, source = 'upload' }) {
  const db = getDb();
  const id = uid('doc');
  db.prepare(
    `insert into documents(id, name, mime_type, size_bytes, char_count, source, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, mimeType, sizeBytes, charCount, source, Date.now());
  return getDocument(id);
}

export function getDocument(id) {
  return getDb().prepare('select * from documents where id = ?').get(id) || null;
}

export function listDocuments() {
  return getDb()
    .prepare(
      `select d.*, (select count(*) from chunks c where c.document_id = d.id) as chunkCount
       from documents d order by d.created_at desc`
    )
    .all();
}

export function deleteDocument(id) {
  // chunks 与 chunk_vec_map 通过外键级联删除，但 vec0 虚拟表需手动清理
  const db = getDb();
  const run = db.transaction(() => {
    const rowids = db
      .prepare(
        `select m.rowid as rowid from chunk_vec_map m
         join chunks c on c.id = m.chunk_id
         where c.document_id = ?`
      )
      .all(id)
      .map((r) => r.rowid);

    const deleteVec = db.prepare('delete from chunk_vectors where rowid = ?');
    for (const rowid of rowids) deleteVec.run(BigInt(rowid));

    return db.prepare('delete from documents where id = ?').run(id).changes > 0;
  });
  return run();
}

export function clearAllDocuments() {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare('delete from chunk_vectors').run();
    db.prepare('delete from chunk_vec_map').run();
    db.prepare('delete from chunks').run();
    const info = db.prepare('delete from documents').run();
    return info.changes;
  });
  return run();
}

/**
 * 批量写入分块及其向量。
 * 单事务提交，保证 chunks / chunk_vec_map / chunk_vectors 三者一致。
 *
 * @param {string} documentId
 * @param {Array<{text: string, embedding: number[], tokenCount?: number, spanStart?: number, spanEnd?: number}>} items
 */
export function insertChunksWithVectors(documentId, items) {
  const db = getDb();
  const now = Date.now();

  const insertChunk = db.prepare(
    `insert into chunks(id, document_id, chunk_index, text, token_count, span_start, span_end, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertMap = db.prepare('insert into chunk_vec_map(chunk_id) values (?)');
  const insertVec = db.prepare('insert into chunk_vectors(rowid, embedding) values (?, ?)');

  const run = db.transaction(() => {
    const created = [];
    items.forEach((item, index) => {
      const chunkId = uid('chunk');
      insertChunk.run(
        chunkId,
        documentId,
        index,
        item.text,
        item.tokenCount || 0,
        item.spanStart || 0,
        item.spanEnd || 0,
        now
      );
      const mapInfo = insertMap.run(chunkId);
      // vec0 的 rowid 必须绑定 BigInt
      insertVec.run(BigInt(mapInfo.lastInsertRowid), toVectorBlob(item.embedding));
      created.push(chunkId);
    });
    return created;
  });

  return run();
}

/**
 * 向量相似检索（cosine）。返回按距离升序（越相似越靠前）的分块及其原文信息。
 *
 * @param {number[]} queryEmbedding
 * @param {number} topK
 * @returns {Array<{chunkId, documentId, documentName, text, spanStart, spanEnd, distance, score}>}
 */
export function searchChunksByVector(queryEmbedding, topK = 50) {
  const db = getDb();
  const rows = db
    .prepare(
      `select v.rowid as rowid, v.distance as distance
       from chunk_vectors v
       where v.embedding match ?
       order by v.distance
       limit ?`
    )
    .all(toVectorBlob(queryEmbedding), topK);

  if (!rows.length) return [];

  const detailStmt = db.prepare(
    `select c.id as chunkId, c.document_id as documentId, d.name as documentName,
            c.text as text, c.span_start as spanStart, c.span_end as spanEnd
     from chunk_vec_map m
     join chunks c on c.id = m.chunk_id
     join documents d on d.id = c.document_id
     where m.rowid = ?`
  );

  const results = [];
  for (const row of rows) {
    const detail = detailStmt.get(row.rowid);
    if (!detail) continue; // 映射已被删除，跳过
    results.push({
      ...detail,
      distance: row.distance,
      // cosine distance -> 相似度，便于阅读
      score: Number((1 - row.distance).toFixed(6))
    });
  }
  return results;
}

/** 统计分块总数（健康检查与 UI 展示用） */
export function countChunks() {
  return getDb().prepare('select count(*) as count from chunks').get().count;
}

export function getChunk(chunkId) {
  return getDb().prepare('select * from chunks where id = ?').get(chunkId) || null;
}
