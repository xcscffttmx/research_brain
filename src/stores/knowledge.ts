import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  clearKnowledgeDocuments,
  deleteKnowledgeDocument,
  fetchKnowledgeDocuments,
  uploadKnowledgeDocuments
} from '@/services/qwen';
import { useUiStore } from './ui';
import type { KnowledgeDocument } from '@/types/chat';

/** 知识库文档列表：与后端 /api/knowledge 打交道，成功清错、失败落错 */
export const useKnowledgeStore = defineStore('knowledge', () => {
  const ui = useUiStore();

  const documents = ref<KnowledgeDocument[]>([]);
  const documentCount = computed(() => documents.value.length);

  async function refreshDocuments() {
    try {
      documents.value = await fetchKnowledgeDocuments();
      ui.errorMessage = '';
    } catch (error) {
      ui.fail(error, '加载知识库失败');
    }
  }

  async function uploadKnowledge(files: FileList | File[]) {
    ui.noticeMessage = '';
    try {
      const uploaded = await uploadKnowledgeDocuments(files);
      documents.value = [...documents.value, ...uploaded];
      ui.errorMessage = '';
      ui.noticeMessage = uploaded.length ? `已成功导入 ${uploaded.length} 份知识文件。` : '';
      ui.sidebarOpen = true;
    } catch (error) {
      ui.fail(error, '上传知识库失败');
    }
  }

  async function removeDocument(id: string) {
    ui.noticeMessage = '';
    try {
      await deleteKnowledgeDocument(id);
      documents.value = documents.value.filter((item) => item.id !== id);
      ui.errorMessage = '';
      ui.notify('知识文件已移除。');
    } catch (error) {
      ui.fail(error, '删除知识库失败');
    }
  }

  async function clearKnowledge() {
    ui.noticeMessage = '';
    try {
      await clearKnowledgeDocuments();
      documents.value = [];
      ui.errorMessage = '';
      ui.notify('知识库已清空。');
    } catch (error) {
      ui.fail(error, '清空知识库失败');
    }
  }

  return { documents, documentCount, refreshDocuments, uploadKnowledge, removeDocument, clearKnowledge };
});
