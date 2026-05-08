<template>
  <main class="knowledge-base-page" aria-labelledby="kb-heading">
    <div class="knowledge-base-header">
      <h1 id="kb-heading">我的知识库</h1>
      <button type="button" class="back-button" @click="goBack">返回</button>
    </div>

    <section class="research-panel" :aria-busy="busy">
      <h2 class="research-panel-title">Research Brain 工作台</h2>
      <p class="research-panel-desc">检索文献、抽取结构化卡片、挖掘研究空白并生成可复现实验规格。</p>
      <div class="research-form">
        <label class="sr-only" for="literature-query-input">研究主题或关键词</label>
        <input
          id="literature-query-input"
          v-model.trim="literatureQuery"
          autocomplete="off"
          placeholder="输入研究主题，例如 multimodal reasoning"
          @keydown.enter.prevent="handleSearchLiterature"
        />
        <button type="button" class="btn btn-primary" :disabled="busy || !literatureQuery" @click="handleSearchLiterature">
          检索文献
        </button>
      </div>

      <div v-if="literatureResults.length" class="literature-list">
        <article v-for="paper in literatureResults" :key="paper.paperId" class="literature-item">
          <label class="paper-check">
            <input v-model="selectedPaperIds" type="checkbox" :value="paper.paperId" />
            <span class="paper-title-text">{{ paper.title }}</span>
          </label>
          <p class="paper-meta">
            {{ paper.source }} · {{ paper.year || 'N/A' }} · {{ paper.authors.slice(0, 3).join(', ') || 'Unknown' }}
          </p>
          <p class="paper-abstract">{{ paper.abstract || '无摘要' }}</p>
          <div class="paper-actions">
            <button type="button" class="btn btn-secondary" :disabled="busy" @click="handleExtractSchema(paper.paperId)">
              抽取 Schema
            </button>
          </div>
        </article>
      </div>

      <div class="research-actions">
        <button type="button" class="btn btn-primary" :disabled="busy || !selectedPaperIds.length" @click="handleIngestLiterature">
          导入知识库
        </button>
        <button type="button" class="btn btn-secondary" :disabled="busy" @click="handleMineGaps">挖掘 Research Gap</button>
        <button type="button" class="btn btn-secondary" :disabled="busy || !gaps.length" @click="handleGenerateSpec">
          生成 Experiment Spec
        </button>
      </div>

      <div v-if="latestSchema" class="result-card">
        <h3>最新 Paper Schema</h3>
        <pre>{{ JSON.stringify(latestSchema, null, 2) }}</pre>
      </div>

      <div v-if="gaps.length" class="result-card">
        <h3>Research Gaps</h3>
        <ol>
          <li v-for="gap in gaps" :key="gap.opportunity">
            <strong>{{ gap.opportunity }}</strong>
            <p>{{ gap.rationale }}</p>
            <small>支持文献: {{ gap.supportingPaperIds.join(', ') || 'N/A' }} | 置信度: {{ gap.confidence }}</small>
          </li>
        </ol>
      </div>

      <div v-if="experimentSpec" class="result-card">
        <h3>Experiment Spec</h3>
        <pre>{{ JSON.stringify(experimentSpec, null, 2) }}</pre>
      </div>
    </section>

    <div v-if="documents.length" class="knowledge-list-full">
      <article v-for="doc in documents" :key="doc.id" class="knowledge-item-full">
        <div class="doc-info">
          <strong>{{ doc.name }}</strong>
          <p>{{ formatTime(doc.createdAt) }}</p>
        </div>
        <div class="doc-actions">
          <button type="button" class="action-button view-button" @click="viewDocument(doc)">查看</button>
          <button type="button" class="action-button remove-button" @click="removeDocument(doc.id)">删除</button>
        </div>
      </article>
    </div>
    <div v-else class="knowledge-empty-full">
      <p>暂无知识文档。请返回主页上传文件，或使用上方工作台导入文献。</p>
    </div>

    <div
      v-if="selectedDocument"
      class="document-viewer-modal"
      role="presentation"
      @click.self="closeViewer"
    >
      <div
        class="document-viewer-content"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="'viewer-title-' + selectedDocument.id"
      >
        <div class="viewer-header">
          <h2 :id="'viewer-title-' + selectedDocument.id">{{ selectedDocument.name }}</h2>
          <button type="button" class="close-button" aria-label="关闭预览" @click="closeViewer">
            <svg class="icon-svg icon-svg--20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" />
            </svg>
          </button>
        </div>
        <div class="viewer-body">
          <pre>{{ selectedDocument.content }}</pre>
        </div>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useChatStore } from '@/stores/chat';
import type { ExperimentSpec, KnowledgeDocument, LiteraturePaper, PaperSchema, ResearchGapOpportunity } from '@/types/chat';
import {
  extractPaperSchema,
  fetchKnowledgeDocumentContent,
  generateExperimentSpec,
  ingestLiteratureToKnowledge,
  mineResearchGaps,
  searchLiterature
} from '@/services/qwen';

const chatStore = useChatStore();
const documents = ref<KnowledgeDocument[]>([]);
const selectedDocument = ref<KnowledgeDocument | null>(null);
const literatureQuery = ref('');
const literatureResults = ref<LiteraturePaper[]>([]);
const selectedPaperIds = ref<string[]>([]);
const latestSchema = ref<PaperSchema | null>(null);
const gaps = ref<ResearchGapOpportunity[]>([]);
const experimentSpec = ref<ExperimentSpec | null>(null);
const busy = ref(false);

onMounted(async () => {
  await chatStore.refreshDocuments();
  documents.value = chatStore.documents;
});

function formatTime(time: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(time);
}

async function viewDocument(doc: KnowledgeDocument) {
  try {
    const docContent = await fetchKnowledgeDocumentContent(doc.id);
    selectedDocument.value = docContent;
  } catch (error) {
    chatStore.errorMessage = error instanceof Error ? error.message : '获取文件内容失败';
  }
}

async function removeDocument(id: string) {
  if (confirm('确定要删除这份知识文档吗？')) {
    await chatStore.removeDocument(id);
    documents.value = chatStore.documents; // 刷新列表
  }
}

async function handleSearchLiterature() {
  try {
    busy.value = true;
    literatureResults.value = await searchLiterature(literatureQuery.value, 8, 'all');
    selectedPaperIds.value = [];
    chatStore.noticeMessage = `检索到 ${literatureResults.value.length} 篇文献。`;
  } catch (error) {
    chatStore.errorMessage = error instanceof Error ? error.message : '文献检索失败';
  } finally {
    busy.value = false;
  }
}

async function handleIngestLiterature() {
  try {
    busy.value = true;
    const inserted = await ingestLiteratureToKnowledge(selectedPaperIds.value);
    await chatStore.refreshDocuments();
    documents.value = chatStore.documents;
    chatStore.noticeMessage = `已导入 ${inserted.length} 篇文献到知识库。`;
  } catch (error) {
    chatStore.errorMessage = error instanceof Error ? error.message : '文献入库失败';
  } finally {
    busy.value = false;
  }
}

async function handleExtractSchema(paperId: string) {
  try {
    busy.value = true;
    latestSchema.value = await extractPaperSchema(paperId);
    chatStore.noticeMessage = 'Paper Schema 抽取成功。';
  } catch (error) {
    chatStore.errorMessage = error instanceof Error ? error.message : 'Schema 抽取失败';
  } finally {
    busy.value = false;
  }
}

async function handleMineGaps() {
  try {
    busy.value = true;
    gaps.value = await mineResearchGaps(literatureQuery.value);
    chatStore.noticeMessage = `已挖掘 ${gaps.value.length} 条研究机会。`;
  } catch (error) {
    chatStore.errorMessage = error instanceof Error ? error.message : 'Research Gap 挖掘失败';
  } finally {
    busy.value = false;
  }
}

async function handleGenerateSpec() {
  try {
    busy.value = true;
    experimentSpec.value = await generateExperimentSpec(literatureQuery.value, 0);
    chatStore.noticeMessage = 'Experiment Spec 生成成功。';
  } catch (error) {
    chatStore.errorMessage = error instanceof Error ? error.message : 'Experiment Spec 生成失败';
  } finally {
    busy.value = false;
  }
}

function closeViewer() {
  selectedDocument.value = null;
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

.research-panel {
  margin-bottom: 24px;
  padding: 20px;
  border-radius: 18px;
  border: 1px solid var(--panel-line);
  background: var(--panel);
  box-shadow: var(--shadow);
}

.research-panel-title {
  margin: 0 0 6px;
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--heading);
  letter-spacing: -0.01em;
}

.research-panel-desc {
  margin: 0 0 16px;
  font-size: 0.9rem;
  line-height: 1.5;
  color: var(--muted);
}

.research-form {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
  align-items: stretch;
}

.research-form input {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  border-radius: 12px;
  border: 1px solid var(--panel-line);
  background: var(--panel-muted);
  color: var(--text);
  padding: 10px 14px;
  font-size: 1rem;
}

.research-form input:focus-visible {
  border-color: var(--accent-strong);
  box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.18);
}

.btn {
  min-height: 44px;
  padding: 0 18px;
  border-radius: 12px;
  font-size: 0.92rem;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.btn-primary {
  border: 1px solid var(--accent-strong);
  background: var(--accent-strong);
  color: #fff;
  box-shadow: 0 4px 14px rgba(26, 115, 232, 0.28);
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.05);
}

.btn-secondary {
  border: 1px solid var(--panel-line);
  background: var(--panel-muted);
  color: var(--text);
}

.btn-secondary:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.research-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin: 16px 0 0;
}

.literature-list {
  display: grid;
  gap: 10px;
}

.literature-item {
  border: 1px solid var(--panel-line);
  border-radius: 14px;
  padding: 14px;
  background: var(--panel-muted);
}

.paper-check {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-weight: 600;
  cursor: pointer;
}

.paper-check input {
  margin-top: 4px;
  width: 18px;
  height: 18px;
  accent-color: var(--accent-strong);
}

.paper-title-text {
  flex: 1;
  min-width: 0;
  line-height: 1.45;
}

.paper-meta {
  margin: 6px 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.paper-abstract {
  margin: 0;
  color: var(--text);
  font-size: 0.9rem;
}

.paper-actions {
  margin-top: 8px;
}

.result-card {
  margin-top: 14px;
  border: 1px solid var(--panel-line);
  border-radius: 14px;
  padding: 14px 16px;
  background: var(--panel-muted);
}

.result-card h3 {
  margin: 0 0 10px;
  font-size: 1rem;
  font-weight: 600;
  color: var(--heading);
}

.result-card pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.85rem;
  line-height: 1.55;
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

.back-button {
  padding: 8px 16px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  border: 1px solid var(--accent);
  font-size: 0.9rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.back-button:hover {
  background: var(--accent-strong);
  color: #ffffff;
}

.knowledge-list-full {
  display: grid;
  gap: 15px;
}

.knowledge-item-full {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 15px 20px;
  border-radius: 18px;
  background: var(--panel);
  border: 1px solid var(--panel-line);
  box-shadow: var(--shadow);
}

.doc-info strong {
  display: block;
  font-size: 1.1rem;
  color: var(--heading);
  margin-bottom: 5px;
}

.doc-info p {
  margin: 0;
  color: var(--muted);
  font-size: 0.9rem;
}

.doc-actions button {
  margin-left: 10px;
  padding: 8px 16px;
  border-radius: 999px;
  font-size: 0.9rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.view-button {
  background: var(--accent-soft);
  color: var(--accent-strong);
  border: 1px solid var(--accent);
}

.view-button:hover {
  background: var(--accent-strong);
  color: #ffffff;
}

.remove-button {
  background: #ffebee;
  color: var(--danger);
  border: 1px solid #ef9a9a;
}

.remove-button:hover {
  background: var(--danger);
  color: #ffffff;
}

.knowledge-empty-full {
  padding: 40px;
  text-align: center;
  color: var(--muted);
  font-size: 1.1rem;
  background: var(--panel);
  border: 1px solid var(--panel-line);
  border-radius: 18px;
  box-shadow: var(--shadow);
}

.document-viewer-modal {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.document-viewer-content {
  background: var(--panel);
  border-radius: 18px;
  width: 90%;
  max-width: 800px;
  max-height: 90%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.viewer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 15px 20px;
  border-bottom: 1px solid var(--panel-line);
}

.viewer-header h2 {
  margin: 0;
  font-size: 1.5rem;
  color: var(--heading);
}

.close-button {
  width: 44px;
  height: 44px;
  background: none;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  color: var(--muted);
  display: grid;
  place-items: center;
}

.close-button:hover {
  color: var(--heading);
  background: var(--panel-muted);
}

.viewer-body {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}

.viewer-body pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: 'Google Sans Text', 'Noto Sans SC', monospace;
  font-size: 1rem;
  line-height: 1.6;
  color: var(--text);
  background: var(--panel-muted);
  padding: 15px;
  border-radius: 12px;
  border: 1px solid var(--panel-line);
}
</style>
