import { createAppError } from '../errors.js';
import { fetchWithTimeout } from '../fetchWithRetry.js';
import { uid } from '../utils.js';

const S2_API_URL = 'https://api.semanticscholar.org/graph/v1/paper/search';
const S2_TIMEOUT_MS = 8000;
const S2_FIELDS = 'paperId,title,abstract,year,venue,authors,url,citationCount,referenceCount,openAccessPdf';

/**
 * 检索 Semantic Scholar。
 * 如果配置了 SEMANTIC_SCHOLAR_API_KEY，会自动加到请求头以提升配额。
 */
export async function searchSemanticScholar(query, limit = 5) {
  const endpoint = new URL(S2_API_URL);
  endpoint.searchParams.set('query', query);
  endpoint.searchParams.set('limit', String(limit));
  endpoint.searchParams.set('fields', S2_FIELDS);

  const headers = {};
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

  const payload = await response.json();
  const rows = Array.isArray(payload.data) ? payload.data : [];
  return rows.map((item) => ({
    source: 'semantic_scholar',
    paperId: item.paperId || uid('s2'),
    title: item.title || 'Untitled',
    abstract: item.abstract || '',
    authors: Array.isArray(item.authors) ? item.authors.map((author) => author.name).filter(Boolean) : [],
    year: item.year || null,
    venue: item.venue || '',
    url: item.url || '',
    pdfUrl: item.openAccessPdf?.url || '',
    citationCount: Number.isFinite(item.citationCount) ? item.citationCount : null,
    referenceCount: Number.isFinite(item.referenceCount) ? item.referenceCount : null
  }));
}
