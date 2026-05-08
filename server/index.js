import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { checkDatabaseHealth } from './db.js';

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

const config = {
  apiKey: process.env.QWEN_API_KEY,
  baseUrl: (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
  model: process.env.QWEN_MODEL || 'qwen-plus',
  port: Number(process.env.SERVER_PORT || 8787)
};

function createAppError(code, message, details = '', status = 500) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.status = status;
  return error;
}

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

async function qwenFetch(endpoint, body, stream = false) {
  if (!config.apiKey) {
    throw createAppError('MISSING_API_KEY', '缺少 Qwen API Key', '请检查服务端 `.env.local` 中的 `QWEN_API_KEY` 配置。', 500);
  }

  let response;
  try {
    response = await fetch(`${config.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw createAppError(
      'NETWORK_UNREACHABLE',
      '无法连接到 Qwen 服务',
      '当前运行环境访问 DashScope 失败。请检查网络、代理、VPN 或防火墙设置。',
      502
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 401) {
      throw createAppError('INVALID_API_KEY', 'Qwen API Key 无效或已过期', text || '请检查 `QWEN_API_KEY` 是否正确。', 401);
    }

    if (response.status === 429) {
      throw createAppError('RATE_LIMITED', 'Qwen 请求过于频繁', text || '请稍后重试，或检查账户配额是否充足。', 429);
    }

    throw createAppError('QWEN_HTTP_ERROR', `Qwen 请求失败（${response.status}）`, text || '上游模型服务返回异常响应。', 502);
  }

  if (stream) {
    return response;
  }

  return response.json();
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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

function buildToolDefinitions(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || {
        type: 'object',
        properties: {}
      }
    }
  }));
}

async function executeToolCallWithMcp(client, toolCall) {
  const name = toolCall.function?.name || 'unknown';
  const args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
  const result = await client.callTool({
    name,
    arguments: args
  });

  const structured = normalizeStructuredContent(result);
  const text = contentToText(result);
  const isError = !!(result && typeof result === 'object' && 'isError' in result && result.isError);

  return {
    args,
    isError,
    resultText: text || JSON.stringify(structured, null, 2),
    resultPayload: structured,
    citations: Array.isArray(structured?.citations) ? structured.citations : []
  };
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
      checkDatabaseHealth().catch((error) => ({ enabled: !!process.env.DATABASE_URL, ok: false, reason: error.message || 'database check failed' })),
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
        hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
        databaseUrlPrefix: process.env.DATABASE_URL ? process.env.DATABASE_URL.slice(0, 24) : ''
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

app.post('/api/chat/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    const session = await createMcpSession();
    const availableTools = await session.client.listTools();
    const incomingMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const currentTime = new Date();
    const messages = [
      {
        role: 'system',
        content: [
          '你是一个中文科研助手 Agent。',
          '你可以通过 MCP 工具检索知识库、查看文档列表、导入或删除文档、获取当前时间。',
          `当前系统时间：${currentTime.toISOString()}（本地时间：${currentTime.toLocaleString('zh-CN', { hour12: false })}）`,
          '如果用户提到“现在”“当前”“最新”“今年”“当下”等时间相关表述，必须先调用 get_current_time 工具，以工具返回时间为唯一时间真值，不要沿用旧会话中的日期。',
          '禁止在没有调用 get_current_time 的情况下声称“当前是某年某月”。若时间信息不确定，先调用工具再回答。',
          '当用户要求查找、搜索、寻找文献或论文时，必须调用 search_literature 工具进行在线检索。',
          '若用户在问题里给出年份（如“2026”或“2025-2026”），请把年份转成 search_literature 的 sinceYear / untilYear 参数。',
          '禁止在未调用 search_literature 的情况下断言“某年份不存在相关文献”，应以工具返回结果为准。',
          '当用户的问题依赖知识库内容时，优先调用 retrieve_knowledge。',
          '当用户要求跨论文对比、总结已有方法和缺陷时，优先调用 query_paper_memory。',
          '当用户要求发现研究空白、创新点或研究机会时，优先调用 mine_research_gaps。',
          '当用户要求设计实验方案、实验规格或对照实验计划时，优先调用 generate_experiment_spec。',
          '当需要先构建论文结构化卡片时，调用 extract_paper_schema。',
          '当用户要求生成论文大纲时，请调用 generate_outline 工具。',
          '当用户要求撰写论文内容时，请调用 write_content 工具。',
          '当用户要求推导公式时，请调用 derive_formula 工具。',
          '请根据用户的实际意图选择合适的工具，不要在没有调用工具的情况下直接生成内容。',
          '最终回答需要清晰、结构化、简洁。'
        ].join('\n')
      },
      ...incomingMessages
    ];

    const gatheredCitations = [];
    const gatheredTools = [];
    const toolDefinitions = buildToolDefinitions(availableTools.tools || []);

    for (let round = 0; round < 4; round += 1) {
      const completion = await qwenFetch('/chat/completions', {
        model: config.model,
        stream: false,
        temperature: 0.4,
        messages,
        tools: toolDefinitions,
        tool_choice: 'auto'
      });

      const choice = completion.choices?.[0]?.message;
      const toolCalls = choice?.tool_calls || [];

      if (!toolCalls.length) {
        if (choice) {
          messages.push(choice);
        }
        break;
      }

      messages.push({
        role: 'assistant',
        content: choice.content || '',
        tool_calls: toolCalls
      });

      for (const toolCall of toolCalls) {
        const previewArgs = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
        sendSse(res, 'tool', {
          id: toolCall.id,
          name: toolCall.function?.name,
          args: previewArgs,
          status: 'running'
        });

        const executed = await executeToolCallWithMcp(session.client, toolCall);

        gatheredCitations.push(...executed.citations);
        gatheredTools.push({
          id: toolCall.id,
          name: toolCall.function?.name,
          args: executed.args,
          status: executed.isError ? 'error' : 'success',
          result: executed.resultText
        });

        sendSse(res, 'tool', {
          id: toolCall.id,
          name: toolCall.function?.name,
          args: executed.args,
          status: executed.isError ? 'error' : 'success',
          result: executed.resultPayload
        });

        if (executed.citations.length) {
          sendSse(res, 'citations', { citations: executed.citations });
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(executed.resultPayload)
        });
      }
    }

    const streamResponse = await qwenFetch('/chat/completions', {
      model: config.model,
      stream: true,
      temperature: 0.4,
      messages
    }, true);

    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const event of events) {
        const lines = event.split('\n').map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') {
            sendSse(res, 'done', { citations: gatheredCitations, tools: gatheredTools });
            res.end();
            return;
          }

          try {
            const json = JSON.parse(raw);
            const token = json.choices?.[0]?.delta?.content;
            if (token) {
              sendSse(res, 'token', { token });
            }
          } catch {
            // ignore invalid chunks
          }
        }
      }
    }

    sendSse(res, 'done', { citations: gatheredCitations, tools: gatheredTools });
    res.end();
  } catch (error) {
    const payload = getErrorPayload(error, '服务异常');
    sendSse(res, 'error', {
      code: payload.code,
      message: payload.message,
      details: payload.details
    });
    res.end();
  }
});

app.use(express.static(path.resolve(__dirname, '../dist')));
app.get('*', (_, res) => {
  res.sendFile(path.resolve(__dirname, '../dist/index.html'));
});

app.listen(config.port, '127.0.0.1', () => {
  console.log(`Server running at http://127.0.0.1:${config.port}`);
});
