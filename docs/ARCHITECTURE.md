# 项目架构说明

本文档是 Research Agent 的唯一架构文档，合并了当前代码实现架构与原始多 Agent 规划设计。

## 1. 项目定位

Research Agent 是一个面向科研场景的多 Agent 小助手，目标是帮助用户完成科研选题调研、文献综述准备、论文结构化分析、研究空白挖掘和实验方案设计。

当前已实现的核心能力包括：

- 文献检索：支持 arXiv、Semantic Scholar、OpenAlex。
- 知识库问答：支持上传文档、分块、向量化和检索增强回答。
- 论文结构化分析：抽取 Paper Schema。
- 研究空白挖掘：基于 Paper Memory 分析潜在创新点。
- 实验方案生成：将研究空白转换为 Experiment Spec。
- 流式聊天：通过 SSE 向前端返回模型 token、工具调用状态和引用信息。

规划中的扩展能力包括：

- 更完整的 Agent 选择器和多 Agent 协作界面。
- 论文写作 Agent。
- 公式推导 Agent。
- 团队协作和多用户知识库隔离。

## 2. 当前实现架构

```text
┌──────────────────────────────────────────┐
│ Vue 3 前端                                │
│ - 页面组件                                │
│ - Pinia 状态                              │
│ - fetch / SSE 请求                        │
└───────────────────┬──────────────────────┘
                    │ /api/*
                    ▼
┌──────────────────────────────────────────┐
│ Express API 服务                          │
│ server/index.js                           │
│ - REST API                                │
│ - SSE 流式聊天                            │
│ - 文件上传                                │
│ - MCP Client 编排                         │
└───────────────────┬──────────────────────┘
                    │ stdio
                    ▼
┌──────────────────────────────────────────┐
│ MCP Server                                │
│ server/mcp-server.js                      │
│ - 工具注册                                │
│ - 知识库管理                              │
│ - 文献检索                                │
│ - Paper Schema / Gap / Spec               │
└───────────────┬──────────────┬───────────┘
                │              │
                ▼              ▼
      ┌────────────────┐   ┌──────────────────────┐
      │ Qwen API        │   │ 外部文献数据源        │
      │ Chat / Embedding│   │ arXiv / S2 / OpenAlex│
      └────────────────┘   └──────────────────────┘
                │
                ▼
      ┌────────────────────────────────────────────┐
      │ 本地运行时状态                              │
      │ .data/knowledge-state.json                 │
      └────────────────────────────────────────────┘
```

## 3. 多 Agent 规划架构

原始设计中的多 Agent 架构如下：

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                                前端层                                      │
│                                                                             │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌────────────────────┐  │
│  │   主界面组件         │  │   Agent 选择器       │  │  知识库管理组件     │  │
│  └─────────────────────┘  └─────────────────────┘  └────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                后端层                                      │
│                                                                             │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌────────────────────┐  │
│  │   Express 服务器     │  │   MCP 服务器         │  │  知识库管理服务     │  │
│  └─────────────────────┘  └─────────────────────┘  └────────────────────┘  │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                            Agent 调度中心                            │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                       │                                     │
│              ┌────────────────────────┼────────────────────────┐            │
│              ▼                        ▼                        ▼            │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌────────────────────┐  │
│  │   文献检索 Agent     │  │   论文写作 Agent     │  │  公式推导 Agent     │  │
│  └─────────────────────┘  └─────────────────────┘  └────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              知识管理层                                    │
│                                                                             │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌────────────────────┐  │
│  │   向量知识库         │  │   PDF/DOCX 解析      │  │  文献管理系统       │  │
│  └─────────────────────┘  └─────────────────────┘  └────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

当前代码已经具备该规划中的部分基础能力：

- Express 服务器。
- MCP 服务器。
- 知识库管理服务。
- 文献检索 Agent 相关工具。
- Paper Schema、Research Gap、Experiment Spec 相关分析链路。

论文写作 Agent、公式推导 Agent、可视化 Agent 选择器和完整 Agent 调度中心仍属于后续扩展方向。

## 4. 目录结构

```text
.
├── docs/                     # 项目文档
│   ├── API.md                # 接口文档
│   ├── ARCHITECTURE.md       # 架构文档
│   ├── DEPLOYMENT.md         # 部署说明
│   ├── ENV.md                # 环境变量说明
│   ├── MCP.md                # MCP 工具链说明
│   ├── SETUP.md              # 本地开发环境搭建
│   └── TROUBLESHOOTING.md    # 常见问题排障
├── server/
│   ├── index.js              # Express API、SSE、MCP Client 编排
│   ├── mcp-server.js         # MCP 工具服务和科研逻辑
│   └── db.js                 # 数据库健康检查
├── src/
│   ├── components/           # Vue 组件
│   ├── composables/          # Vue 组合式逻辑
│   ├── services/             # 前端 API 服务层
│   ├── stores/               # Pinia 状态管理
│   ├── types/                # TypeScript 类型定义
│   ├── App.vue
│   └── main.ts
├── .data/                    # 本地运行时知识库状态
├── Dockerfile
├── vite.config.ts            # Vite 配置和开发代理
├── package.json
└── README.md
```

## 5. 前端架构

前端基于 Vue 3 + TypeScript + Vite。

### 5.1 主要职责

- 展示聊天、知识库、科研检索和分析结果。
- 通过 `src/services/qwen.ts` 调用后端接口。
- 使用 Pinia 管理会话和消息状态。
- 对 `/api/chat/stream` 进行 SSE 流式解析。
- 展示工具调用状态、引用信息和模型回复。

### 5.2 关键模块

| 文件或目录             | 说明                                 |
| ---------------------- | ------------------------------------ |
| `src/main.ts`          | 前端入口                             |
| `src/App.vue`          | 应用根组件                           |
| `src/components/`      | 页面和 UI 组件                       |
| `src/services/qwen.ts` | 后端 API 请求封装                    |
| `src/stores/chat.ts`   | 聊天会话状态管理                     |
| `src/types/chat.ts`    | 消息、引用、论文、实验方案等类型定义 |

### 5.3 前端扩展方向

后续可增强：

- Agent 选择器组件：展示不同专业 Agent 的能力和状态。
- 多 Agent 交互界面：展示协作过程、任务进度和工具调用链路。
- 知识库管理增强：文献分类、标签、预览、统计和搜索。
- 科研分析可视化：研究空白、实验方案、文献图谱等结果展示。

## 6. 后端架构

后端基于 Node.js + Express + MCP SDK。

### 6.1 `server/index.js`

负责对外提供 HTTP API：

- 启用 CORS 和 JSON body 解析。
- 提供 `/api/health` 健康检查。
- 提供知识库 REST 接口。
- 提供科研分析 REST 接口。
- 提供 `/api/chat/stream` SSE 流式聊天接口。
- 通过 MCP Client 连接并调用 `server/mcp-server.js`。
- 生产环境托管 `dist/` 静态资源。

### 6.2 `server/mcp-server.js`

负责实现 MCP 工具服务：

- 注册知识库工具。
- 注册文献检索工具。
- 注册论文结构化分析工具。
- 注册研究空白挖掘和实验方案生成工具。
- 维护 Agent 定义和工具能力。
- 调用 Qwen Embedding 建立向量索引。
- 持久化本地知识库状态。

### 6.3 `server/db.js`

负责数据库健康检查。当前主要用于 `/api/health` 中验证 `DATABASE_URL` 是否可用。

## 7. MCP 与 Agent 调度设计

### 7.1 当前 MCP 调用链路

```text
Express API
  -> createMcpSession()
  -> StdioClientTransport
  -> node server/mcp-server.js
  -> MCP Server registerTool(...)
  -> 执行具体工具
  -> 返回 structuredContent / content
```

### 7.2 Agent 调度中心规划

Agent 调度中心的目标：

- 接收用户请求并分析任务类型。
- 选择合适的专业 Agent 处理任务。
- 协调多个 Agent 之间的协作。
- 整合各 Agent 的输出结果。
- 将中间步骤、证据和工具调用过程返回前端。

当前项目主要通过 Qwen 工具调用和 MCP Tool 实现初步编排，未来可以进一步抽象为独立的 Agent 调度层。

### 7.3 专业 Agent 规划

#### 文献检索 Agent

当前已有较完整实现。

功能：

- 支持学术文献搜索。
- 分析文献内容和引用指标。
- 提取文献关键信息。
- 将检索结果导入个人知识库。
- 为 Paper Schema 和 Research Gap 提供基础数据。

相关工具：

- `search_literature`
- `analyze_literature`
- `summarize_literature`
- `ingest_literature_to_knowledge`
- `extract_paper_schema`
- `query_paper_memory`
- `mine_research_gaps`
- `generate_experiment_spec`

#### 论文写作 Agent

规划能力：

- 辅助论文大纲生成。
- 提供论文写作建议。
- 语法和风格检查。
- 引用格式处理。
- 基于知识库和文献证据生成草稿。

规划工具：

- 大纲生成工具。
- 写作建议工具。
- 语法检查工具。
- 引用格式工具。

#### 公式推导 Agent

规划能力：

- 支持数学公式推导。
- 验证公式正确性。
- 提供公式解释和应用。
- 与论文写作流程集成。

规划工具：

- 公式推导工具。
- 公式验证工具。
- 公式解释工具。
- 公式应用工具。

## 8. 核心数据流

### 8.1 普通 REST 请求

```text
Vue 前端
  -> fetch('/api/research/search-literature')
  -> Express 路由
  -> callMcpTool('search_literature')
  -> MCP Server 执行工具
  -> 返回 JSON
```

适用接口：

- `/api/knowledge`
- `/api/research/search-literature`
- `/api/research/ingest-literature`
- `/api/research/paper-schema/extract`
- `/api/research/gaps/mine`
- `/api/research/spec/generate`

### 8.2 聊天 SSE 请求

```text
Vue 前端
  -> fetch('/api/chat/stream')
  -> Express 建立 text/event-stream 响应
  -> Qwen Chat Completions 流式输出
  -> 如需工具，调用 MCP Tool
  -> 通过 event: token / tool / citations / done 返回前端
```

前端不能将该接口当作普通 JSON 处理，需要读取 `response.body.getReader()`。

### 8.3 文件上传和知识库入库

```text
Vue 前端
  -> FormData(files)
  -> POST /api/knowledge/upload
  -> Express + multer 读取文件
  -> MCP Tool: ingest_knowledge_documents
  -> PDF / DOCX / 文本解析
  -> 文本分块
  -> Qwen Embedding
  -> 写入 .data/knowledge-state.json
```

### 8.4 RAG 检索增强

```text
用户问题
  -> retrieve_knowledge
  -> 从 state.chunks 中计算相似度
  -> 返回 citations
  -> Qwen 结合引用生成回答
```

### 8.5 文献分析链路

```text
search_literature
  -> 缓存论文元数据
  -> extract_paper_schema
  -> 写入 Paper Memory
  -> mine_research_gaps
  -> generate_experiment_spec
```

## 9. 状态和存储

当前项目以本地文件作为主要运行时状态：

```text
.data/knowledge-state.json
```

主要包含：

- `documents`：知识库文档列表。
- `chunks`：文档分块和向量。
- `literature`：检索论文、标签、分类和 Paper Schema。

如果配置了 `DATABASE_URL`，当前主要用于健康检查。后续可扩展为 PostgreSQL + pgvector 持久化方案。

### 9.1 知识管理规划

个人文献知识库的长期目标：

- 支持 PDF / DOCX / TXT / Markdown 文档上传和解析。
- 建立文献向量索引。
- 提供文献检索和管理。
- 支持文献分类和标签。
- 支持文献版本控制。
- 与多个专业 Agent 集成。

## 10. 外部依赖

| 依赖               | 用途                               |
| ------------------ | ---------------------------------- |
| Qwen Chat API      | 对话、工具调用编排                 |
| Qwen Embedding API | 文档向量化                         |
| arXiv              | 学术文献检索                       |
| Semantic Scholar   | 学术文献检索和引用信息             |
| OpenAlex           | 学术文献检索                       |
| PostgreSQL / Neon  | 可选数据库健康检查和后续持久化扩展 |
| S3 兼容对象存储    | 预留对象存储配置                   |
| pdf-parse          | PDF 文档解析                       |
| mammoth            | DOCX 文档解析                      |
| Zod                | MCP 工具入参校验                   |

## 11. 开发环境与生产环境差异

### 11.1 开发环境

- 前端由 Vite 提供服务，默认 `http://localhost:5173`。
- 后端由 Express 提供服务，默认 `http://127.0.0.1:8788`。
- Vite 将 `/api/*` 代理到后端。

### 11.2 生产环境

- 先执行 `npm run build` 生成 `dist/`。
- Express 托管 `dist/`。
- 页面和 API 同源访问。

## 12. 技术挑战与风险

### 12.1 多 Agent 协作

风险：

- Agent 通信机制复杂。
- 多 Agent 之间可能出现任务边界不清。
- 工具调用链路过长时，调试难度增加。

应对：

- 使用 MCP Tool 作为能力边界。
- 为每个 Agent 定义清晰输入、输出和职责。
- 在前端展示工具调用过程和中间证据。

### 12.2 知识管理

风险：

- 大量文献分块和向量检索可能带来性能瓶颈。
- PDF / DOCX 解析结果可能不稳定。
- 本地 JSON 文件不适合多人、多租户和大规模知识库。

应对：

- 后续迁移到 PostgreSQL + pgvector。
- 对上传文件做大小、类型和解析结果校验。
- 增加文档重建索引和备份机制。

### 12.3 第三方依赖

风险：

- Qwen、Semantic Scholar、OpenAlex、arXiv 可能限流或不可用。
- 网络环境可能导致上游访问失败。

应对：

- 设置超时、重试和降级策略。
- 文献检索多源聚合，单源失败时尽量返回可用结果。
- 增加缓存，减少重复请求。

### 12.4 用户体验

风险：

- 多 Agent 和工具调用过程对用户来说可能过于复杂。
- SSE 流式响应和工具状态需要清晰展示。

应对：

- 提供清晰的任务进度反馈。
- 将工具调用结果以卡片或折叠面板展示。
- 对错误信息进行用户友好化处理。

## 13. 扩展方向

后续可以优先扩展：

- 将 `.data/knowledge-state.json` 替换为 PostgreSQL + pgvector。
- 增加用户体系和多用户知识库隔离。
- 增加接口鉴权、限流和审计日志。
- 增加 OpenAPI 文档和接口测试集合。
- 将 MCP 工具拆分为更细粒度的模块。
- 实现完整 Agent 调度中心。
- 实现论文写作 Agent 和公式推导 Agent。
- 支持团队协作能力。
- 增加数据分析和可视化能力。

## 14. 实施计划

### 第一阶段：基础能力和架构落地

- 完成 Vue 前端和 Express 后端联调。
- 完成 MCP Server 工具注册和调用链路。
- 完成知识库上传、分块、向量化和检索。
- 完成文献检索和基础科研分析链路。

### 第二阶段：专业 Agent 增强

- 强化文献检索 Agent。
- 实现论文写作 Agent。
- 实现公式推导 Agent。
- 抽象 Agent 注册和调度机制。

### 第三阶段：前端交互增强

- 开发 Agent 选择器组件。
- 增强知识库管理界面。
- 展示多 Agent 协作过程。
- 提供任务进度跟踪和工具调用可视化。

### 第四阶段：稳定性和性能优化

- 优化向量检索性能。
- 增加缓存、限流和超时机制。
- 增强错误处理和日志。
- 补充自动化测试和接口测试。

### 第五阶段：部署和产品化

- 完善 Docker 部署。
- 增加鉴权和安全控制。
- 支持云部署和数据持久化。
- 完善用户文档和反馈机制。

## 15. 结论

Research Agent 当前已经具备科研助手的核心闭环：文献检索、知识库增强、Paper Schema、研究空白挖掘、实验方案生成和流式对话。

后续架构演进重点应放在三方面：

1. 将本地文件状态升级为可扩展持久化存储。
2. 将当前 MCP 工具能力进一步抽象为清晰的多 Agent 调度体系。
3. 增强前端对 Agent 协作、工具调用和科研分析结果的可视化表达。
