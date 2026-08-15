# 环境变量说明

本文档说明 Research Agent 使用的环境变量、默认值和配置建议。

## 配置文件加载顺序

项目后端会读取 `.env.local` 和默认环境变量。

建议本地开发时在项目根目录创建：

```text
.env.local
```

不要将 `.env.local` 提交到代码仓库。

## 最小可用配置

本地启动至少建议配置：

```env
QWEN_API_KEY=你的 Qwen API Key
SERVER_PORT=8788
```

如果需要数据库健康检查或后续持久化能力，再配置：

```env
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
```

## 变量总览

| 变量名 | 必填 | 默认值 | 是否敏感 | 说明 |
|---|---|---|---|---|
| `QWEN_API_KEY` | 是 | - | 是 | Qwen / DashScope API Key |
| `QWEN_BASE_URL` | 否 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 否 | Qwen 兼容 OpenAI API 地址 |
| `QWEN_MODEL` | 否 | `qwen-plus` | 否 | 聊天模型名称 |
| `QWEN_EMBEDDING_MODEL` | 否 | `text-embedding-v3` | 否 | 向量模型名称 |
| `SERVER_PORT` | 建议 | `8788` | 否 | 后端监听端口，需与 Vite 代理一致 |
| `SEMANTIC_SCHOLAR_API_KEY` | 否 | - | 是 | Semantic Scholar API Key，配置后可提升额度 |
| `DATABASE_URL` | 建议 | - | 是 | PostgreSQL / Neon 连接串 |
| `OBJECT_STORAGE_PROVIDER` | 否 | `s3` | 否 | 对象存储类型，预留 S3 兼容配置 |
| `OBJECT_STORAGE_ENDPOINT` | 否 | - | 否 | 对象存储 Endpoint |
| `OBJECT_STORAGE_REGION` | 否 | `auto` | 否 | 对象存储区域 |
| `OBJECT_STORAGE_ACCESS_KEY` | 否 | - | 是 | 对象存储 Access Key |
| `OBJECT_STORAGE_SECRET_KEY` | 否 | - | 是 | 对象存储 Secret Key |
| `OBJECT_STORAGE_BUCKET` | 否 | `research-docs` | 否 | 对象存储 Bucket 名称 |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | 否 | `true` | 否 | 是否启用 S3 path-style 访问 |

## Qwen 相关变量

### QWEN_API_KEY

必填。用于调用 Qwen Chat 和 Embedding 接口。

示例：

```env
QWEN_API_KEY=sk-xxxxxxxx
```

如果缺失，后端在调用模型或向量化时会返回：

```text
MISSING_API_KEY
```

### QWEN_BASE_URL

可选。默认值：

```env
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

如果使用其他兼容 OpenAI Chat Completions / Embeddings 的服务，可改为对应地址。

### QWEN_MODEL

可选。默认值：

```env
QWEN_MODEL=qwen-plus
```

用于 `/api/chat/stream` 对话接口。

### QWEN_EMBEDDING_MODEL

可选。默认值：

```env
QWEN_EMBEDDING_MODEL=text-embedding-v3
```

用于知识库文档向量化。

## 后端服务变量

### SERVER_PORT

建议配置为：

```env
SERVER_PORT=8788
```

注意：`vite.config.ts` 中开发代理当前指向：

```text
http://127.0.0.1:8788
```

因此开发环境下应保持 `SERVER_PORT=8788`，否则前端请求会代理到错误端口。

## 文献检索变量

### SEMANTIC_SCHOLAR_API_KEY

可选。Semantic Scholar 在未配置 API Key 时可能更容易遇到限流。

建议生产或重度使用时配置：

```env
SEMANTIC_SCHOLAR_API_KEY=你的 Semantic Scholar API Key
```

如果未配置，项目仍可通过 arXiv 和 OpenAlex 提供部分文献检索能力。

## 数据库变量

### DATABASE_URL

建议配置。用于 PostgreSQL / Neon 连接。

示例：

```env
DATABASE_URL=postgresql://user:password@xxx.neon.tech/neondb?sslmode=require
```

当前代码中主要用于 `/api/health` 的数据库健康检查。后续可扩展为知识库、会话和向量数据持久化。

安全建议：

- 不要将 `DATABASE_URL` 写入 README、Issue、聊天记录或公开仓库。
- 如果连接串泄漏，应立即在数据库控制台轮换密码。
- 生产环境建议使用最小权限账号。

## 对象存储变量

对象存储相关变量当前属于预留配置，适合后续将上传文件原文保存到 S3 兼容服务。

示例：

```env
OBJECT_STORAGE_PROVIDER=s3
OBJECT_STORAGE_ENDPOINT=https://example.r2.cloudflarestorage.com
OBJECT_STORAGE_REGION=auto
OBJECT_STORAGE_ACCESS_KEY=xxxxxxxx
OBJECT_STORAGE_SECRET_KEY=xxxxxxxx
OBJECT_STORAGE_BUCKET=research-docs
OBJECT_STORAGE_FORCE_PATH_STYLE=true
```

## 本地开发示例

```env
QWEN_API_KEY=sk-xxxxxxxx
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-plus
QWEN_EMBEDDING_MODEL=text-embedding-v3
SERVER_PORT=8788
SEMANTIC_SCHOLAR_API_KEY=
DATABASE_URL=
```

## 生产环境建议

生产环境建议至少配置：

```env
QWEN_API_KEY=sk-xxxxxxxx
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-plus
QWEN_EMBEDDING_MODEL=text-embedding-v3
SERVER_PORT=8788
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
```

并通过平台的 Secret / Environment 管理能力注入，不要写死在镜像或代码中。
