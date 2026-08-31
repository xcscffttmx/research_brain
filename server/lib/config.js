/**
 * 集中管理 Qwen（DashScope 兼容模式）配置。
 * 从环境变量读取，保持与 mcp-server.js 原实现完全一致的默认值。
 */
export const qwenConfig = {
  apiKey: process.env.QWEN_API_KEY,
  baseUrl: (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
  embeddingModel: process.env.QWEN_EMBEDDING_MODEL || 'text-embedding-v3',
  chatModel: process.env.QWEN_MODEL || 'qwen-plus'
};
