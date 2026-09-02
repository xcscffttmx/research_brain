/**
 * SQLite 迁移器。
 * 目前只有 v1（初始 schema），后续新增迁移在 MIGRATIONS 里追加即可。
 * 运行：npm run db:migrate
 */
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb } from './client.js';

const SCHEMA_FILE = path.resolve(import.meta.dirname, 'schema.sql');

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      const sql = fs.readFileSync(SCHEMA_FILE, 'utf-8');
      db.exec(sql);
    }
  },
  {
    version: 2,
    name: 'documents.content for original text preview',
    up(db) {
      // 新库由 v1 的 schema.sql 直接建出该列，这里只补老库
      const columns = db.prepare('pragma table_info(documents)').all();
      if (columns.some((column) => column.name === 'content')) return;
      db.exec("alter table documents add column content TEXT NOT NULL DEFAULT ''");
    }
  }
];

function getCurrentVersion(db) {
  // schema_migrations 可能还不存在
  const exists = db
    .prepare("select count(*) as count from sqlite_master where type = 'table' and name = 'schema_migrations'")
    .get();
  if (!exists.count) return 0;

  const row = db.prepare('select max(version) as version from schema_migrations').get();
  return row.version || 0;
}

export function migrate({ verbose = true } = {}) {
  const db = getDb();
  const current = getCurrentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current);

  if (!pending.length) {
    if (verbose) console.log(`数据库已是最新版本 (v${current})，无需迁移。`);
    return { from: current, to: current, applied: [] };
  }

  const applied = [];
  for (const migration of pending) {
    if (verbose) console.log(`应用迁移 v${migration.version}: ${migration.name}…`);
    const runInTx = db.transaction(() => {
      migration.up(db);
      db.prepare('insert into schema_migrations(version, applied_at) values (?, ?)').run(migration.version, Date.now());
    });
    runInTx();
    applied.push(migration.version);
  }

  const to = getCurrentVersion(db);
  if (verbose) console.log(`迁移完成：v${current} -> v${to}`);
  return { from: current, to, applied };
}

// 作为脚本直接运行时执行迁移
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  try {
    migrate();
  } finally {
    closeDb();
  }
}
