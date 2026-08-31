import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { checkDatabaseHealth } from './db/client.js';
import { createAppError } from './lib/errors.js';
import { qwenFetch } from './lib/apiClients/qwen.js';
import { createSseWriter } from './lib/sseWriter.js';
import { runAgentTurn, abortRun, getActiveRunCount } from './agent/runtime.js';
import { generateAnswer, collectCitations } from './services/answerGenerator.js';
import * as sessionRepo from './repositories/sessionRepo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootEnvPath = path.resolve(__dirname, '../.env.local');
dotenv.config({ path: rootEnvPath, override: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });
dotenv.config({ override: false });
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '4mb' }));

const serverPort = Number(process.env.SERVER_PORT || 8787);

function getErrorPayload(error, fallbackMessage) {
  if (error && typeof error === 'object' && 'message' in error) {
    return {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message || fallbackMessage,
      details: error.details || '',
      status: error.status || 500
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: fallbackMessage,
    details: '',
    status: 500
  };
}

let mcpSessionPromise = null;

async function createMcpSession() {
  if (mcpSessionPromise) {
    return mcpSessionPromise;
  }

  mcpSessionPromise = (async () => {
    const client = new McpClient({
      name: 'research-agent-chat-orchestrator',
      version: '1.0.0'
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(__dirname, './mcp-server.js')],
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'development'
      },
      stderr: 'pipe'
    });

    if (transport.stderr) {
      transport.stderr.on('data', (chunk) => {
        const message = chunk.toString().trim();
        if (message) {
          console.error(`[mcp-server] ${message}`);
        }
      });
    }

    await client.connect(transport);

    const session = {
      client,
      transport,
      async close() {
        mcpSessionPromise = null;
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      }
    };

    return session;
  })().catch((error) => {
    mcpSessionPromise = null;
    throw error;
  });

  return mcpSessionPromise;
}

function normalizeStructuredContent(result) {
  if (result && typeof result === 'object' && 'structuredContent' in result && result.structuredContent) {
    return result.structuredContent;
  }
  if (result && typeof result === 'object' && 'toolResult' in result) {
    return result.toolResult;
  }
  return {};
}

function contentToText(result) {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) {
    return '';
  }

  return result.content
    .filter((item) => item && typeof item === 'object' && item.type === 'text')
    .map((item) => item.text || '')
    .join('\n')
    .trim();
}

async function callMcpTool(name, args = {}) {
  const session = await createMcpSession();
  const result = await session.client.callTool({ name, arguments: args });
  const structured = normalizeStructuredContent(result);
  const isError = !!(result && typeof result === 'object' && 'isError' in result && result.isError);
  if (isError) {
    throw createAppError(
      structured.code || 'MCP_TOOL_ERROR',
      structured.message || `${name} 执行失败`,
      structured.details || '',
      400
    );
  }
  return structured;
}

app.get('/api/health', async (_, res) => {
  try {
    const [dbHealth, mcpResult] = await Promise.all([
      Promise.resolve()
        .then(() => checkDatabaseHealth())
        .catch((error) => ({ enabled: true, ok: false, engine: 'sqlite', reason: error.message || 'database check failed' })),
      (async () => {
        const session = await createMcpSession();
        const result = await session.client.callTool({
          name: 'list_knowledge_documents',
          arguments: {}
        });
        return normalizeStructuredContent(result);
      })()
    ]);

    res.json({
      ok: true,
      documents: Array.isArray(mcpResult.documents) ? mcpResult.documents.length : 0,
      mcp: true,
      database: dbHealth,
      envDebug: {
        cwd: process.cwd(),
        sqlitePath: process.env.SQLITE_PATH || '.data/research-agent.db'
      }
    });
  } catch (error) {
    const payload = getErrorPayload(error, 'MCP 健康检查失败');
    res.status(payload.status).json({
      ok: false,
      code: payload.code,
      error: payload.message,
      details: payload.details
    });
  }
});

app.get('/api/knowledge', async (_, res) => {
  try {
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: 'list_knowledge_documents',
      arguments: {}
    });

    const structured = normalizeStructuredContent(result);
    res.json({
      documents: structured.documents || []
    });
  } catch (error) {
    const payload = getErrorPayload(error, '加载知识库失败');
    res.status(payload.status).json({
      error: payload.message,
      code: payload.code,
      details: payload.details
    });
  }
});

app.get('/api/knowledge/content/:id', async (req, res) => {
  try {
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: 'get_knowledge_document_content',
      arguments: { id: req.params.id }
    });

    const structured = normalizeStructuredContent(result);
    if (result.isError) {
      throw createAppError(structured.code || 'MCP_TOOL_ERROR', structured.message || '获取文档内容失败', structured.details || '', 400);
    }

    res.json(structured);
  } catch (error) {
    const payload = getErrorPayload(error, '获取文档内容失败');
    res.status(payload.status).json({
      error: payload.message,
      code: payload.code,
      details: payload.details
    });
  }
});

app.post('/api/knowledge/upload', upload.array('files'), async (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: 'ingest_knowledge_documents',
      arguments: {
        documents: files.map((file) => {
          const name = file.originalname.toLowerCase();
          if (name.endsWith('.pdf') || name.endsWith('.docx')) {
            // 对于二进制文件，使用Base64编码
            return {
              name: file.originalname,
              content: file.buffer.toString('base64'),
              isBinary: true
            };
          } else {
            // 对于文本文件，使用UTF-8编码
            return {
              name: file.originalname,
              content: file.buffer.toString('utf-8'),
              isBinary: false
            };
          }
        })
      }
    });

    const structured = normalizeStructuredContent(result);
    if (result.isError) {
      throw createAppError(structured.code || 'MCP_TOOL_ERROR', structured.message || '知识库导入失败', structured.details || '', 400);
    }

    res.json({
      documents: structured.documents || [],
      message: structured.message || '上传成功'
    });
  } catch (error) {
    const payload = getErrorPayload(error, '知识库导入失败');
    res.status(payload.status).json({
      error: payload.message,
      code: payload.code,
      details: payload.details
    });
  }
});

app.delete('/api/knowledge/:id', async (req, res) => {
  try {
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: 'delete_knowledge_document',
      arguments: { id: req.params.id }
    });

    const structured = normalizeStructuredContent(result);
    if (result.isError) {
      throw createAppError(structured.code || 'MCP_TOOL_ERROR', structured.message || '删除失败', structured.details || '', 400);
    }

    res.json({ ok: true });
  } catch (error) {
    const payload = getErrorPayload(error, '删除失败');
    res.status(payload.status).json({
      error: payload.message,
      code: payload.code,
      details: payload.details
    });
  }
});

app.delete('/api/knowledge', async (_, res) => {
  try {
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: 'clear_knowledge_documents',
      arguments: {}
    });

    const structured = normalizeStructuredContent(result);
    if (result.isError) {
      throw createAppError(structured.code || 'MCP_TOOL_ERROR', structured.message || '清空失败', structured.details || '', 400);
    }

    res.json({ ok: true });
  } catch (error) {
    const payload = getErrorPayload(error, '清空失败');
    res.status(payload.status).json({
      error: payload.message,
      code: payload.code,
      details: payload.details
    });
  }
});

app.post('/api/research/search-literature', async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim();
    if (!query) {
      throw createAppError('INVALID_QUERY', 'query 不能为空', '', 400);
    }
    const source = req.body?.source || 'all';
    const limit = Number(req.body?.limit || 6);
    const sinceYearRaw = req.body?.sinceYear;
    const untilYearRaw = req.body?.untilYear;
    const parsedSinceYear = Number(sinceYearRaw);
    const parsedUntilYear = Number(untilYearRaw);
    const sinceYear = Number.isFinite(parsedSinceYear) ? parsedSinceYear : undefined;
    const untilYear = Number.isFinite(parsedUntilYear) ? parsedUntilYear : undefined;

    const structured = await callMcpTool('search_literature', { query, source, limit, sinceYear, untilYear });
    res.json({
      query: structured.query || query,
      sinceYear: structured.sinceYear ?? sinceYear,
      untilYear: structured.untilYear ?? untilYear,
      currentYear: structured.currentYear,
      results: structured.results || [],
      count: structured.count || 0,
      warnings: Array.isArray(structured.warnings) ? structured.warnings : []
    });
  } catch (error) {
    const payload = getErrorPayload(error, '文献检索失败');
    res.status(payload.status).json({ error: payload.message, code: payload.code, details: payload.details });
  }
});

app.post('/api/research/ingest-literature', async (req, res) => {
  try {
    const paperIds = Array.isArray(req.body?.paperIds) ? req.body.paperIds : [];
    const structured = await callMcpTool('ingest_literature_to_knowledge', { paperIds });
    res.json({
      documents: structured.documents || [],
      message: structured.message || '文献入库成功'
    });
  } catch (error) {
    const payload = getErrorPayload(error, '文献入库失败');
    res.status(payload.status).json({ error: payload.message, code: payload.code, details: payload.details });
  }
});

app.post('/api/research/paper-schema/extract', async (req, res) => {
  try {
    const paperId = String(req.body?.paperId || '').trim();
    if (!paperId) {
      throw createAppError('INVALID_PAPER_ID', 'paperId 不能为空', '', 400);
    }
    const structured = await callMcpTool('extract_paper_schema', { paperId });
    res.json({
      paperId: structured.paperId || paperId,
      schema: structured.schema
    });
  } catch (error) {
    const payload = getErrorPayload(error, '抽取 Paper Schema 失败');
    res.status(payload.status).json({ error: payload.message, code: payload.code, details: payload.details });
  }
});

app.post('/api/research/gaps/mine', async (req, res) => {
  try {
    const focus = String(req.body?.focus || '');
    const structured = await callMcpTool('mine_research_gaps', { focus });
    res.json({
      focus: structured.focus || focus,
      opportunities: structured.opportunities || [],
      count: structured.count || 0
    });
  } catch (error) {
    const payload = getErrorPayload(error, '研究空白挖掘失败');
    res.status(payload.status).json({ error: payload.message, code: payload.code, details: payload.details });
  }
});

app.post('/api/research/spec/generate', async (req, res) => {
  try {
    const focus = String(req.body?.focus || '');
    const gapIndex = Number(req.body?.gapIndex || 0);
    const structured = await callMcpTool('generate_experiment_spec', { focus, gapIndex });
    res.json({
      selectedGap: structured.selectedGap,
      experimentSpec: structured.experimentSpec
    });
  } catch (error) {
    const payload = getErrorPayload(error, '生成 Experiment Spec 失败');
    res.status(payload.status).json({ error: payload.message, code: payload.code, details: payload.details });
  }
});

/**
 * 过渡版上下文摘要：把除当前问题外的历史消息压成一段文本。
 * S5 的分层 Context 管理接入后由 contextManager 替换。
 */
const CONTEXT_HINT_MAX_MESSAGES = 8;
const CONTEXT_HINT_MAX_CHARS = 2_000;

function buildContextHint(messages) {
  const history = messages.slice(0, -1).slice(-CONTEXT_HINT_MAX_MESSAGES);
  const text = history
    .map((item) => `${item.role}: ${String(item.content || '').replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
  return text.slice(-CONTEXT_HINT_MAX_CHARS);
}

/** Agent Runtime 的工具调用适配器：把 CancelNode 的 signal 透传给 MCP */
async function callAgentTool(toolName, args, signal) {
  const session = await createMcpSession();
  const result = await session.client.callTool({ name: toolName, arguments: args }, undefined, { signal });

  const structured = normalizeStructuredContent(result);
  const isError = !!(result && typeof result === 'object' && 'isError' in result && result.isError);

  if (isError) {
    throw createAppError(
      structured.code || 'MCP_TOOL_ERROR',
      structured.message || `${toolName} 执行失败`,
      structured.details || '',
      400
    );
  }

  // 部分工具只返回文本内容，兜底带上便于生成阶段使用
  if (!Object.keys(structured).length) {
    return { text: contentToText(result) };
  }

  return structured;
}

app.post('/api/chat/stream', async (req, res) => {
  const emit = createSseWriter(res);

  // HTTP 连接断开 -> 取消树根节点 abort -> 级联终止所有在途工具调用
  const disconnect = new AbortController();
  res.on('close', () => disconnect.abort());

  try {
    const incomingMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const question = String([...incomingMessages].reverse().find((item) => item.role === 'user')?.content || '').trim();

    if (!question) {
      throw createAppError('INVALID_QUESTION', '缺少用户问题', 'messages 中没有 role=user 的消息。', 400);
    }

    const sessionId = String(req.body?.sessionId || '').trim();
    // 会话行必须先存在，否则 agent_runs 的外键写入会失败；没传 sessionId 时降级为不落库
    let persist = false;
    if (sessionId) {
      try {
        sessionRepo.ensureSession(sessionId, question.slice(0, 30));
        persist = true;
      } catch (error) {
        console.error('[chat] 会话落库失败，本轮不持久化:', error.message);
      }
    }

    const result = await runAgentTurn({
      sessionId,
      question,
      contextHint: buildContextHint(incomingMessages),
      emit,
      externalSignal: disconnect.signal,
      persist,
      deps: {
        qwenFetch,
        callTool: callAgentTool,
        generateAnswer
      }
    });

    // citations 随 done 一起下发；工具调用已在 tool_call / tool_result 事件中流式给过，不重复下发
    const citations = collectCitations(result.toolResults || []);

    emit.done({
      runId: result.runId,
      status: result.status,
      reason: result.status === 'cancelled' ? 'aborted' : 'complete',
      citations
    });
  } catch (error) {
    const payload = getErrorPayload(error, '服务异常');
    emit.error({
      code: payload.code,
      message: payload.message,
      details: payload.details
    });
    emit.done({ reason: 'error' });
  }
});

/** 停止生成：按 runId 精确取消一次运行 */
app.post('/api/chat/abort', (req, res) => {
  const runId = String(req.body?.runId || '').trim();
  if (!runId) {
    res.status(400).json({ error: 'runId 不能为空', code: 'INVALID_RUN_ID' });
    return;
  }

  const aborted = abortRun(runId);
  res.json({ ok: aborted, aborted, activeRuns: getActiveRunCount() });
});

app.use(express.static(path.resolve(__dirname, '../dist')));
app.get('*', (_, res) => {
  res.sendFile(path.resolve(__dirname, '../dist/index.html'));
});

app.listen(serverPort, '127.0.0.1', () => {
  console.log(`Server running at http://127.0.0.1:${serverPort}`);
});
