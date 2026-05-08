<template>
  <header class="topbar-shell">
    <div class="topbar-left">
      <button type="button" class="nav-icon-button desktop-hidden" aria-label="打开侧边菜单" @click="$emit('menu')">
        <svg class="icon-svg icon-svg--22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" stroke-linecap="round" />
        </svg>
      </button>
      <div class="topbar-title-group">
        <h1>research-agent</h1>
        <p>{{ titleText }}</p>
      </div>
    </div>

    <div class="topbar-right">
      <button type="button" class="topbar-icon desktop-only-flex" aria-label="展开侧边栏" @click="$emit('menu')">
        <svg class="icon-svg icon-svg--22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" stroke-linecap="round" />
        </svg>
      </button>
      <button type="button" class="topbar-chip" @click="$emit('toggle-rag')">
        {{ ragEnabled ? 'RAG 开启' : 'RAG 关闭' }}
      </button>
      <button type="button" class="topbar-chip" :disabled="disabled" @click="$emit('new-session')">新对话</button>
      <button type="button" class="topbar-chip stop-chip" :disabled="!isResponding" @click="$emit('stop')">停止输出</button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  ragEnabled: boolean;
  documentCount: number;
  conversationId: string;
  messageCount: number;
  isResponding: boolean;
  disabled: boolean;
}>();

defineEmits<{
  menu: [];
  stop: [];
  'new-session': [];
  'toggle-rag': [];
}>();

const titleText = computed(
  () => `research-agent · 会话 ${props.conversationId.slice(0, 8)} · ${props.messageCount} 条消息 · ${props.documentCount} 份知识文档`
);
</script>
