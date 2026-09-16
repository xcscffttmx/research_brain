<template>
  <section class="conversation-shell">
    <div v-if="messages.length <= 1" class="conversation-empty">
      <el-empty description="今天想探索什么？">
        <template #image>
          <div class="hero-chip">research-agent</div>
        </template>
        <p>你可以直接聊天，也可以上传文档，让 Agent 自动调用后端工具完成向量检索与知识增强回答。</p>
      </el-empty>
    </div>

    <DynamicScroller
      v-else
      ref="scrollerRef"
      class="conversation-scroller"
      :items="messages"
      :min-item-size="120"
      key-field="id"
      @scroll.passive="onScroll"
    >
      <template #default="{ item, index, active }">
        <DynamicScrollerItem :item="item" :active="active" :size-dependencies="sizeDeps(item)" :data-index="index">
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
import { createFollowState, nextFollowState } from '@/utils/scrollFollow';
import MessageCard from './MessageCard.vue';

const props = defineProps<{
  messages: ChatMessage[];
}>();

const scrollerRef = ref<any>(null);
let followState = createFollowState();

/**
 * 虚拟列表的尺寸依赖。
 * 只取会影响高度的字段：正文、状态标签、工具与引用的条数。
 * 工具入参和结果在折叠面板内，未展开时不影响高度，因此不必参与比较
 * （早期这里对 tools / citations 做了 JSON.stringify，流式期间每帧都会序列化一次）。
 */
function sizeDeps(message: ChatMessage) {
  return [message.content, message.status, message.tools?.length ?? 0, message.citations?.length ?? 0];
}

function onScroll(event: Event) {
  const element = event.target as HTMLElement | null;
  if (!element) return;
  followState = nextFollowState(followState, {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight
  });
}

async function scrollToBottom() {
  await nextTick();
  const lastIndex = props.messages.length - 1;
  if (lastIndex >= 0) {
    scrollerRef.value?.scrollToItem(lastIndex);
  }
}

let lastMessageCount = props.messages.length;

// 只观察最后一条消息：流式期间无需对整个列表做 O(n) 拼接比较
watch(
  () => {
    const last = props.messages[props.messages.length - 1];
    return last ? `${props.messages.length}:${last.id}:${last.content.length}:${last.status}` : '';
  },
  () => {
    // 新消息（用户发送或新一轮回答）总是跟随；流式增量则尊重用户是否已向上翻阅
    if (props.messages.length !== lastMessageCount) {
      lastMessageCount = props.messages.length;
      followState = { ...followState, following: true };
    }
    if (followState.following) scrollToBottom();
  },
  { immediate: true }
);
</script>
