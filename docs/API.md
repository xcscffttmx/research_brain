# API 接口文档

本文档说明 Research Agent 项目的前后端接口联调规范、请求格式、响应格式和错误格式。

## 基础信息

### 开发环境地址

- 前端开发服务：`http://localhost:5173`
- 后端 API 服务：`http://127.0.0.1:8788`
- API Base URL：`/api`

开发环境下，前端统一使用 `/api/*` 相对路径发起请求，Vite 会将 `/api` 请求代理到后端服务。

### 生产环境地址

生产构建后，Express 会托管 `dist` 静态资源，前端页面和后端接口同源访问。

示例：

- 页面：`http://127.0.0.1:8788/`
- 接口：`http://127.0.0.1:8788/api/health`

### 接口格式约定

项目当前主要使用三类接口格式：

| 类型 | Content-Type | 适用场景 |
|---|---|---|
| 普通 JSON 接口 | `application/json` | 查询、分析、删除、生成等普通业务接口 |
| 文件上传接口 | `multipart/form-data` | 知识库文件上传 |
| SSE 流式接口 | `text/event-stream` | 聊天流式输出 |

### 统一错误响应

普通 JSON 接口失败时，通常返回：

```json
{
  "error": "错误说明",
  "code": "ERROR_CODE",
  "details": "详细错误信息"
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `error` | string | 是 | 面向用户或前端展示的错误说明 |
| `code` | string | 否 | 业务错误码或上游错误码 |
| `details` | string | 否 | 详细错误信息，通常用于排障 |

SSE 流式接口失败时，会通过 `event: error` 返回，格式见 `POST /api/chat/stream`。

---

## 健康检查

## GET /api/health

### 说明

检查后端服务、MCP 工具链和数据库连接状态。

### 请求格式

无需请求体。

### 响应示例

```json
{
  "ok": true,
  "documents": 3,
  "mcp": true,
  "database": {
    "enabled": true,
    "ok": true
  },
  "envDebug": {
    "cwd": "D:/Projects/agentchat/reserach_agent",
    "hasDatabaseUrl": true,
    "databaseUrlPrefix": "postgresql://user:pass"
  }
}
```

### 错误响应示例

```json
{
  "ok": false,
  "error": "MCP 健康检查失败",
  "code": "UNKNOWN_ERROR",
  "details": "具体错误信息"
}
```

---

## 聊天接口

## POST /api/chat/stream

### 说明

流式对话接口。后端会根据用户消息调用 Qwen 模型和 MCP 工具，并通过 SSE 返回工具调用状态、引用信息和模型 token。

该接口不是普通 JSON 响应，而是 `text/event-stream` 流式响应。

### 请求头

```http
Content-Type: application/json
```

### 请求参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `messages` | QwenMessage[] | 是 | 对话上下文消息列表 |

### QwenMessage 结构

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `role` | string | 是 | 消息角色，可选：`system`、`user`、`assistant`、`tool` |
| `content` | string | 是 | 消息内容 |

### 请求示例

```json
{
  "messages": [
    {
      "role": "user",
      "content": "帮我检索 2026 年遥感图像分割相关论文"
    }
  ]
}
```

### 响应头

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
```

### SSE 事件类型

#### token

模型输出的文本片段。

```text
event: token
data: {"token":"你好"}
```

字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `token` | string | 模型流式输出片段 |

#### tool

工具调用状态事件。工具开始、成功或失败时都会返回该事件。

```text
event: tool
data: {"id":"call_xxx","name":"search_literature","args":{"query":"remote sensing segmentation"},"status":"running"}
```

成功示例：

```text
event: tool
data: {"id":"call_xxx","name":"search_literature","args":{"query":"remote sensing segmentation"},"status":"success","result":{}}
```

字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 工具调用 ID |
| `name` | string | 工具名称 |
| `args` | object | 工具调用参数 |
| `status` | string | 工具状态：`running`、`success`、`error` |
| `result` | object | 工具返回结果，成功或失败后可能存在 |

#### citations

工具返回的引用信息。

```text
event: citations
data: {"citations":[{"id":"doc_1","title":"Paper Title","snippet":"引用片段","source":"knowledge","score":0.86}]}
```

Citation 结构：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 引用 ID |
| `title` | string | 引用标题 |
| `snippet` | string | 引用片段 |
| `source` | string | 引用来源 |
| `score` | number | 相似度或相关性分数，可选 |

#### error

流式接口错误事件。

```text
event: error
data: {"message":"服务异常","code":"UNKNOWN_ERROR","details":"具体错误信息"}
```

字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `message` | string | 错误说明 |
| `code` | string | 错误码 |
| `details` | string | 详细错误信息 |

#### done

流式输出结束事件。

```text
event: done
data: {"citations":[],"tools":[]}
```

字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `citations` | Citation[] | 本轮对话收集到的引用 |
| `tools` | ToolInvocation[] | 本轮对话调用过的工具列表 |

---

## 知识库接口

## GET /api/knowledge

### 说明

获取知识库文档列表。

### 请求格式

无需请求体。

### 响应示例

```json
{
  "documents": [
    {
      "id": "doc_1",
      "name": "paper.pdf",
      "createdAt": 1710000000000
    }
  ]
}
```

### ServerDocumentResponse 结构

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 文档 ID |
| `name` | string | 文档名称 |
| `createdAt` | number | 创建时间戳，单位通常为毫秒 |

---

## GET /api/knowledge/content/:id

### 说明

获取指定知识库文档的文本内容。

### 路径参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 文档 ID |

### 响应示例

```json
{
  "id": "doc_1",
  "name": "paper.pdf",
  "content": "文档解析后的文本内容",
  "createdAt": 1710000000000
}
```

---

## POST /api/knowledge/upload

### 说明

上传知识库文档。后端会读取上传文件，并交给 MCP 工具导入知识库。

支持文本文件和二进制文档。当前后端会对 `.pdf`、`.docx` 文件使用 Base64 方式传入工具，其余文件按 UTF-8 文本处理。

### 请求格式

```http
Content-Type: multipart/form-data
```

### FormData 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `files` | File[] | 是 | 上传文件列表，支持多个同名字段 |

### 请求示例

```text
files: paper1.pdf
files: paper2.docx
```

### 响应示例

```json
{
  "documents": [
    {
      "id": "doc_1",
      "name": "paper1.pdf",
      "createdAt": 1710000000000
    }
  ],
  "message": "上传成功"
}
```

---

## DELETE /api/knowledge/:id

### 说明

删除指定知识库文档。

### 路径参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 文档 ID |

### 响应示例

```json
{
  "ok": true
}
```

---

## DELETE /api/knowledge

### 说明

清空知识库文档。

### 请求格式

无需请求体。

### 响应示例

```json
{
  "ok": true
}
```

---

## 科研检索与分析接口

## POST /api/research/search-literature

### 说明

检索论文文献。支持从 arXiv、Semantic Scholar、OpenAlex 等来源检索，并返回统一论文结构。

### 请求头

```http
Content-Type: application/json
```

### 请求参数

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `query` | string | 是 | - | 检索关键词，不能为空 |
| `source` | string | 否 | `all` | 检索来源：`all`、`arxiv`、`semantic_scholar`、`openalex` |
| `limit` | number | 否 | `6` | 返回数量 |
| `sinceYear` | number | 否 | - | 起始年份 |
| `untilYear` | number | 否 | - | 截止年份 |

### 请求示例

```json
{
  "query": "remote sensing image segmentation",
  "source": "all",
  "limit": 5,
  "sinceYear": 2024,
  "untilYear": 2026
}
```

### 响应示例

```json
{
  "query": "remote sensing image segmentation",
  "sinceYear": 2024,
  "untilYear": 2026,
  "currentYear": 2026,
  "results": [
    {
      "source": "arxiv",
      "paperId": "arxiv:2401.00001",
      "title": "Paper Title",
      "abstract": "Paper abstract...",
      "authors": ["Author A", "Author B"],
      "year": 2024,
      "venue": "arXiv",
      "url": "https://arxiv.org/abs/2401.00001",
      "pdfUrl": "https://arxiv.org/pdf/2401.00001",
      "citationCount": null,
      "referenceCount": null
    }
  ],
  "count": 1,
  "warnings": []
}
```

### LiteraturePaper 结构

| 字段 | 类型 | 说明 |
|---|---|---|
| `source` | string | 文献来源 |
| `paperId` | string | 论文 ID |
| `title` | string | 论文标题 |
| `abstract` | string | 摘要 |
| `authors` | string[] | 作者列表 |
| `year` | number \| null | 发表年份 |
| `venue` | string | 会议、期刊或平台 |
| `url` | string | 论文页面链接 |
| `pdfUrl` | string | PDF 链接 |
| `citationCount` | number \| null | 引用数 |
| `referenceCount` | number \| null | 参考文献数 |

### 错误响应示例

```json
{
  "error": "query 不能为空",
  "code": "INVALID_QUERY",
  "details": ""
}
```

---

## POST /api/research/ingest-literature

### 说明

将已检索到的论文导入知识库。

### 请求头

```http
Content-Type: application/json
```

### 请求参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `paperIds` | string[] | 是 | 需要入库的论文 ID 列表 |

### 请求示例

```json
{
  "paperIds": ["arxiv:2401.00001", "semantic_scholar:xxx"]
}
```

### 响应示例

```json
{
  "documents": [
    {
      "id": "doc_1",
      "name": "Paper Title",
      "createdAt": 1710000000000
    }
  ],
  "message": "文献入库成功"
}
```

---

## POST /api/research/paper-schema/extract

### 说明

从指定论文中抽取结构化 Paper Schema。

### 请求头

```http
Content-Type: application/json
```

### 请求参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `paperId` | string | 是 | 论文 ID，不能为空 |

### 请求示例

```json
{
  "paperId": "arxiv:2401.00001"
}
```

### 响应示例

```json
{
  "paperId": "arxiv:2401.00001",
  "schema": {
    "title": "Paper Title",
    "problem": "研究问题",
    "method": "方法概述",
    "architecture": "模型结构",
    "dataset": ["Dataset A"],
    "metrics": ["mIoU", "F1"],
    "conclusion": "结论",
    "limitations": ["局限性"]
  }
}
```

### PaperSchema 结构

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 论文标题 |
| `problem` | string | 研究问题 |
| `method` | string | 方法概述 |
| `architecture` | string | 模型结构或系统架构 |
| `dataset` | string[] | 使用的数据集 |
| `metrics` | string[] | 评价指标 |
| `conclusion` | string | 论文结论 |
| `limitations` | string[] | 局限性 |

### 错误响应示例

```json
{
  "error": "paperId 不能为空",
  "code": "INVALID_PAPER_ID",
  "details": ""
}
```

---

## POST /api/research/gaps/mine

### 说明

基于知识库和论文记忆挖掘研究空白与潜在创新点。

### 请求头

```http
Content-Type: application/json
```

### 请求参数

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `focus` | string | 否 | 空字符串 | 关注方向或研究主题 |

### 请求示例

```json
{
  "focus": "remote sensing image segmentation"
}
```

### 响应示例

```json
{
  "focus": "remote sensing image segmentation",
  "opportunities": [
    {
      "opportunity": "研究机会描述",
      "rationale": "为什么这是机会",
      "supportingPaperIds": ["arxiv:2401.00001"],
      "confidence": 0.82
    }
  ],
  "count": 1
}
```

### ResearchGapOpportunity 结构

| 字段 | 类型 | 说明 |
|---|---|---|
| `opportunity` | string | 研究机会或创新点 |
| `rationale` | string | 推理依据 |
| `supportingPaperIds` | string[] | 支撑该机会的论文 ID |
| `confidence` | number | 置信度，通常为 0 到 1 |

---

## POST /api/research/spec/generate

### 说明

基于研究主题和研究空白生成实验方案。

### 请求头

```http
Content-Type: application/json
```

### 请求参数

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `focus` | string | 否 | 空字符串 | 关注方向或研究主题 |
| `gapIndex` | number | 否 | `0` | 选择第几个研究空白生成实验方案 |

### 请求示例

```json
{
  "focus": "remote sensing image segmentation",
  "gapIndex": 0
}
```

### 响应示例

```json
{
  "selectedGap": {
    "opportunity": "研究机会描述",
    "rationale": "为什么这是机会",
    "supportingPaperIds": ["arxiv:2401.00001"],
    "confidence": 0.82
  },
  "experimentSpec": {
    "baseline": "Baseline model",
    "proposed_change": "Proposed improvement",
    "dataset": "Dataset A",
    "metrics": ["mIoU", "F1"],
    "training_plan": {
      "epochs": 100,
      "optimizer": "AdamW",
      "learning_rate": "1e-4",
      "batch_size": 8,
      "notes": "训练说明"
    },
    "ablation_plan": ["移除模块 A", "替换损失函数"],
    "evidenceRefs": [
      {
        "paperId": "arxiv:2401.00001",
        "title": "Paper Title",
        "reason": "作为实验设计依据"
      }
    ]
  }
}
```

### ExperimentSpec 结构

| 字段 | 类型 | 说明 |
|---|---|---|
| `baseline` | string | 基线方法 |
| `proposed_change` | string | 拟改进方案 |
| `dataset` | string | 实验数据集 |
| `metrics` | string[] | 评价指标 |
| `training_plan` | object | 训练计划 |
| `ablation_plan` | string[] | 消融实验计划 |
| `evidenceRefs` | object[] | 实验依据引用 |

---

## 前后端联调说明

### 开发环境联调

1. 确认 `.env.local` 中配置后端端口：

```env
SERVER_PORT=8788
```

2. 启动前后端：

```bash
npm run dev
```

3. 前端通过相对路径访问接口：

```text
/api/knowledge
/api/chat/stream
/api/research/search-literature
```

4. Vite 会将 `/api` 请求代理到：

```text
http://127.0.0.1:8788
```

### 生产环境联调

1. 构建前端：

```bash
npm run build
```

2. 启动后端：

```bash
npm run dev:server
```

3. 访问：

```text
http://127.0.0.1:8788/
```

此时前端页面和接口同源，不需要额外代理。

---

## 备注

- 当前接口暂未设计登录鉴权，调用方无需携带业务 token。
- 后端已启用 CORS，但开发环境推荐通过 Vite 代理访问 `/api/*`。
- `POST /api/chat/stream` 是 SSE 流式接口，前端需要按事件流解析，不能按普通 JSON 处理。
- 普通接口错误字段为 `error`，SSE 错误事件字段为 `message`。
