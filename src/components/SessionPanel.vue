<template>
  <aside class="session-panel">
    <div class="session-panel-header">
      <div>
        <p class="section-label">research-agent conversations</p>
        <h2>最近对话</h2>
      </div>
      <button class="nav-icon-button" :disabled="disabled" @click="$emit('new-session')">＋</button>
    </div>

    <div class="session-list">
      <article
        v-for="session in sessions"
        :key="session.id"
        class="session-card"
        :class="{ 'session-card-active': session.id === activeSessionId }"
        @click="$emit('switch-session', session.id)"
      >
        <div class="session-card-body">
          <strong>{{ session.title }}</strong>
          <p>{{ formatTime(session.updatedAt) }} · {{ session.messages.length }} 条消息</p>
        </div>
        <button
          class="session-delete"
          :disabled="disabled || sessions.length === 1"
          @click.stop="$emit('delete-session', session.id)"
        >
          删除
        </button>
      </article>
    </div>
  </aside>
</template>

<script setup lang="ts">
import type { ChatSession } from '@/types/chat';

defineProps<{
  sessions: ChatSession[];
  activeSessionId: string;
  disabled: boolean;
}>();

defineEmits<{
  'new-session': [];
  'switch-session': [sessionId: string];
  'delete-session': [sessionId: string];
}>();

function formatTime(time: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(time);
}
</script>
