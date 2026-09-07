/**
 * 知识库服务 —— 文档解析、分块、向量化与检索。
 *
 * 从 mcp-server.ts 抽出：这些逻辑与 MCP 协议无关，抽出后可独立测试，
 * 也便于 HTTP 层在不经过 MCP 的场景直接复用。
 */

import { createAppError } from '../lib/errors.js';
import { createEmbedding } from '../lib/apiClients/qwen.js';
import * as chunkRepo from '../repositories/chunkRepo.js';
import type { VectorSearchHit } from '../repositories/chunkRepo.js';
import type { DocumentRow } from '../db/types.js';
import { isRecord, toAppError } from '../mcp/toolkit.js';

type PdfParser = (buffer: Buffer) => Promise<{ text: string }>;
type MammothParser = { extractRawText(input: { buffer: Buffer }): Promise<{ value: string }> };

export interface TextChunk {
  text: string;
  spanStart: number;
  spanEnd: number;
}

export interface KnowledgeCitation {
  id: string;
  title: string;
  snippet: string;
  source: string;
  score: number;
}

export interface UploadedDocument {
  name: string;
  content: string;
  isBinary?: boolean;
}

/** 单条相似度下限：低于该值的召回视为噪声 */
export const MIN_VECTOR_SCORE = 0.15;

/** 支持解析的文件扩展名 */
const SUPPORTED_FILE_PATTERN = /\.(txt|md|markdown|json|pdf|docx)$/i;

// PDF / DOCX 解析库按需加载：装不上时降级为仅支持文本文件，不阻塞启动
let pdf: PdfParser | null = null;
let mammoth: MammothParser | null = null;

export async function loadDocumentParsers(): Promise<void> {
  try {
    const pdfParse = (await import('pdf-parse')) as unknown as PdfParser & { default?: PdfParser };
    pdf = typeof pdfParse.default === 'function' ? pdfParse.default : pdfParse;
    const mammothImport = await import('mammoth');
    mammoth = (
      isRecord(mammothImport) && isRecord(mammothImport.default) ? mammothImport.default : mammothImport
    ) as MammothParser;
    console.log('PDF和DOCX处理库加载成功');
  } catch (error) {
    console.error('PDF和DOCX处理库加载失败:', error);
    console.log('将使用降级模式，仅支持文本文件');
  }
}

/**
 * 定长滑窗分块。返回带原文区间的对象，供证据溯源定位原文位置。
 */
export function chunkText(text: string, chunkSize = 900, overlap = 160): TextChunk[] {
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    const raw = text.slice(start, end);
    const value = raw.trim();
    if (value) {
      // trim 会改变边界，这里换算回原文中的真实区间
      const leading = raw.length - raw.trimStart().length;
      chunks.push({ text: value, spanStart: start + leading, spanEnd: start + leading + value.length });
    }
    start += chunkSize - overlap;
  }
  return chunks;
}

export function buildCitation(row: VectorSearchHit): KnowledgeCitation {
  return {
    id: row.chunkId,
    title: row.documentName,
    snippet: row.text,
    source: `向量知识库 / ${row.documentName}`,
    score: Number(row.score.toFixed(4))
  };
}

export async function searchKnowledge(query: string, topK = 4): Promise<KnowledgeCitation[]> {
  if (!chunkRepo.countChunks()) {
    return [];
  }

  const queryEmbedding = await createEmbedding(query);
  return chunkRepo
    .searchChunksByVector(queryEmbedding, topK)
    .filter((row) => row.score > MIN_VECTOR_SCORE)
    .map(buildCitation);
}

/**
 * 把一篇文档写入知识库：先落文档行，再逐块生成向量后单事务写入。
 * 向量生成放在事务外，避免长时间持有写锁。
 */
export async function persistDocumentWithChunks({
  name,
  content,
  source
}: {
  name: string;
  content: string;
  source: string;
}): Promise<DocumentRow> {
  const parts = chunkText(content);
  const items = [];
  for (const part of parts) {
    items.push({ ...part, embedding: await createEmbedding(part.text) });
  }

  const document = chunkRepo.createDocument({
    name,
    content,
    charCount: content.length,
    sizeBytes: Buffer.byteLength(content, 'utf-8'),
    source
  });

  if (!document) {
    throw createAppError('DOCUMENT_CREATE_FAILED', '知识文件写入失败', '数据库未返回新建文档。', 500);
  }
  chunkRepo.insertChunksWithVectors(document.id, items);
  return document;
}

export async function extractTextFromFile(document: UploadedDocument): Promise<string> {
  const name = document.name.toLowerCase();
  const content = document.content;
  const isBinary = document.isBinary || false;

  if (name.endsWith('.pdf')) {
    if (!pdf) {
      throw createAppError('PDF_LIBRARY_NOT_LOADED', 'PDF处理库未加载', '请检查依赖安装是否正确。', 500);
    }
    try {
      const pdfData = Buffer.from(content, isBinary ? 'base64' : 'utf-8');
      const pdfResult = await pdf(pdfData);
      return pdfResult.text;
    } catch (error) {
      console.error('处理PDF文件时出错:', error);
      throw createAppError('PDF_PROCESS_ERROR', 'PDF文件处理失败', toAppError(error).message, 400);
    }
  }

  if (name.endsWith('.docx')) {
    if (!mammoth) {
      throw createAppError('MAMMOTH_LIBRARY_NOT_LOADED', 'DOCX处理库未加载', '请检查依赖安装是否正确。', 500);
    }
    try {
      const docxData = Buffer.from(content, isBinary ? 'base64' : 'utf-8');
      const docxResult = await mammoth.extractRawText({ buffer: docxData });
      return docxResult.value;
    } catch (error) {
      console.error('处理DOCX文件时出错:', error);
      throw createAppError('DOCX_PROCESS_ERROR', 'DOCX文件处理失败', toAppError(error).message, 400);
    }
  }

  // 其他文本文件直接返回
  return content;
}

/** 批量导入：单个文件解析失败或内容为空时跳过，不中断整批 */
export async function ingestDocuments(documents: UploadedDocument[]): Promise<Array<Record<string, unknown>>> {
  const supported = documents.filter((document) => SUPPORTED_FILE_PATTERN.test(document.name));

  if (!supported.length) {
    throw createAppError(
      'UNSUPPORTED_FILES',
      '没有可导入的知识文件',
      '仅支持 `.md`、`.markdown`、`.txt`、`.json`、`.pdf`、`.docx` 文件。',
      400
    );
  }

  const inserted: Array<Record<string, unknown>> = [];

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

    const document = await persistDocumentWithChunks({ name: source.name, content, source: 'upload' });
    inserted.push({ id: document.id, name: document.name, createdAt: document.created_at });
  }

  if (!inserted.length) {
    throw createAppError('EMPTY_FILES', '上传的文件内容为空', '请确认文件不是空文件，且编码为 UTF-8。', 400);
  }

  return inserted;
}

export function listDocuments(): Array<Record<string, unknown>> {
  return chunkRepo.listDocuments().map((document) => ({
    id: document.id,
    name: document.name,
    createdAt: document.created_at,
    chunkCount: document.chunkCount
  }));
}

export function getDocumentContent(id: string): Record<string, unknown> {
  const document = chunkRepo.getDocument(id);
  if (!document) {
    throw createAppError('DOCUMENT_NOT_FOUND', '知识文件不存在', '请确认传入的文档 ID 是否正确。', 404);
  }
  return {
    id: document.id,
    name: document.name,
    content: document.content,
    createdAt: document.created_at
  };
}

export function deleteDocument(id: string): Record<string, unknown> {
  if (!chunkRepo.deleteDocument(id)) {
    throw createAppError('DOCUMENT_NOT_FOUND', '知识文件不存在', '请确认传入的文档 ID 是否正确。', 404);
  }
  return { ok: true, id };
}

export function clearDocuments(): Record<string, unknown> {
  chunkRepo.clearAllDocuments();
  return { ok: true };
}
