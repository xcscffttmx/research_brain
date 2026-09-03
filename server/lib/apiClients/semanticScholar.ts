import { createAppError } from '../errors.js';
import { fetchWithTimeout } from '../fetchWithRetry.js';
import { uid } from '../utils.js';
import type { PaperInput } from '../../repositories/paperRepo.js';

const S2_API_URL = 'https://api.semanticscholar.org/graph/v1/paper/search';
const S2_TIMEOUT_MS = 8000;
const S2_FIELDS = 'paperId,title,abstract,year,venue,authors,url,citationCount,referenceCount,openAccessPdf';

interface SemanticScholarPaper {
  paperId?: string;
  title?: string;
  abstract?: string;
  authors?: Array<{ name?: string }>;
  year?: number;
  venue?: string;
  url?: string;
  openAccessPdf?: { url?: string };
  citationCount?: number;
  referenceCount?: number;
}

/**
 * 检索 Semantic Scholar。
 * 如果配置了 SEMANTIC_SCHOLAR_API_KEY，会自动加到请求头以提升配额。
 */
export async function searchSemanticScholar(query: string, limit = 5): Promise<PaperInput[]> {
  const endpoint = new URL(S2_API_URL);
  endpoint.searchParams.set('query', query);
  endpoint.searchParams.set('limit', String(limit));
  endpoint.searchParams.set('fields', S2_FIELDS);

  const headers: Record<string, string> = {};
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
    headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  }

  const response = await fetchWithTimeout(endpoint, { headers }, S2_TIMEOUT_MS);
  if (!response.ok) {
    throw createAppError(
      'SEMANTIC_SCHOLAR_FETCH_FAILED',
      `Semantic Scholar 检索失败（${response.status}）`,
      '请稍后重试。',
      502
    );
  }

  const payload = (await response.json()) as { data?: unknown };
  const rows = Array.isArray(payload.data) ? (payload.data as SemanticScholarPaper[]) : [];
  return rows.map((item) => ({
    source: 'semantic_scholar',
    paperId: item.paperId || uid('s2'),
    title: item.title || 'Untitled',
    abstract: item.abstract || '',
    authors: Array.isArray(item.authors)
      ? item.authors.map((author) => author.name).filter((name): name is string => Boolean(name))
      : [],
    year: item.year || null,
    venue: item.venue || '',
    url: item.url || '',
    pdfUrl: item.openAccessPdf?.url || '',
    citationCount: Number.isFinite(item.citationCount) ? Number(item.citationCount) : null,
    referenceCount: Number.isFinite(item.referenceCount) ? Number(item.referenceCount) : null
  }));
}
