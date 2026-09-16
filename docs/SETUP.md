# 本地开发环境搭建

本文档说明如何在本地启动 Research Agent 项目，并完成前后端联调。

## 环境要求

建议使用以下环境：

| 工具    | 建议版本        | 说明                              |
| ------- | --------------- | --------------------------------- |
| Node.js | 18+，推荐 20+   | 项目使用原生 `fetch`、ESM 和 Vite |
| npm     | 随 Node.js 安装 | 用于安装依赖和运行脚本            |
| Git     | 最新稳定版      | 拉取代码和版本管理                |
| Docker  | 可选            | 用于容器化部署验证                |

Windows 环境建议使用 PowerShell、Windows Terminal 或 Cursor 内置终端。

## 获取代码

```bash
git clone <repository-url>
cd reserach_agent
```

如果已经在 Cursor 中打开项目，可直接在项目根目录继续后续步骤。

## 安装依赖

```bash
npm install
```

安装完成后，项目会生成 `node_modules/`。

## 配置环境变量

项目优先读取根目录下的 `.env.local`。

如果存在 `.env.example`，可以复制一份：

```bash
cp .env.example .env.local
```

Windows PowerShell 可使用：

```powershell
Copy-Item .env.example .env.local
```

然后填写至少以下配置：

```env
QWEN_API_KEY=你的 Qwen API Key
SERVER_PORT=8788
```

更多变量说明见 `docs/ENV.md`。

## 启动开发环境

```bash
npm run dev
```

该命令会并行启动：

- 前端开发服务：`npm run dev:client`
- 后端 API 服务：`npm run dev:server`

默认访问地址：

| 服务     | 地址                               |
| -------- | ---------------------------------- |
| 前端     | `http://localhost:5173`            |
| 后端     | `http://127.0.0.1:8788`            |
| 健康检查 | `http://127.0.0.1:8788/api/health` |

## 单独启动服务

只启动前端：

```bash
npm run dev:client
```

只启动后端：

```bash
npm run dev:server
```

## 前后端联调方式

开发环境下，前端统一请求 `/api/*` 相对路径。例如：

```text
/api/knowledge
/api/chat/stream
/api/research/search-literature
```

Vite 代理会将这些请求转发到后端：

```text
http://127.0.0.1:8788
```

代理配置位于 `vite.config.ts`：

```text
/api -> http://127.0.0.1:8788
```

因此要确保 `.env.local` 中的 `SERVER_PORT` 与 Vite 代理端口一致：

```env
SERVER_PORT=8788
```

## 验证服务是否正常

启动后，优先访问健康检查：

```bash
curl http://127.0.0.1:8788/api/health
```

Windows PowerShell 也可以使用：

```powershell
Invoke-RestMethod http://127.0.0.1:8788/api/health
```

如果返回 `ok: true`，说明后端基础服务可用。

## 构建生产产物

```bash
npm run build
```

构建结果会输出到 `dist/`。

## 本地预览构建结果

```bash
npm run preview
```

注意：`npm run preview` 是 Vite 的静态预览服务，主要用于检查前端构建结果。完整生产行为以 Express 托管 `dist/` 为准。

## 常用脚本

| 命令                 | 说明                          |
| -------------------- | ----------------------------- |
| `npm run dev`        | 并行启动前端和后端            |
| `npm run dev:client` | 仅启动 Vite 前端开发服务      |
| `npm run dev:server` | 仅启动 Express 后端服务       |
| `npm run build`      | TypeScript 检查并构建前端产物 |
| `npm run preview`    | 本地预览前端构建产物          |

## 本地开发注意事项

- 不要提交 `.env.local`，其中通常包含 API Key 和数据库连接串。
- 如果接口请求失败，先检查 `SERVER_PORT` 是否与 `vite.config.ts` 代理端口一致。
- `POST /api/chat/stream` 是 SSE 流式接口，浏览器 Network 中会保持连接一段时间，这是正常现象。
- 知识库状态默认写入 `.data/knowledge-state.json`，本地调试时可按需清理该目录。
