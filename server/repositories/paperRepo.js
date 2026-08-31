import { getDb } from '../db/client.js';

/** 批量 upsert 文献缓存（多源检索结果落库，替代原来的内存 state.literature.papers） */
export function upsertPapers(papers) {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `insert into papers(paper_id, source, title, abstract, authors, year, venue, url, pdf_url,
                        citation_count, reference_count, cached_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(source, paper_id) do update set
       title = excluded.title,
       abstract = excluded.abstract,
       authors = excluded.authors,
       year = excluded.year,
       venue = excluded.venue,
       url = excluded.url,
       pdf_url = excluded.pdf_url,
       citation_count = excluded.citation_count,
       reference_count = excluded.reference_count,
       cached_at = excluded.cached_at`
  );

  const run = db.transaction(() => {
    for (const p of papers) {
      stmt.run(
        p.paperId,
        p.source,
        p.title || '',
        p.abstract || '',
        JSON.stringify(p.authors || []),
        p.year ?? null,
        p.venue || '',
        p.url || '',
        p.pdfUrl || '',
        p.citationCount ?? null,
        p.referenceCount ?? null,
        now
      );
    }
    return papers.length;
  });

  return run();
}

/** 按 paperId 查（不限来源，取最近缓存的一条） */
export function findPaper(paperId) {
  const row = getDb()
    .prepare('select * from papers where paper_id = ? order by cached_at desc limit 1')
    .get(paperId);
  return row ? toPaper(row) : null;
}

/** 列出缓存的文献 */
export function listPapers(limit = 100) {
  return getDb()
    .prepare('select * from papers order by cached_at desc limit ?')
    .all(limit)
    .map(toPaper);
}

// ---------- paper_schemas ----------

export function savePaperSchema(paperId, schema) {
  getDb()
    .prepare(
      `insert into paper_schemas(paper_id, schema_json, created_at) values (?, ?, ?)
       on conflict(paper_id) do update set schema_json = excluded.schema_json, created_at = excluded.created_at`
    )
    .run(paperId, JSON.stringify(schema), Date.now());
}

export function getPaperSchema(paperId) {
  const row = getDb().prepare('select * from paper_schemas where paper_id = ?').get(paperId);
  if (!row) return null;
  try {
    return JSON.parse(row.schema_json);
  } catch {
    return null;
  }
}

export function listPaperSchemas() {
  return getDb()
    .prepare('select * from paper_schemas order by created_at desc')
    .all()
    .map((row) => {
      try {
        return { paperId: row.paper_id, schema: JSON.parse(row.schema_json), createdAt: row.created_at };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function toPaper(row) {
  let authors = [];
  try {
    authors = JSON.parse(row.authors);
  } catch {
    authors = [];
  }
  return {
    paperId: row.paper_id,
    source: row.source,
    title: row.title,
    abstract: row.abstract,
    authors,
    year: row.year,
    venue: row.venue,
    url: row.url,
    pdfUrl: row.pdf_url,
    citationCount: row.citation_count,
    referenceCount: row.reference_count,
    cachedAt: row.cached_at
  };
}
