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

    <DocumentViewerDialog :document="selectedDocument" @close="selectedDocument = null" />
  </main>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useChatStore } from '@/stores/chat';
import { useResearchBrain } from '@/composables/useResearchBrain';
import DocumentViewerDialog from '@/components/knowledge/DocumentViewerDialog.vue';
import KnowledgeDocumentList from '@/components/knowledge/KnowledgeDocumentList.vue';
import LiteratureSearchPanel from '@/components/knowledge/LiteratureSearchPanel.vue';
import ResearchResultCards from '@/components/knowledge/ResearchResultCards.vue';
import { fetchKnowledgeDocumentContent } from '@/services/qwen';
import type { KnowledgeDocument } from '@/types/chat';

const chatStore = useChatStore();
const documents = ref<KnowledgeDocument[]>([]);
const selectedDocument = ref<KnowledgeDocument | null>(null);

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

onMounted(reloadDocuments);

async function viewDocument(doc: KnowledgeDocument) {
  try {
    selectedDocument.value = await fetchKnowledgeDocumentContent(doc.id);
  } catch (error) {
    chatStore.errorMessage = error instanceof Error ? error.message : '获取文件内容失败';
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
