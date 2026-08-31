/**
 * sqlite-vec 可行性验证脚本（S0 风险前置）
 *
 * 验证结论（Apple Silicon / Node 24 / better-sqlite3 11 / sqlite-vec 0.1.7-alpha.2）：
 *   1. native 模块与扩展均可正常加载
 *   2. rowid 必须绑定 BigInt（传 JS number 会报 "Only integers are allows for primary key"）
 *   3. 向量可传 Buffer（Float32Array.buffer）或 JSON 字符串
 *   4. vec0 默认距离是 L2，需显式声明 distance_metric=cosine
 *   5. 不要开 defaultSafeIntegers(true)，会导致 BigInt 序列化报错
 *
 * 运行：node server/db/verifySqliteVec.js
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const DIM = 4;

/** better-sqlite3 需要 Buffer 而非 Float32Array */
export function toVectorBlob(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

function main() {
  const db = new Database(':memory:');
  sqliteVec.load(db);

  const { version } = db.prepare('select vec_version() as version').get();
  console.log(`[1/4] sqlite-vec 加载成功，版本 ${version}`);

  // 关键：显式声明 cosine 距离
  db.exec(`
    create virtual table vec_demo using vec0(
      embedding float[${DIM}] distance_metric=cosine
    )
  `);
  console.log('[2/4] vec0 虚拟表建成（distance_metric=cosine）');

  const insert = db.prepare('insert into vec_demo(rowid, embedding) values (?, ?)');
  insert.run(1n, toVectorBlob([1, 0, 0, 0]));
  insert.run(2n, toVectorBlob([0, 1, 0, 0]));
  insert.run(3n, toVectorBlob([0.9, 0.1, 0, 0]));
  console.log('[3/4] 插入 3 条向量（rowid 用 BigInt）');

  const rows = db
    .prepare(
      `select rowid, distance
       from vec_demo
       where embedding match ?
       order by distance
       limit 3`
    )
    .all(toVectorBlob([1, 0, 0, 0]));

  console.log('[4/4] cosine 距离检索结果：');
  for (const row of rows) {
    console.log(`      rowid=${row.rowid}  cosine_distance=${row.distance.toFixed(6)}`);
  }

  // 期望：rowid=1 距离 0（完全同向）；rowid=3 距离很小；rowid=2 距离最大（正交=1）
  const ok =
    rows.length === 3 &&
    rows[0].rowid === 1 &&
    rows[0].distance < 1e-6 &&
    rows[2].rowid === 2 &&
    Math.abs(rows[2].distance - 1) < 1e-5;

  db.close();

  if (!ok) {
    console.error('\n❌ cosine 语义不符合预期，请检查 distance_metric 配置');
    process.exit(1);
  }
  console.log('\n✅ 全部通过：sqlite-vec 可用于生产，cosine 距离语义正确');
}

main();
