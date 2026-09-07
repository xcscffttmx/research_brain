# 面试讲解材料

本文是 Research Agent 的面试向导读，目标是：**给定 20 分钟，能把这个项目里真正有技术含量的部分讲清楚，并且每个论断都能落到具体文件和可复现的数据上。**

其他文档的分工：`ARCHITECTURE.md` 讲架构全貌，`API.md` 讲接口，`DEPLOYMENT.md` 讲部署。本文只讲**怎么讲**。

## 1. 30 秒电梯陈述

面向科研场景的问答 Agent 平台。用户上传文献或按主题检索文献入库，然后用自然语言提问；系统自动规划工具调用、做证据检索、生成带 `[^n]` 角标的可溯源回答，并对回答做 groundedness 校验，必要时自动补充检索。

技术栈：

- 前端：Vue 3 + TypeScript + Vite + Pinia + Element Plus
- 后端：Express + MCP SDK，全量 TypeScript
- 存储：SQLite + `better-sqlite3` + `sqlite-vec`（向量检索）
- 模型：Qwen Chat / Embedding / gte-rerank

## 2. 架构分层

```text
Vue 3 SPA
  │  fetch + SSE
  ▼
server/index.ts            HTTP 入口：路由、SSE、CORS 白名单、上传限额
  ▼
server/agent/              Agent Runtime：Planner / Executor / 取消树 / 重试策略
  ▼
server/services/           业务编排：Agentic RAG、答案生成、Context 管理
  ▼
server/repositories/       持久化访问：session / message / chunk / paper / agentRun
  ▼
server/db/ + server/lib/   SQLite 客户端、迁移器、外部 API 客户端

server/mcp-server.ts       独立 stdio 子进程，注册全部 MCP 工具
```

依赖方向严格单向（入口 → 服务 → 数据/工具），`AGENTS.md` 里把这条写成了硬约束。

## 3. 六个可深挖的技术点

### 3.1 SSE 流式链路与 Output Gate

**问题**：SSE 直接交给业务代码有三类坑 —— 多字节 UTF-8 字符跨 chunk 被截断、模型进入重复输出循环、网络假死后前端一直转圈。

**方案**：`src/services/llmStreamAdapter.ts` 把这三件事收在一层。

- 基于 `ReadableStream` + `TextDecoder({ stream: true })` 做增量解码，天然处理跨块字符
- `parseSseFrame` 按 SSE 规范解析（多行 `data` 用 `\n` 拼接，`:` 开头为注释）
- `OutputGate` 三重拦截：`seq` 单调递增校验丢弃乱序/重放帧；滑动窗口指纹（FNV-1a 变体）连续命中阈值判定模型 loop 并中断；`stallTimeoutMs` 超时无帧（含心跳）判定 `interrupted`
- `normalizeFrame` 把后端事件归一成统一事件模型，下游只认 `delta / plan / tool_call / tool_result / status / usage / error / done`

**可追问**：为什么不用 `EventSource`？因为需要 POST body 传 messages，且要自定义中断语义。

### 3.2 Agent Runtime：取消树

**问题**：一轮回答里可能并发多个工具调用。用户点"停止"或浏览器断连时，必须级联终止所有在途请求，否则上游 token 白烧、连接泄漏。

**方案**：`server/agent/cancelTree.ts` 实现 `CancelNode` 树。

- 每个节点持有自己的 `AbortController`，父节点 cancel 时递归 cancel 全部子节点
- 取消原因是结构化的：`CancelReason` 枚举 `USER_ABORT / TIMEOUT / PARENT_CANCELLED / UPSTREAM_ERROR / LOOP_DETECTED`，配合 `nodeId` 可定位到具体哪一步被取消
- HTTP 层双路取消：`res.on('close')` 触发根节点 abort（`server/index.ts`），`/api/chat/abort` 按 `runId` 精确取消（`activeRuns` Map 索引）
- 前端 `stopStreaming` 先显式调 abort 接口再断连接，让服务端能立刻回收工具调用，而不是等 TCP 超时

### 3.3 超时与重试策略层

`server/agent/policy.ts` 的 `runWithPolicy` 把"超时 + 指数退避重试 + 取消联动"抽成一个壳：

- `RetryPolicy` 含 `retries / baseDelayMs / maxDelayMs / jitterRatio`，加抖动避免重试风暴
- 每次尝试挂在取消树的子节点上，超时触发 `CancelReason.TIMEOUT`
- `onAttempt` 回调把重试事件透给 SSE，前端时间线能看到 `tool_retry`

### 3.4 Agentic RAG 与证据溯源

`server/services/agenticRag.ts` 不是"检索一次拼进 prompt"，而是一条带反馈的链路：

1. **检索规划**：LLM 产出结构化 `RetrievalPlan`（Zod 校验）
2. **HyDE 改写**：生成假设性答案再用它做向量检索，缓解问题与文档表述不对齐
3. **向量召回**：`sqlite-vec` 的 `vec0` 虚拟表按 cosine distance 检索
4. **精排**：`gte-rerank` 重排；**上游失败时降级为保持向量顺序并打 `degraded` 标记**，不让整条链路挂掉
5. **证据落库**：命中片段写入 evidence 表，带 `span` 原文区间
6. **引用构建**：产出 `RagCitation`，前端渲染可点击的来源卡片
7. **groundedness 校验**：`answerGenerator.ts` 生成答案后校验每个论断是否有证据支撑
8. **补充检索**：校验不通过时自动再检索一轮

**分块的一个细节**：`chunkText` 做定长滑窗，但 `trim()` 会改变边界，所以要换算回原文真实区间（`spanStart = start + leading`），否则证据溯源会指错位置。

**可追问**：为什么选 sqlite-vec 而不是 pgvector？单机零运维、进程内调用无网络开销，适合这个体量；代价是不支持多写并发，rowid 必须绑 `BigInt`。

### 3.5 分层 Context 与 Token 预算

`server/services/contextManager.ts` 把上下文分三层：Working（当前轮）/ Short-Term（近期消息）/ Long-Term（压缩摘要）。

- `countTokens` 用 `gpt-tokenizer` 真实计数，不是按字符估
- 短期消息按预算从新到旧选，超预算的部分触发压缩进长期层
- 返回 `usage` 与 `budget`，通过 `status` 事件下发，前端能显示"已用 / 可用 token"

**一个容易踩的顺序问题**：先按历史组装上下文，**再**落当前轮用户消息。反过来会让问题在上下文里出现两次。

### 3.6 流式渲染性能（有真实数据）

**问题**：逐字写回响应式状态，每个字符触发一次 Vue 重渲染。

**方案**：两级缓冲。`useTypewriter` 把服务端攒批的 delta 拆成逐字，`useRenderBuffer` 用 `requestAnimationFrame` 批量刷回。

`npm run bench:render` 基于**真实录制的 SSE 时间线**（`bench/stream-timeline.json`）跑出的数据：

- 样本：131 个 delta / 1006 字符 / 12915ms，上游到达 10.1 次/s（平均 7.7 字符/delta）
- 逐字直写：**77.4 次/s**（峰值 91）
- Buffer + rAF：**27.2 次/s**（峰值 31）
- **刷新频率降幅 65%**，合并比 2.8 字符/次刷新

停止生成时会先 `flush()` 打字机和缓冲，避免丢掉最后一小段；报错时则 `reset()` 丢弃未输出内容，因为错误信息要覆盖已渲染文本。

## 4. 工程化

| 项目     | 现状                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| 类型     | 前后端全量 TypeScript，服务端独立 `tsconfig.server.json` 做 no-emit 检查      |
| 单元测试 | Vitest，19 个文件 / 296 个用例                                                |
| E2E      | Playwright，2 条主链路（对话流式渲染、知识库科研工作台）                      |
| 规范     | ESLint + Prettier + Husky + lint-staged + commitlint（Conventional Commits）  |
| CI       | GitHub Actions：lint → format:check → typecheck → test → build → e2e          |
| 生产构建 | `tsconfig.server.build.json` 把服务端编译进 `.server-build`，镜像不依赖 `tsx` |

**安全加固**（都在 `server/index.ts`）：

- CORS 从 `cors()` 全开改为 `ALLOWED_ORIGINS` 白名单
- multer 从无限制改为 `fileSize` + `files` 双限额，并加 `MulterError` 中间件返回 413 与中文提示
- `SERVER_HOST` 可配置，默认 `127.0.0.1` 而非 `0.0.0.0`

**两个值得讲的工程决策**：

1. **服务端为什么要单独编译？** 开发期用 `tsx` 直接跑 `.ts`，但生产镜像里不该带 dev 依赖。所以加了 `build:server` 产出纯 JS。踩过的坑：`tsc` 不会拷贝 `.sql` 资源，需要在 build 脚本里显式复制 `schema.sql`。
2. **E2E 为什么本地和 CI 用不同浏览器？** Playwright 的 chromium 二进制在开发机网络下载不完（多次中断留下残缺目录）。所以 `playwright.config.ts` 里 `channel: process.env.CI ? undefined : 'chrome'` —— 本地复用系统 Chrome，CI 用官方 chromium。E2E 的后端全部 `page.route` 打桩，不依赖真实 API Key。

## 5. 已知局限（如实说）

面试时主动讲局限比被问出来更好：

- **`server/mcp-server.ts` 仍有约 2190 行**，工具注册和业务逻辑混在一个文件，尚未按领域拆分。其 `registerTool` 目前用 `as unknown as` 绕过 MCP SDK 的重型泛型，是折中方案。
- **Docker 镜像未做真机验证**。Dockerfile 已按编译产物路径修正，但开发机没有 docker CLI，只验证了 `npm run build:server` 与编译后的 `migrate.js` 可执行。
- **文献缓存仍是文件态**：`state.literature` 存在 `.data/knowledge-state.json`，未随文档/向量一起落 SQLite。
- **无鉴权**：所有 `/api/*` 接口无认证，当前定位是单机自用。
- **15 条 lint warning 未清**：主要是 `llmStreamAdapter` 里处理未知 payload 的 `any`，以及 Markdown 渲染的 `v-html`（已过 DOMPurify，但规则仍会告警）。
- `ARCHITECTURE.md` 部分内容滞后于 SQLite 迁移，仍描述 JSON 文件存 chunks。

## 6. 高频追问速答

**Q：怎么保证回答不是编的？**
三层：prompt 里硬性要求"只使用工具结果中的事实"；证据带 `span` 原文区间可回溯；生成后跑 groundedness 校验，不通过则补充检索。

**Q：工具调用失败怎么办？**
`runWithPolicy` 做超时 + 指数退避重试；文献检索多源聚合，单源失败只记 `warnings` 不中断；全部源失败才抛 `LITERATURE_ALL_SOURCES_FAILED`。rerank 失败降级为向量顺序并标记 `degraded`。

**Q：为什么用 MCP 而不是直接函数调用？**
工具边界进程化隔离，工具崩溃不影响主服务；`stderr` 单独收集便于排障。代价是 stdio 序列化开销，以及父进程用 `tsx` 时子进程必须继承同样的 loader（`server/index.ts` 里 `loaderArgs` 就是处理这个）。

**Q：SQLite 单机瓶颈？**
承认。当前是单写者模型，向量检索在万级分块规模下够用。迁移路径是 PostgreSQL + pgvector，repositories 层已经把 SQL 隔离，替换面收敛在一层。

**Q：测试怎么覆盖流式和取消这种时序逻辑？**
注入式设计：`runAgentTurn` 的所有外部依赖（`qwenFetch` / `callTool` / `runRag` / `generateAnswer`）都从 `deps` 传入，测试里替换成可控 stub。取消树和重试策略各有独立测试文件（`cancelTree.test.js` 23 例、`policy.test.js` 25 例）。

## 7. 演示动线建议

1. `npm run dev`，上传一篇 PDF，展示分块与向量入库
2. 提问，指着 Agent 时间线讲 plan → tool_call → tool_result → 生成
3. 中途点"停止"，讲取消树级联
4. 展开来源卡片，讲证据溯源与 `[^n]` 角标
5. 去知识库页跑一遍 检索 → Schema → Gap → Spec 四连
6. `npm run bench:render` 现场跑出那组 65% 的数据
