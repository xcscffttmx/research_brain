<template>
  <aside class="sidebar-panel">
    <div>
      <p class="eyebrow">Session Control</p>
      <h1>Qwen Agent Console</h1>
      <p class="sidebar-copy">
        面向大模型对话、RAG 检索、工具调用和语音输入的前端工作台。
      </p>
    </div>

    <section class="stat-grid">
      <article>
        <span>会话 ID</span>
        <strong>{{ sessionIdShort }}</strong>
      </article>
      <article>
        <span>消息数量</span>
        <strong>{{ messageCount }}</strong>
      </article>
      <article>
        <span>响应状态</span>
        <strong :class="isResponding ? 'status-live' : 'status-idle'">
          {{ isResponding ? 'Streaming' : 'Idle' }}
        </strong>
      </article>
    </section>

    <section class="capability-list">
      <div v-for="item in capabilities" :key="item.title" class="capability-item">
        <h3>{{ item.title }}</h3>
        <p>{{ item.description }}</p>
      </div>
    </section>

    <button class="ghost-button" @click="$emit('reset')">重置会话</button>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  messageCount: number;
  conversationId: string;
  isResponding: boolean;
}>();

defineEmits<{
  reset: [];
}>();

const capabilities = [
  { title: 'Streaming', description: '基于 ReadableStream 模拟 token 级响应输出。' },
  { title: 'RAG Overlay', description: '展示查询改写、召回来源与引用摘要。' },
  { title: 'Tool Calls', description: '可视化执行中 / 成功 / 失败状态。' },
  { title: 'Voice Input', description: 'Web Speech API 三态识别流程。' }
];

const sessionIdShort = computed(() => props.conversationId.slice(0, 8));
</script>
