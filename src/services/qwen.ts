import type {
  ApiErrorPayload,
  BackendStreamEvent,
  ExperimentSpec,
  LiteraturePaper,
  PaperSchema,
  QwenMessage,
  ResearchGapOpportunity,
  ServerDocumentResponse
} from '@/types/chat';

function formatApiError(payload: Partial<ApiErrorPayload>, fallback: string) {
  const message = payload.error || fallback;
  return payload.details ? `${message}\n${payload.details}` : message;
}

function parseSseChunk(chunk: string) {
  const lines = chunk.split('\n').map((line) => line.trim()).filter(Boolean);
  const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
  const data = lines.find((line) => line.startsWith('data:'))?.slice(5).trim() || '{}';
  return { event, data };
}

export async function streamAgentChat(
  messages: QwenMessage[],
  onEvent: (event: BackendStreamEvent) => void,
  signal?: AbortSignal
) {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messages }),
    signal
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `请求失败：${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      break;
    }

    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const segments = buffer.split('\n\n');
    buffer = segments.pop() ?? '';

    for (const segment of segments) {
      const { event, data } = parseSseChunk(segment);
      const payload = JSON.parse(data);

      if (event === 'token') {
        onEvent({ type: 'token', token: payload.token });
      }

      if (event === 'tool') {
        onEvent({
          type: 'tool',
          tool: {
            id: payload.id,
            name: payload.name,
            args: payload.args || {},
            status: payload.status,
            result:
              typeof payload.result === 'string'
                ? payload.result
                : payload.result
                  ? JSON.stringify(payload.result, null, 2)
                  : undefined
          }
        });
      }

      if (event === 'citations') {
        onEvent({ type: 'citations', citations: payload.citations || [] });
      }

      if (event === 'error') {
        onEvent({
          type: 'error',
          message: payload.message || '请求失败',
          details: payload.details,
          code: payload.code
        });
      }

      if (event === 'done') {
        onEvent({ type: 'done', citations: payload.citations || [], tools: payload.tools || [] });
      }
    }
  }
}

export async function fetchKnowledgeDocuments(): Promise<ServerDocumentResponse[]> {
  const response = await fetch('/api/knowledge');
  const data = await response.json();

  if (!response.ok) {
    throw new Error(formatApiError(data, '加载知识库失败'));
  }

  return data.documents || [];
}

export async function fetchKnowledgeDocumentContent(id: string): Promise<{ id: string; name: string; content: string; createdAt: number }> {
  const response = await fetch(`/api/knowledge/content/${id}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(formatApiError(data, '获取文档内容失败'));
  }

  return data;
}

export async function uploadKnowledgeDocuments(files: FileList | File[]): Promise<ServerDocumentResponse[]> {
  const formData = new FormData();
  Array.from(files).forEach((file) => formData.append('files', file));

  const response = await fetch('/api/knowledge/upload', {
    method: 'POST',
    body: formData
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(formatApiError(data, '上传失败'));
  }

  return data.documents || [];
}

export async function deleteKnowledgeDocument(id: string) {
  const response = await fetch(`/api/knowledge/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    let data: Partial<ApiErrorPayload> = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    throw new Error(formatApiError(data, '删除失败'));
  }
}

export async function clearKnowledgeDocuments() {
  const response = await fetch('/api/knowledge', { method: 'DELETE' });
  if (!response.ok) {
    let data: Partial<ApiErrorPayload> = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    throw new Error(formatApiError(data, '清空失败'));
  }
}

export async function searchLiterature(
  query: string,
  limit = 6,
  source: 'all' | 'arxiv' | 'semantic_scholar' | 'openalex' = 'all',
  sinceYear?: number,
  untilYear?: number
) {
  const response = await fetch('/api/research/search-literature', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit, source, sinceYear, untilYear })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(formatApiError(data, '文献检索失败'));
  }
  return (data.results || []) as LiteraturePaper[];
}

export async function ingestLiteratureToKnowledge(paperIds: string[]) {
  const response = await fetch('/api/research/ingest-literature', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paperIds })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(formatApiError(data, '文献入库失败'));
  }
  return data.documents || [];
}

export async function extractPaperSchema(paperId: string) {
  const response = await fetch('/api/research/paper-schema/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paperId })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(formatApiError(data, '抽取 Paper Schema 失败'));
  }
  return data.schema as PaperSchema;
}

export async function mineResearchGaps(focus = '') {
  const response = await fetch('/api/research/gaps/mine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ focus })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(formatApiError(data, '研究空白挖掘失败'));
  }
  return (data.opportunities || []) as ResearchGapOpportunity[];
}

export async function generateExperimentSpec(focus = '', gapIndex = 0) {
  const response = await fetch('/api/research/spec/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ focus, gapIndex })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(formatApiError(data, '生成 Experiment Spec 失败'));
  }
  return data.experimentSpec as ExperimentSpec;
}
