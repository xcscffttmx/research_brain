<template>
  <el-card class="research-panel" shadow="never" :aria-busy="busy">
    <template #header>
      <div class="research-panel-head">
        <h2 class="research-panel-title">Research Brain 工作台</h2>
        <p class="research-panel-desc">检索文献、抽取结构化卡片、挖掘研究空白并生成可复现实验规格。</p>
      </div>
    </template>

    <div class="research-form">
      <el-input
        :model-value="query"
        placeholder="输入研究主题，例如 multimodal reasoning"
        clearable
        aria-label="研究主题或关键词"
        @update:model-value="$emit('update:query', $event)"
        @keydown.enter.prevent="$emit('search')"
      />
      <el-button type="primary" :disabled="busy || !query" @click="$emit('search')">检索文献</el-button>
    </div>

    <el-checkbox-group
      v-if="papers.length"
      class="literature-list"
      :model-value="selectedIds"
      @update:model-value="$emit('update:selectedIds', $event as string[])"
    >
      <article v-for="paper in papers" :key="paper.paperId" class="literature-item">
        <el-checkbox :value="paper.paperId" :label="paper.title" size="large" />
        <p class="paper-meta">
          {{ paper.source }} · {{ paper.year || 'N/A' }} · {{ paper.authors.slice(0, 3).join(', ') || 'Unknown' }}
        </p>
        <p class="paper-abstract">{{ paper.abstract || '无摘要' }}</p>
        <el-button size="small" :disabled="busy" @click="$emit('extract', paper.paperId)">抽取 Schema</el-button>
      </article>
    </el-checkbox-group>

    <div class="research-actions">
      <el-button type="primary" :disabled="busy || !selectedIds.length" @click="$emit('ingest')">导入知识库</el-button>
      <el-button :disabled="busy" @click="$emit('mine-gaps')">挖掘 Research Gap</el-button>
      <el-button :disabled="busy || !hasGaps" @click="$emit('generate-spec')">生成 Experiment Spec</el-button>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import type { LiteraturePaper } from '@/types/chat';

defineProps<{
  query: string;
  papers: LiteraturePaper[];
  selectedIds: string[];
  hasGaps: boolean;
  busy: boolean;
}>();

defineEmits<{
  'update:query': [value: string];
  'update:selectedIds': [value: string[]];
  search: [];
  ingest: [];
  extract: [paperId: string];
  'mine-gaps': [];
  'generate-spec': [];
}>();
</script>

<style scoped>
.research-panel {
  margin-bottom: 24px;
}

.research-panel-title {
  margin: 0 0 6px;
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--heading);
}

.research-panel-desc {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.5;
  color: var(--muted);
}

.research-form {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}

.literature-list {
  display: grid;
  gap: 10px;
  width: 100%;
}

.literature-item {
  border: 1px solid var(--panel-line);
  border-radius: 14px;
  padding: 14px;
  background: var(--panel-muted);
}

/* el-checkbox 默认单行截断，文献标题需要换行显示 */
.literature-item :deep(.el-checkbox) {
  height: auto;
  align-items: flex-start;
  white-space: normal;
}

.literature-item :deep(.el-checkbox__label) {
  line-height: 1.45;
  white-space: normal;
}

.paper-meta {
  margin: 6px 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.paper-abstract {
  margin: 0 0 8px;
  color: var(--text);
  font-size: 0.9rem;
}

.research-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 16px;
}
</style>
