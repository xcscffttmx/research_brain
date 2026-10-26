import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildCitation,
  chunkText,
  MIN_VECTOR_SCORE,
  extractTextFromFile,
  loadDocumentParsers
} from './knowledgeBase.js';

describe('chunkText', () => {
  it('短文本只产出一个分块，区间覆盖全文', () => {
    const chunks = chunkText('abc', 900, 160);
    expect(chunks).toEqual([{ text: 'abc', spanStart: 0, spanEnd: 3 }]);
  });

  it('空白文本不产出分块', () => {
    expect(chunkText('   \n\t  ')).toEqual([]);
  });

  it('按 chunkSize 切分并保留 overlap', () => {
    const text = 'a'.repeat(25);
    const chunks = chunkText(text, 10, 4);
    // 步长 = chunkSize - overlap = 6
    expect(chunks.map((chunk) => [chunk.spanStart, chunk.spanEnd])).toEqual([
      [0, 10],
      [6, 16],
      [12, 22],
      [18, 25],
      [24, 25]
    ]);
  });

  it('trim 掉的前导空白要换算回原文真实区间', () => {
    // 第二个分块以空格开头，spanStart 必须跳过这些空白
    const text = `${'a'.repeat(6)}    ${'b'.repeat(6)}`;
    const chunks = chunkText(text, 10, 4);
    const second = chunks[1];
    expect(text.slice(second.spanStart, second.spanEnd)).toBe(second.text);
    expect(second.text.startsWith(' ')).toBe(false);
  });

  it('每个分块的 span 都能在原文中还原出分块文本', () => {
    const text = Array.from({ length: 12 }, (_, index) => `第 ${index} 段内容。  `).join('');
    for (const chunk of chunkText(text, 20, 5)) {
      expect(text.slice(chunk.spanStart, chunk.spanEnd)).toBe(chunk.text);
    }
  });
});

describe('buildCitation', () => {
  it('把向量召回行转成引用卡片，score 保留四位小数', () => {
    const citation = buildCitation({
      chunkId: 'chunk-1',
      documentId: 'doc-1',
      documentName: 'agentic-rag.md',
      text: '证据片段',
      spanStart: 10,
      spanEnd: 14,
      distance: 0.123456,
      score: 0.876544
    });

    expect(citation).toEqual({
      id: 'chunk-1',
      title: 'agentic-rag.md',
      snippet: '证据片段',
      source: '向量知识库 / agentic-rag.md',
      score: 0.8765
    });
  });
});

describe('MIN_VECTOR_SCORE', () => {
  it('保持噪声过滤下限不被无意改动', () => {
    expect(MIN_VECTOR_SCORE).toBe(0.15);
  });
});

/** 生成一个含可检索文本的最小合法 PDF 字节，用于验证解析库。 */
function buildMinimalPdf(text: string): Buffer {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n'
  ];
  const stream = `BT\n/F1 18 Tf\n72 700 Td\n(${text}) Tj\nET\n`;
  objects.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);
  objects.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  let body = '%PDF-1.4\n' + objects.join('');
  let offset = '%PDF-1.4\n'.length;
  const offsets = objects.map((obj) => {
    const off = offset;
    offset += obj.length;
    return off;
  });

  body += `xref\n0 6\n0000000000 65535 f \n`;
  for (const o of offsets) body += `${String(o).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(body, 'utf-8');
}

describe('extractTextFromFile / PDF', () => {
  beforeAll(async () => {
    await loadDocumentParsers();
  });

  it('能从 Base64 编码的PDF中提取正文文本', async () => {
    const buffer = buildMinimalPdf('ResearchAgent PDF extraction test');
    const text = await extractTextFromFile({
      name: 'sample.pdf',
      content: buffer.toString('base64'),
      isBinary: true
    });
    expect(text).toContain('ResearchAgent PDF extraction test');
    // 不应混入 v2 默认的页分隔横幅（"-- N of N --"）
    expect(text).not.toMatch(/--\s*\d+ of \d+\s*--/);
  });
});
