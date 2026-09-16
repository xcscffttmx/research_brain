import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  ACTIVE_SESSION_KEY,
  buildSessionTitle,
  createInitialAssistantMessage,
  createSession,
  deserializeSessions,
  serializeSessions
} from './chatHelpers';
import { useUiStore } from './ui';
import type { ChatSession } from '@/types/chat';

const initialState = deserializeSessions();

/** 会话列表与当前会话：只管数据与持久化，不碰流式运行时 */
export const useSessionStore = defineStore('session', () => {
  const ui = useUiStore();

  const sessions = ref<ChatSession[]>(initialState.sessions);
  const activeConversationId = ref(initialState.activeSessionId || initialState.sessions[0].id);

  const activeSession = computed(
    () => sessions.value.find((session) => session.id === activeConversationId.value) || sessions.value[0]
  );
  const messages = computed(() => activeSession.value.messages);
  const messageCount = computed(() => activeSession.value.messages.length);
  const sessionList = computed(() => [...sessions.value].sort((a, b) => b.updatedAt - a.updatedAt));

  function persist() {
    serializeSessions(sessions.value);
    if (typeof window !== 'undefined') {
      localStorage.setItem(ACTIVE_SESSION_KEY, activeConversationId.value);
    }
  }

  /** 每次消息变动都要调：更新时间戳、按首条用户消息生成标题、落盘 */
  function touch() {
    activeSession.value.updatedAt = Date.now();
    activeSession.value.title = buildSessionTitle(activeSession.value.messages);
    persist();
  }

  function switchSession(sessionId: string, locked: boolean) {
    if (sessionId === activeConversationId.value || locked) {
      return;
    }

    activeConversationId.value = sessionId;
    ui.clearMessages();
    persist();
    ui.closeSidebar();
  }

  function createNewSession(locked: boolean) {
    if (locked) {
      return;
    }

    const session = createSession();
    sessions.value = [session, ...sessions.value.filter((item) => item.id !== session.id)];
    activeConversationId.value = session.id;
    ui.errorMessage = '';
    ui.notify('已创建新的对话。');
    persist();
    ui.closeSidebar();
  }

  function deleteSession(sessionId: string, locked: boolean) {
    // 至少保留一个会话，否则界面会没有可用上下文
    if (locked || sessions.value.length === 1) {
      return;
    }

    const nextSessions = sessions.value.filter((session) => session.id !== sessionId);
    if (!nextSessions.length) {
      return;
    }

    sessions.value = nextSessions;
    if (activeConversationId.value === sessionId) {
      activeConversationId.value = nextSessions[0].id;
    }
    ui.errorMessage = '';
    ui.notify('会话已删除。');
    persist();
  }

  function clearMessages(locked: boolean) {
    if (locked) {
      return;
    }

    activeSession.value.messages = [
      createInitialAssistantMessage('新的会话已开始。你可以继续提问，或者上传文件后让我使用向量知识库来辅助回答。')
    ];
    activeSession.value.updatedAt = Date.now();
    activeSession.value.title = '新对话';
    ui.errorMessage = '';
    ui.notify('当前会话已清空。');
    persist();
  }

  return {
    sessions,
    activeConversationId,
    activeSession,
    messages,
    messageCount,
    sessionList,
    persist,
    touch,
    switchSession,
    createNewSession,
    deleteSession,
    clearMessages
  };
});
