import type {
  ApiErrorPayload,
  BackendStreamEvent,
  Citation,
  ExperimentSpec,
  LiteraturePaper,
  PaperSchema,
  QwenMessage,
  ResearchGapOpportunity,
  ServerDocumentResponse,
  ToolInvocation
} from '@/types/chat';
import { streamAgentChat as consumeAgentStream } from './llmStreamAdapter';

function formatApiError(payload: Partial<ApiErrorPayload>, fallback: string) {
  const message = payload.error || fallback;
  return payload.details ? `${message}\n${payload.details}` : message;
}

/** tool_result 的状态 -> 前端 ToolInvocation 状态 */
const TOOL_STATUS_MAP: Record<string, ToolInvocation['status']> = {
  succeeded: 'success',
  failed: 'error',
  timeout: 'error',
  cancelled: 'error'
};

/**
 * 发起一轮对话，把 Stream Adapter 的统一事件翻译成 store 使用的事件。
 *
 * 解码、Gate 拦截、乱序丢弃都在 llmStreamAdapter 内完成，这里只做形状转换。
 */
export async function streamAgentChat(
  messages: QwenMessage[],
  onEvent: (event: BackendStreamEvent) => void,
  signal?: AbortSignal,
  sessionId?: string
) {
  const stream = consumeAgentStream({ messages, sessionId }, { signal });

  for await (const event of stream) {
    switch (event.type) {
      case 'delta':
        onEvent({ type: 'token', token: event.text });
        break;
      case 'plan':
        onEvent({ type: 'plan', runId: event.runId, plan: { intent: event.intent, steps: event.steps } });
        break;
      case 'status':
        onEvent({ type: 'status', stage: event.stage, detail: event.detail });
        break;
      case 'tool_call':
        onEvent({
          type: 'tool',
          tool: { id: event.id, name: event.name, args: (event.args || {}) as Record<string, unknown>, status: 'running' }
        });
        break;
      case 'tool_result':
        onEvent({
          type: 'tool',
          tool: {
            id: event.id,
            name: event.name,
            args: {},
            status: TOOL_STATUS_MAP[event.status] ?? 'error',
            result:
              event.errorMsg ||
              (typeof event.result === 'string' ? event.result : event.result ? JSON.stringify(event.result, null, 2) : undefined)
          }
        });
        break;
      case 'error':
        onEvent({ type: 'error', message: event.message, details: event.details, code: event.code });
        break;
      case 'done':
        onEvent({
          type: 'done',
          reason: event.reason,
          citations: (event.citations || []) as Citation[],
          tools: (event.tools || []) as ToolInvocation[]
        });
        break;
      default:
        break;
    }
  }
}

/** 通知服务端取消指定 run（HTTP 断开之外的显式取消，便于服务端立即回收工具调用） */
export async function abortAgentRun(runId: string) {
  await fetch('/api/chat/abort', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId })
  }).catch(() => undefined);
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
