# 部署说明

本文档说明 Research Agent 的本地生产构建、Docker 部署和生产环境配置建议。

## 部署模式

项目支持两种主要部署方式：

1. Node.js 直接部署。
2. Docker 容器化部署。

生产环境推荐使用 Docker，便于固定运行环境和迁移。

## 生产构建流程

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

生产环境至少需要：

```env
QWEN_API_KEY=你的 Qwen API Key
SERVER_PORT=8788
```

更多变量见 `docs/ENV.md`。

### 3. 构建前端

```bash
npm run build
```

构建产物会输出到：

```text
dist/
```

### 4. 启动后端

```bash
npm run dev:server
```

当前脚本名为 `dev:server`，实际执行的是：

```bash
node ./server/index.js
```

Express 启动后会：

- 提供 `/api/*` 接口。
- 托管 `dist/` 静态资源。
- 将未知路由回退到 `dist/index.html`。

访问地址：

```text
http://127.0.0.1:8788/
```

## Docker 部署

### 1. 构建镜像

```bash
docker build -t research-agent:latest .
```

### 2. 运行容器

```bash
docker run -d --name research-agent \
  -p 8788:8788 \
  -e QWEN_API_KEY=你的Key \
  -e QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \
  -e QWEN_MODEL=qwen-plus \
  -e QWEN_EMBEDDING_MODEL=text-embedding-v3 \
  -e SERVER_PORT=8788 \
  research-agent:latest
```

Windows PowerShell 可写为：

```powershell
docker run -d --name research-agent `
  -p 8788:8788 `
  -e QWEN_API_KEY=你的Key `
  -e QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 `
  -e QWEN_MODEL=qwen-plus `
  -e QWEN_EMBEDDING_MODEL=text-embedding-v3 `
  -e SERVER_PORT=8788 `
  research-agent:latest
```

### 3. 验证服务

```bash
curl http://127.0.0.1:8788/api/health
```

返回 `ok: true` 表示服务基础功能正常。

## 使用环境变量文件运行 Docker

可以创建仅供本地使用的 `.env.production.local`：

```env
QWEN_API_KEY=你的Key
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-plus
QWEN_EMBEDDING_MODEL=text-embedding-v3
SERVER_PORT=8788
DATABASE_URL=
SEMANTIC_SCHOLAR_API_KEY=
```

运行：

```bash
docker run -d --name research-agent \
  -p 8788:8788 \
  --env-file .env.production.local \
  research-agent:latest
```

注意：不要将包含真实密钥的 `.env.production.local` 提交到仓库。

## 持久化数据

当前知识库状态默认保存在容器内：

```text
.data/knowledge-state.json
```

如果希望容器重建后保留知识库状态，需要挂载卷。

示例：

```bash
docker run -d --name research-agent \
  -p 8788:8788 \
  --env-file .env.production.local \
  -v research-agent-data:/app/.data \
  research-agent:latest
```

如果不挂载卷，容器删除后 `.data` 中的运行时状态也会丢失。

## 反向代理建议

如果部署到服务器，建议在 Nginx、Caddy 或云平台网关后面运行。

需要注意：

- `/api/chat/stream` 是 SSE 流式接口，反向代理不要强制缓冲响应。
- 保持连接超时时间应适当调大。
- 生产环境建议启用 HTTPS。

Nginx 关键建议：

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 300s;
proxy_send_timeout 300s;
```

## 健康检查

健康检查接口：

```text
GET /api/health
```

可用于：

- 容器健康检查。
- 部署后验证。
- 监控告警。

示例：

```bash
curl http://127.0.0.1:8788/api/health
```

## 生产环境安全建议

当前项目默认没有业务登录鉴权，生产对外开放前建议补充：

- 用户登录和接口鉴权。
- API 限流。
- 上传文件大小和类型限制。
- 日志脱敏。
- 错误信息脱敏。
- CORS 白名单。
- HTTPS。

尤其注意不要暴露：

- `QWEN_API_KEY`
- `DATABASE_URL`
- 对象存储 Secret

## 生产环境稳定性建议

建议逐步补充：

- 文献检索结果缓存。
- 上游接口超时和重试策略。
- 结构化日志。
- 错误告警。
- 数据备份策略。
- PostgreSQL + pgvector 持久化向量数据。

## 常用运维命令

查看容器：

```bash
docker ps
```

查看日志：

```bash
docker logs -f research-agent
```

停止容器：

```bash
docker stop research-agent
```

删除容器：

```bash
docker rm research-agent
```

重新部署：

```bash
docker stop research-agent
docker rm research-agent
docker build -t research-agent:latest .
docker run -d --name research-agent -p 8788:8788 --env-file .env.production.local research-agent:latest
```
