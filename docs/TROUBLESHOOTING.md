# 常见问题排障

本文档记录 Research Agent 本地开发、联调和部署过程中常见问题及处理方式。

## 1. 前端页面能打开，但接口请求失败

### 现象

- 页面可以访问 `http://localhost:5173`。
- Network 中 `/api/*` 请求失败。
- 控制台可能出现 404、500、ECONNREFUSED 或代理错误。

### 可能原因

- 后端没有启动。
- `.env.local` 中 `SERVER_PORT` 与 `vite.config.ts` 代理端口不一致。
- 后端启动失败但前端仍在运行。

### 解决方案

1. 确认后端服务是否启动：

```bash
curl http://127.0.0.1:8788/api/health
```

2. 确认 `.env.local`：

```env
SERVER_PORT=8788
```

3. 重新启动：

```bash
npm run dev
```

## 2. `/api/health` 返回失败

### 现象

访问：

```text
/api/health
```

返回 `ok: false` 或包含错误信息。

### 可能原因

- MCP Server 启动失败。
- 数据库连接失败。
- `.env.local` 配置不正确。
- 依赖安装不完整。

### 解决方案

1. 重新安装依赖：

```bash
npm install
```

2. 检查 `.env.local` 是否存在。
3. 检查 `QWEN_API_KEY` 和 `DATABASE_URL` 是否正确。
4. 查看后端终端日志中的具体错误。

## 3. 聊天接口一直转圈或中断

### 现象

- 发送消息后没有回复。
- 回复到一半停止。
- Network 中 `/api/chat/stream` 长时间 pending。

### 可能原因

- `/api/chat/stream` 是 SSE 流式接口，pending 一段时间是正常现象。
- Qwen API Key 无效。
- 网络无法访问 DashScope。
- 上游模型服务限流。
- 代理或部署网关缓冲了 SSE 响应。

### 解决方案

1. 检查 `QWEN_API_KEY`。
2. 查看后端日志是否有：

```text
MISSING_API_KEY
INVALID_API_KEY
RATE_LIMITED
NETWORK_UNREACHABLE
```

3. 如果是部署环境，确认反向代理关闭 SSE 缓冲：

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 300s;
```

4. 降低请求频率后重试。

## 4. 报错 `MISSING_API_KEY`

### 原因

后端没有读取到 `QWEN_API_KEY`。

### 解决方案

在项目根目录 `.env.local` 中配置：

```env
QWEN_API_KEY=你的 Qwen API Key
```

然后重启后端：

```bash
npm run dev:server
```

## 5. 报错 `INVALID_API_KEY`

### 原因

Qwen API Key 无效、过期或没有权限。

### 解决方案

- 确认 API Key 没有复制错误。
- 确认 DashScope 账号和模型权限正常。
- 重新生成或轮换 API Key。
- 更新 `.env.local` 后重启服务。

## 6. 报错 `RATE_LIMITED` 或 429

### 可能来源

- Qwen 模型服务限流。
- Semantic Scholar 限流。
- arXiv / OpenAlex 请求过于频繁。

### 解决方案

- 降低请求频率。
- 减小文献检索的 `limit`。
- 使用单一数据源，如 `source=openalex`。
- 配置 `SEMANTIC_SCHOLAR_API_KEY`。
- 稍后重试。

## 7. 文献检索没有结果

### 可能原因

- 查询词过窄。
- 年份过滤过严格。
- 上游源暂时不可用。
- 网络访问外部数据源失败。

### 解决方案

- 放宽关键词。
- 去掉 `sinceYear` / `untilYear`。
- 尝试不同数据源：

```json
{
  "query": "remote sensing segmentation",
  "source": "openalex",
  "limit": 5
}
```

- 查看响应中的 `warnings` 字段。

## 8. 上传 PDF / DOCX 失败

### 可能原因

- 文件过大。
- 文件损坏或加密。
- 文档解析库处理失败。
- Qwen Embedding 调用失败。

### 解决方案

- 先用较小的 `.txt` 或 `.md` 文件测试上传流程。
- 确认 `QWEN_API_KEY` 可用。
- 如果是扫描版 PDF，可能无法提取文本，建议先 OCR。
- 查看后端日志中的解析错误。

## 9. 知识库内容丢失

### 可能原因

- 本地 `.data/knowledge-state.json` 被删除。
- Docker 容器没有挂载数据卷。
- 容器重建导致容器内 `.data` 丢失。

### 解决方案

本地开发：

- 检查 `.data/knowledge-state.json` 是否存在。

Docker 部署：

```bash
docker run -d --name research-agent \
  -p 8788:8788 \
  --env-file .env.production.local \
  -v research-agent-data:/app/.data \
  research-agent:latest
```

## 10. Paper Schema 抽取失败

### 常见错误

```text
PAPER_NOT_FOUND
```

### 原因

还没有通过 `search_literature` 检索并缓存对应论文，或传入的 `paperId` 不正确。

### 解决方案

1. 先调用文献检索接口。
2. 从返回结果中复制准确的 `paperId`。
3. 再调用 `POST /api/research/paper-schema/extract`。

## 11. 研究空白挖掘失败

### 常见错误

```text
GAP_DATA_INSUFFICIENT
```

### 原因

研究空白挖掘至少需要多个 Paper Schema 作为分析基础。

### 解决方案

1. 检索多篇论文。
2. 对至少 2 篇论文执行 Paper Schema 抽取。
3. 再调用：

```text
POST /api/research/gaps/mine
```

## 12. 实验方案生成失败

### 常见错误

```text
SPEC_DATA_INSUFFICIENT
SPEC_GAP_EMPTY
```

### 原因

- Paper Schema 数量不足。
- 当前语料无法挖掘出有效研究空白。

### 解决方案

- 增加论文数量。
- 调整 `focus`。
- 先调用 `mine_research_gaps` 确认有可用机会点。

## 13. 端口被占用

### 现象

后端启动失败，提示端口占用。

### 解决方案

方式一：释放占用 `8788` 的进程。

方式二：修改 `.env.local`：

```env
SERVER_PORT=8790
```

同时需要修改 `vite.config.ts` 中代理目标，否则前端仍会请求旧端口。

## 14. Docker 容器启动后访问失败

### 可能原因

- 端口没有正确映射。
- 容器内环境变量缺失。
- 镜像构建失败或构建产物缺失。

### 解决方案

1. 查看容器状态：

```bash
docker ps
```

2. 查看日志：

```bash
docker logs -f research-agent
```

3. 确认运行参数包含：

```bash
-p 8788:8788
-e SERVER_PORT=8788
-e QWEN_API_KEY=你的Key
```

## 15. 数据库健康检查失败

### 可能原因

- `DATABASE_URL` 格式错误。
- 数据库服务不可达。
- Neon 数据库处于休眠或连接被限制。
- SSL 参数缺失。

### 解决方案

使用类似格式：

```env
DATABASE_URL=postgresql://user:password@xxx.neon.tech/neondb?sslmode=require
```

如果暂时不需要数据库能力，可以先不配置 `DATABASE_URL`，项目核心聊天、文献检索和本地知识库仍可运行。

## 16. 修改环境变量后不生效

### 原因

Node.js 进程启动时读取环境变量，运行中修改 `.env.local` 不会自动生效。

### 解决方案

重启后端：

```bash
npm run dev:server
```

如果使用 `npm run dev`，建议整体停止后重新执行。

## 17. 排障优先级建议

遇到问题时建议按顺序检查：

1. `npm install` 是否成功。
2. `.env.local` 是否存在。
3. `SERVER_PORT` 是否为 `8788`。
4. `QWEN_API_KEY` 是否有效。
5. `/api/health` 是否正常。
6. 浏览器 Network 中失败接口的状态码和响应体。
7. 后端终端日志。
8. 是否存在上游限流或网络问题。
