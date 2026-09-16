# 项目架构说明

本文档是 Research Agent 的唯一架构文档，合并了当前代码实现架构与原始多 Agent 规划设计。

## 1. 项目定位

Research Agent 是一个面向科研场景的多 Agent 小助手，目标是帮助用户完成科研选题调研、文献综述准备、论文结构化分析、研究空白挖掘和实验方案设计。

当前已实现的核心能力包括：

- 文献检索：支持 arXiv、Semantic Scholar、OpenAlex，多源聚合并带 TTL 缓存。
- 知识库问答：支持上传文档、分块、向量化和检索增强回答。
- Agentic RAG：检索规划、HyDE 改写、向量召回、精排、证据溯源与 groundedness 校验。
- Agent Runtime：结构化计划、逐步执行、取消树级联终止、超时重试、命中条件提前结束。
- 分层 Context：Working / Short-Term / Long-Term 三层与 Token 预算控制。
- 论文结构化分析：抽取 Paper Schema。
- 研究空白挖掘：基于 Paper Memory 分析潜在创新点。
- 实验方案生成：将研究空白转换为 Experiment Spec。
- 流式聊天：SSE 下发 token、计划、工具调用状态、引用与校验结果，前端做打字机与 rAF 缓冲。

规划中的扩展能力包括：

- 更完整的 Agent 选择器和多 Agent 协作界面。
- 论文写作 Agent（当前相关 MCP 工具多为模拟实现）。
- 公式推导 Agent（同上）。
- 接口鉴权、团队协作和多用户知识库隔离。

## 2. 当前实现架构

```text
┌──────────────────────────────────────────┐
│ Vue 3 前端                                │
│ - 页面组件 / Pinia 状态                   │
│ - LLM Stream Adapter（SSE 解码 + Gate）   │
│ - 打字机 + rAF 渲染缓冲                   │
└───────────────────┬──────────────────────┘
                    │ /api/*
                    ▼
┌──────────────────────────────────────────┐
│ Express API 服务  server/index.ts         │
│ - REST API / SSE 流式聊天 / 文件上传      │
│ - CORS 白名单、上传限额                   │
│ - MCP Client 编排                         │
└───────────────────┬──────────────────────┘
                    ▼
┌──────────────────────────────────────────┐
│ Agent Runtime  server/agent/              │
│ - Planner（结构化计划 + 终止条件）        │
│ - Executor（逐步执行、提前结束）          │
│ - CancelNode 取消树 / Timeout+Retry 策略  │
└───────────────────┬──────────────────────┘
                    ▼
┌──────────────────────────────────────────┐
│ 业务服务  server/services/                │
│ - Agentic RAG（检索规划/HyDE/精排/核查）  │
│ - 答案生成 + groundedness 校验            │
│ - 分层 Context 与 Token Budget            │
└───────────────────┬──────────────────────┘
                    ▼
┌──────────────────────────────────────────┐
│ 持久化  server/repositories/ + server/db/ │
│ SQLite + sqlite-vec（vec0 虚拟表）        │
│ .data/research-agent.db                   │
└──────────────────────────────────────────┘

              ┌──────────────────────────────┐
              │ MCP Server                    │
  stdio 子进程 │ server/mcp-server.ts          │
  ◄───────────│ - 工具注册（知识库/文献/分析）│
              └──────┬──────────────┬─────────┘
                     ▼              ▼
           ┌────────────────┐  ┌──────────────────────┐
           │ Qwen API        │  │ 外部文献数据源        │
           │ Chat/Embed/Rerank│ │ arXiv / S2 / OpenAlex│
           └────────────────┘  └──────────────────────┘
```

> 说明：`.data/knowledge-state.json` 现在只保留文献检索缓存与 Paper Schema 等易变状态，
> 文档、分块和向量已全部迁到 SQLite。

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
│   ├── INTERVIEW.md          # 面试讲解材料
│   ├── MCP.md                # MCP 工具链说明
│   ├── SETUP.md              # 本地开发环境搭建
│   └── TROUBLESHOOTING.md    # 常见问题排障
├── e2e/                      # Playwright 端到端用例
├── server/
│   ├── index.ts              # Express API、SSE、MCP Client 编排
│   ├── mcp-server.ts         # MCP 工具服务和科研逻辑
│   ├── agent/                # Agent Runtime
│   │   ├── cancelTree.ts     # 取消树
│   │   ├── policy.ts         # 超时与重试策略
│   │   ├── planner.ts        # 计划生成 + 终止条件
│   │   ├── executor.ts       # 逐步执行
│   │   └── runtime.ts        # 一轮对话的生命周期编排
│   ├── services/
│   │   ├── agenticRag.ts     # 检索规划、HyDE、精排、证据、核查
│   │   ├── answerGenerator.ts# 答案生成与 groundedness 校验
│   │   └── contextManager.ts # 分层 Context 与 Token Budget
│   ├── repositories/         # session/message/chunk/paper/evidence/agentRun/queryCache
│   ├── db/
│   │   ├── client.ts         # better-sqlite3 + sqlite-vec 初始化
│   │   ├── migrate.ts        # 迁移器
│   │   ├── schema.sql        # 建表语句
│   │   └── types.ts          # 行类型定义
│   └── lib/
│       ├── apiClients/       # qwen / rerank / arxiv / semanticScholar / openAlex
│       ├── config.ts, errors.ts, utils.ts
│       ├── fetchWithRetry.ts # 带重试的 fetch
│       └── sseWriter.ts      # SSE 事件写入器
├── src/
│   ├── components/           # Vue 组件（含 knowledge/ 子目录）
│   ├── composables/          # useRenderBuffer / useTypewriter / useTheme 等
│   ├── services/             # qwen.ts、llmStreamAdapter.ts、markdown.ts
│   ├── stores/               # chat / session / knowledge / ui
│   ├── types/                # TypeScript 类型定义
│   ├── utils/                # agentStage / renderProfiler
│   ├── App.vue
│   └── main.ts
├── bench/                    # 真实 SSE 录制样本（渲染性能基准用）
├── .data/                    # SQLite 库文件与文献缓存
├── Dockerfile
├── playwright.config.ts
├── vite.config.ts            # Vite 配置、开发代理与 Vitest 配置
├── tsconfig.server.json      # 服务端类型检查
├── tsconfig.server.build.json# 服务端生产编译（输出 .server-build）
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

| 文件或目录                           | 说明                                 |
| ------------------------------------ | ------------------------------------ |
| `src/main.ts`                        | 前端入口                             |
| `src/App.vue`                        | 应用根组件                           |
| `src/components/`                    | 页面和 UI 组件                       |
| `src/services/qwen.ts`               | 后端 API 请求封装                    |
| `src/services/llmStreamAdapter.ts`   | SSE 解码、事件归一化、Output Gate    |
| `src/stores/chat.ts`                 | 一轮对话的编排与流式状态             |
| `src/stores/session.ts`              | 会话与消息列表                       |
| `src/stores/knowledge.ts`            | 知识库文档                           |
| `src/composables/useRenderBuffer.ts` | rAF 批量刷新，降低渲染频率           |
| `src/composables/useTypewriter.ts`   | 把服务端攒批的 delta 拆成逐字        |
| `src/utils/agentStage.ts`            | 阶段文案、步骤进度、提前结束信息解析 |
| `src/types/chat.ts`                  | 消息、引用、论文、实验方案等类型定义 |

### 5.3 前端扩展方向

后续可增强：

- Agent 选择器组件：展示不同专业 Agent 的能力和状态。
- 多 Agent 交互界面：展示协作过程、任务进度和工具调用链路。
- 知识库管理增强：文献分类、标签、预览、统计和搜索。
- 科研分析可视化：研究空白、实验方案、文献图谱等结果展示。

## 6. 后端架构

后端基于 Node.js + Express + MCP SDK。

### 6.1 `server/index.ts`

负责对外提供 HTTP API：

- CORS 白名单（`ALLOWED_ORIGINS`）与 JSON body 解析。
- 提供 `/api/health` 健康检查（含 SQLite 与 MCP 连通性）。
- 提供知识库 REST 接口，上传走 multer 内存存储并限制单文件大小与数量。
- 提供科研分析 REST 接口。
- 提供 `/api/chat/stream` SSE 流式聊天与 `/api/chat/abort` 取消接口。
- 通过 MCP Client 以 stdio 连接 `server/mcp-server.ts`；父进程由 `tsx` 启动时会把
  同样的 loader 参数传给子进程，否则子进程解析不到 `.ts` 模块。
- 生产环境托管 `dist/` 静态资源。

### 6.2 `server/agent/` —— Agent Runtime

一轮对话的完整生命周期：

```text
createCancelRoot -> startRun(落库)
  -> Planner 产出结构化计划 -> updateRunPlan(落库)
  -> Executor 逐步执行（Timeout/Retry/取消联动/终止条件）
  -> 工具结果整理成上下文，交给生成阶段流式产出答案
  -> finishRun(落库)
```

- `cancelTree.ts`：`CancelNode` 树，父节点取消时递归取消子节点。取消原因是结构化的
  （`USER_ABORT` / `TIMEOUT` / `PARENT_CANCELLED` / `UPSTREAM_ERROR` / `LOOP_DETECTED`）。
- `policy.ts`：`runWithPolicy` 提供超时 + 指数退避重试（带抖动），每次尝试挂在取消树子节点上。
- `planner.ts`：Zod 校验的计划结构。除自然语言 `stopWhen` 外，还产出可机械求值的
  `stopConditions`（`{afterStep, path, op, value}`），`normalizeStopConditions` 会丢弃永不触发的条件。
- `executor.ts`：逐步执行工具；关键步骤失败终止计划，可选步骤失败继续；命中终止条件时
  发出 `plan_stopped_early` 事件并跳过剩余步骤。
- `runtime.ts`：编排上述环节，维护 `activeRuns` 以支持按 `runId` 精确取消。

### 6.3 `server/services/` —— 业务服务

- `agenticRag.ts`：检索规划 -> HyDE 改写 -> 向量召回 -> 精排（失败降级为向量顺序并标记
  `degraded`）-> 证据落库 -> 引用构建 -> groundedness 校验 -> 必要时补充检索。
- `answerGenerator.ts`：组装 prompt、流式生成、注入 `[^n]` 引用要求，并串联证据核查。
- `contextManager.ts`：Working / Short-Term / Long-Term 三层上下文，用 `gpt-tokenizer`
  真实计数，超预算时压缩进长期层。

### 6.4 `server/db/` 与 `server/repositories/`

- `db/client.ts`：`better-sqlite3` 初始化并加载 `sqlite-vec` 扩展，提供
  `toVectorBlob` 与 `checkDatabaseHealth`。
- `db/migrate.ts`：按 `schema_migrations` 版本号顺序应用迁移。
- `repositories/`：每张表一个模块，对外只暴露驼峰视图，SQL 全部收在这一层，
  便于后续整体替换存储引擎。

### 6.5 `server/mcp-server.ts`

负责实现 MCP 工具服务：

- 注册知识库工具（检索、列表、内容、导入、删除、清空）。
- 注册文献检索与分析工具（多源检索、分析、摘要、入库）。
- 注册 Paper Schema / Paper Memory / Research Gap / Experiment Spec 工具。
- 注册论文写作、公式推导、分类标签、多 Agent 协作等工具（部分为模拟实现）。
- 调用 Qwen Embedding 建立向量索引，文档与分块写入 SQLite。
- 文献缓存与 Paper Schema 仍持久化在 `.data/knowledge-state.json`。

> 该文件目前约 2200 行，工具注册与业务逻辑混在一起，是已知的待拆分项。

## 7. MCP 与 Agent 调度设计

### 7.1 当前 MCP 调用链路

```text
Express API / Agent Executor
  -> createMcpSession()
  -> StdioClientTransport（继承 tsx loader 参数）
  -> node server/mcp-server.ts
  -> MCP Server registerTool(...)
  -> 执行具体工具
  -> 返回 structuredContent / content
```

工具调用的 `AbortSignal` 来自取消树节点，透传给 `client.callTool`，
因此用户中断或超时能立即终止在途工具调用。

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
  -> buildContext 组装分层上下文（先组装，再落当前轮用户消息）
  -> Planner 出计划 -> Executor 执行工具（可提前结束）
  -> Agentic RAG 检索证据
  -> Qwen Chat Completions 流式输出 -> groundedness 校验
  -> 事件：status / plan / tool_call / tool_result / delta / citations / done
```

前端不能将该接口当作普通 JSON 处理，需要读取 `response.body.getReader()`；
解码、事件归一化与 Gate 拦截统一由 `src/services/llmStreamAdapter.ts` 完成。

### 8.3 文件上传和知识库入库

```text
Vue 前端
  -> FormData(files)
  -> POST /api/knowledge/upload（multer 内存存储 + 大小/数量限额）
  -> MCP Tool: ingest_knowledge_documents
  -> PDF / DOCX / 文本解析
  -> 定长滑窗分块（记录 span 原文区间）
  -> Qwen Embedding
  -> 单事务写入 documents / chunks / chunk_vec_map / chunk_vectors
```

向量生成放在事务外，避免长时间持有 SQLite 写锁。

### 8.4 RAG 检索增强

```text
用户问题
  -> 检索规划（Zod 校验的 RetrievalPlan）
  -> HyDE 改写
  -> chunk_vectors 向量召回（cosine，vec0）
  -> gte-rerank 精排（失败则降级为向量顺序 + degraded 标记）
  -> 证据写入 evidence 表（带 span 与打分）
  -> 构建 [^n] 引用 -> 生成答案
  -> groundedness 校验 -> 不通过则补充检索
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

当前项目以 SQLite 作为主要持久化，默认库文件：

```text
.data/research-agent.db        # 可用 SQLITE_PATH 覆盖，测试可设为 :memory:
.data/knowledge-state.json     # 仅存文献检索缓存与 Paper Schema 等易变状态
```

SQLite 表结构（详见 `server/db/schema.sql`）：

| 表                          | 用途                                            |
| --------------------------- | ----------------------------------------------- |
| `sessions`                  | 会话，含 Long-Term Context 摘要与覆盖位置       |
| `messages`                  | 消息，含预计算 `token_count` 供 Token Budget 用 |
| `documents`                 | 知识库文档，保留原文供预览                      |
| `chunks`                    | 分块，含 `span_start/span_end` 供证据溯源       |
| `chunk_vectors`             | `vec0` 虚拟表，`float[1024] cosine`             |
| `chunk_vec_map`             | `chunk_id` <-> vec0 整数 rowid 映射             |
| `papers` / `paper_schemas`  | 文献缓存与结构化抽取结果                        |
| `query_cache`               | 上游检索结果 TTL 缓存，降低 429 概率            |
| `agent_runs` / `tool_calls` | Agent 运行与工具调用记录，支持可观测与回放      |
| `evidence`                  | 证据溯源，含向量分/精排分与最终引用序号         |
| `schema_migrations`         | 迁移版本记录                                    |

约定：所有时间戳统一用 `INTEGER` 存 epoch 毫秒；`journal_mode=WAL`、`foreign_keys=ON`。

后续若需要多用户或更大规模，迁移路径是 PostgreSQL + pgvector；SQL 已全部收在
`server/repositories/`，替换面收敛在这一层。

### 9.1 知识管理规划

个人文献知识库的长期目标：

- 支持 PDF / DOCX / TXT / Markdown 文档上传和解析。
- 建立文献向量索引。
- 提供文献检索和管理。
- 支持文献分类和标签。
- 支持文献版本控制。
- 与多个专业 Agent 集成。

## 10. 外部依赖

| 依赖                 | 用途                                    |
| -------------------- | --------------------------------------- |
| Qwen Chat API        | 对话、规划、答案生成、groundedness 校验 |
| Qwen Embedding API   | 文档与查询向量化（text-embedding-v3）   |
| gte-rerank-v2        | Agentic RAG 精排                        |
| arXiv                | 学术文献检索                            |
| Semantic Scholar     | 学术文献检索和引用信息                  |
| OpenAlex             | 学术文献检索                            |
| better-sqlite3       | SQLite 驱动（同步 API，native 模块）    |
| sqlite-vec           | 向量检索扩展，提供 `vec0` 虚拟表        |
| gpt-tokenizer        | Token 计数，用于 Context 预算           |
| pdf-parse            | PDF 文档解析                            |
| mammoth              | DOCX 文档解析                           |
| Zod                  | MCP 工具入参与计划结构校验              |
| Element Plus         | 前端组件库（按需导入）                  |
| vue-virtual-scroller | 消息列表虚拟滚动                        |
| DOMPurify            | Markdown 渲染前的 XSS 清洗              |

## 11. 开发环境与生产环境差异

### 11.1 开发环境

- 前端由 Vite 提供服务，默认 `http://localhost:5173`。
- 后端由 Express 提供服务，`.env.example` 里 `SERVER_PORT=8788`（代码未设该变量时回退 8787）。
- Vite 将 `/api/*` 代理到 `http://127.0.0.1:8788`，改端口时两处要同步。
- `npm run dev` 通过 concurrently 同时起前后端，服务端用 `tsx` 直接跑 `.ts`。

### 11.2 生产环境

- `npm run build` 依次执行 `vue-tsc -b`、`vite build`、`build:server`。
- `build:server` 用 `tsconfig.server.build.json` 把服务端编译到 `.server-build`，
  并显式复制 `schema.sql`（`tsc` 不会拷贝非 TS 资源）。
- 运行时用编译后的纯 JS，镜像不需要 `tsx` 等 dev 依赖。
- Express 托管 `dist/`，页面和 API 同源访问。
- Docker/云部署需把 `SERVER_HOST` 设为 `0.0.0.0`，并按实际域名配置 `ALLOWED_ORIGINS`。

### 11.3 质量流水线

`.github/workflows/ci.yml` 顺序执行：`lint` -> `format:check` -> `typecheck` ->
`test`（Vitest）-> `build` -> `test:e2e`（Playwright）。E2E 的报告作为 artifact 上传。

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
- SQLite 是单写者模型，不适合多人写入与多租户。

应对：

- 已迁到 SQLite + sqlite-vec，向量检索走 `vec0` 索引；更大规模再迁 PostgreSQL + pgvector。
- 上传已限制单文件大小与数量，解析失败的文件跳过而不中断整批导入。
- 分块记录 `span` 原文区间，证据可回溯到原文位置。
- 仍缺文档重建索引与备份机制。

### 12.3 第三方依赖

风险：

- Qwen、Semantic Scholar、OpenAlex、arXiv 可能限流或不可用。
- 网络环境可能导致上游访问失败。

应对：

- `fetchWithRetry` 与 `runWithPolicy` 提供超时、指数退避重试。
- 文献检索多源聚合，单源失败只记 `warnings`，全部失败才抛 `LITERATURE_ALL_SOURCES_FAILED`。
- 精排失败降级为向量顺序并标记 `degraded`，不让整条 RAG 链路挂掉。
- `query_cache` 表对上游检索结果做 TTL 缓存，降低 429 概率。

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

- 拆分 `server/mcp-server.ts`（当前约 2200 行），按知识库 / 文献 / 分析 / 写作分模块。
- 把 `.data/knowledge-state.json` 里剩余的文献缓存与 Paper Schema 也迁入 SQLite。
- 增加用户体系、接口鉴权、限流和审计日志（当前 `/api/*` 无认证）。
- 在真实环境验证 Docker 镜像（目前只验证了编译产物路径）。
- 增加 OpenAPI 文档和接口测试集合。
- 实现完整 Agent 调度中心。
- 实现论文写作 Agent 和公式推导 Agent（当前相关工具多为模拟实现）。
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

- 优化向量检索性能（已迁 sqlite-vec 的 `vec0` 索引）。
- 增加缓存、限流和超时机制（`query_cache` + `runWithPolicy` 已落地）。
- 增强错误处理和日志（结构化 AppError + 取消原因枚举已落地）。
- 补充自动化测试（Vitest 单测 + Playwright E2E + GitHub Actions 已落地）。

### 第五阶段：部署和产品化

- 完善 Docker 部署（Dockerfile 已改为使用编译产物，尚未真机验证）。
- 增加鉴权和安全控制（CORS 白名单与上传限额已落地，接口鉴权待做）。
- 支持云部署和数据持久化。
- 完善用户文档和反馈机制。

## 15. 结论

Research Agent 当前已经具备科研助手的核心闭环：文献检索、知识库增强、Paper Schema、研究空白挖掘、实验方案生成和流式对话。

在此之上已经补齐了工程骨架：Agent Runtime（规划 / 执行 / 取消树 / 重试 / 终止条件）、
Agentic RAG（证据溯源 + groundedness 校验）、分层 Context 与 Token 预算、
SQLite + sqlite-vec 持久化、前端流式渲染优化，以及 lint / typecheck / 单测 / E2E 的 CI 流水线。

后续架构演进重点应放在三方面：

1. 拆分体量过大的 MCP 工具服务，并把剩余文件态状态收进 SQLite。
2. 将当前 MCP 工具能力进一步抽象为清晰的多 Agent 调度体系。
3. 补上鉴权与多用户隔离，让项目具备对外提供服务的前提。
