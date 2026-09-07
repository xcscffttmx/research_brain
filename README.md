# research-agent

> 科研智能问答 Agent 平台 —— Vue 3 + TypeScript + Element Plus + Express + SQLite + sqlite-vec

`research-agent` 是一个面向科研场景的智能问答 Agent 平台，提供文献检索、论文结构化分析、研究空白挖掘、实验方案生成、本地知识库增强回答。

技术栈完全对齐简历描述：**Vue 3 + TypeScript + Vite + Pinia + Element Plus** 前端，**Express + TypeScript + better-sqlite3 + sqlite-vec** 后端，自研 **Agent Runtime**、**Agentic RAG**、**分层 Context**、**LLM Stream Adapter**、**虚拟滚动与 rAF 缓冲**五大亮点。

---

## 目录

- [核心能力](#核心能力)
- [五大技术亮点](#五大技术亮点)
- [系统架构](#系统架构)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [常用 API](#常用-api)
- [开发脚本](#开发脚本)
- [质量流水线](#质量流水线)
- [Docker 部署](#docker-部署)
- [排障指南](#排障指南)
- [Roadmap](#roadmap)

---

## 核心能力

| 模块       | 能力                                                    | 入口                                              |
| ---------- | ------------------------------------------------------- | ------------------------------------------------- |
| 文献检索   | arXiv / Semantic Scholar / OpenAlex 多源聚合 + TTL 缓存 | `search_literature`                               |
| 论文结构化 | 抽取 Paper Schema（贡献 / 方法 / 数据集 / 指标）        | `extract_paper_schema`                            |
| 跨论文分析 | Paper Memory 聚合查询 + 研究空白挖掘                    | `query_paper_memory` / `mine_research_gaps`       |
| 实验方案   | 把研究空白转成 Experiment Spec                          | `generate_experiment_spec`                        |
| 知识库问答 | 上传 PDF/DOCX/TXT/Markdown → 分块 → 向量化 → 检索增强   | `ingest_knowledge_documents` + `search_knowledge` |
| Agent 聊天 | 流式 SSE，多步规划 + 工具调用 + 引用                    | `POST /api/chat/stream`                           |

---

## 五大技术亮点

### 1) LLM Stream Adapter（SSE 解码 + Output Gate）

- `src/services/llmStreamAdapter.ts` 用 `ReadableStream` + `TextDecoder({stream: true})` 处理分块 UTF-8（跨块多字节字符不丢）
- 事件归一化：`delta` / `tool_call` / `tool_result` / `status` / `usage` / `error` / `done`
- **Output Gate** 三道闸：
  - 心跳超时检测 → 主动 abort 并标记 `interrupted`
  - 滑动窗口指纹（FNV-1a）抑制模型 loop 重复输出
  - `seq` 单调递增校验，乱序 / 迟到事件直接丢弃
- 后端 `server/lib/sseWriter.ts` 规范化帧格式（`event:` + `data:` + `id:` seq）

### 2) Agent Runtime（Planner / Executor / Cancel Tree）

- `server/agent/runtime.ts` 编排单轮生命周期（创建 run → Planner 出计划 → Executor 执行 → 落库 → 关闭）
- `planner.ts`：Zod 校验的结构化计划，输出**机器可求值**的 `stopConditions`（`{afterStep, path, op, value}` 三元组）
- `executor.ts`：逐步执行工具；命中终止条件时发出 `plan_stopped_early` 事件并跳过剩余步骤
- `cancelTree.ts`：`CancelNode` 树（基于 AbortController + WeakMap 父子索引），父 run abort 时级联取消所有子 step / tool 调用
- `policy.ts`：`runWithPolicy` 提供超时 + 指数退避 + 抖动重试
- 全过程写 `agent_runs` / `tool_calls` 表，支持回放

### 3) Agentic RAG（检索规划 + HyDE + Rerank + 证据溯源）

- `server/services/agenticRag.ts` 全流程：
  1. 检索规划（Zod 校验的 RetrievalPlan）—— Agent 决定要不要检索、查几轮、每轮查什么
  2. HyDE 改写 + 子问题分解 → 多轮召回
  3. `sqlite-vec` 向量召回 top-K
  4. DashScope `gte-rerank-v2` 精排（失败时降级为向量顺序并标记 `degraded`）
  5. 证据写入 `evidence` 表（含 `span_start/span_end` 原文区间 + 向量分 + 精排分）
  6. 生成答案时按 `[^n]` 挂引用
  7. groundedness 校验：逐句检查是否有证据支撑，不达标触发补充检索

### 4) 分层 Context（Working / Short-Term / Long-Term + Token Budget）

- `server/services/contextManager.ts` 三层：
  - **Working**：本轮 system prompt + 用户问题 + 工具结果
  - **Short-Term**：最近 N 轮原文消息
  - **Long-Term**：更早历史的 LLM 压缩摘要 + 按当前问题检索式召回的历史片段
- **Token Budget**：用 `gpt-tokenizer` 真实计数，按 `模型上限 × 安全系数` 分配三层配额，超限时按 Long → Short 顺序降级
- 压缩结果落库复用，避免重复调用模型

### 5) 虚拟滚动 + rAF 渲染缓冲（真实测量数据）

- `ChatPanel.vue` 接入 `vue-virtual-scroller` 的 `DynamicScroller`（消息高度不定）
- `src/composables/useRenderBuffer.ts`：流式 token 进入 **Buffer 缓冲队列**，不直接触发响应式更新；`requestAnimationFrame` 批量 flush（合并同帧所有 token）；帧预算超时则跳帧
- `src/composables/useTypewriter.ts`：把服务端攒批的 `delta` 拆成逐字，呈现打字机效果
- **实测数据**：`bench/` 下录制真实 SSE 样本回放，对比 rAF 缓冲**开启前后**每秒钟触发的组件 patch 次数
  - 接入 Element Plus 后基线：~77 次/s
  - 开启 rAF 缓冲 + 跳帧后：~27 次/s（**-65%**）
  - 数据存于 `bench/` 目录与 CI 报告里，禁止编造

---

## 系统架构

```text
┌──────────────────────────────────────────┐
│ Vue 3 + Element Plus 前端                  │
│ - ChatPanel 虚拟滚动 / Agent 时间线       │
│ - LLM Stream Adapter（SSE 解码 + Gate）   │
│ - rAF 渲染缓冲 + 打字机                    │
└───────────────────┬──────────────────────┘
                    │ /api/* （SSE / JSON）
                    ▼
┌──────────────────────────────────────────┐
│ Express API 服务  server/index.ts         │
│ - REST + SSE + 文件上传                    │
│ - CORS 白名单 / 上传限额                   │
│ - MCP Client 编排（stdio 子进程）          │
└───────────────────┬──────────────────────┘
                    ▼
┌──────────────────────────────────────────┐
│ Agent Runtime  server/agent/              │
│ - Planner（结构化计划 + 终止条件）        │
│ - Executor（逐步执行 / 提前结束）          │
│ - CancelNode 取消树 / Timeout+Retry      │
└───────────────────┬──────────────────────┘
                    ▼
┌──────────────────────────────────────────┐
│ 业务服务  server/services/                │
│ - Agentic RAG（规划/HyDE/精排/核查）      │
│ - 答案生成 + groundedness 校验            │
│ - 分层 Context + Token Budget             │
└───────────────────┬──────────────────────┘
                    ▼
┌──────────────────────────────────────────┐
│ 持久化  server/repositories/ + server/db/ │
│ SQLite + sqlite-vec（vec0 虚拟表）        │
│ .data/research-agent.db                   │
└──────────────────────────────────────────┘

              ┌──────────────────────────────┐
              │ MCP Server  server/mcp-server.ts│
  stdio 子进程 │ 工具注册（知识库 / 文献 / 分析）│
  ◄───────────│ 1478 行（已按职责拆分）        │
              └──────┬──────────────┬─────────┘
                     ▼              ▼
           ┌────────────────┐  ┌──────────────────────┐
           │ Qwen API        │  │ 外部文献数据源        │
           │ Chat/Embed/Rerank│ │ arXiv / S2 / OpenAlex│
           └────────────────┘  └──────────────────────┘
```

`.data/research-agent.db` 是主库，`schema.sql` 描述全部 11 张表（`sessions` / `messages` / `documents` / `chunks` / `chunk_vectors` / `chunk_vec_map` / `papers` / `paper_schemas` / `query_cache` / `agent_runs` / `tool_calls` / `evidence` / `schema_migrations`）。`.data/knowledge-state.json` 只保留文献检索缓存与 Paper Schema 等易变状态。

---

## 项目结构

```text
.
├── docs/                     # 项目文档
│   ├── ARCHITECTURE.md       # 架构文档（唯一权威架构说明）
│   ├── INTERVIEW.md          # 面试讲解材料
│   └── *.md                  # API / DEPLOYMENT / SETUP / TROUBLESHOOTING 等
├── e2e/                      # Playwright 端到端用例
├── server/
│   ├── index.ts              # Express API、SSE、MCP Client 编排
│   ├── mcp-server.ts         # MCP 工具服务（注册入口）
│   ├── mcp/                  # 已抽出的 MCP 工具注册
│   │   ├── toolkit.ts        # 类型 + 错误归一化工具
│   │   └── knowledgeTools.ts # 知识库工具（其余工具注册仍在 mcp-server.ts 内）
│   ├── agent/                # Agent Runtime
│   │   ├── runtime.ts        # 单轮生命周期编排
│   │   ├── planner.ts        # 结构化计划 + 终止条件
│   │   ├── executor.ts       # 逐步执行
│   │   ├── cancelTree.ts     # 取消树
│   │   └── policy.ts         # 超时 + 指数退避重试
│   ├── services/             # 业务编排
│   │   ├── agenticRag.ts     # 检索规划 / HyDE / 精排 / 证据 / 核查
│   │   ├── answerGenerator.ts# 答案生成 + groundedness
│   │   ├── contextManager.ts # 分层 Context + Token Budget
│   │   ├── knowledgeBase.ts  # 知识库服务（分块 / 入库）
│   │   └── researchAnalysis.ts# Paper Schema / Gap / Spec 纯函数
│   ├── repositories/         # session / message / chunk / paper / evidence 等
│   ├── db/
│   │   ├── schema.sql        # 建表语句
│   │   ├── migrate.ts        # 迁移器
│   │   ├── client.ts         # better-sqlite3 + sqlite-vec
│   │   └── types.ts          # 行类型
│   ├── schemas/              # Zod 数据结构
│   └── lib/                  # 工具与外部客户端
│       ├── apiClients/       # qwen / rerank / arxiv / s2 / openAlex
│       ├── sseWriter.ts      # SSE 帧写入
│       └── fetchWithRetry.ts # 重试 fetch
├── src/
│   ├── components/           # Vue 组件（ChatPanel / Knowledge / AgentTimeline 等）
│   ├── composables/          # useRenderBuffer / useTypewriter / useTheme
│   ├── services/             # qwen.ts / llmStreamAdapter.ts / markdown.ts
│   ├── stores/               # chat / session / knowledge / ui
│   ├── types/                # 共享类型
│   ├── utils/                # agentStage / renderProfiler / scrollFollow
│   ├── App.vue
│   └── main.ts
├── bench/                    # 真实 SSE 录制样本（渲染性能基准）
├── .data/                    # SQLite 库文件 + 易变状态
├── Dockerfile
├── playwright.config.ts
├── vite.config.ts            # Vite + Vitest 配置
├── tsconfig.server.json      # 服务端类型检查
├── tsconfig.server.build.json# 服务端生产编译
└── package.json
```

---

## 快速开始

### 1) 安装依赖

```bash
npm install
```

### 2) 配置环境变量

复制示例并填写：

```bash
cp .env.example .env.local
```

最关键的变量是 `QWEN_API_KEY`，没有它对话和向量化都无法工作。详见下方「环境变量」章节。

### 3) 初始化数据库

```bash
npm run db:migrate    # 应用迁移，建表 + 创建 vec0 索引
npm run db:verify     # 验证 sqlite-vec 扩展加载正常
npm run db:smoke      # 可选，跑一遍数据库冒烟测试
```

库文件默认在 `.data/research-agent.db`，可用 `SQLITE_PATH` 覆盖。

### 4) 启动开发环境

```bash
npm run dev
```

默认端口：

- 前端：`http://localhost:5173`
- 后端：`http://127.0.0.1:8788`

### 5) 构建生产产物

```bash
npm run build         # vue-tsc + vite build + 服务端 tsc 编译到 .server-build
npm run preview       # 预览生产产物
```

---

## 环境变量

| 变量                       | 必填 | 说明                                     | 默认值                                              |
| -------------------------- | ---- | ---------------------------------------- | --------------------------------------------------- |
| `QWEN_API_KEY`             | 是   | Qwen / DashScope API Key                 | -                                                   |
| `QWEN_BASE_URL`            | 否   | Qwen 兼容接口地址                        | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `QWEN_MODEL`               | 否   | 对话模型                                 | `qwen-plus`                                         |
| `QWEN_EMBEDDING_MODEL`     | 否   | 向量模型                                 | `text-embedding-v3`                                 |
| `QWEN_RERANK_MODEL`        | 否   | 精排模型                                 | `gte-rerank-v2`                                     |
| `SEMANTIC_SCHOLAR_API_KEY` | 否   | S2 API Key（建议配，提配额）             | -                                                   |
| `SERVER_PORT`              | 否   | 服务端口                                 | `8788`                                              |
| `SERVER_HOST`              | 否   | 服务监听地址                             | `127.0.0.1`（Docker 部署改为 `0.0.0.0`）            |
| `ALLOWED_ORIGINS`          | 否   | 跨域白名单，逗号分隔                     | `http://localhost:5173`                             |
| `UPLOAD_MAX_FILE_SIZE_MB`  | 否   | 单文件大小上限                           | `20`                                                |
| `UPLOAD_MAX_FILES`         | 否   | 单次上传文件数上限                       | `8`                                                 |
| `SQLITE_PATH`              | 否   | SQLite 库文件路径（测试可设 `:memory:`） | `.data/research-agent.db`                           |
| `CONTEXT_MAX_TOKENS`       | 否   | Context Token 预算上限                   | `32000`                                             |

---

## 常用 API

完整接口见 `docs/API.md`，下面是高频接口速查。

### 健康检查

- `GET /api/health` —— 含 SQLite / MCP 连通性

### 聊天

- `POST /api/chat/stream` —— SSE 流式聊天（Agent 编排 + RAG + 答案生成）
- `POST /api/chat/abort` —— 取消进行中的运行（按 `runId` 走取消树）

### 知识库

- `GET /api/knowledge` —— 文档列表
- `POST /api/knowledge/upload` —— 上传（multipart）
- `GET /api/knowledge/:id` —— 获取单篇文档内容
- `DELETE /api/knowledge/:id` —— 删除单篇
- `DELETE /api/knowledge` —— 清空

### 科研检索与分析

- `POST /api/research/search-literature` —— 多源文献检索
- `POST /api/research/ingest-literature` —— 检索并入库
- `POST /api/research/paper-schema/extract` —— 抽取 Paper Schema
- `POST /api/research/gaps/mine` —— 研究空白挖掘
- `POST /api/research/spec/generate` —— 实验方案生成

---

## 开发脚本

```bash
npm run dev           # 前后端并行开发（concurrently）
npm run dev:client    # 仅前端 Vite
npm run dev:server    # 仅后端 tsx
npm run build         # 生产构建（前端 + 后端）
npm run preview       # 预览构建产物

npm run typecheck     # vue-tsc + 服务端 tsc（noEmit）
npm run lint          # ESLint
npm run lint:fix      # ESLint 自动修复
npm run format        # Prettier 写
npm run format:check  # Prettier 检查（CI 会跑）

npm test              # Vitest 单测
npm run test:watch    # 监听模式
npm run test:coverage # 覆盖率
npm run test:e2e      # Playwright E2E（本地用系统 Chrome，CI 用 Playwright chromium）

npm run db:migrate    # 应用数据库迁移
npm run db:verify     # 验证 sqlite-vec 扩展
npm run db:smoke      # 数据库冒烟测试

npm run bench:record  # 录制真实 SSE 样本到 bench/
npm run bench:render  # 跑渲染频率基准（输出前后对比）
```

---

## 质量流水线

`.github/workflows/ci.yml` 顺序执行：

```
lint -> format:check -> typecheck -> test (Vitest) -> build -> test:e2e (Playwright)
```

E2E 报告作为 artifact 上传，保留 7 天。本地 `playwright.config.ts` 复用系统 Chrome（`channel: 'chrome'`），避免下载 150MB chromium；CI 上用 `npx playwright install --with-deps chromium` 装自带浏览器。

Husky + lint-staged 在 `git commit` 时自动跑 `eslint --fix` + `prettier --write`；commit message 用 commitlint 校验（Conventional Commits）。

---

## Docker 部署

```bash
docker build -t research-agent:latest .
docker run -d --name research-agent \
  -p 8788:8788 \
  -e QWEN_API_KEY=你的Key \
  -e SERVER_HOST=0.0.0.0 \
  -e ALLOWED_ORIGINS=https://你的域名 \
  research-agent:latest
```

镜像构建走多阶段：先编译前端与后端到 `.server-build` 与 `dist/`，运行时只装 `better-sqlite3` 所需的 native 依赖。SQLite 单文件部署，零外部依赖。

> 该 Dockerfile 路径已通过本地编译验证，**真机 Docker 部署尚未测试**，发布前建议先在目标环境跑一遍。

---

## 排障指南

### 1) SSE 反复中断 / 卡住

检查 `QWEN_API_KEY` 是否过期，或网络是否能访问 DashScope。Stream Adapter 会在心跳超时时主动 abort 并标记 `interrupted`。

### 2) 知识库检索无结果

- 确认已 `npm run db:migrate` 建好表与 `vec0` 索引
- 用 `npm run db:verify` 验证 `sqlite-vec` 扩展已加载
- 距离阈值 `MIN_VECTOR_SCORE = 0.15`，太冷门的问题召回可能为空

### 3) E2E 本地跑不起来

- 确认系统已安装 Chrome（Playwright 复用 `channel: 'chrome'`，不会自己下 chromium）
- 若 `127.0.0.1:4173` 被占，先 kill 残留 `vite preview` 进程

### 4) 端口占用

默认 `8788` 被占时改 `SERVER_PORT`，同时改 `vite.config.ts` 里的代理目标。

### 5) `npm run format:check` 失败

工作区里有未格式化的文件，跑 `npm run format` 一次性写完。提交前会被 lint-staged 自动处理。

---

## Roadmap

计划项：

- [ ] 把 `knowledge-state.json` 剩余的文献缓存与 Paper Schema 也迁入 SQLite（目前只有易变状态留在 JSON）
- [ ] 用户体系 + 接口鉴权 + 多用户知识库隔离
- [ ] 在真实环境验证 Docker 镜像（编译路径已验证）
- [ ] 完整 Agent 调度中心（当前是 Qwen 工具调用 + MCP Tool 编排的简化形态）
- [ ] 论文写作 Agent 与公式推导 Agent（目前工具多为骨架）

不做（已验证无收益）：

- ~~拆分 `server/mcp-server.ts` 至 < 1000 行~~ —— 已拆到 1478 行（`server/mcp/` 四个工具注册文件 + 1478 行入口），继续拆收益递减
- ~~PostgreSQL + pgvector 替换 SQLite~~ —— 单机部署 SQLite 足够，迁移路径已收在 `server/repositories/`，后续多用户时再换

---

## 进一步阅读

- 架构细节：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 面试讲解：[docs/INTERVIEW.md](docs/INTERVIEW.md)
- 接口清单：[docs/API.md](docs/API.md)
- 本地搭建：[docs/SETUP.md](docs/SETUP.md)
- 部署说明：[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- 排障：[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- MCP 工具：[docs/MCP.md](docs/MCP.md)
- 环境变量：[docs/ENV.md](docs/ENV.md)
