import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { checkDatabaseHealth } from './db/client.js';
import { createAppError } from './lib/errors.js';
import { qwenFetch } from './lib/apiClients/qwen.js';
import { createSseWriter } from './lib/sseWriter.js';
import { runAgentTurn, abortRun, getActiveRunCount } from './agent/runtime.js';
import { generateAnswerWithGroundedness, collectCitations } from './services/answerGenerator.js';
import { runAgenticRag } from './services/agenticRag.js';
import type { RagCitation } from './services/agenticRag.js';
import { buildContext, countTokens } from './services/contextManager.js';
import * as sessionRepo from './repositories/sessionRepo.js';
import * as messageRepo from './repositories/messageRepo.js';
import * as agentRunRepo from './repositories/agentRunRepo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootEnvPath = path.resolve(__dirname, '../.env.local');
dotenv.config({ path: rootEnvPath, override: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });
dotenv.config({ override: false });
const app = express();
const uploadMaxFileSizeMb = Number(process.env.UPLOAD_MAX_FILE_SIZE_MB || 20);
const uploadMaxFiles = Number(process.env.UPLOAD_MAX_FILES || 8);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: uploadMaxFileSizeMb * 1024 * 1024,
    files: uploadMaxFiles
  }
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, allowedOrigins.includes(origin));
    }
  })
);
app.use(express.json({ limit: '4mb' }));

const serverPort = Number(process.env.SERVER_PORT || 8787);
const serverHost = process.env.SERVER_HOST || '127.0.0.1';

interface ErrorPayload {
  code: string;
  message: string;
  details: string;
  status: number;
}

interface McpSession {
  client: McpClient;
  transport: StdioClientTransport;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function stringField(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

function numberField(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === 'number' ? value : fallback;
}

function normalizeToolArgs(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {};
}

function isRagCitation(value: unknown): value is RagCitation {
  if (!isRecord(value)) return false;
  return (
    typeof value.index === 'number' &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.snippet === 'string' &&
    typeof value.source === 'string' &&
    Array.isArray(value.span) &&
    value.span.length === 2 &&
    value.span.every((item) => typeof item === 'number') &&
    typeof value.score === 'number' &&
    typeof value.vectorScore === 'number'
  );
}

function normalizeRagCitations(citations: unknown): RagCitation[] {
  return Array.isArray(citations) ? citations.filter(isRagCitation) : [];
}

function getErrorPayload(error: unknown, fallbackMessage: string): ErrorPayload {
  if (isRecord(error)) {
    return {
      code: stringField(error, 'code', 'UNKNOWN_ERROR'),
      message: stringField(error, 'message', fallbackMessage),
      details: stringField(error, 'details'),
      status: numberField(error, 'status', 500)
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: fallbackMessage,
    details: '',
    status: 500
  };
}

let mcpSessionPromise: Promise<McpSession> | null = null;

async function createMcpSession(): Promise<McpSession> {
  if (mcpSessionPromise) {
    return mcpSessionPromise;
  }

  mcpSessionPromise = (async () => {
    const client = new McpClient({
      name: 'research-agent-chat-orchestrator',
      version: '1.0.0'
    });

    // 父进程若由 tsx 启动，子进程必须继承同样的 loader，否则解析不到 .ts 模块
    const loaderArgs = process.execArgv.filter((arg, index, args) => {
      if (arg === '--require' || arg === '--import') return args[index + 1]?.includes('tsx');
      return arg.includes('tsx');
    });

    const mcpSourceEntry = path.resolve(__dirname, './mcp-server.ts');
    const mcpCompiledEntry = path.resolve(__dirname, './mcp-server.js');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...loaderArgs, existsSync(mcpSourceEntry) ? mcpSourceEntry : mcpCompiledEntry],
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

function normalizeStructuredContent(result: unknown): Record<string, unknown> {
  if (isRecord(result) && isRecord(result.structuredContent)) {
    return result.structuredContent;
  }
  if (isRecord(result) && isRecord(result.toolResult)) {
    return result.toolResult;
  }
  return {};
}

function contentToText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return '';
  }

  return result.content
    .filter((item): item is { type: 'text'; text?: string } => isRecord(item) && item.type === 'text')
    .map((item) => item.text || '')
    .join('\n')
    .trim();
}

async function callMcpTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const session = await createMcpSession();
  const result = await session.client.callTool({ name, arguments: args });
  const structured = normalizeStructuredContent(result);
  const isError = !!(isRecord(result) && result.isError);
  if (isError) {
    throw createAppError(
      stringField(structured, 'code', 'MCP_TOOL_ERROR'),
      stringField(structured, 'message', `${name} 执行失败`),
      stringField(structured, 'details'),
      400
    );
  }
  return structured;
}

app.get('/api/health', async (_: Request, res: Response) => {
  try {
    const [dbHealth, mcpResult] = await Promise.all([
      Promise.resolve()
        .then(() => checkDatabaseHealth())
        .catch((error: unknown) => ({
          enabled: true,
          ok: false,
          engine: 'sqlite',
          reason: isRecord(error) ? stringField(error, 'message', 'database check failed') : 'database check failed'
        })),
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

app.get('/api/knowledge', async (_: Request, res: Response) => {
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
    if (isRecord(result) && result.isError) {
      throw createAppError(
        stringField(structured, 'code', 'MCP_TOOL_ERROR'),
        stringField(structured, 'message', '获取文档内容失败'),
        stringField(structured, 'details'),
        400
      );
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
    const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
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
    if (isRecord(result) && result.isError) {
      throw createAppError(
        stringField(structured, 'code', 'MCP_TOOL_ERROR'),
        stringField(structured, 'message', '知识库导入失败'),
        stringField(structured, 'details'),
        400
      );
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
    if (isRecord(result) && result.isError) {
      throw createAppError(
        stringField(structured, 'code', 'MCP_TOOL_ERROR'),
        stringField(structured, 'message', '删除失败'),
        stringField(structured, 'details'),
        400
      );
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

app.delete('/api/knowledge', async (_: Request, res: Response) => {
  try {
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: 'clear_knowledge_documents',
      arguments: {}
    });

    const structured = normalizeStructuredContent(result);
    if (isRecord(result) && result.isError) {
      throw createAppError(
        stringField(structured, 'code', 'MCP_TOOL_ERROR'),
        stringField(structured, 'message', '清空失败'),
        stringField(structured, 'details'),
        400
      );
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

/** Agent Runtime 的工具调用适配器：把 CancelNode 的 signal 透传给 MCP */
async function callAgentTool(toolName: string, args: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  const session = await createMcpSession();
  const result = await session.client.callTool({ name: toolName, arguments: normalizeToolArgs(args) }, undefined, {
    signal
  });

  const structured = normalizeStructuredContent(result);
  const isError = !!(isRecord(result) && result.isError);

  if (isError) {
    throw createAppError(
      stringField(structured, 'code', 'MCP_TOOL_ERROR'),
      stringField(structured, 'message', `${toolName} 执行失败`),
      stringField(structured, 'details'),
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
    const question = String(
      [...incomingMessages].reverse().find((item) => isRecord(item) && item.role === 'user')?.content || ''
    ).trim();

    if (!question) {
      throw createAppError('INVALID_QUESTION', '缺少用户问题', 'messages 中没有 role=user 的消息。', 400);
    }

    const sessionId = String(req.body?.sessionId || '').trim();
    // 会话行必须先存在，否则 agent_runs / messages 的外键写入会失败；没传 sessionId 时降级为不落库
    let persist = false;
    if (sessionId) {
      try {
        sessionRepo.ensureSession(sessionId, question.slice(0, 30));
        persist = true;
      } catch (error) {
        const payload = getErrorPayload(error, '会话落库失败');
        console.error('[chat] 会话落库失败，本轮不持久化:', payload.message);
      }
    }

    // 分层 Context：先按历史组装上下文，再落当前轮的用户消息，避免问题在上下文里出现两次
    const context = await buildContext({
      sessionId: persist ? sessionId : '',
      question,
      persist,
      signal: disconnect.signal,
      deps: { qwenFetch }
    });

    emit.status('context', {
      shortTermCount: context.layers.shortTerm.count,
      shortTermTokens: context.layers.shortTerm.tokens,
      longTermTokens: context.layers.longTerm.tokens,
      compressed: context.layers.longTerm.compressed,
      usedTokens: context.usage.total,
      availableTokens: context.budget.available
    });

    let assistantMessageId = null;
    if (persist) {
      messageRepo.appendMessage({ sessionId, role: 'user', content: question, tokenCount: countTokens(question) });
      const draft = messageRepo.appendMessage({ sessionId, role: 'assistant', content: '', status: 'streaming' });
      assistantMessageId = draft?.id || null;
    }

    const result = await runAgentTurn({
      sessionId,
      question,
      assistantMessageId,
      contextHint: context.contextHint,
      emit,
      externalSignal: disconnect.signal,
      persist,
      deps: {
        qwenFetch,
        callTool: callAgentTool,
        runRag: runAgenticRag,
        // 生成阶段负责注入证据、核查 groundedness，必要时补充检索
        generateAnswer: (ctx, signal, onDelta, meta) =>
          generateAnswerWithGroundedness({
            ctx: {
              ...ctx,
              citations: normalizeRagCitations(ctx.citations)
            },
            signal,
            onDelta,
            ...meta
          })
      }
    });

    if (persist && assistantMessageId) {
      messageRepo.updateMessage(assistantMessageId, {
        content: result.answer || '',
        tokenCount: countTokens(result.answer || ''),
        status: result.status === 'succeeded' ? 'done' : result.status
      });
      if (result.runId) agentRunRepo.attachRunMessage(result.runId, assistantMessageId);
    }

    // citations 随 done 一起下发；工具调用已在 tool_call / tool_result 事件中流式给过，不重复下发
    const citations = result.citations?.length ? result.citations : collectCitations(result.toolResults || []);

    emit.done({
      runId: result.runId,
      status: result.status,
      reason: result.status === 'cancelled' ? 'aborted' : 'complete',
      citations,
      verification: result.verification || undefined
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

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `单个文件不能超过 ${uploadMaxFileSizeMb}MB`
        : error.code === 'LIMIT_FILE_COUNT'
          ? `一次最多上传 ${uploadMaxFiles} 个文件`
          : '上传请求不符合限制';
    res.status(413).json({
      error: message,
      code: error.code,
      details: error.message
    });
    return;
  }

  next(error);
});

app.use(express.static(path.resolve(__dirname, '../dist')));
app.get('*', (_: Request, res: Response) => {
  res.sendFile(path.resolve(__dirname, '../dist/index.html'));
});

app.listen(serverPort, serverHost, () => {
  console.log(`Server running at http://${serverHost}:${serverPort}`);
});
