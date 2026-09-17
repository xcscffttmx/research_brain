# 面试讲解材料

本文是 Research Agent 的面试向导读。目标是：**给定 20 分钟，能把这个项目里真正有技术含量的部分讲清楚，每个论断都能落到具体文件和可复现的数据。**

文档分工：`ARCHITECTURE.md` 讲架构全貌，`API.md` 讲接口，`DEPLOYMENT.md` 讲部署。本文只讲**怎么讲**。

---

## 1. 30 秒电梯陈述

面向科研场景的问答 Agent 平台。用户上传文献或按主题检索入库，然后用自然语言提问；系统自动规划工具调用、做证据检索、生成带 `[^n]` 角标的可溯源回答，并对回答做 groundedness 校验，必要时自动补充检索。

技术栈：

- 前端：Vue 3 + TypeScript + Vite + Pinia + Element Plus
- 后端：Express + MCP SDK，全量 TypeScript
- 存储：SQLite + `better-sqlite3` + `sqlite-vec`（向量检索）
- 模型：Qwen Chat / Embedding / gte-rerank

---

## 2. 五大亮点 STAR 卡片

每张卡片按 Situation / Task / Action / Result 四段组织，可直接当面试提纲。每个亮点结尾附「可追问」，便于被追到细节时调取具体代码。

### 卡片 1 / 5：LLM Stream Adapter（SSE 解码 + Output Gate）

**价值主张**：把 SSE 的三类不稳定因素（跨块 UTF-8 截断、模型 loop、网络半开连接）全部收在一层，下游业务只看到统一事件流。

- **Situation**：早期 SSE 解码散落在 `src/services/qwen.ts`，出现过三类线上问题：
  1. 跨 chunk 的 UTF-8 多字节字符被 `JSON.parse` 抛出 `Unexpected end of JSON input`
  2. 模型进入重复输出循环（同一句连续刷几十次），前端 token 计数飞涨
  3. 网络假死后浏览器侧一直转圈，需要手动刷新才能恢复
- **Task**：在前端建一个独立的流适配层，把解码、事件归一、异常拦截收在一起；下游业务不直接碰 `getReader()`。
- **Action**（`src/services/llmStreamAdapter.ts`）：
  - **分块 UTF-8**：基于 `ReadableStream` + `TextDecoder({ stream: true })` 增量解码，把跨块字符粘回去
  - **`parseSseFrame`**：按 SSE 规范解析（多行 `data:` 用 `\n` 拼接，`:` 开头为注释），返回 `event` + `data` + `id` 三元组
  - **`OutputGate` 三道闸**：
    - **`seq` 单调递增校验**：乱序 / 重放帧直接丢弃
    - **滑动窗口指纹**（FNV-1a 变体）：连续命中阈值判定模型 loop 并触发 abort
    - **`stallTimeoutMs`**：N 秒内无任何帧（含心跳）判定 `interrupted`，主动 abort reader
  - **`normalizeFrame`**：把后端事件归一成 `delta / plan / tool_call / tool_result / status / usage / error / done` 八个语义事件
- **Result**：
  - 在真实 SSE 样本（`bench/stream-timeline.json`，131 个 delta / 1006 字符）上解码零异常
  - 单测覆盖 `parseSseFrame` 边缘情况（多行 data / 注释行 / 心跳 / 不完整帧）
  - loop 检测通过注入重复片段的单元测试验证可触发

**可追问**：

- 为什么不用浏览器原生 `EventSource`？需要 POST body 传 messages，且要自定义中断语义，EventSource 不支持。
- `TextDecoder({ stream: true })` 比 `TextDecoder()` 多了什么？前者会缓存不完整的多字节序列等下一块，后者直接报错。
- `seq` 校验在端到端加密失败时怎么定位？`server/lib/sseWriter.ts` 在每帧写入前分配单调 seq，前后端各有一份序号生成器。

---

### 卡片 2 / 5：Agent Runtime（Planner / Executor / 取消树 / 重试）

**价值主张**：用户点「停止」时，正在飞的 3 个工具调用必须**立刻**全部中断，否则上游 token 白烧、连接泄漏。

- **Situation**：一轮回答里常常并发多个工具调用（多源检索 + 知识库检索 + Rerank）。取消机制缺位时，会出现：浏览器断连但服务端仍跑到结束；用户按停止但只打断了当前工具，下一个工具继续跑；超时只终止了最外层 fetch，工具内部递归调用没收尾。
- **Task**：设计一套树形取消机制，覆盖三种触发源（用户主动、超时、错误级联），且能精确取消指定 `runId`。
- **Action**（`server/agent/`）：
  - **`cancelTree.ts`**：`CancelNode` 树。每个节点持自己的 `AbortController`，父子索引用 `WeakMap`；父节点 cancel 时递归 cancel 所有子节点。`CancelReason` 枚举区分来源：`USER_ABORT / TIMEOUT / PARENT_CANCELLED / UPSTREAM_ERROR / LOOP_DETECTED`。
  - **`policy.ts`**：`runWithPolicy(opts, fn)` 提供 `timeout + 指数退避 + jitter` 组合；每次尝试挂在取消树的子节点上，超时触发 `CancelReason.TIMEOUT`；`onAttempt` 回调把重试事件透到 SSE，前端时间线能展示 `tool_retry`。
  - **`planner.ts`**：让模型产出结构化 `Plan`（步骤列表 + 每步要调的工具 + 终止条件）。除自然语言 `stopWhen` 外，还要求输出**机器可求值**的 `stopConditions`（`{afterStep, path, op, value}` 三元组），`normalizeStopConditions` 丢弃永不触发的条件。
  - **`executor.ts`**：逐步执行工具；命中终止条件时发 `plan_stopped_early` 事件并跳过剩余步骤；关键步骤失败终止计划，可选步骤失败继续。
  - **`runtime.ts`**：编排上述环节；维护 `activeRuns: Map<runId, CancelNode>`，支持 `/api/chat/abort` 按 `runId` 精确取消。
  - **HTTP 双路取消**（`server/index.ts`）：`res.on('close')` 触发根节点 abort（兜底，断网也收）；`/api/chat/abort` 按 `runId` 精确取消（用户主动操作）。
  - **前端**（`src/stores/chat.ts` 的 `stopStreaming`）：先显式调 abort 接口再断连接，让服务端能立刻回收工具调用而不是等 TCP 超时。
- **Result**：
  - `cancelTree.test.js`（23 例）+ `policy.test.js`（25 例）+ `executor.test.js` 覆盖取消传播、抖动退避、终止条件命中
  - 注入式测试：`runAgentTurn` 的所有外部依赖（`qwenFetch` / `callTool` / `runRag` / `generateAnswer`）从 `deps` 传入，测试里替换成可控 stub，可精确验证「停止时哪些工具被取消」
  - 真实 UI 上点停止后 ~50ms 内所有在途工具调用停止流式输出

**可追问**：

- 为什么不用 `Promise.race` 配 `AbortSignal.timeout`？单点超时不够 —— 需要的是**层级关系**，子节点超时应该让父节点也知道。
- `WeakMap` 做父子索引的好处？节点回收时无需手动 unmap，避免循环引用导致内存泄漏。
- 抖动怎么算？`baseDelayMs * 2^attempt * (1 + jitterRatio * (Math.random() * 2 - 1))`，`jitterRatio` 默认 0.3。

---

### 卡片 3 / 5：Agentic RAG（检索规划 + HyDE + Rerank + 证据溯源 + groundedness）

**价值主张**：检索不是「一次向量召回拼进 prompt」，而是一条**带反馈的闭环** —— 检索不够就自己再查一轮，回答没证据支撑就自动补充检索。

- **Situation**：传统 RAG 把「检索」当成一次性的事。问题：(a) 用户问题与文档表述不对齐时召回质量差；(b) 模型在没有证据时也会「自信地」编造回答；(c) 检索结果无法回溯到原文位置，引用指哪儿全凭模型心情。
- **Task**：把检索做成 8 步闭环，每一步都有结构化校验和降级策略。
- **Action**（`server/services/agenticRag.ts` + `server/services/answerGenerator.ts`）：
  1. **检索规划**：LLM 产出 `RetrievalPlan`（Zod 校验）—— 决定要不要检索、查几轮、每轮查什么
  2. **HyDE 改写**：生成假设性答案再用它做向量检索，缓解 query / doc 表述不对齐
  3. **向量召回**：`sqlite-vec` 的 `vec0` 虚拟表按 cosine distance 检索 top-K
  4. **精排**：DashScope `gte-rerank-v2` 重排；**上游失败时降级为向量顺序并打 `degraded` 标记**，不让整条链路挂掉
  5. **证据落库**：命中片段写入 `evidence` 表，带 `span_start/span_end` 原文区间 + 向量分 + 精排分
  6. **引用构建**：产出 `RagCitation`（含 `[^n]` 序号、`documentId`、`chunkId`、`span`），前端渲染可点击的来源卡片
  7. **groundedness 校验**：生成答案后校验每个论断是否有证据支撑（基于证据向量相似度 + 论断句向量化对比）
  8. **补充检索**：校验不通过时自动再检索一轮
  - **关键工程细节**：`chunkText` 做定长滑窗，但 `trim()` 会改变边界，所以要换算回原文真实区间：`spanStart = start + leading`（`knowledgeBase.test.ts` 用例验证），否则证据溯源会指错位置。
  - **关键工程决策**：向量生成放在事务外，避免长时间持有 SQLite 写锁（`server/services/knowledgeBase.ts`）。
- **Result**：
  - 答案带 `[^n]` 可点击引用，证据表 + 原文 + 向量分/精排分三件套可回放
  - `agenticRag.test.js`（多文件）覆盖各环节：HyDE 改写、向量召回、精排降级、证据构建、groundedness
  - 真实 RAG 流式链路在前端能完整看到 `status → plan → tool_call → tool_result → delta → citations → done`

**可追问**：

- 为什么选 `sqlite-vec` 而不是 `pgvector`？单机零运维、进程内调用无网络开销。代价是不支持多写并发、`vec0` 的 rowid 必须绑 `BigInt`。
- groundedness 校验的实现是启发式还是模型判断？启发式 + 模型判断混合：把每个论断向量化后与证据向量做相似度比对，相似度低的标记为「无证据支撑」，再触发补充检索。模型在二次生成时会被显式提示「不要扩展证据以外的内容」。
- 精排失败为什么降级而不是抛错？检索质量下降 ≠ 任务失败，向量顺序对部分 query 仍可用；标 `degraded` 让前端能展示「这条引用置信度低」。

---

### 卡片 4 / 5：分层 Context（Working / Short-Term / Long-Term + Token Budget）

**价值主张**：长会话不超 token 上限，超限时按 Long → Short 顺序降级，且压缩结果落库复用避免重复调用模型。

- **Situation**：早期用 `.slice(-12)` 粗暴截断最近 12 条消息。长会话时：(a) 早期重要信息直接丢失；(b) token 计数靠 `text.length / 4` 估算，实际超限时被模型侧 400 拒绝；(c) 每次重压缩都调模型，浪费 token 也增加延迟。
- **Task**：把 Context 分层、用真实计数、压缩结果持久化复用。
- **Action**（`server/services/contextManager.ts`）：
  - **三层**：
    - **Working**：当前轮的 system prompt + 用户问题 + 工具结果
    - **Short-Term**：最近 N 轮原文消息，按预算从新到旧选
    - **Long-Term**：更早历史的 LLM 压缩摘要 + 按当前问题从历史中检索式召回的片段
  - **`countTokens`**：用 `gpt-tokenizer` 真实计数（不是 `text.length / 4` 估算），按模型 `cl100k_base` 词表
  - **Token Budget**：按 `模型上限 × 安全系数`（默认 0.8）分配三层配额；超限时按 Long → Short 顺序降级（先压缩 Long，再丢 Short 早段）
  - **压缩落库**：压缩摘要写入 `messages.summary` 字段（或独立 `summaries` 表），同会话再次访问时直接复用
  - **顺序陷阱**：先按历史组装上下文，**再**落当前轮用户消息。反过来会让问题在上下文里出现两次。
- **Result**：
  - `contextManager.test.js` 覆盖三层配额分配、降级顺序、压缩复用、边界情况
  - 真实 50 轮长对话不超 32k token 限制，且早期信息通过 Long-Term 摘要仍能保留
  - `usage / budget` 通过 `status` 事件下发，前端能显示「已用 / 可用 token」

**可追问**：

- 为什么不用滑动窗口 + 摘要的两段式？因为漏掉了「按当前问题检索历史片段」的能力。两段式只按时间切，丢失了语义相关性。
- 压缩摘要用什么 prompt？「保留所有决策点、未解决的开放问题、用户偏好与硬约束；省略过渡性发言与重复确认」，强制 JSON 结构便于解析。
- `gpt-tokenizer` 跟模型实际 token 一致吗？词表是 `cl100k_base`，对 Qwen 系列是近似（Qwen 自有词表未公开），误差通常在 ±5% 以内，安全系数 0.8 兜底。

---

### 卡片 5 / 5：虚拟滚动 + rAF 渲染缓冲（带真实测量数据）

**价值主张**：用真实录制的 SSE 样本做基准，跑出 **77.4 → 27.2 次/s（-65%）**的实测降幅，把性能优化的「感觉变快了」变成可验证的数字。

- **Situation**：早期聊天界面在长会话 + 流式输出场景下明显卡顿，肉眼观察约每帧 3-5 个 patch。原因怀疑是逐字写回响应式状态 + Vue 重渲染叠加，但缺乏量化证据。
- **Task**：在不改业务语义的前提下，把渲染频率打下来，并拿出**真实测量数据**而不是估算。
- **Action**（`src/composables/`）：
  - **`useTypewriter.ts`**：把服务端攒批的 `delta`（一段若干字符）拆成逐字，按打字机间隔产出
  - **`useRenderBuffer.ts`**：流式 token 进 Buffer 队列，**不直接触发响应式更新**；`requestAnimationFrame` 里批量 flush（合并同帧所有 token）；帧预算超时则跳帧
  - **`useVirtualScroller`**：`ChatPanel.vue` 接入 `vue-virtual-scroller` 的 `DynamicScroller`，长消息列表只渲染可见区
  - **基准设施**（`bench/` + `src/utils/renderProfiler.ts` + `scripts/recordStreamTimeline.mjs`）：
    - 用脚本录制真实 SSE 流到 `bench/stream-timeline.json`（时间戳 + 字符）
    - 测试里回放该时间线，统计单位时间组件 patch 次数
- **Result**（`npm run bench:render` 跑出来的真实数据）：
  - 样本：131 个 delta / 1006 字符 / 12915ms
  - 上游到达率：10.1 次/s（平均 7.7 字符/delta）
  - **逐字直写：77.4 次/s**（峰值 91）
  - **Buffer + rAF：27.2 次/s**（峰值 31）
  - **刷新频率降幅 65%**，合并比 2.8 字符/次刷新
  - 终止语义：停止生成时 `flush()` 打字机和缓冲，避免丢最后一小段；报错时 `reset()` 丢弃未输出内容，因为错误信息要覆盖已渲染文本
- **注意**：计划里估算的「120 → 40」是早期未实测的乐观估计；当前接入 Element Plus 后的真实基线已经比那个假设更低（77 vs 120），但降幅 65% 的相对收益仍然成立。**禁止在简历/PPT 里沿用未实测的数字。**

**可追问**：

- 为什么不直接 `setTimeout(0)` 节流？`setTimeout` 跟屏幕刷新率不同步，可能在两次刷新之间挤进多次 patch；rAF 保证跟显示器刷新率对齐。
- 跳帧策略会不会丢字符？不会。Buffer 是 FIFO，跳帧只是推迟 flush，不会丢字符；最坏情况是某一帧字符多，下一帧一起输出。
- 打字机本身会不会抵消 rAF 的收益？打字机是**输出节奏**控制（每帧显示到第几个字符），不影响响应式更新频率，所以不抵消。

---

## 3. 工程化（基础信息，回答「项目怎么搭」用）

| 项   | 现状                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| 类型 | 前后端全量 TypeScript；服务端独立 `tsconfig.server.json`（noEmit 检查） + `tsconfig.server.build.json`（编译到 `.server-build`） |
| 单测 | Vitest，22 文件 / 361 用例（取消树 23 / 策略 25 / RAG 各环节 / Context 三层 / 知识库分块 / MCP 工具 / Stream Adapter 等）        |
| E2E  | Playwright，3 条用例（聊天流式渲染、知识库工作台、Agent 时间线）                                                                 |
| 规范 | ESLint + Prettier + Husky + lint-staged + commitlint（Conventional Commits）                                                     |
| CI   | GitHub Actions：lint → format:check → typecheck → test → build → e2e                                                             |
| 构建 | 前端 `vue-tsc -b && vite build`；后端 `tsc -p tsconfig.server.build.json` 后手动 `cp schema.sql`（tsc 不会拷贝非 TS 资源）       |

**安全加固**（都在 `server/index.ts`）：

- CORS 从 `cors()` 全开改为 `ALLOWED_ORIGINS` 白名单
- multer 从无限制改为 `fileSize` + `files` 双限额，配 `MulterError` 中间件返回 413 与中文提示
- `SERVER_HOST` 可配置，默认 `127.0.0.1` 而非 `0.0.0.0`

**两个值得讲的工程决策**：

1. **服务端为什么要单独编译？** 开发期用 `tsx` 直接跑 `.ts`，但生产镜像不该带 dev 依赖。所以加了 `build:server` 产出纯 JS。踩过的坑：`tsc` 不会拷贝 `.sql` 资源，需要在 build 脚本里显式 `cp schema.sql`。
2. **E2E 为什么本地和 CI 用不同浏览器？** Playwright 自带 chromium 在开发机网络下载不完（多次中断留下残缺目录）。所以 `playwright.config.ts` 里 `channel: process.env.CI ? undefined : 'chrome'` —— 本地复用系统 Chrome，CI 用 `npx playwright install --with-deps chromium`。E2E 的后端全部 `page.route` 打桩，不依赖真实 API Key。

---

## 4. 已知局限（如实说）

面试时主动讲局限比被问出来更好：

- **`server/mcp-server.ts` 仍有 1478 行**，工具注册和业务逻辑混在一个文件。已抽出的部分：知识库工具（`server/mcp/knowledgeTools.ts`） + 工具函数辅助（`server/mcp/toolkit.ts`）。文献、分析、写作等工具仍在入口文件内，因为按职责拆分的边际收益递减。
- **文献缓存仍是文件态**：`state.literature` 存在 `.data/knowledge-state.json`，未随文档/向量一起落 SQLite。
- **无鉴权**：所有 `/api/*` 接口无认证，当前定位是单机自用。
- **15 条 lint warning 未清**：主要是 `llmStreamAdapter` 里处理未知 payload 的 `any`，以及 Markdown 渲染的 `v-html`（已过 DOMPurify，但规则仍会告警）。

---

## 5. 高频追问速答

**Q：怎么保证回答不是编的？**
三层：prompt 里硬性要求「只使用工具结果中的事实」；证据带 `span` 原文区间可回溯；生成后跑 groundedness 校验，不通过则补充检索。

**Q：工具调用失败怎么办？**
`runWithPolicy` 做超时 + 指数退避重试；文献检索多源聚合，单源失败只记 `warnings` 不中断；全部源失败才抛 `LITERATURE_ALL_SOURCES_FAILED`。rerank 失败降级为向量顺序并标记 `degraded`。

**Q：为什么用 MCP 而不是直接函数调用？**
工具边界进程化隔离，工具崩溃不影响主服务；`stderr` 单独收集便于排障。代价是 stdio 序列化开销，以及父进程用 `tsx` 时子进程必须继承同样的 loader（`server/index.ts` 里 `loaderArgs` 就是处理这个）。

**Q：SQLite 单机瓶颈？**
承认。当前是单写者模型，向量检索在万级分块规模下够用。迁移路径是 PostgreSQL + pgvector，repositories 层已经把 SQL 隔离，替换面收敛在一层。

**Q：测试怎么覆盖流式和取消这种时序逻辑？**
注入式设计：`runAgentTurn` 的所有外部依赖（`qwenFetch` / `callTool` / `runRag` / `generateAnswer`）都从 `deps` 传入，测试里替换成可控 stub。取消树和重试策略各有独立测试文件（`cancelTree.test.js` 23 例、`policy.test.js` 25 例）。

**Q：`sqlite-vec` 的 rowid 为什么用 `BigInt`？**
`vec0` 虚拟表用 64 位 rowid，超过 `Number.MAX_SAFE_INTEGER` 的概率不为零（百万级分块累计）。统一用 BigInt 可以避免精度丢失；测试用 `0n` / `1n` 字面量避免误解。

**Q：怎么验证分块的 span 区间是准确的？**
`knowledgeBase.test.ts` 里有用例：构造一段已知文本，遍历每个 chunk 断言 `text.slice(spanStart, spanEnd) === chunk.text`。如果 trim 出问题，会直接 fail。

**Q：渲染性能的 65% 降幅是怎么测出来的？**
`bench/stream-timeline.json` 是真实录制的 SSE 流（131 个 delta / 1006 字符 / 12915ms）。`renderRate.bench.test.ts` 回放这个时间线，关闭/开启 rAF 缓冲各跑一遍，统计单位时间组件 patch 次数。

---

## 6. 演示动线建议

1. `npm run dev`，上传一篇 PDF，展示分块与向量入库
2. 提问，指着 Agent 时间线讲 plan → tool_call → tool_result → 生成
3. 中途点「停止」，讲取消树级联
4. 展开来源卡片，讲证据溯源与 `[^n]` 角标
5. 去知识库页跑一遍 检索 → Schema → Gap → Spec 四连
6. `npm run bench:render` 现场跑出那组 65% 的数据

---

## 7. 简历 / PPT 取数速查

写简历或做 PPT 时直接复制，避免数字漂移：

| 项         | 数字                                                       |
| ---------- | ---------------------------------------------------------- |
| 代码量     | server/ + src/ + e2e/ 合计约 1.3 万行（TS/Vue）            |
| 单测       | 22 文件 / 361 用例                                         |
| E2E        | 3 用例                                                     |
| SQLite 表  | 11 张（详见 `ARCHITECTURE.md` §9）                         |
| MCP 工具   | 14+（知识库 6 / 文献 4 / 分析 4+ / 写作 / 分类 / 公式 等） |
| 渲染优化   | 77.4 → 27.2 次/s（**-65%**），合并比 2.8 字符/次           |
| 向量召回   | `vec0` 虚拟表 + cosine                                     |
| 精排模型   | gte-rerank-v2                                              |
| Embedding  | text-embedding-v3（1024 维）                               |
| Token 计数 | gpt-tokenizer，词表 cl100k_base                            |
| 取消树     | CancelNode + AbortController + WeakMap 父子索引            |
| 重试策略   | 指数退避 + jitter 0.3                                      |
