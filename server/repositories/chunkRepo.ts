import { getDb, toVectorBlob } from '../db/client.js';
import { uid } from '../lib/utils.js';
import type { ChunkRow, DocumentRow } from '../db/types.js';

export interface DocumentWithChunkCount extends DocumentRow {
  chunkCount: number;
}

export interface CreateDocumentInput {
  name: string;
  /** 归属用户 ID；NULL 表示公共/历史数据 */
  userId?: string;
  mimeType?: string;
  sizeBytes?: number;
  charCount?: number;
  source?: string;
  content?: string;
}

export interface ChunkInput {
  text: string;
  embedding: number[];
  tokenCount?: number;
  spanStart?: number;
  spanEnd?: number;
}

export interface VectorSearchHit {
  chunkId: string;
  documentId: string;
  documentName: string;
  text: string;
  spanStart: number;
  spanEnd: number;
  distance: number;
  /** cosine distance 换算的相似度，便于阅读 */
  score: number;
}

/** 新建文档记录 */
export function createDocument({
  name,
  userId,
  mimeType = '',
  sizeBytes = 0,
  charCount = 0,
  source = 'upload',
  content = ''
}: CreateDocumentInput): DocumentRow | null {
  const db = getDb();
  const id = uid('doc');
  db.prepare(
    `insert into documents(id, user_id, name, mime_type, size_bytes, char_count, source, content, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId ?? null, name, mimeType, sizeBytes, charCount, source, content, Date.now());
  return getDocument(id);
}

export function getDocument(id: string, userId?: string): DocumentRow | null {
  const row = (getDb().prepare('select * from documents where id = ?').get(id) as DocumentRow | undefined) || null;
  if (row && userId && row.user_id !== userId) return null; // 非本人文档视为不存在
  return row;
}

/** 是否已存在同名文档（文献入库去重用） */
export function findDocumentByName(name: string): DocumentRow | null {
  return (getDb().prepare('select * from documents where name = ?').get(name) as DocumentRow | undefined) || null;
}

export function listDocuments(userId?: string): DocumentWithChunkCount[] {
  if (userId) {
    return getDb()
      .prepare(
        `select d.*, (select count(*) from chunks c where c.document_id = d.id) as chunkCount
         from documents d where d.user_id = ? order by d.created_at desc`
      )
      .all(userId) as DocumentWithChunkCount[];
  }
  return getDb()
    .prepare(
      `select d.*, (select count(*) from chunks c where c.document_id = d.id) as chunkCount
       from documents d order by d.created_at desc`
    )
    .all() as DocumentWithChunkCount[];
}

export function deleteDocument(id: string, userId?: string): boolean {
  const db = getDb();
  if (userId && getDocument(id, userId) === null) return false; // 非本人文档无权删除
  // chunks 与 chunk_vec_map 通过外键级联删除，但 vec0 虚拟表需手动清理
  const run = db.transaction(() => {
    const rowids = (
      db
        .prepare(
          `select m.rowid as rowid from chunk_vec_map m
         join chunks c on c.id = m.chunk_id
         where c.document_id = ?`
        )
        .all(id) as Array<{ rowid: number }>
    ).map((r) => r.rowid);

    const deleteVec = db.prepare('delete from chunk_vectors where rowid = ?');
    for (const rowid of rowids) deleteVec.run(BigInt(rowid));

    return db.prepare('delete from documents where id = ?').run(id).changes > 0;
  });
  return run();
}

export function clearAllDocuments(): number {
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
 */
export function insertChunksWithVectors(documentId: string, items: ChunkInput[]): string[] {
  const db = getDb();
  const now = Date.now();

  const insertChunk = db.prepare(
    `insert into chunks(id, document_id, chunk_index, text, token_count, span_start, span_end, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertMap = db.prepare('insert into chunk_vec_map(chunk_id) values (?)');
  const insertVec = db.prepare('insert into chunk_vectors(rowid, embedding) values (?, ?)');

  const run = db.transaction(() => {
    const created: string[] = [];
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

/** 向量相似检索（cosine），按距离升序返回；传 userId 时只检索该用户的私有文档 */
export function searchChunksByVector(queryEmbedding: number[], topK = 50, userId?: string): VectorSearchHit[] {
  const db = getDb();
  const rows = db
    .prepare(
      `select v.rowid as rowid, v.distance as distance
       from chunk_vectors v
       where v.embedding match ?
       order by v.distance
       limit ?`
    )
    .all(toVectorBlob(queryEmbedding), topK) as Array<{ rowid: number; distance: number }>;

  if (!rows.length) return [];

  // 检索主查询无法带出归属，这里回表按 user_id 校验归属，避免跨用户命中私有文档
  const detailStmt = userId
    ? db.prepare(
        `select c.id as chunkId, c.document_id as documentId, d.name as documentName,
                c.text as text, c.span_start as spanStart, c.span_end as spanEnd
         from chunk_vec_map m
         join chunks c on c.id = m.chunk_id
         join documents d on d.id = c.document_id
         where m.rowid = ? and d.user_id = ?`
      )
    : db.prepare(
        `select c.id as chunkId, c.document_id as documentId, d.name as documentName,
                c.text as text, c.span_start as spanStart, c.span_end as spanEnd
         from chunk_vec_map m
         join chunks c on c.id = m.chunk_id
         join documents d on d.id = c.document_id
         where m.rowid = ?`
      );

  const results: VectorSearchHit[] = [];
  for (const row of rows) {
    const detail = (userId ? detailStmt.get(row.rowid, userId) : detailStmt.get(row.rowid)) as
      | Omit<VectorSearchHit, 'distance' | 'score'>
      | undefined;
    if (!detail) continue; // 映射已被删除，跳过
    results.push({
      ...detail,
      distance: row.distance,
      score: Number((1 - row.distance).toFixed(6))
    });
  }
  return results;
}

/** 统计分块总数（健康检查与 UI 展示用） */
export function countChunks(): number {
  return (getDb().prepare('select count(*) as count from chunks').get() as { count: number }).count;
}

export function getChunk(chunkId: string): ChunkRow | null {
  return (getDb().prepare('select * from chunks where id = ?').get(chunkId) as ChunkRow | undefined) || null;
}
