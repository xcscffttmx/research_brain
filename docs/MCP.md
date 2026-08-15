# MCP 工具链说明

本文档说明 Research Agent 项目中的 MCP 架构、工具职责和调用链路。

## MCP 在项目中的作用

MCP，全称 Model Context Protocol。在本项目中，MCP 用于把后端能力组织成工具，让模型和 API 服务可以统一调用。

当前项目中：

- `server/index.js` 是 Express API 服务，同时作为 MCP Client。
- `server/mcp-server.js` 是 MCP Server，注册并实现具体工具。
- Express 通过 stdio 启动并连接 MCP Server。
- 聊天接口和普通 REST 接口都会复用 MCP 工具。

## 调用链路

```text
前端 Vue
  -> Express API server/index.js
  -> MCP Client
  -> MCP Server server/mcp-server.js
  -> 工具函数
  -> Qwen / 文献源 / 本地知识库状态
```

聊天流式接口中，模型也可以通过 tool call 触发 MCP 工具：

```text
用户消息
  -> /api/chat/stream
  -> Qwen Chat Completions
  -> 模型请求调用工具
  -> Express 调用 MCP Tool
  -> 工具结果回填给模型
  -> SSE 返回 token / tool / citations / done
```

## MCP Server 启动方式

`server/index.js` 中通过 `StdioClientTransport` 启动 MCP Server：

```text
node server/mcp-server.js
```

通信方式是 stdio，不需要额外开放端口。

## 工具返回格式

MCP 工具通常通过 `toTextContent()` 返回结构化 JSON 内容。

成功时通常包含：

```json
{
  "content": [
    {
      "type": "text",
      "text": "{...JSON 字符串...}"
    }
  ],
  "structuredContent": {
    "...": "..."
  }
}
```

失败时通常包含：

```json
{
  "structuredContent": {
    "code": "ERROR_CODE",
    "message": "错误说明",
    "details": "详细信息"
  },
  "isError": true
}
```

Express 层会对 MCP 返回做归一化处理，然后返回给前端。

## 核心工具分类

### 1. 知识库工具

| 工具名 | 说明 |
|---|---|
| `retrieve_knowledge` | 从向量知识库检索相关文档片段 |
| `list_knowledge_documents` | 列出知识库文档 |
| `get_knowledge_document_content` | 获取指定文档完整内容 |
| `ingest_knowledge_documents` | 导入文档并建立向量索引 |
| `delete_knowledge_document` | 删除指定文档和向量索引 |
| `clear_knowledge_documents` | 清空知识库 |

### 2. 基础工具

| 工具名 | 说明 |
|---|---|
| `get_current_time` | 获取当前系统时间 |

### 3. Agent 调度工具

| 工具名 | 说明 |
|---|---|
| `list_agents` | 列出可用专业 Agent |
| `select_agent` | 选择指定 Agent 处理任务 |
| `get_agent_info` | 获取指定 Agent 信息 |
| `agent协作` | 生成多 Agent 协作计划 |

当前预置 Agent：

| Agent | ID | 能力 |
|---|---|---|
| 文献检索 Agent | `literature-agent` | 文献搜索、文献分析、引用关系分析、文献摘要 |
| 论文写作 Agent | `writing-agent` | 大纲生成、内容写作、语法检查、引用格式处理 |
| 公式推导 Agent | `formula-agent` | 公式推导、公式验证、公式解释、公式应用 |

### 4. 文献检索与分析工具

| 工具名 | 说明 |
|---|---|
| `search_literature` | 从 arXiv / Semantic Scholar / OpenAlex 检索论文 |
| `analyze_literature` | 分析检索到的文献内容和引用指标 |
| `summarize_literature` | 基于检索结果生成文献摘要 |
| `ingest_literature_to_knowledge` | 将检索论文导入知识库 |
| `extract_paper_schema` | 抽取论文结构化 Paper Schema |
| `get_paper_schema` | 获取已保存的 Paper Schema |
| `query_paper_memory` | 基于 Paper Schema 做跨论文聚合分析 |
| `mine_research_gaps` | 挖掘研究空白 |
| `generate_experiment_spec` | 生成结构化实验方案 |

### 5. 论文写作工具

| 工具名 | 说明 |
|---|---|
| `generate_outline` | 生成论文大纲 |
| `write_content` | 撰写论文内容 |

代码中还注册了更多与写作、公式、文献管理相关的工具，可在 `server/mcp-server.js` 中搜索 `server.registerTool` 查看完整列表。

## 知识库工作流

### 上传文档入库

```text
POST /api/knowledge/upload
  -> ingest_knowledge_documents
  -> 文档解析
  -> 文本分块
  -> Qwen Embedding
  -> state.documents / state.chunks
  -> persistState()
```

状态持久化文件：

```text
.data/knowledge-state.json
```

### 对话中检索知识

```text
用户提问
  -> retrieve_knowledge
  -> searchKnowledge(query, topK)
  -> 返回 citations
  -> 模型结合 citations 生成回答
```

## 文献分析工作流

推荐链路：

```text
search_literature
  -> extract_paper_schema
  -> query_paper_memory
  -> mine_research_gaps
  -> generate_experiment_spec
```

说明：

1. 先检索论文，得到 `paperId`。
2. 对候选论文抽取 Paper Schema。
3. Paper Schema 会写入本地状态。
4. 基于多个 Paper Schema 分析共性、局限和研究机会。
5. 将机会点转为实验方案。

## 错误处理

MCP 工具内部会使用统一错误结构：

```json
{
  "code": "ERROR_CODE",
  "message": "错误说明",
  "details": "详细信息"
}
```

常见错误：

| 错误码 | 场景 |
|---|---|
| `MISSING_API_KEY` | 未配置 `QWEN_API_KEY` |
| `INVALID_API_KEY` | Qwen API Key 无效或过期 |
| `RATE_LIMITED` | Qwen 或上游服务限流 |
| `NETWORK_UNREACHABLE` | 无法访问上游服务 |
| `PAPER_NOT_FOUND` | 未找到指定论文，请先检索 |
| `SCHEMA_NOT_FOUND` | 未找到 Paper Schema，请先抽取 |
| `GAP_DATA_INSUFFICIENT` | 研究空白挖掘论文数量不足 |
| `SPEC_DATA_INSUFFICIENT` | 实验方案生成论文数量不足 |

## 开发新 MCP 工具的建议

新增工具建议遵循以下规范：

1. 使用英文工具名，避免空格。
2. 使用 Zod 定义 `inputSchema`。
3. 工具内部捕获错误并返回 `toErrorContent(error)`。
4. 成功时返回可 JSON 序列化的结构化对象。
5. 如果工具结果会被前端展示，应保持字段稳定。
6. 如果工具产生引用，建议返回 `citations` 字段。
7. 如果工具会改变知识库状态，记得调用 `persistState()`。

## 排查建议

如果 MCP 相关功能异常，可以按以下顺序检查：

1. 后端是否成功启动。
2. `/api/health` 中 `mcp` 是否为 `true`。
3. `.env.local` 中 `QWEN_API_KEY` 是否可用。
4. 终端日志中是否有 `[mcp-server]` 错误。
5. `.data/knowledge-state.json` 是否损坏。
6. 上游文献源或 Qwen 服务是否限流。
