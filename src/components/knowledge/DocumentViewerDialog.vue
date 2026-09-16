<template>
  <el-dialog
    :model-value="Boolean(document)"
    :title="document?.name"
    width="800px"
    top="6vh"
    @update:model-value="$emit('close')"
  >
    <pre ref="bodyRef" class="viewer-body"><template v-if="highlightSpan && document?.content"><span>{{
      before
    }}</span><mark ref="markRef" class="viewer-highlight">{{ hit }}</mark><span>{{ after }}</span></template><template
        v-else
        >{{ document?.content }}</template
      ></pre>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { KnowledgeDocument } from '@/types/chat';

const props = defineProps<{
  document: KnowledgeDocument | null;
  /** 命中片段的字符区间 [start, end)，用于高亮并滚动到该处 */
  highlightSpan?: [number, number] | null;
}>();

defineEmits<{
  close: [];
}>();

const bodyRef = ref<HTMLElement | null>(null);
const markRef = ref<HTMLElement | null>(null);

/** 把原文按 span 切成 before / hit / after 三段，hit 段高亮 */
const segments = computed(() => {
  const content = props.document?.content ?? '';
  const span = props.highlightSpan;
  if (!span) return { before: content, hit: '', after: '' };
  const [start, end] = span;
  const safeStart = Math.max(0, Math.min(start, content.length));
  const safeEnd = Math.max(safeStart, Math.min(end, content.length));
  return {
    before: content.slice(0, safeStart),
    hit: content.slice(safeStart, safeEnd),
    after: content.slice(safeEnd)
  };
});

const before = computed(() => segments.value.before);
const hit = computed(() => segments.value.hit);
const after = computed(() => segments.value.after);

// 文档或高亮区间变化时，等 DOM 渲染完滚动到高亮处
watch(
  () => [props.document?.id, props.highlightSpan?.[0], props.highlightSpan?.[1]],
  async () => {
    if (!props.highlightSpan) return;
    await nextTick();
    markRef.value?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
);
</script>

<style scoped>
.viewer-body {
  margin: 0;
  max-height: 70vh;
  overflow-y: auto;
  white-space: pre-wrap;
  word-wrap: break-word;
  font-size: 1rem;
  line-height: 1.6;
  color: var(--text);
  background: var(--panel-muted);
  padding: 15px;
  border-radius: 12px;
  border: 1px solid var(--panel-line);
}

.viewer-highlight {
  background: var(--accent);
  color: var(--heading);
  border-radius: 3px;
  padding: 1px 2px;
  box-shadow: 0 0 0 2px var(--accent-strong);
}
</style>
