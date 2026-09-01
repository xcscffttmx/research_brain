<template>
  <section class="knowledge-documents">
    <el-empty v-if="!documents.length" description="暂无知识文档。请返回主页上传文件，或使用上方工作台导入文献。" />

    <el-card v-for="doc in documents" v-else :key="doc.id" class="document-row" shadow="never">
      <div class="document-row-body">
        <div class="doc-info">
          <strong>{{ doc.name }}</strong>
          <p>{{ formatTime(doc.createdAt) }}</p>
        </div>
        <div class="doc-actions">
          <el-button size="small" @click="$emit('view', doc)">查看</el-button>
          <el-popconfirm
            title="确定要删除这份知识文档吗？"
            confirm-button-text="删除"
            cancel-button-text="取消"
            confirm-button-type="danger"
            @confirm="$emit('remove', doc.id)"
          >
            <template #reference>
              <el-button size="small" type="danger" plain>删除</el-button>
            </template>
          </el-popconfirm>
        </div>
      </div>
    </el-card>
  </section>
</template>

<script setup lang="ts">
import type { KnowledgeDocument } from '@/types/chat';

defineProps<{
  documents: KnowledgeDocument[];
}>();

defineEmits<{
  view: [doc: KnowledgeDocument];
  remove: [id: string];
}>();

function formatTime(time: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(time);
}
</script>

<style scoped>
.knowledge-documents {
  display: grid;
  gap: 12px;
}

.document-row-body {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.doc-info strong {
  display: block;
  font-size: 1.05rem;
  color: var(--heading);
  margin-bottom: 4px;
}

.doc-info p {
  margin: 0;
  color: var(--muted);
  font-size: 0.88rem;
}

.doc-actions {
  display: flex;
  gap: 8px;
}
</style>
