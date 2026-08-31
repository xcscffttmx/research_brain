import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// 拆分后的通用工具与外部客户端（P1-a 抽出）
import { createAppError } from './lib/errors.js';
import { uid, normalizeWhitespace } from './lib/utils.js';
import { qwenFetch, createEmbedding } from './lib/apiClients/qwen.js';
import { searchArxiv } from './lib/apiClients/arxiv.js';
import { searchSemanticScholar } from './lib/apiClients/semanticScholar.js';
import { searchOpenAlex } from './lib/apiClients/openAlex.js';

// 尝试导入PDF和DOCX处理库
let pdf = null;
let mammoth = null;

async function loadLibraries() {
  try {
    const pdfParse = await import('pdf-parse');
    pdf = pdfParse.default || pdfParse;
    const mammothImport = await import('mammoth');
    mammoth = mammothImport.default || mammothImport;
    console.log('PDF和DOCX处理库加载成功');
  } catch (error) {
    console.error('PDF和DOCX处理库加载失败:', error);
    console.log('将使用降级模式，仅支持文本文件');
  }
}

const rootEnvPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: rootEnvPath, override: true });
dotenv.config({ override: false });

// Agent 定义
const agents = {
 文献检索: {
    id: 'literature-agent',
    name: '文献检索 Agent',
    description: '负责学术文献的搜索、分析和管理',
    capabilities: ['文献搜索', '文献分析', '引用关系分析', '文献摘要']
  },
 论文写作: {
    id: 'writing-agent',
    name: '论文写作 Agent',
    description: '辅助科研论文的撰写、修改和优化',
    capabilities: ['大纲生成', '内容写作', '语法检查', '引用格式处理']
  },
 公式推导: {
    id: 'formula-agent',
    name: '公式推导 Agent',
    description: '支持数学公式的推导、验证和解释',
    capabilities: ['公式推导', '公式验证', '公式解释', '公式应用']
  }
};

const state = {
  documents: [],
  chunks: [],
  agentState: {},
  literature: {
    categories: [],
    tags: [],
    papers: [],
    paperSchemas: {}
  }
};

// 注：Qwen 配置已迁移到 lib/config.js，通过 apiClients/qwen.js 内部消费。

const dataDir = path.resolve(process.cwd(), '.data');
const knowledgeStateFile = path.join(dataDir, 'knowledge-state.json');

async function persistState() {
  const payload = {
    documents: state.documents,
    chunks: state.chunks,
    literature: state.literature
  };

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(knowledgeStateFile, JSON.stringify(payload), 'utf-8');
}

async function hydrateState() {
  if (!existsSync(knowledgeStateFile)) {
    return;
  }

  try {
    const raw = await fs.readFile(knowledgeStateFile, 'utf-8');
    const parsed = JSON.parse(raw);
    state.documents = Array.isArray(parsed.documents) ? parsed.documents : [];
    state.chunks = Array.isArray(parsed.chunks) ? parsed.chunks : [];
    state.literature.categories = Array.isArray(parsed?.literature?.categories) ? parsed.literature.categories : [];
    state.literature.tags = Array.isArray(parsed?.literature?.tags) ? parsed.literature.tags : [];
    state.literature.papers = Array.isArray(parsed?.literature?.papers) ? parsed.literature.papers : [];
    state.literature.paperSchemas = parsed?.literature?.paperSchemas && typeof parsed.literature.paperSchemas === 'object'
      ? parsed.literature.paperSchemas
      : {};
    console.log(`知识库已加载：${state.documents.length} 篇文档，${state.chunks.length} 个分块。`);
  } catch (error) {
    console.error('加载本地知识库失败，将使用空状态启动:', error);
    state.documents = [];
    state.chunks = [];
    state.literature.categories = [];
    state.literature.tags = [];
    state.literature.papers = [];
    state.literature.paperSchemas = {};
  }
}

function tokenize(input) {
  return input
    .toLowerCase()
    .replace(/[`*_>#\-\[\]\(\)]/g, ' ')
    .split(/[\s，。；：！？、,.!?;:\/\\|]+/)
    .filter((token) => token.length > 1);
}

function chunkText(text, chunkSize = 900, overlap = 160) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    const value = text.slice(start, end).trim();
    if (value) chunks.push(value);
    start += chunkSize - overlap;
  }
  return chunks;
}

function cosineSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < len; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildCitation(chunk, score) {
  return {
    id: chunk.id,
    title: chunk.documentName,
    snippet: chunk.text,
    source: `向量知识库 / ${chunk.documentName}`,
    score: Number(score.toFixed(4))
  };
}

async function searchKnowledge(query, topK = 4) {
  if (!state.chunks.length) {
    return [];
  }

  const queryEmbedding = await createEmbedding(query);
  return state.chunks
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding)
    }))
    .filter((item) => item.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ chunk, score }) => buildCitation(chunk, score));
}

function cacheLiteraturePapers(rows) {
  const merged = new Map();
  for (const paper of state.literature.papers) {
    merged.set(`${paper.source}:${paper.paperId}`, paper);
  }
  for (const paper of rows) {
    merged.set(`${paper.source}:${paper.paperId}`, paper);
  }
  state.literature.papers = Array.from(merged.values());
}

function findCachedPaper(paperId) {
  return state.literature.papers.find((paper) => paper.paperId === paperId);
}

function draftFindingsFromAbstract(abstract) {
  const parts = normalizeWhitespace(abstract).split(/[.。!?！？]/).map((line) => line.trim()).filter(Boolean);
  if (!parts.length) {
    return ['缺少摘要信息，建议先补充论文摘要或全文后再分析。'];
  }
  return parts.slice(0, 4).map((line) => `${line}${/[.。]$/.test(line) ? '' : '。'}`);
}

const paperSchemaShape = z.object({
  title: z.string(),
  problem: z.string(),
  method: z.string(),
  architecture: z.string(),
  dataset: z.array(z.string()),
  metrics: z.array(z.string()),
  conclusion: z.string(),
  limitations: z.array(z.string())
});

function extractJsonObject(text) {
  if (!text) {
    throw createAppError('SCHEMA_EMPTY', '模型返回为空', '请稍后重试。', 502);
  }

  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');

  if (start < 0 || end < 0 || end <= start) {
    throw createAppError('SCHEMA_PARSE_ERROR', '无法解析 Paper Schema', '模型返回结果不包含有效 JSON 对象。', 502);
  }

  const jsonText = candidate.slice(start, end + 1);
  try {
    return JSON.parse(jsonText);
  } catch {
    throw createAppError('SCHEMA_PARSE_ERROR', '无法解析 Paper Schema', '模型返回的 JSON 格式不合法。', 502);
  }
}

function getPaperById(paperId) {
  const paper = findCachedPaper(paperId);
  if (!paper) {
    throw createAppError('PAPER_NOT_FOUND', '未找到指定文献', '请先调用 search_literature 并使用返回的 paperId。', 404);
  }
  return paper;
}

async function generatePaperSchema(paper) {
  const prompt = [
    '你是科研论文结构化抽取助手。',
    '请仅输出一个 JSON 对象，不要输出任何解释文字，不要使用 markdown 代码块。',
    '字段必须严格包含：title, problem, method, architecture, dataset, metrics, conclusion, limitations。',
    '其中 dataset、metrics、limitations 必须是字符串数组。',
    '若信息缺失，请使用空字符串或空数组，不要臆造事实。',
    '',
    `Title: ${paper.title || ''}`,
    `Abstract: ${paper.abstract || ''}`,
    `Venue: ${paper.venue || ''}`,
    `Year: ${paper.year || ''}`,
    `Authors: ${(paper.authors || []).join(', ')}`
  ].join('\n');

  const completion = await qwenFetch('/chat/completions', {
    model: process.env.QWEN_MODEL || 'qwen-plus',
    temperature: 0.1,
    messages: [
      { role: 'system', content: '你输出严格 JSON，不要额外文本。' },
      { role: 'user', content: prompt }
    ]
  });

  const content = completion?.choices?.[0]?.message?.content || '';
  const parsed = extractJsonObject(content);
  const validated = paperSchemaShape.safeParse(parsed);
  if (!validated.success) {
    throw createAppError('SCHEMA_VALIDATE_ERROR', 'Paper Schema 校验失败', validated.error.message, 400);
  }
  return validated.data;
}

function buildSchemaSearchText(record) {
  const schema = record?.schema || {};
  return [
    record?.title || '',
    schema.problem || '',
    schema.method || '',
    schema.architecture || '',
    Array.isArray(schema.dataset) ? schema.dataset.join(' ') : '',
    Array.isArray(schema.metrics) ? schema.metrics.join(' ') : '',
    schema.conclusion || '',
    Array.isArray(schema.limitations) ? schema.limitations.join(' ') : ''
  ].join(' ').toLowerCase();
}

function splitKeywords(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[\s，。；：！？、,.!?;:\/\\|]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
}

function summarizePaperMemory(matches, query) {
  const methods = new Set();
  const limitations = new Set();
  const datasets = new Set();

  for (const item of matches) {
    const schema = item.schema;
    if (schema.method) methods.add(schema.method);
    for (const dataset of schema.dataset || []) datasets.add(dataset);
    for (const limitation of schema.limitations || []) limitations.add(limitation);
  }

  return {
    query,
    totalMatched: matches.length,
    methods: Array.from(methods).slice(0, 8),
    datasets: Array.from(datasets).slice(0, 8),
    commonLimitations: Array.from(limitations).slice(0, 8)
  };
}

function buildMemoryCitations(matches) {
  return matches.slice(0, 6).map((item, index) => ({
    id: `memory-${index + 1}`,
    title: item.title,
    snippet: [item.schema.problem, item.schema.method, (item.schema.limitations || []).join('；')].filter(Boolean).join(' | '),
    source: `PaperMemory / ${item.paperId}`,
    score: Number(item.score.toFixed(4))
  }));
}

const researchGapShape = z.object({
  opportunity: z.string(),
  rationale: z.string(),
  supportingPaperIds: z.array(z.string()),
  confidence: z.number().min(0).max(1)
});

function countItems(records, picker) {
  const counter = new Map();
  for (const record of records) {
    const values = picker(record).filter(Boolean);
    for (const value of values) {
      counter.set(value, (counter.get(value) || 0) + 1);
    }
  }
  return counter;
}

function collectSupportingPapers(records, keyword) {
  const key = String(keyword || '').toLowerCase();
  return records
    .filter((record) => buildSchemaSearchText(record).includes(key))
    .map((record) => record.paperId)
    .slice(0, 6);
}

function normalizeGap(opportunity, rationale, supportingPaperIds, confidence) {
  return researchGapShape.parse({
    opportunity,
    rationale,
    supportingPaperIds: Array.from(new Set(supportingPaperIds)).filter(Boolean).slice(0, 8),
    confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(2))
  });
}

function mineResearchGaps(records, focus = '') {
  const methodCount = countItems(records, (record) => [record.schema.method]);
  const datasetCount = countItems(records, (record) => record.schema.dataset || []);
  const limitationCount = countItems(records, (record) => record.schema.limitations || []);

  const opportunities = [];
  const focusKeywords = splitKeywords(focus);

  const underExploredMethods = Array.from(methodCount.entries()).filter(([, count]) => count === 1).slice(0, 2);
  for (const [method] of underExploredMethods) {
    opportunities.push(
      normalizeGap(
        `扩展低覆盖方法：${method}`,
        `当前语料中该方法仅出现 1 次，存在系统性复现与对比不足的空白。`,
        collectSupportingPapers(records, method),
        0.62
      )
    );
  }

  const underExploredDatasets = Array.from(datasetCount.entries()).filter(([, count]) => count === 1).slice(0, 2);
  for (const [dataset] of underExploredDatasets) {
    opportunities.push(
      normalizeGap(
        `补充跨数据集验证：${dataset}`,
        `该数据集在当前论文集中覆盖较少，建议纳入统一评测以验证泛化能力。`,
        collectSupportingPapers(records, dataset),
        0.66
      )
    );
  }

  const recurringLimitations = Array.from(limitationCount.entries()).filter(([, count]) => count >= 2).slice(0, 2);
  for (const [limitation, count] of recurringLimitations) {
    opportunities.push(
      normalizeGap(
        `针对共性限制设计改进：${limitation}`,
        `该 limitation 在 ${count} 篇论文中重复出现，可作为下一步研究突破口。`,
        collectSupportingPapers(records, limitation),
        0.74
      )
    );
  }

  if (focusKeywords.length) {
    const focusedMatches = records.filter((record) => {
      const text = buildSchemaSearchText(record);
      return focusKeywords.some((keyword) => text.includes(keyword));
    });
    if (focusedMatches.length >= 2) {
      opportunities.push(
        normalizeGap(
          `围绕主题“${focus}”构建定向对照实验`,
          `已命中 ${focusedMatches.length} 篇相关论文，可基于其方法差异设计系统 ablation 与变量控制。`,
          focusedMatches.map((item) => item.paperId),
          0.7
        )
      );
    }
  }

  return opportunities
    .filter((item, index, array) => array.findIndex((x) => x.opportunity === item.opportunity) === index)
    .slice(0, 6);
}

const experimentSpecShape = z.object({
  baseline: z.string(),
  proposed_change: z.string(),
  dataset: z.string(),
  metrics: z.array(z.string()),
  training_plan: z.object({
    epochs: z.number().int().positive(),
    optimizer: z.string(),
    learning_rate: z.string(),
    batch_size: z.number().int().positive(),
    notes: z.string()
  }),
  ablation_plan: z.array(z.string()),
  evidenceRefs: z.array(
    z.object({
      paperId: z.string(),
      title: z.string(),
      reason: z.string()
    })
  )
});

function pickPrimaryDataset(records) {
  const counts = countItems(records, (record) => record.schema.dataset || []);
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || '待补充公开数据集';
}

function pickPrimaryMetric(records) {
  const counts = countItems(records, (record) => record.schema.metrics || []);
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 4).map(([name]) => name);
}

function buildEvidenceRefs(records, supportingPaperIds, opportunity) {
  const byId = new Map(records.map((record) => [record.paperId, record]));
  return supportingPaperIds.slice(0, 6).map((paperId) => {
    const record = byId.get(paperId);
    return {
      paperId,
      title: record?.title || 'Unknown',
      reason: `该论文支持机会点：${opportunity}`
    };
  });
}

function buildExperimentSpecFromGap(opportunityItem, records) {
  const supportingRecords = records.filter((record) => opportunityItem.supportingPaperIds.includes(record.paperId));
  const candidateRecords = supportingRecords.length ? supportingRecords : records;

  const methods = Array.from(
    new Set(candidateRecords.map((record) => record.schema.method).filter(Boolean))
  ).slice(0, 3);
  const baseline = methods[0] || '当前主流基线方法';
  const dataset = pickPrimaryDataset(candidateRecords);
  const metrics = pickPrimaryMetric(candidateRecords);

  const spec = {
    baseline,
    proposed_change: `围绕“${opportunityItem.opportunity}”进行结构/训练策略改造，并与基线做同预算对照。`,
    dataset,
    metrics: metrics.length ? metrics : ['Accuracy', 'F1'],
    training_plan: {
      epochs: 50,
      optimizer: 'AdamW',
      learning_rate: '2e-4 (cosine decay)',
      batch_size: 32,
      notes: '固定随机种子，至少运行 3 次并报告均值与方差。'
    },
    ablation_plan: [
      '仅替换 proposed_change 的核心模块，其余保持基线一致',
      '去除 proposed_change 的关键子组件，评估性能回退',
      '在不同数据子集上重复实验，观察泛化稳定性'
    ],
    evidenceRefs: buildEvidenceRefs(records, opportunityItem.supportingPaperIds, opportunityItem.opportunity)
  };

  return experimentSpecShape.parse(spec);
}

async function ingestLiteratureByPaperIds(paperIds) {
  const inserted = [];
  const nextDocuments = [];
  const nextChunks = [];

  for (const paperId of paperIds) {
    const paper = findCachedPaper(paperId);
    if (!paper) {
      continue;
    }

    const docName = `paper-${paper.source}-${paper.paperId}.md`;
    if (state.documents.some((doc) => doc.name === docName)) {
      continue;
    }

    const content = [
      `# ${paper.title}`,
      '',
      `- Source: ${paper.source}`,
      `- Paper ID: ${paper.paperId}`,
      `- Year: ${paper.year || 'N/A'}`,
      `- Venue: ${paper.venue || 'N/A'}`,
      `- Authors: ${paper.authors.join(', ') || 'N/A'}`,
      `- URL: ${paper.url || 'N/A'}`,
      `- PDF: ${paper.pdfUrl || 'N/A'}`,
      '',
      '## Abstract',
      paper.abstract || 'N/A'
    ].join('\n').trim();

    const document = {
      id: uid('doc'),
      name: docName,
      content,
      createdAt: Date.now()
    };

    nextDocuments.push(document);
    inserted.push({
      id: document.id,
      name: document.name,
      createdAt: document.createdAt,
      paperId: paper.paperId,
      source: paper.source
    });

    const parts = chunkText(content);
    for (const part of parts) {
      const embedding = await createEmbedding(part);
      nextChunks.push({
        id: uid('chunk'),
        documentId: document.id,
        documentName: document.name,
        text: part,
        tokens: tokenize(part),
        embedding
      });
    }
  }

  if (!inserted.length) {
    throw createAppError('LITERATURE_NOT_INGESTED', '没有新的文献被导入', '可能是 paperId 无效，或文献已存在于知识库。', 400);
  }

  state.documents.push(...nextDocuments);
  state.chunks.push(...nextChunks);
  await persistState();

  return inserted;
}

async function extractTextFromFile(document) {
  const name = document.name.toLowerCase();
  let content = document.content;
  const isBinary = document.isBinary || false;

  if (name.endsWith('.pdf')) {
    // 处理PDF文件
    if (!pdf) {
      throw createAppError('PDF_LIBRARY_NOT_LOADED', 'PDF处理库未加载', '请检查依赖安装是否正确。', 500);
    }
    try {
      const pdfData = Buffer.from(content, isBinary ? 'base64' : 'utf-8');
      const pdfResult = await pdf(pdfData);
      return pdfResult.text;
    } catch (error) {
      console.error(`处理PDF文件时出错:`, error);
      throw createAppError('PDF_PROCESS_ERROR', 'PDF文件处理失败', error.message, 400);
    }
  } else if (name.endsWith('.docx')) {
    // 处理DOCX文件
    if (!mammoth) {
      throw createAppError('MAMMOTH_LIBRARY_NOT_LOADED', 'DOCX处理库未加载', '请检查依赖安装是否正确。', 500);
    }
    try {
      const docxData = Buffer.from(content, isBinary ? 'base64' : 'utf-8');
      const docxResult = await mammoth.extractRawText({ buffer: docxData });
      return docxResult.value;
    } catch (error) {
      console.error(`处理DOCX文件时出错:`, error);
      throw createAppError('DOCX_PROCESS_ERROR', 'DOCX文件处理失败', error.message, 400);
    }
  } else {
    // 其他文本文件直接返回
    return content;
  }
}

async function ingestDocuments(documents) {
  const supported = documents.filter((document) => /\.(txt|md|markdown|json|pdf|docx)$/i.test(document.name));

  if (!supported.length) {
    throw createAppError('UNSUPPORTED_FILES', '没有可导入的知识文件', '仅支持 `.md`、`.markdown`、`.txt`、`.json`、`.pdf`、`.docx` 文件。', 400);
  }

  const inserted = [];
  const nextDocuments = [];
  const nextChunks = [];

  for (const source of supported) {
    let content;
    try {
      content = await extractTextFromFile(source);
    } catch (error) {
      console.error(`处理文件 ${source.name} 时出错:`, error);
      continue;
    }

    content = content.trim();
    if (!content) continue;

    const document = {
      id: uid('doc'),
      name: source.name,
      content,
      createdAt: Date.now()
    };

    nextDocuments.push(document);
    inserted.push({ id: document.id, name: document.name, createdAt: document.createdAt });

    const parts = chunkText(content);
    for (const part of parts) {
      const embedding = await createEmbedding(part);
      nextChunks.push({
        id: uid('chunk'),
        documentId: document.id,
        documentName: document.name,
        text: part,
        tokens: tokenize(part),
        embedding
      });
    }
  }

  if (!inserted.length) {
    throw createAppError('EMPTY_FILES', '上传的文件内容为空', '请确认文件不是空文件，且编码为 UTF-8。', 400);
  }

  state.documents.push(...nextDocuments);
  state.chunks.push(...nextChunks);
  await persistState();

  return inserted;
}

function listDocuments() {
  return state.documents.map((document) => ({
    id: document.id,
    name: document.name,
    createdAt: document.createdAt
  }));
}

function getDocumentContent(id) {
  const document = state.documents.find((doc) => doc.id === id);
  if (!document) {
    throw createAppError('DOCUMENT_NOT_FOUND', '知识文件不存在', '请确认传入的文档 ID 是否正确。', 404);
  }
  return {
    id: document.id,
    name: document.name,
    content: document.content,
    createdAt: document.createdAt
  };
}

async function deleteDocument(id) {
  const before = state.documents.length;
  state.documents = state.documents.filter((document) => document.id !== id);
  state.chunks = state.chunks.filter((chunk) => chunk.documentId !== id);

  if (before === state.documents.length) {
    throw createAppError('DOCUMENT_NOT_FOUND', '知识文件不存在', '请确认传入的文档 ID 是否正确。', 404);
  }

  await persistState();
  return { ok: true, id };
}

async function clearDocuments() {
  state.documents = [];
  state.chunks = [];
  await persistState();
  return { ok: true };
}

function toTextContent(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: value
  };
}

function toErrorContent(error) {
  return {
    content: [
      {
        type: 'text',
        text: error.details ? `${error.message}\n${error.details}` : error.message
      }
    ],
    structuredContent: {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message,
      details: error.details || ''
    },
    isError: true
  };
}

const server = new McpServer({
  name: 'research-agent-mcp-server',
  version: '1.0.0'
});

server.registerTool(
  'retrieve_knowledge',
  {
    description: '从后端向量知识库检索与用户问题最相关的文档片段',
    inputSchema: z.object({
      query: z.string().min(1, 'query 不能为空'),
      topK: z.number().int().min(1).max(10).optional()
    })
  },
  async ({ query, topK = 4 }) => {
    try {
      const citations = await searchKnowledge(query, topK);
      return toTextContent({ citations, count: citations.length });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'list_knowledge_documents',
  {
    description: '列出当前后端知识库中的文档',
    inputSchema: z.object({})
  },
  async () => toTextContent({ documents: listDocuments() })
);

server.registerTool(
  'get_knowledge_document_content',
  {
    description: '获取指定知识文档的完整内容',
    inputSchema: z.object({
      id: z.string().min(1, 'id 不能为空')
    })
  },
  async ({ id }) => {
    try {
      return toTextContent(getDocumentContent(id));
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'ingest_knowledge_documents',
  {
    description: '导入知识文档到向量知识库中并建立向量索引',
    inputSchema: z.object({
      documents: z.array(
        z.object({
          name: z.string().min(1, 'name 不能为空'),
          content: z.string().min(1, 'content 不能为空'),
          isBinary: z.boolean().optional()
        })
      ).min(1, '至少导入一份文档')
    })
  },
  async ({ documents }) => {
    try {
      const inserted = await ingestDocuments(documents);
      return toTextContent({ documents: inserted, message: `已成功导入 ${inserted.length} 份知识文件。` });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'delete_knowledge_document',
  {
    description: '删除指定的知识文档以及对应的向量索引',
    inputSchema: z.object({
      id: z.string().min(1, 'id 不能为空')
    })
  },
  async ({ id }) => {
    try {
      return toTextContent(await deleteDocument(id));
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'clear_knowledge_documents',
  {
    description: '清空知识库中的所有文档与向量索引',
    inputSchema: z.object({})
  },
  async () => toTextContent(await clearDocuments())
);

server.registerTool(
  'get_current_time',
  {
    description: '获取当前系统时间',
    inputSchema: z.object({})
  },
  async () =>
    toTextContent({
      iso: new Date().toISOString(),
      locale: new Date().toLocaleString('zh-CN', { hour12: false })
    })
);

// Agent 调度中心相关工具
server.registerTool(
  'list_agents',
  {
    description: '列出所有可用的专业 Agent',
    inputSchema: z.object({})
  },
  async () => {
    const agentList = Object.values(agents).map(agent => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      capabilities: agent.capabilities
    }));
    return toTextContent({ agents: agentList, count: agentList.length });
  }
);

server.registerTool(
  'select_agent',
  {
    description: '选择一个专业 Agent 来处理特定任务',
    inputSchema: z.object({
      agentId: z.string().min(1, 'agentId 不能为空'),
      task: z.string().min(1, 'task 不能为空')
    })
  },
  async ({ agentId, task }) => {
    const agent = Object.values(agents).find(a => a.id === agentId);
    if (!agent) {
      throw createAppError('AGENT_NOT_FOUND', 'Agent 不存在', '请选择有效的 Agent ID。', 404);
    }
    
    // 保存 Agent 状态
    state.agentState.selectedAgent = agentId;
    state.agentState.currentTask = task;
    
    return toTextContent({
      agent: agent,
      task: task,
      message: `已选择 ${agent.name} 处理任务：${task}`
    });
  }
);

server.registerTool(
  'get_agent_info',
  {
    description: '获取指定 Agent 的详细信息',
    inputSchema: z.object({
      agentId: z.string().min(1, 'agentId 不能为空')
    })
  },
  async ({ agentId }) => {
    const agent = Object.values(agents).find(a => a.id === agentId);
    if (!agent) {
      throw createAppError('AGENT_NOT_FOUND', 'Agent 不存在', '请选择有效的 Agent ID。', 404);
    }
    return toTextContent(agent);
  }
);

server.registerTool(
  'agent协作',
  {
    description: '协调多个 Agent 协作完成复杂任务',
    inputSchema: z.object({
      task: z.string().min(1, 'task 不能为空'),
      agents: z.array(z.string()).min(1, '至少选择一个 Agent')
    })
  },
  async ({ task, agents: agentIds }) => {
    const selectedAgents = agentIds.map(id => Object.values(agents).find(a => a.id === id)).filter(Boolean);
    
    if (selectedAgents.length === 0) {
      throw createAppError('AGENTS_NOT_FOUND', '没有找到有效的 Agent', '请选择有效的 Agent ID。', 404);
    }
    
    // 模拟 Agent 协作过程
    const协作Plan = {
      task: task,
      agents: selectedAgents,
      steps: selectedAgents.map(agent => ({
        agent: agent.name,
        role: getAgentRole(agent.id, task),
        status: 'pending'
      }))
    };
    
    // 保存协作计划
    state.agentState.collaborationPlan =协作Plan;
    
    return toTextContent({
      message: `已启动多 Agent 协作处理任务：${task}`,
      plan:协作Plan
    });
  }
);

// 辅助函数：根据 Agent ID 和任务获取角色
function getAgentRole(agentId, task) {
  const roleMap = {
    'literature-agent': '文献收集和分析',
    'writing-agent': '内容撰写和优化',
    'formula-agent': '公式推导和验证'
  };
  return roleMap[agentId] || '辅助支持';
}

// 文献检索 Agent 相关工具
server.registerTool(
  'search_literature',
  {
    description: '从 arXiv 与 Semantic Scholar 检索学术文献',
    inputSchema: z.object({
      query: z.string().min(1, 'query 不能为空'),
      source: z.enum(['all', 'arxiv', 'semantic_scholar', 'openalex']).optional(),
      limit: z.number().int().min(1).max(10).optional(),
      sinceYear: z.number().int().min(1900).max(2100).optional(),
      untilYear: z.number().int().min(1900).max(2100).optional()
    })
  },
  async ({ query, source = 'all', limit = 5, sinceYear, untilYear }) => {
    try {
      const expandedLimit = Math.min(50, Math.max(limit * 4, limit));
      const warnings = [];

      async function safeFetch(name, runner) {
        try {
          const rows = await runner();
          return { name, rows, ok: true };
        } catch (error) {
          warnings.push({
            source: name,
            code: error?.code || 'UPSTREAM_ERROR',
            message: error?.message || `${name} 检索失败`,
            details: error?.details || ''
          });
          return { name, rows: [], ok: false };
        }
      }

      const tasks = [];
      if (source === 'all') {
        tasks.push(safeFetch('openalex', () => searchOpenAlex(query, expandedLimit)));
        tasks.push(safeFetch('arxiv', () => searchArxiv(query, expandedLimit)));
        tasks.push(safeFetch('semantic_scholar', () => searchSemanticScholar(query, expandedLimit)));
      } else {
        if (source === 'arxiv') tasks.push(safeFetch('arxiv', () => searchArxiv(query, expandedLimit)));
        if (source === 'semantic_scholar') tasks.push(safeFetch('semantic_scholar', () => searchSemanticScholar(query, expandedLimit)));
        if (source === 'openalex') tasks.push(safeFetch('openalex', () => searchOpenAlex(query, expandedLimit)));
      }

      const resultsBySource = await Promise.all(tasks);
      const arxivRows = resultsBySource.find((item) => item.name === 'arxiv')?.rows || [];
      const s2Rows = resultsBySource.find((item) => item.name === 'semantic_scholar')?.rows || [];
      const openalexRows = resultsBySource.find((item) => item.name === 'openalex')?.rows || [];

      const currentYear = new Date().getFullYear();
      const queryYears = Array.from(String(query).matchAll(/\b(19|20)\d{2}\b/g)).map((m) => Number(m[0])).filter((y) => Number.isFinite(y));

      let minYear = Number.isInteger(sinceYear) ? sinceYear : currentYear - 3;
      let maxYear = Number.isInteger(untilYear) ? untilYear : undefined;

      if (!Number.isInteger(sinceYear) && queryYears.length === 1) {
        minYear = queryYears[0];
        maxYear = queryYears[0];
      }

      if (!Number.isInteger(sinceYear) && !Number.isInteger(untilYear) && queryYears.length >= 2) {
        minYear = Math.min(...queryYears);
        maxYear = Math.max(...queryYears);
      }

      const merged = [...arxivRows, ...s2Rows, ...openalexRows]
        .filter((paper) => paper.title)
        .filter((paper) => {
          if (!paper.year) return true;
          if (paper.year < minYear) return false;
          if (Number.isInteger(maxYear) && paper.year > maxYear) return false;
          return true;
        })
        .sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0))
        .slice(0, limit);

      if (!merged.length && warnings.length === tasks.length && tasks.length > 0) {
        return toErrorContent(createAppError('LITERATURE_ALL_SOURCES_FAILED', '文献检索失败：所有数据源都不可用', warnings.map((w) => `${w.source}: ${w.message}`).join('\n'), 502));
      }

      cacheLiteraturePapers(merged);

      return toTextContent({
        query,
        source,
        sinceYear: minYear,
        untilYear: maxYear,
        currentYear,
        results: merged,
        count: merged.length,
        warnings
      });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'analyze_literature',
  {
    description: '分析检索到的文献内容和引用指标',
    inputSchema: z.object({
      paperId: z.string().min(1, 'paperId 不能为空')
    })
  },
  async ({ paperId }) => {
    try {
      const paper = findCachedPaper(paperId);
      if (!paper) {
        throw createAppError('PAPER_NOT_FOUND', '未找到指定文献', '请先调用 search_literature 并使用返回的 paperId。', 404);
      }

      return toTextContent({
        id: paper.paperId,
        source: paper.source,
        title: paper.title,
        year: paper.year,
        venue: paper.venue,
        keyFindings: draftFindingsFromAbstract(paper.abstract),
        citations: {
          citedBy: paper.citationCount,
          references: paper.referenceCount
        },
        links: {
          url: paper.url,
          pdfUrl: paper.pdfUrl
        }
      });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'summarize_literature',
  {
    description: '基于检索结果生成文献摘要',
    inputSchema: z.object({
      paperId: z.string().min(1, 'paperId 不能为空')
    })
  },
  async ({ paperId }) => {
    try {
      const paper = findCachedPaper(paperId);
      if (!paper) {
        throw createAppError('PAPER_NOT_FOUND', '未找到指定文献', '请先调用 search_literature 并使用返回的 paperId。', 404);
      }

      const abstract = normalizeWhitespace(paper.abstract || '');
      const summary = abstract
        ? abstract.slice(0, 700)
        : '当前文献缺少摘要内容，建议补充全文后再生成更准确摘要。';

      return toTextContent({
        id: paper.paperId,
        source: paper.source,
        title: paper.title,
        summary,
        keyPoints: draftFindingsFromAbstract(abstract)
      });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'ingest_literature_to_knowledge',
  {
    description: '将检索到的文献（标题与摘要）导入知识库并建立向量索引',
    inputSchema: z.object({
      paperIds: z.array(z.string().min(1)).min(1, '至少提供一个 paperId')
    })
  },
  async ({ paperIds }) => {
    try {
      const inserted = await ingestLiteratureByPaperIds(paperIds);
      return toTextContent({
        documents: inserted,
        message: `已导入 ${inserted.length} 篇文献到知识库。`
      });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'extract_paper_schema',
  {
    description: '为指定文献抽取 Paper Schema（结构化卡片）并持久化',
    inputSchema: z.object({
      paperId: z.string().min(1, 'paperId 不能为空')
    })
  },
  async ({ paperId }) => {
    try {
      const paper = getPaperById(paperId);
      const schema = await generatePaperSchema(paper);

      state.literature.paperSchemas[paperId] = {
        paperId,
        source: paper.source,
        title: paper.title,
        schema,
        updatedAt: Date.now()
      };
      await persistState();

      return toTextContent({
        paperId,
        schema,
        message: 'Paper Schema 抽取并保存成功。'
      });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'get_paper_schema',
  {
    description: '获取已保存的 Paper Schema',
    inputSchema: z.object({
      paperId: z.string().min(1, 'paperId 不能为空')
    })
  },
  async ({ paperId }) => {
    try {
      const record = state.literature.paperSchemas[paperId];
      if (!record) {
        throw createAppError('SCHEMA_NOT_FOUND', 'Paper Schema 不存在', '请先调用 extract_paper_schema。', 404);
      }
      return toTextContent(record);
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'query_paper_memory',
  {
    description: '基于已抽取的 Paper Schema 进行跨论文聚合分析并返回可追溯证据',
    inputSchema: z.object({
      query: z.string().min(1, 'query 不能为空'),
      topK: z.number().int().min(1).max(20).optional()
    })
  },
  async ({ query, topK = 6 }) => {
    try {
      const records = Object.values(state.literature.paperSchemas || {});
      if (!records.length) {
        throw createAppError('SCHEMA_EMPTY', '尚未建立 Paper Memory', '请先对至少一篇文献执行 extract_paper_schema。', 400);
      }

      const keywords = splitKeywords(query);
      const scored = records
        .map((record) => {
          const text = buildSchemaSearchText(record);
          const hitCount = keywords.reduce((acc, keyword) => (text.includes(keyword) ? acc + 1 : acc), 0);
          const score = keywords.length ? hitCount / keywords.length : 0;
          return {
            paperId: record.paperId,
            title: record.title,
            schema: record.schema,
            score
          };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      if (!scored.length) {
        return toTextContent({
          query,
          message: '没有在现有 Paper Memory 中命中相关论文，请先扩大文献范围或调整问题关键词。',
          summary: {
            query,
            totalMatched: 0,
            methods: [],
            datasets: [],
            commonLimitations: []
          },
          papers: [],
          citations: []
        });
      }

      const summary = summarizePaperMemory(scored, query);
      const papers = scored.map((item) => ({
        paperId: item.paperId,
        title: item.title,
        score: Number(item.score.toFixed(4)),
        method: item.schema.method,
        dataset: item.schema.dataset,
        limitations: item.schema.limitations
      }));
      const citations = buildMemoryCitations(scored);

      return toTextContent({
        query,
        summary,
        papers,
        citations
      });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'mine_research_gaps',
  {
    description: '基于 Paper Memory 挖掘研究空白并输出研究机会列表',
    inputSchema: z.object({
      focus: z.string().optional()
    })
  },
  async ({ focus = '' }) => {
    try {
      const records = Object.values(state.literature.paperSchemas || {});
      if (records.length < 2) {
        throw createAppError('GAP_DATA_INSUFFICIENT', '研究空白挖掘需要更多论文', '请至少先完成 2 篇论文的 extract_paper_schema。', 400);
      }

      const opportunities = mineResearchGaps(records, focus);
      if (!opportunities.length) {
        return toTextContent({
          focus,
          opportunities: [],
          message: '当前语料未提取到稳定的研究空白，建议扩大论文覆盖或补充 limitation 信息。'
        });
      }

      return toTextContent({
        focus,
        opportunities,
        count: opportunities.length
      });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

server.registerTool(
  'generate_experiment_spec',
  {
    description: '将研究空白转为结构化 Experiment Spec，并附带可追溯文献证据',
    inputSchema: z.object({
      focus: z.string().optional(),
      gapIndex: z.number().int().min(0).optional()
    })
  },
  async ({ focus = '', gapIndex = 0 }) => {
    try {
      const records = Object.values(state.literature.paperSchemas || {});
      if (records.length < 2) {
        throw createAppError('SPEC_DATA_INSUFFICIENT', '生成 Experiment Spec 需要更多论文', '请至少先完成 2 篇论文的 extract_paper_schema。', 400);
      }

      const opportunities = mineResearchGaps(records, focus);
      if (!opportunities.length) {
        throw createAppError('SPEC_GAP_EMPTY', '当前无法生成 Experiment Spec', '请先调用 mine_research_gaps 确认可用机会点。', 400);
      }

      const selected = opportunities[Math.min(gapIndex, opportunities.length - 1)];
      const spec = buildExperimentSpecFromGap(selected, records);

      return toTextContent({
        focus,
        selectedGap: selected,
        experimentSpec: spec,
        message: 'Experiment Spec 生成成功。'
      });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

// 论文写作 Agent 相关工具
server.registerTool(
  'generate_outline',
  {
    description: '生成论文大纲',
    inputSchema: z.object({
      topic: z.string().min(1, 'topic 不能为空'),
      sections: z.number().int().min(3).max(10).optional()
    })
  },
  async ({ topic, sections = 5 }) => {
    // 模拟论文大纲生成
    const mockOutline = {
      topic: topic,
      sections: [
        {
          id: '1',
          title: '1. 引言',
          subsections: [
            '1.1 研究背景',
            '1.2 研究目的',
            '1.3 研究方法',
            '1.4 论文结构'
          ]
        },
        {
          id: '2',
          title: '2. 文献综述',
          subsections: [
            '2.1 相关研究现状',
            '2.2 现有方法分析',
            '2.3 研究 gaps',
            '2.4 本文贡献'
          ]
        },
        {
          id: '3',
          title: '3. 研究方法',
          subsections: [
            '3.1 研究设计',
            '3.2 数据收集',
            '3.3 分析方法',
            '3.4 评估指标'
          ]
        },
        {
          id: '4',
          title: '4. 实验结果',
          subsections: [
            '4.1 实验设置',
            '4.2 结果分析',
            '4.3 对比研究',
            '4.4 讨论'
          ]
        },
        {
          id: '5',
          title: '5. 结论与展望',
          subsections: [
            '5.1 主要结论',
            '5.2 研究局限性',
            '5.3 未来研究方向',
            '5.4 总结'
          ]
        }
      ].slice(0, sections)
    };
    
    return toTextContent(mockOutline);
  }
);

server.registerTool(
  'write_content',
  {
    description: '撰写论文内容',
    inputSchema: z.object({
      section: z.string().min(1, 'section 不能为空'),
      topic: z.string().min(1, 'topic 不能为空'),
      length: z.number().int().min(100).max(2000).optional()
    })
  },
  async ({ section, topic, length = 500 }) => {
    // 模拟论文内容撰写
    const mockContent = {
      section: section,
      topic: topic,
      content: `# ${section}\n\n这是关于"${topic}"的${section}部分内容。本部分详细讨论了${topic}的相关概念、理论基础和应用场景。\n\n首先，我们介绍了${topic}的基本定义和重要性。${topic}是现代科学研究中的重要领域，它涉及到多个学科的交叉融合，包括计算机科学、数学、统计学等。\n\n其次，我们分析了${topic}的发展历程和现状。近年来，随着技术的不断进步，${topic}在各个领域都取得了显著的进展，为科学研究提供了新的方法和思路。\n\n然后，我们探讨了${topic}的核心技术和方法。这些技术和方法不仅推动了${topic}本身的发展，也为其他领域的研究提供了有力的工具。\n\n最后，我们讨论了${topic}的未来发展趋势和挑战。随着研究的深入，${topic}将面临更多的机遇和挑战，需要研究者们不断创新和探索。\n\n通过本部分的讨论，我们希望能够为读者提供对${topic}的全面了解，为后续的研究工作奠定基础。`,
      wordCount: length
    };
    
    return toTextContent(mockContent);
  }
);

server.registerTool(
  'check_grammar',
  {
    description: '检查论文语法和风格',
    inputSchema: z.object({
      content: z.string().min(1, 'content 不能为空')
    })
  },
  async ({ content }) => {
    // 模拟语法检查结果
    const mockCheck = {
      issues: [
        {
          type: 'grammar',
          message: '建议使用更正式的学术语言',
          location: '第2段第3行'
        },
        {
          type: 'style',
          message: '句子过长，建议拆分',
          location: '第3段第1行'
        },
        {
          type: 'vocabulary',
          message: '建议使用更精确的专业术语',
          location: '第4段第2行'
        }
      ],
      suggestions: [
        '增加更多的学术引用',
        '使用更一致的术语',
        '改进段落结构'
      ],
      score: 85
    };
    
    return toTextContent(mockCheck);
  }
);

server.registerTool(
  'format_citations',
  {
    description: '处理论文引用格式',
    inputSchema: z.object({
      citations: z.array(z.object({
        author: z.string(),
        title: z.string(),
        year: z.number(),
        journal: z.string().optional()
      })),
      style: z.string().optional()
    })
  },
  async ({ citations, style = 'APA' }) => {
    // 模拟引用格式处理
    const formattedCitations = citations.map((citation, index) => ({
      id: index + 1,
      original: citation,
      formatted: style === 'APA' 
        ? `${citation.author} (${citation.year}). ${citation.title}. ${citation.journal || 'Unpublished work'}.`
        : `${citation.author}. ${citation.title}. ${citation.journal || 'Unpublished work'}, ${citation.year}.`
    }));
    
    return toTextContent({
      style: style,
      citations: formattedCitations,
      bibliography: formattedCitations.map(c => c.formatted).join('\n')
    });
  }
);

// 公式推导 Agent 相关工具
server.registerTool(
  'derive_formula',
  {
    description: '推导数学公式',
    inputSchema: z.object({
      formula: z.string().min(1, 'formula 不能为空'),
      steps: z.number().int().min(1).max(20).optional()
    })
  },
  async ({ formula, steps = 5 }) => {
    // 模拟公式推导
    const mockDerivation = {
      originalFormula: formula,
      steps: [
        {
          step: 1,
          expression: '初始公式: ' + formula,
          explanation: '给定初始公式'
        },
        {
          step: 2,
          expression: '应用基本代数规则',
          explanation: '展开括号或简化表达式'
        },
        {
          step: 3,
          expression: '合并同类项',
          explanation: '将相同变量的项合并'
        },
        {
          step: 4,
          expression: '应用微积分规则（如果适用）',
          explanation: '求导或积分操作'
        },
        {
          step: 5,
          expression: '最终简化形式',
          explanation: '得到最终推导结果'
        }
      ].slice(0, steps),
      result: '推导完成: ' + formula + ' 的简化形式'
    };
    
    return toTextContent(mockDerivation);
  }
);

server.registerTool(
  'verify_formula',
  {
    description: '验证数学公式的正确性',
    inputSchema: z.object({
      formula: z.string().min(1, 'formula 不能为空')
    })
  },
  async ({ formula }) => {
    // 模拟公式验证
    const mockVerification = {
      formula: formula,
      isValid: true,
      checks: [
        {
          type: '语法检查',
          result: '通过',
          message: '公式语法正确'
        },
        {
          type: '逻辑检查',
          result: '通过',
          message: '公式逻辑自洽'
        },
        {
          type: '边界情况检查',
          result: '通过',
          message: '边界情况处理正确'
        }
      ],
      suggestions: [
        '可以考虑更简洁的表达方式',
        '建议添加适用条件说明'
      ]
    };
    
    return toTextContent(mockVerification);
  }
);

server.registerTool(
  'explain_formula',
  {
    description: '解释数学公式的含义和应用',
    inputSchema: z.object({
      formula: z.string().min(1, 'formula 不能为空')
    })
  },
  async ({ formula }) => {
    // 模拟公式解释
    const mockExplanation = {
      formula: formula,
      explanation: '这个公式描述了变量之间的关系，在科学研究中常用于建模和预测。',
      components: [
        {
          symbol: 'x',
          meaning: '自变量，表示输入值'
        },
        {
          symbol: 'y',
          meaning: '因变量，表示输出值'
        },
        {
          symbol: 'a',
          meaning: '系数，表示比例关系'
        },
        {
          symbol: 'b',
          meaning: '常数项，表示基础值'
        }
      ],
      applications: [
        '物理学中的运动学模型',
        '经济学中的需求预测',
        '工程学中的系统建模',
        '生物学中的生长模型'
      ],
      examples: [
        '在自由落体运动中，位移与时间的关系可以用类似公式表示',
        '在市场分析中，商品价格与需求量的关系可以用类似公式建模'
      ]
    };
    
    return toTextContent(mockExplanation);
  }
);

server.registerTool(
  'apply_formula',
  {
    description: '应用数学公式解决实际问题',
    inputSchema: z.object({
      formula: z.string().min(1, 'formula 不能为空'),
      parameters: z.object({}),
      problem: z.string().optional()
    })
  },
  async ({ formula, parameters, problem }) => {
    // 模拟公式应用
    const mockApplication = {
      formula: formula,
      problem: problem || '应用公式解决实际问题',
      parameters: parameters,
      calculation: '根据给定参数计算结果的过程',
      result: '计算结果: 42',
      interpretation: '这个结果表示在给定条件下的预期值，符合实际情况。',
      implications: [
        '结果在合理范围内',
        '可以用于预测类似情况下的结果',
        '需要进一步验证实际数据'
      ]
    };
    
    return toTextContent(mockApplication);
  }
);

// 文献知识库管理相关工具
server.registerTool(
  'add_literature_category',
  {
    description: '添加文献分类',
    inputSchema: z.object({
      name: z.string().min(1, 'name 不能为空'),
      description: z.string().optional()
    })
  },
  async ({ name, description }) => {
    const category = {
      id: uid('cat'),
      name: name,
      description: description || '',
      createdAt: Date.now()
    };
    
    state.literature.categories.push(category);
    
    return toTextContent({
      category: category,
      message: `已添加分类：${name}`
    });
  }
);

server.registerTool(
  'add_literature_tag',
  {
    description: '添加文献标签',
    inputSchema: z.object({
      name: z.string().min(1, 'name 不能为空')
    })
  },
  async ({ name }) => {
    const tag = {
      id: uid('tag'),
      name: name,
      createdAt: Date.now()
    };
    
    state.literature.tags.push(tag);
    
    return toTextContent({
      tag: tag,
      message: `已添加标签：${name}`
    });
  }
);

server.registerTool(
  'list_literature_categories',
  {
    description: '列出所有文献分类',
    inputSchema: z.object({})
  },
  async () => {
    return toTextContent({
      categories: state.literature.categories,
      count: state.literature.categories.length
    });
  }
);

server.registerTool(
  'list_literature_tags',
  {
    description: '列出所有文献标签',
    inputSchema: z.object({})
  },
  async () => {
    return toTextContent({
      tags: state.literature.tags,
      count: state.literature.tags.length
    });
  }
);

server.registerTool(
  'search_literature_by_category',
  {
    description: '按分类搜索文献',
    inputSchema: z.object({
      categoryId: z.string().min(1, 'categoryId 不能为空')
    })
  },
  async ({ categoryId }) => {
    // 模拟按分类搜索结果
    const mockResults = [
      {
        id: '1',
        title: '深度学习在科学研究中的应用',
        authors: ['张三', '李四'],
        category: categoryId,
        tags: ['深度学习', '科学研究'],
        year: new Date().getFullYear(),
        abstract: '本文探讨了深度学习技术在科学研究中的应用，包括图像识别、数据预测等领域。'
      },
      {
        id: '2',
        title: '人工智能辅助科研的进展',
        authors: ['王五', '赵六'],
        category: categoryId,
        tags: ['人工智能', '科研辅助'],
        year: new Date().getFullYear() - 1,
        abstract: '本文综述了人工智能技术在辅助科研方面的最新进展，包括文献分析、实验设计等。'
      }
    ];
    
    return toTextContent({
      categoryId: categoryId,
      results: mockResults,
      count: mockResults.length
    });
  }
);

server.registerTool(
  'search_literature_by_tag',
  {
    description: '按标签搜索文献',
    inputSchema: z.object({
      tagId: z.string().min(1, 'tagId 不能为空')
    })
  },
  async ({ tagId }) => {
    // 模拟按标签搜索结果
    const mockResults = [
      {
        id: '1',
        title: '深度学习在科学研究中的应用',
        authors: ['张三', '李四'],
        category: 'cat-1',
        tags: [tagId, '科学研究'],
        year: 2024,
        abstract: '本文探讨了深度学习技术在科学研究中的应用，包括图像识别、数据预测等领域。'
      },
      {
        id: '3',
        title: '深度学习在医学影像中的应用',
        authors: ['孙七', '周八'],
        category: 'cat-2',
        tags: [tagId, '医学影像'],
        year: new Date().getFullYear(),
        abstract: '本文研究了深度学习技术在医学影像分析中的应用，提高了疾病诊断的准确性。'
      }
    ];
    
    return toTextContent({
      tagId: tagId,
      results: mockResults,
      count: mockResults.length
    });
  }
);

// 多 Agent 协作机制相关工具
server.registerTool(
  'decompose_task',
  {
    description: '分解复杂科研任务',
    inputSchema: z.object({
      task: z.string().min(1, 'task 不能为空')
    })
  },
  async ({ task }) => {
    // 模拟任务分解
    const mockDecomposition = {
      task: task,
      subtasks: [
        {
          id: 'subtask-1',
          title: '文献调研',
          description: '收集和分析相关领域的学术文献',
          agent: 'literature-agent',
          priority: 'high'
        },
        {
          id: 'subtask-2',
          title: '论文大纲设计',
          description: '设计论文的结构和章节',
          agent: 'writing-agent',
          priority: 'high'
        },
        {
          id: 'subtask-3',
          title: '公式推导',
          description: '推导和验证相关数学公式',
          agent: 'formula-agent',
          priority: 'medium'
        },
        {
          id: 'subtask-4',
          title: '论文撰写',
          description: '根据大纲撰写论文内容',
          agent: 'writing-agent',
          priority: 'high'
        },
        {
          id: 'subtask-5',
          title: '语法检查',
          description: '检查论文的语法和风格',
          agent: 'writing-agent',
          priority: 'medium'
        }
      ]
    };
    
    return toTextContent(mockDecomposition);
  }
);

server.registerTool(
  'assign_agents',
  {
    description: '为子任务分配 Agent',
    inputSchema: z.object({
      subtasks: z.array(z.object({
        id: z.string(),
        title: z.string(),
        agent: z.string()
      }))
    })
  },
  async ({ subtasks }) => {
    // 模拟 Agent 分配
    const assignments = subtasks.map(subtask => ({
      ...subtask,
      assigned: true,
      estimatedTime: '2-4 小时',
      status: 'pending'
    }));
    
    return toTextContent({
      assignments: assignments,
      totalAssignments: assignments.length
    });
  }
);

server.registerTool(
  'execute_collaboration',
  {
    description: '执行多 Agent 协作流程',
    inputSchema: z.object({
      collaborationId: z.string().min(1, 'collaborationId 不能为空')
    })
  },
  async ({ collaborationId }) => {
    // 模拟协作执行
    const mockExecution = {
      collaborationId: collaborationId,
      status: 'in_progress',
      steps: [
        {
          id: 'step-1',
          agent: 'literature-agent',
          task: '文献调研',
          status: 'completed',
          result: '已收集 10 篇相关文献'
        },
        {
          id: 'step-2',
          agent: 'writing-agent',
          task: '论文大纲设计',
          status: 'completed',
          result: '已完成论文大纲，包含 5 个章节'
        },
        {
          id: 'step-3',
          agent: 'formula-agent',
          task: '公式推导',
          status: 'in_progress',
          result: '正在进行公式推导'
        },
        {
          id: 'step-4',
          agent: 'writing-agent',
          task: '论文撰写',
          status: 'pending',
          result: ''
        },
        {
          id: 'step-5',
          agent: 'writing-agent',
          task: '语法检查',
          status: 'pending',
          result: ''
        }
      ],
      progress: 40
    };
    
    return toTextContent(mockExecution);
  }
);

server.registerTool(
  'get_collaboration_status',
  {
    description: '获取协作任务的状态',
    inputSchema: z.object({
      collaborationId: z.string().min(1, 'collaborationId 不能为空')
    })
  },
  async ({ collaborationId }) => {
    // 模拟协作状态
    const mockStatus = {
      collaborationId: collaborationId,
      status: 'in_progress',
      progress: 60,
      nextStep: '论文撰写',
      estimatedCompletion: '2 小时后',
      agents: [
        {
          id: 'literature-agent',
          status: 'idle'
        },
        {
          id: 'writing-agent',
          status: 'busy'
        },
        {
          id: 'formula-agent',
          status: 'idle'
        }
      ]
    };
    
    return toTextContent(mockStatus);
  }
);

server.registerTool(
  'complete_collaboration',
  {
    description: '完成协作任务',
    inputSchema: z.object({
      collaborationId: z.string().min(1, 'collaborationId 不能为空')
    })
  },
  async ({ collaborationId }) => {
    // 模拟协作完成
    const mockCompletion = {
      collaborationId: collaborationId,
      status: 'completed',
      progress: 100,
      results: [
        '完成文献调研，收集了 15 篇相关文献',
        '设计了详细的论文大纲',
        '完成了关键公式的推导和验证',
        '撰写了完整的论文初稿',
        '进行了语法和风格检查'
      ],
      summary: '多 Agent 协作成功完成了科研任务，生成了完整的论文初稿。'
    };
    
    return toTextContent(mockCompletion);
  }
);

const transport = new StdioServerTransport();
await loadLibraries();
await hydrateState();
await server.connect(transport);
