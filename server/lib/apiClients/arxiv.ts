import { createAppError } from '../errors.js';
import { fetchWithTimeout } from '../fetchWithRetry.js';
import { uid, pickText, pickAllTexts } from '../utils.js';
import type { PaperInput } from '../../repositories/paperRepo.js';

/** arXiv 标准 API 入口与超时配置 */
const ARXIV_API_URL = 'https://export.arxiv.org/api/query';
const ARXIV_TIMEOUT_MS = 8000;

/**
 * 解析 arXiv Atom Feed。
 * 采用轻量正则实现，无外部 XML 依赖，兼顾体积和可读性。
 */
export function parseArxivFeed(xml: string): PaperInput[] {
  const entries: PaperInput[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match = entryRegex.exec(xml);

  while (match) {
    const block = match[1];
    const id = pickText(block, 'id');
    const title = pickText(block, 'title');
    const summary = pickText(block, 'summary');
    const published = pickText(block, 'published');
    const year = Number(published.slice(0, 4)) || null;
    const authors = pickAllTexts(block, 'name');

    const pdfLinkMatch = block.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/i);
    const pdfUrl = pdfLinkMatch?.[1] || '';

    entries.push({
      source: 'arxiv',
      paperId: id || uid('arxiv'),
      title: title || 'Untitled',
      abstract: summary || '',
      authors,
      year,
      venue: 'arXiv',
      url: id || pdfUrl || '',
      pdfUrl: pdfUrl || '',
      citationCount: null,
      referenceCount: null
    });

    match = entryRegex.exec(xml);
  }

  return entries;
}

/**
 * 检索 arXiv，按相关性降序返回统一 Paper 结构。
 */
export async function searchArxiv(query: string, limit = 5): Promise<PaperInput[]> {
  const endpoint = new URL(ARXIV_API_URL);
  endpoint.searchParams.set('search_query', `all:${query}`);
  endpoint.searchParams.set('start', '0');
  endpoint.searchParams.set('max_results', String(limit));
  endpoint.searchParams.set('sortBy', 'relevance');
  endpoint.searchParams.set('sortOrder', 'descending');

  const response = await fetchWithTimeout(endpoint, {}, ARXIV_TIMEOUT_MS);
  if (!response.ok) {
    throw createAppError('ARXIV_FETCH_FAILED', `arXiv 检索失败（${response.status}）`, '请稍后重试。', 502);
  }

  const xml = await response.text();
  return parseArxivFeed(xml);
}
