# AGENTS Guide

本文件用于约束后续代理协作与开发流程，目标是长期复用、规则简洁、可执行。

## 1) 代码风格与约束

- 命名规范
  - 变量、函数：`camelCase`
  - 类型、接口、Vue 组件名：`PascalCase`
  - 常量：`UPPER_SNAKE_CASE`（同一文件保持一致）
  - 组件文件：`PascalCase.vue`
  - TS 模块文件：`camelCase.ts`
- 模块依赖
  - 不允许循环依赖（尤其是 `src/services`、`src/stores`、`server/services` 之间）。
  - 依赖方向保持单向：入口层 -> 服务层 -> 数据层/工具层。
- 导出约定
  - TS 优先命名导出（`export function/type/interface`）。
  - Vue SFC 使用默认导出（遵循框架约定）。
  - 服务端统一使用 ESM（`import/export`）。

## 2) 目录结构约定

- 现有核心目录职责不可随意变更：
  - `src/components/`：界面组件
  - `src/services/`：前端 API 封装
  - `src/stores/`：Pinia 状态管理
  - `src/types/`：共享类型
  - `server/index.js`：HTTP 入口
  - `server/mcp-server.js`：MCP 入口
- 后续新增后端能力时优先放置：
  - `server/lib/`：纯工具函数与外部客户端封装
  - `server/services/`：业务编排
  - `server/repositories/`：持久化访问
  - `server/schemas/`：Zod 数据结构定义
- 代理技能固定目录：`.agents/skills/`

## 3) 运行与测试

- 安装依赖：`npm install`
- 本地配置：复制 `.env.example` 为 `.env.local` 后填写必要环境变量
- 开发启动：`npm run dev`
- 生产构建：`npm run build`
- 测试约定
  - 新增或改动核心逻辑时，必须补充可执行测试（后续统一挂到 `npm test`）。
  - 每次阶段性交付至少执行一次构建验证（`npm run build`）。

## 4) 生成内容要求

- 文件命名
  - 功能文件使用语义化命名，避免 `temp`、`new`、`test2` 等一次性命名。
  - 技能目录名统一小写 kebab-case：`.agents/skills/<skill-name>/`
- 注释语言
  - 代码注释与用户可见说明默认使用中文，保持简洁、可执行。
  - 字段名、类型名、接口名保持英文，避免中英文混杂命名。
- 示例要求
  - 仅在规则、接口或流程不直观时提供最小可运行示例。
  - 优先给输入/输出示例，不堆砌大段演示代码。

## 5) 提交规范

- Commit message 使用 Conventional Commits：
  - `feat(scope): ...`
  - `fix(scope): ...`
  - `refactor(scope): ...`
  - `docs(scope): ...`
  - `test(scope): ...`
  - `chore(scope): ...`
- 分支命名规范：
  - `feat/<topic>`
  - `fix/<topic>`
  - `chore/<topic>`

## 6) 技能复用与安装流程（必须遵循）

1. 接到任务后，先检查本地 `.agents/skills/` 是否已有可复用技能。
2. 本地没有合适技能时，再到 GitHub 开源仓库和 Skills.sh 搜索相关技能。
3. 优先选择来源清晰、结构规范、说明完整、风险较低的技能。
4. 安装技能时，保存到 `.agents/skills/<skill-name>/`。
5. 安装后更新必要说明（建议同步更新 `.agents/README.md`），保证后续对话可直接复用。
6. 找不到合适技能时再自行完成任务，并优先沉淀为可复用技能。
7. 避免重复安装相同技能，保持技能目录整洁、命名清晰、可维护。

## 7) 任务执行流程（Harness Engineering）

1. 接收需求并输出实施计划。
2. 人工确认计划后，再进入开发。
3. 按阶段小步实现，每阶段完成后自测与验证。
4. 向用户汇报阶段结果并等待验收，再继续下一阶段。
5. 默认优先可复用能力建设，避免一次性实现不可沉淀的方案。
