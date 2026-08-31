/**
 * 集中管理 Qwen（DashScope 兼容模式）配置。
 *
 * 用 getter 而非普通字段：入口文件的 `import` 会在 `dotenv.config()` 之前求值，
 * 若在模块加载时就快照 process.env，`.env.local` 里的 Key 会读不到。
 */
export const qwenConfig = {
  get apiKey() {
    return process.env.QWEN_API_KEY;
  },
  get baseUrl() {
    return (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
  },
  get embeddingModel() {
    return process.env.QWEN_EMBEDDING_MODEL || 'text-embedding-v3';
  },
  get chatModel() {
    return process.env.QWEN_MODEL || 'qwen-plus';
  },
  get rerankModel() {
    return process.env.QWEN_RERANK_MODEL || 'gte-rerank';
  }
};
