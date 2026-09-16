<template>
  <main class="knowledge-base-page" aria-labelledby="kb-heading">
    <div class="knowledge-base-header">
      <h1 id="kb-heading">我的知识库</h1>
      <el-button round @click="goBack">返回</el-button>
    </div>

    <LiteratureSearchPanel
      v-model:query="literatureQuery"
      v-model:selected-ids="selectedPaperIds"
      :papers="literatureResults"
      :has-gaps="gaps.length > 0"
      :busy="busy"
      @search="searchPapers"
      @ingest="ingestSelected"
      @extract="extractSchema"
      @mine-gaps="mineGaps"
      @generate-spec="generateSpec"
    />

    <ResearchResultCards :schema="latestSchema" :gaps="gaps" :spec="experimentSpec" />

    <KnowledgeDocumentList :documents="documents" @view="viewDocument" @remove="removeDocument" />

    <DocumentViewerDialog :document="selectedDocument" :highlight-span="highlightSpan" @close="closeViewer" />
  </main>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useChatStore } from '@/stores/chat';
import { useResearchBrain } from '@/composables/useResearchBrain';
import DocumentViewerDialog from '@/components/knowledge/DocumentViewerDialog.vue';
import KnowledgeDocumentList from '@/components/knowledge/KnowledgeDocumentList.vue';
import LiteratureSearchPanel from '@/components/knowledge/LiteratureSearchPanel.vue';
import ResearchResultCards from '@/components/knowledge/ResearchResultCards.vue';
import { fetchKnowledgeDocumentContent } from '@/services/qwen';
import type { KnowledgeDocument } from '@/types/chat';

const chatStore = useChatStore();
const route = useRoute();
const router = useRouter();
const documents = ref<KnowledgeDocument[]>([]);
const selectedDocument = ref<KnowledgeDocument | null>(null);
const highlightSpan = ref<[number, number] | null>(null);

async function reloadDocuments() {
  await chatStore.refreshDocuments();
  documents.value = chatStore.documents;
}

const research = useResearchBrain(reloadDocuments);
const {
  literatureQuery,
  literatureResults,
  selectedPaperIds,
  latestSchema,
  gaps,
  experimentSpec,
  busy,
  searchPapers,
  ingestSelected,
  extractSchema,
  mineGaps,
  generateSpec
} = research;

/** 解析 query 里的 span（形如 "12-48"），非法时返回 null */
function parseSpan(raw: unknown): [number, number] | null {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/^(\d+)-(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

/** 打开文档并可选高亮（点引用跳原文与列表「查看」共用） */
async function openDocument(id: string, span: [number, number] | null): Promise<void> {
  try {
    selectedDocument.value = await fetchKnowledgeDocumentContent(id);
    highlightSpan.value = span;
  } catch (error) {
    chatStore.errorMessage = error instanceof Error ? error.message : '获取文件内容失败';
  }
}

onMounted(async () => {
  await reloadDocuments();
  // 点引用跳原文：URL 带 ?doc=xxx&span=start-end 时自动打开并高亮
  const docId = typeof route.query.doc === 'string' ? route.query.doc : '';
  if (docId) {
    await openDocument(docId, parseSpan(route.query.span));
  }
});

async function viewDocument(doc: KnowledgeDocument) {
  await openDocument(doc.id, null);
}

function closeViewer() {
  selectedDocument.value = null;
  highlightSpan.value = null;
  // 清掉 query，避免刷新时又弹一次
  if (route.query.doc || route.query.span) {
    router.replace({ name: 'knowledge-base' });
  }
}

async function removeDocument(id: string) {
  await chatStore.removeDocument(id);
  documents.value = chatStore.documents;
}

function goBack() {
  window.history.back();
}
</script>

<style scoped>
.knowledge-base-page {
  padding: 20px;
  max-width: 900px;
  margin: 0 auto;
}

.knowledge-base-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.knowledge-base-header h1 {
  font-size: 2rem;
  color: var(--heading);
}
</style>
