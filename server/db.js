import pg from 'pg';

const { Pool } = pg;

let pool = null;

function getPool() {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : undefined
    });
  }

  return pool;
}

export async function checkDatabaseHealth() {
  const db = getPool();
  if (!db) {
    return { enabled: false, ok: false, reason: 'DATABASE_URL 未配置' };
  }

  const client = await db.connect();
  try {
    const result = await client.query('SELECT NOW() AS now, version() AS version');
    return {
      enabled: true,
      ok: true,
      now: result.rows?.[0]?.now,
      version: result.rows?.[0]?.version
    };
  } finally {
    client.release();
  }
}
