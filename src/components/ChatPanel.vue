<template>
  <section class="conversation-shell">
    <div v-if="messages.length <= 1" class="conversation-empty">
      <div class="empty-hero">
        <div class="hero-chip">research-agent</div>
        <h2>今天想探索什么？</h2>
        <p>你可以直接聊天，也可以上传文档，让 Agent 自动调用后端工具完成向量检索与知识增强回答。</p>
      </div>
    </div>

    <DynamicScroller
      v-else
      ref="scrollerRef"
      class="conversation-scroller"
      :items="messages"
      :min-item-size="120"
      key-field="id"
    >
      <template #default="{ item, index, active }">
        <DynamicScrollerItem
          :item="item"
          :active="active"
          :size-dependencies="[item.content, JSON.stringify(item.tools || []), JSON.stringify(item.citations || [])]"
          :data-index="index"
        >
          <MessageCard :message="item" />
        </DynamicScrollerItem>
      </template>
    </DynamicScroller>
  </section>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller';
import type { ChatMessage } from '@/types/chat';
import MessageCard from './MessageCard.vue';

const props = defineProps<{
  messages: ChatMessage[];
}>();

const scrollerRef = ref<any>(null);

async function scrollToBottom() {
  await nextTick();
  const lastIndex = props.messages.length - 1;
  if (lastIndex >= 0) {
    scrollerRef.value?.scrollToItem(lastIndex);
  }
}

// 只观察最后一条消息：流式期间无需对整个列表做 O(n) 拼接比较
watch(
  () => {
    const last = props.messages[props.messages.length - 1];
    return last ? `${props.messages.length}:${last.id}:${last.content.length}:${last.status}` : '';
  },
  () => {
    scrollToBottom();
  },
  { immediate: true }
);
</script>
