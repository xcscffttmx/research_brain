/**
 * 集中管理 Qwen（DashScope 兼容模式）配置。
 *
 * 用 getter 而非普通字段：入口文件的 `import` 会在 `dotenv.config()` 之前求值，
 * 若在模块加载时就快照 process.env，`.env.local` 里的 Key 会读不到。
 */
export const qwenConfig = {
  get apiKey(): string | undefined {
    return process.env.QWEN_API_KEY;
  },
  get baseUrl(): string {
    return (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
  },
  get embeddingModel(): string {
    return process.env.QWEN_EMBEDDING_MODEL || 'text-embedding-v3';
  },
  get chatModel(): string {
    return process.env.QWEN_MODEL || 'qwen-plus';
  },
  get rerankModel(): string {
    // gte-rerank 已下线，gte-rerank-v2 为其在原生 text-rerank 接口上的替代
    return process.env.QWEN_RERANK_MODEL || 'gte-rerank-v2';
  },
  /**
   * Reranker 走 DashScope 原生 text-rerank 接口。
   * 兼容模式的 /reranks 并非所有账号都开放，实测返回 404，故固定用原生路径。
   */
  get rerankUrl(): string {
    if (process.env.QWEN_RERANK_URL) return process.env.QWEN_RERANK_URL;
    const nativeBase = this.baseUrl.replace(/\/compatible-mode\/v1$/, '/api/v1');
    return `${nativeBase}/services/rerank/text-rerank/text-rerank`;
  }
};
