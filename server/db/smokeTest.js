/**
 * 持久化层端到端冒烟测试（S1 验证）
 * 用内存数据库跑一遍全链路：会话 -> 消息 -> 文档 -> 分块+向量 -> 向量检索
 *                            -> Agent run -> tool call -> 证据 -> 引用标记 -> 缓存
 * 运行：SQLITE_PATH=:memory: node server/db/smokeTest.js
 */
process.env.SQLITE_PATH = ':memory:';

import { EMBEDDING_DIM, closeDb } from './client.js';
import { migrate } from './migrate.js';
import * as sessionRepo from '../repositories/sessionRepo.js';
import * as messageRepo from '../repositories/messageRepo.js';
import * as chunkRepo from '../repositories/chunkRepo.js';
import * as agentRunRepo from '../repositories/agentRunRepo.js';
import * as evidenceRepo from '../repositories/evidenceRepo.js';
import * as paperRepo from '../repositories/paperRepo.js';
import * as queryCacheRepo from '../repositories/queryCacheRepo.js';

let passed = 0;
let failed = 0;

function check(label, condition, extra = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label} ${extra}`);
  }
}

/** 造一个指定"方向"的单位向量，便于验证 cosine 检索顺序 */
function makeEmbedding(seedIndex) {
  const vec = new Array(EMBEDDING_DIM).fill(0);
  vec[seedIndex % EMBEDDING_DIM] = 1;
  return vec;
}

function main() {
  console.log('迁移数据库…');
  migrate({ verbose: false });

  console.log('\n[1] 会话与消息');
  const session = sessionRepo.createSession('测试会话');
  check('创建会话', !!session?.id);

  const m1 = messageRepo.appendMessage({
    sessionId: session.id,
    role: 'user',
    content: 'Transformer 在遥感图像分割上的最新进展？',
    tokenCount: 18
  });
  const m2 = messageRepo.appendMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '正在检索…',
    tokenCount: 5,
    status: 'streaming'
  });
  check('追加两条消息且 seq 递增', m1.seq === 1 && m2.seq === 2, `got ${m1.seq}, ${m2.seq}`);

  messageRepo.updateMessage(m2.id, { content: '已找到 3 篇相关文献。', tokenCount: 12, status: 'done' });
  check('回填流式消息', messageRepo.getMessage(m2.id).status === 'done');

  const stats = messageRepo.getSessionStats(session.id);
  check('统计 token 总数', stats.messageCount === 2 && stats.totalTokens === 30, JSON.stringify(stats));

  sessionRepo.updateSessionSummary(session.id, '用户关注遥感分割方向。', 1);
  check('写入 Long-Term 摘要', sessionRepo.getSession(session.id).summary_upto === 1);

  console.log('\n[2] 知识库与向量检索');
  const doc = chunkRepo.createDocument({ name: 'survey.md', mimeType: 'text/markdown', charCount: 500 });
  check('创建文档', !!doc?.id);

  const chunkIds = chunkRepo.insertChunksWithVectors(doc.id, [
    { text: 'ViT 在遥感分割中的应用综述。', embedding: makeEmbedding(0), tokenCount: 20, spanStart: 0, spanEnd: 100 },
    { text: 'CNN 与 Transformer 的混合架构。', embedding: makeEmbedding(1), tokenCount: 22, spanStart: 100, spanEnd: 220 },
    { text: '数据增强对小样本分割的影响。', embedding: makeEmbedding(2), tokenCount: 19, spanStart: 220, spanEnd: 340 }
  ]);
  check('批量写入 3 个分块+向量', chunkIds.length === 3);
  check('分块总数正确', chunkRepo.countChunks() === 3);

  // 用与第 2 个分块完全同向的向量查询，期望它排第一且相似度接近 1
  const hits = chunkRepo.searchChunksByVector(makeEmbedding(1), 3);
  check('向量检索返回结果', hits.length === 3, `got ${hits.length}`);
  check(
    '最相似的是第 2 个分块',
    hits[0]?.text === 'CNN 与 Transformer 的混合架构。',
    `got "${hits[0]?.text}"`
  );
  check('相似度接近 1', Math.abs(hits[0].score - 1) < 1e-5, `got ${hits[0]?.score}`);
  check('携带原文 span 信息', hits[0].spanStart === 100 && hits[0].spanEnd === 220);
  check('携带文档名', hits[0].documentName === 'survey.md');

  console.log('\n[3] Agent Runtime 记录');
  const run = agentRunRepo.startRun({ sessionId: session.id, messageId: m2.id });
  check('开启 run', run?.status === 'running');

  agentRunRepo.updateRunPlan(run.id, [
    { step: 1, tool: 'search_literature', reason: '需要在线文献' },
    { step: 2, tool: 'search_knowledge', reason: '结合个人知识库' }
  ]);
  check('回填 Planner 计划', agentRunRepo.getRun(run.id).plan.length === 2);

  const tc1 = agentRunRepo.startToolCall({
    runId: run.id,
    stepIndex: 1,
    toolName: 'search_literature',
    args: { query: 'remote sensing segmentation', limit: 5 }
  });
  agentRunRepo.finishToolCall(tc1, 'succeeded', { result: { count: 3 } });

  const tc2 = agentRunRepo.startToolCall({
    runId: run.id,
    stepIndex: 2,
    toolName: 'search_knowledge',
    args: { query: 'ViT segmentation' },
    attempt: 2
  });
  agentRunRepo.finishToolCall(tc2, 'timeout', { errorMsg: '上游超时' });

  const calls = agentRunRepo.listToolCalls(run.id);
  check('记录 2 次工具调用', calls.length === 2);
  check('工具调用状态正确', calls[0].status === 'succeeded' && calls[1].status === 'timeout');
  check('记录重试次数', calls[1].attempt === 2);
  check('反序列化 args', calls[0].args.query === 'remote sensing segmentation');

  console.log('\n[4] 证据溯源');
  const evIds = evidenceRepo.recordEvidence(run.id, 1, [
    { chunkId: chunkIds[1], snippet: 'CNN 与 Transformer 的混合架构。', vectorScore: 0.98, rerankScore: 0.91 },
    { chunkId: chunkIds[0], snippet: 'ViT 在遥感分割中的应用综述。', vectorScore: 0.72, rerankScore: 0.55 },
    { paperId: 'arxiv-2401.12345', snippet: '在线文献摘要片段…', vectorScore: 0.80, rerankScore: 0.88 }
  ]);
  check('写入 3 条证据', evIds.length === 3);

  const allEvidence = evidenceRepo.listEvidence(run.id);
  check(
    '证据按 rerank 分降序',
    allEvidence[0].rerank_score === 0.91 && allEvidence[1].rerank_score === 0.88,
    JSON.stringify(allEvidence.map((e) => e.rerank_score))
  );

  evidenceRepo.markCited([
    { evidenceId: evIds[0], citationIndex: 1 },
    { evidenceId: evIds[2], citationIndex: 2 }
  ]);
  const cited = evidenceRepo.listCitedEvidence(run.id);
  check('标记 2 条被引用', cited.length === 2);
  check('引用序号有序', cited[0].citation_index === 1 && cited[1].citation_index === 2);

  agentRunRepo.finishRun(run.id, 'succeeded');
  check('结束 run', agentRunRepo.getRun(run.id).status === 'succeeded');
  check('记录耗时', agentRunRepo.getRun(run.id).ended_at > 0);

  console.log('\n[5] 文献缓存与 TTL');
  paperRepo.upsertPapers([
    {
      paperId: 'arxiv-2401.12345',
      source: 'arxiv',
      title: 'Remote Sensing Segmentation with ViT',
      abstract: 'We propose…',
      authors: ['Alice', 'Bob'],
      year: 2026,
      citationCount: 42
    }
  ]);
  const paper = paperRepo.findPaper('arxiv-2401.12345');
  check('缓存文献可读回', paper?.title === 'Remote Sensing Segmentation with ViT');
  check('authors 反序列化为数组', Array.isArray(paper.authors) && paper.authors.length === 2);

  // upsert 幂等性
  paperRepo.upsertPapers([
    { paperId: 'arxiv-2401.12345', source: 'arxiv', title: '更新后的标题', authors: ['Alice'] }
  ]);
  check('upsert 覆盖而非重复插入', paperRepo.listPapers().length === 1);
  check('upsert 更新了字段', paperRepo.findPaper('arxiv-2401.12345').title === '更新后的标题');

  paperRepo.savePaperSchema('arxiv-2401.12345', { problem: '小样本分割难', method: 'ViT + 数据增强' });
  check('保存 Paper Schema', paperRepo.getPaperSchema('arxiv-2401.12345').method === 'ViT + 数据增强');

  const key = queryCacheRepo.buildCacheKey({ query: 'remote sensing', source: 'all', sinceYear: 2026 });
  queryCacheRepo.setCached(key, { papers: [1, 2, 3] });
  check('缓存命中', queryCacheRepo.getCached(key)?.papers.length === 3);
  check(
    '相同参数产生相同 key',
    queryCacheRepo.buildCacheKey({ sinceYear: 2026, source: 'all', query: 'remote sensing' }) === key
  );

  queryCacheRepo.setCached(key, { papers: [] }, -1000); // 立即过期
  check('过期缓存返回 null', queryCacheRepo.getCached(key) === null);

  console.log('\n[6] 级联删除');
  chunkRepo.deleteDocument(doc.id);
  check('删除文档后分块清零', chunkRepo.countChunks() === 0);
  check('向量检索返回空', chunkRepo.searchChunksByVector(makeEmbedding(1), 3).length === 0);

  sessionRepo.deleteSession(session.id);
  check('删除会话后消息清零', messageRepo.listMessages(session.id).length === 0);
  check('删除会话后 run 级联清零', agentRunRepo.listRunsBySession(session.id).length === 0);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  closeDb();
  if (failed > 0) process.exit(1);
  console.log('✅ 持久化层全链路验证通过');
}

main();
