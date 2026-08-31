import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/** embedding 维度，与 DashScope text-embedding-v3 默认输出一致 */
export const EMBEDDING_DIM = 1024;

const DATA_DIR = path.resolve(process.cwd(), '.data');
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'research-agent.db');

let db = null;

/**
 * 获取 SQLite 单例连接（已加载 sqlite-vec 扩展）。
 * 通过 SQLITE_PATH 环境变量可覆盖路径，测试时可传 ':memory:'。
 */
export function getDb() {
  if (db) return db;

  const dbPath = process.env.SQLITE_PATH || DEFAULT_DB_PATH;
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** 关闭连接（进程退出或测试清理时用） */
export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * 把普通数组 / Float32Array 转成 better-sqlite3 可绑定的 Buffer。
 * 注意：vec0 的 rowid 必须绑定 BigInt，向量必须是 Buffer 或 JSON 字符串。
 */
export function toVectorBlob(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

/** 从 Buffer 还原成普通数组（调试或导出时用） */
export function fromVectorBlob(buffer) {
  return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4));
}

/** 健康检查：替代原来的 PostgreSQL 版本 */
export function checkDatabaseHealth() {
  try {
    const conn = getDb();
    const { version } = conn.prepare('select sqlite_version() as version').get();
    const { vecVersion } = conn.prepare('select vec_version() as vecVersion').get();
    const { count } = conn.prepare('select count(*) as count from sqlite_master where type = ?').get('table');
    return {
      enabled: true,
      ok: true,
      engine: 'sqlite',
      sqliteVersion: version,
      sqliteVecVersion: vecVersion,
      tableCount: count
    };
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      engine: 'sqlite',
      reason: error.message
    };
  }
}
