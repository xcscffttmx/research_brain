<template>
  <section v-if="schema || gaps.length || spec" class="research-results">
    <el-card v-if="schema" class="result-card" shadow="never" header="最新 Paper Schema">
      <pre>{{ JSON.stringify(schema, null, 2) }}</pre>
    </el-card>

    <el-card v-if="gaps.length" class="result-card" shadow="never" header="Research Gaps">
      <ol class="gap-list">
        <li v-for="gap in gaps" :key="gap.opportunity">
          <strong>{{ gap.opportunity }}</strong>
          <p>{{ gap.rationale }}</p>
          <div class="gap-meta">
            <el-tag size="small" effect="plain">置信度 {{ gap.confidence }}</el-tag>
            <span>支持文献：{{ gap.supportingPaperIds.join(', ') || 'N/A' }}</span>
          </div>
        </li>
      </ol>
    </el-card>

    <el-card v-if="spec" class="result-card" shadow="never" header="Experiment Spec">
      <pre>{{ JSON.stringify(spec, null, 2) }}</pre>
    </el-card>
  </section>
</template>

<script setup lang="ts">
import type { ExperimentSpec, PaperSchema, ResearchGapOpportunity } from '@/types/chat';

defineProps<{
  schema: PaperSchema | null;
  gaps: ResearchGapOpportunity[];
  spec: ExperimentSpec | null;
}>();
</script>

<style scoped>
.research-results {
  display: grid;
  gap: 14px;
  margin-bottom: 24px;
}

.result-card pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.85rem;
  line-height: 1.55;
}

.gap-list {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 12px;
}

.gap-list p {
  margin: 4px 0;
  color: var(--text);
  font-size: 0.9rem;
}

.gap-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 0.82rem;
}
</style>
