import { createAppError } from '../errors.js';
import { fetchWithTimeout } from '../fetchWithRetry.js';
import { uid } from '../utils.js';

const OPENALEX_API_URL = 'https://api.openalex.org/works';
const OPENALEX_TIMEOUT_MS = 8000;
const OPENALEX_SELECT_FIELDS = [
  'id',
  'display_name',
  'publication_year',
  'abstract_inverted_index',
  'authorships',
  'primary_location',
  'cited_by_count',
  'referenced_works_count',
  'open_access'
].join(',');

/**
 * OpenAlex 使用 abstract_inverted_index 存储摘要（token -> 位置数组）。
 * 这里按位置重新拼回原文。
 */
function recoverAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return '';
  const pairs = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (Number.isInteger(pos)) pairs.push([pos, word]);
    }
  }
  return pairs
    .sort((a, b) => a[0] - b[0])
    .map((item) => item[1])
    .join(' ')
    .trim();
}

/**
 * 检索 OpenAlex。返回统一的 Paper 结构（含还原后的摘要）。
 */
export async function searchOpenAlex(query, limit = 5) {
  const endpoint = new URL(OPENALEX_API_URL);
  endpoint.searchParams.set('search', query);
  endpoint.searchParams.set('per-page', String(limit));
  endpoint.searchParams.set('select', OPENALEX_SELECT_FIELDS);

  const response = await fetchWithTimeout(endpoint, {}, OPENALEX_TIMEOUT_MS);
  if (!response.ok) {
    throw createAppError('OPENALEX_FETCH_FAILED', `OpenAlex 检索失败（${response.status}）`, '请稍后重试。', 502);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload.results) ? payload.results : [];

  return rows.map((item) => {
    const id = typeof item.id === 'string' ? item.id : '';
    const paperId = id ? id.split('/').pop() : uid('openalex');
    const authors = Array.isArray(item.authorships)
      ? item.authorships.map((auth) => auth?.author?.display_name).filter(Boolean)
      : [];

    const primaryUrl = item?.primary_location?.landing_page_url || item?.primary_location?.source?.homepage_url || '';
    const pdfUrl = item?.open_access?.oa_url || '';

    return {
      source: 'openalex',
      paperId,
      title: item.display_name || 'Untitled',
      abstract: recoverAbstract(item.abstract_inverted_index),
      authors,
      year: Number.isFinite(item.publication_year) ? item.publication_year : null,
      venue: item?.primary_location?.source?.display_name || '',
      url: primaryUrl || id,
      pdfUrl,
      citationCount: Number.isFinite(item.cited_by_count) ? item.cited_by_count : null,
      referenceCount: Number.isFinite(item.referenced_works_count) ? item.referenced_works_count : null
    };
  });
}
