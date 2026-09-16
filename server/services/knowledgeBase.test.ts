import { describe, it, expect } from 'vitest';
import { buildCitation, chunkText, MIN_VECTOR_SCORE } from './knowledgeBase.js';

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
