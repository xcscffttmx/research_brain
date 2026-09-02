# research-agent

> 多 Agent 科研小助手（Vue 3 + MCP + Qwen）

`research-agent` 是一个面向科研场景的多 Agent 协作系统，提供：

- 实时文献检索（arXiv / Semantic Scholar / OpenAlex）
- 论文结构化抽取（Paper Schema）
- 研究空白挖掘与实验方案生成
- 本地知识库导入、向量检索、对话增强

适用于科研选题调研、文献综述准备、实验方案设计、论文草稿辅助等场景。

---

## 目录

- [核心能力](#核心能力)
- [系统架构](#系统架构)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [常用 API](#常用-api)
- [文献检索说明](#文献检索说明)
- [Docker 部署（推荐）](#docker-部署推荐)
- [生产环境建议](#生产环境建议)
- [排障指南](#排障指南)
- [开发脚本](#开发脚本)
- [Roadmap](#roadmap)

---

## 核心能力

### 1) 多 Agent 协作

- **文献检索 Agent**：检索、分析、摘要、入库
- **论文写作 Agent**：大纲、写作、语法检查、引用格式
- **公式推导 Agent**：推导、验证、解释、应用

### 2) 实时文献检索

支持在线来源：

- `arxiv`
- `semantic_scholar`
- `openalex`

并支持：

- `sinceYear` / `untilYear` 年份过滤
- 多源聚合与排序（按引用数优先）
- 部分源失败时尽量返回可用结果（减少全量失败）

### 3) RAG 知识库

- 文件上传：`.md` `.txt` `.json` `.pdf` `.docx`
- 服务端分块与向量化
- 对话中调用知识检索工具进行增强回答

### 4) 科研分析链路

- `extract_paper_schema`：论文结构化抽取
- `query_paper_memory`：跨论文聚合分析
- `mine_research_gaps`：研究空白挖掘
- `generate_experiment_spec`：实验方案生成

---

## 系统架构

```text
Vue3 前端 (SSE)
   |
   v
Express API (server/index.js)
   |
   v
MCP Client <-> MCP Server (server/mcp-server.js)
   |
   +--> Qwen Chat / Embedding
   +--> arXiv / Semantic Scholar / OpenAlex
   +--> 本地知识库状态(.data/knowledge-state.json)
```

说明：

- 前端通过 `/api/chat/stream` 进行流式会话。
- 后端基于 MCP 工具编排模型能力和检索工具。
- 文献检索与知识库检索可组合用于回答生成。

---

## 项目结构

```text
.
├── server/
│   ├── index.js               # Express API + SSE + MCP 客户端编排
│   └── mcp-server.js          # MCP 工具定义与科研逻辑
├── src/
│   ├── components/            # UI 组件
│   ├── services/              # 前端 API 服务层
│   ├── stores/                # Pinia 状态
│   ├── types/                 # 类型定义
│   ├── App.vue
│   ├── main.ts
│   └── styles.css
├── .data/                     # 运行时知识库状态（本地持久化）
├── Dockerfile
├── .dockerignore
├── package.json
└── README.md
```

---

## 快速开始

### 1) 安装依赖

```bash
npm install
```

### 2) 配置环境变量

复制：

```bash
cp .env.example .env.local
```

并填写关键变量（见下方“环境变量”章节）。

### 3) 启动开发环境

```bash
npm run dev
```

默认地址：

- 前端：`http://localhost:5173`
- 后端：`http://127.0.0.1:8788`

### 4) 构建生产产物

```bash
npm run build
```

---

## 环境变量

| 变量名                            | 必填 | 说明                      | 默认值                                              |
| --------------------------------- | ---- | ------------------------- | --------------------------------------------------- |
| `QWEN_API_KEY`                    | 是   | Qwen API Key              | -                                                   |
| `QWEN_BASE_URL`                   | 否   | Qwen 兼容接口地址         | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `QWEN_MODEL`                      | 否   | 对话模型                  | `qwen-plus`                                         |
| `QWEN_EMBEDDING_MODEL`            | 否   | 向量模型                  | `text-embedding-v3`                                 |
| `SERVER_PORT`                     | 否   | 服务端口                  | `8788`                                              |
| `SEMANTIC_SCHOLAR_API_KEY`        | 否   | S2 API Key（建议配置）    | -                                                   |
| `DATABASE_URL`                    | 建议 | PostgreSQL 连接串（Neon） | -                                                   |
| `OBJECT_STORAGE_PROVIDER`         | 否   | 对象存储提供商（S3兼容）  | `s3`                                                |
| `OBJECT_STORAGE_ENDPOINT`         | 否   | 对象存储 Endpoint         | -                                                   |
| `OBJECT_STORAGE_REGION`           | 否   | 对象存储区域              | `auto`                                              |
| `OBJECT_STORAGE_ACCESS_KEY`       | 否   | 对象存储 Access Key       | -                                                   |
| `OBJECT_STORAGE_SECRET_KEY`       | 否   | 对象存储 Secret Key       | -                                                   |
| `OBJECT_STORAGE_BUCKET`           | 否   | 对象存储 Bucket 名称      | `research-docs`                                     |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | 否   | S3 Path Style             | `true`                                              |

---

Neon 连接串示例：

```bash
DATABASE_URL=postgresql://user:password@xxx.neon.tech/neondb?sslmode=require
```

安全建议：如果你曾在聊天或公开仓库里暴露连接串，请在 Neon 控制台立即 Rotate Password。

## 常用 API

### 健康检查

- `GET /api/health`

### 聊天流式

- `POST /api/chat/stream`

### 知识库

- `GET /api/knowledge`
- `POST /api/knowledge/upload`
- `DELETE /api/knowledge/:id`
- `DELETE /api/knowledge`

### 科研检索与分析

- `POST /api/research/search-literature`
- `POST /api/research/ingest-literature`
- `POST /api/research/paper-schema/extract`
- `POST /api/research/gaps/mine`
- `POST /api/research/spec/generate`

---

## 文献检索说明

### 请求示例

```json
{
  "query": "remote sensing segmentation 2026",
  "source": "all",
  "limit": 5,
  "sinceYear": 2026,
  "untilYear": 2026
}
```

### 参数说明

- `source`：`all | arxiv | semantic_scholar | openalex`
- `limit`：返回数量（建议 3~10）
- `sinceYear / untilYear`：年份范围过滤

### 响应特性

- 返回统一结构的论文列表
- 多源聚合后排序
- 部分源失败时会尽量返回可用结果

---

## Docker 部署（推荐）

### 1) 构建镜像

```bash
docker build -t research-agent:latest .
```

### 2) 运行容器

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

### 3) 验证服务

```bash
curl http://127.0.0.1:8788/api/health
```

---

## 生产环境建议

- 为上游检索接口设置超时、重试、退避
- 对文献请求做短期缓存（query + 年份范围）
- 开启接口限流，避免触发上游 429
- 记录结构化日志（请求 ID、耗时、错误码）
- 增加可观测性（健康检查 + 错误告警）

---

## 排障指南

### 1) 返回 429（Too Many Requests）

原因：上游平台限流（arXiv / S2 / OpenAlex）。

建议：

- 降低并发与请求频率
- 优先单源检索（如 `openalex`）
- 配置 `SEMANTIC_SCHOLAR_API_KEY`
- 增加重试与缓存

### 2) 检索卡顿

- 检查是否存在上游超时
- 适当减小 `limit`
- 优先使用 `source=openalex`

### 3) 时间判断异常

- 确认后端已重启并加载最新代码
- 新开会话避免旧上下文干扰

### 4) 端口占用

- 默认端口 `8788` 被占用时，修改 `SERVER_PORT` 或释放占用进程

---

## 开发脚本

```bash
npm run dev          # 前后端并行开发
npm run dev:client   # 仅前端
npm run dev:server   # 仅后端
npm run build        # 生产构建
npm run preview      # 构建产物预览
```

---

## Roadmap

- [ ] 接入持久化向量数据库（PostgreSQL + pgvector）
- [ ] 检索结果缓存与更细粒度重试策略
- [ ] 更完善的权限系统与多用户支持
- [ ] 自动化测试与 CI/CD
- [ ] 更多数据源与领域化检索策略

---

如果你在部署或调优过程中遇到问题，建议先检查：

1. `QWEN_API_KEY` 是否可用
2. `/api/health` 是否返回 `ok: true`
3. 外网连通性与上游接口状态
