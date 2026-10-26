/**
 * 知识库相关 MCP 工具注册。
 *
 * 这一层只做协议适配：解析入参、调用 knowledgeBase 服务、把结果/异常包成 MCP 响应。
 */

import { z } from 'zod';
import {
  clearDocuments,
  deleteDocument,
  getDocumentContent,
  ingestDocuments,
  listDocuments,
  searchKnowledge
} from '../services/knowledgeBase.js';
import { toErrorContent, toTextContent } from './toolkit.js';
import type { McpToolServer } from './toolkit.js';

export function registerKnowledgeTools(server: McpToolServer): void {
  server.registerTool(
    'retrieve_knowledge',
    {
      description: '从后端向量知识库检索与用户问题最相关的文档片段',
      inputSchema: z.object({
        query: z.string().min(1, 'query 不能为空'),
        topK: z.number().int().min(1).max(10).optional(),
        userId: z.string().optional()
      })
    },
    async ({ query, topK = 4, userId }: { query: string; topK?: number; userId?: string }) => {
      try {
        const citations = await searchKnowledge(query, topK, userId);
        return toTextContent({ citations, count: citations.length });
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'list_knowledge_documents',
    {
      description: '列出当前用户知识库中的文档',
      inputSchema: z.object({
        userId: z.string().optional()
      })
    },
    async ({ userId }: { userId?: string }) => toTextContent({ documents: listDocuments(userId) })
  );

  server.registerTool(
    'get_knowledge_document_content',
    {
      description: '获取指定知识文档的完整内容',
      inputSchema: z.object({
        id: z.string().min(1, 'id 不能为空'),
        userId: z.string().optional()
      })
    },
    async ({ id, userId }: { id: string; userId?: string }) => {
      try {
        return toTextContent(getDocumentContent(id, userId));
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'ingest_knowledge_documents',
    {
      description: '导入知识文档到向量知识库中并建立向量索引',
      inputSchema: z.object({
        documents: z
          .array(
            z.object({
              name: z.string().min(1, 'name 不能为空'),
              content: z.string().min(1, 'content 不能为空'),
              isBinary: z.boolean().optional()
            })
          )
          .min(1, '至少导入一份文档'),
        userId: z.string().optional()
      })
    },
    async ({
      documents,
      userId
    }: {
      documents: Array<{ name: string; content: string; isBinary?: boolean }>;
      userId?: string;
    }) => {
      try {
        const inserted = await ingestDocuments(documents, userId);
        return toTextContent({ documents: inserted, message: `已成功导入 ${inserted.length} 份知识文件。` });
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'delete_knowledge_document',
    {
      description: '删除指定的知识文档以及对应的向量索引',
      inputSchema: z.object({
        id: z.string().min(1, 'id 不能为空'),
        userId: z.string().optional()
      })
    },
    async ({ id, userId }: { id: string; userId?: string }) => {
      try {
        return toTextContent(deleteDocument(id, userId));
      } catch (error) {
        return toErrorContent(error);
      }
    }
  );

  server.registerTool(
    'clear_knowledge_documents',
    {
      description: '清空知识库中的所有文档与向量索引',
      inputSchema: z.object({})
    },
    async () => toTextContent(clearDocuments())
  );
}
