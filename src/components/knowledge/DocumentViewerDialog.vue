<template>
  <el-dialog
    :model-value="Boolean(document)"
    :title="document?.name"
    width="800px"
    top="6vh"
    @update:model-value="$emit('close')"
  >
    <pre class="viewer-body">{{ document?.content }}</pre>
  </el-dialog>
</template>

<script setup lang="ts">
import type { KnowledgeDocument } from '@/types/chat';

defineProps<{
  document: KnowledgeDocument | null;
}>();

defineEmits<{
  close: [];
}>();
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
</style>
