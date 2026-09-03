import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * 界面级提示与侧边栏开合。
 *
 * 单独成 store 的原因：会话、知识库、流式运行时都要写提示文案，
 * 放在任意一个业务 store 里都会造成反向依赖。
 */
export const useUiStore = defineStore('ui', () => {
  const errorMessage = ref('');
  const noticeMessage = ref('');
  const sidebarOpen = ref(false);

  function notify(message: string) {
    noticeMessage.value = message;
  }

  function fail(error: unknown, fallback: string) {
    errorMessage.value = error instanceof Error ? error.message : fallback;
    return errorMessage.value;
  }

  function clearMessages() {
    errorMessage.value = '';
    noticeMessage.value = '';
  }

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value;
  }

  function closeSidebar() {
    sidebarOpen.value = false;
  }

  return { errorMessage, noticeMessage, sidebarOpen, notify, fail, clearMessages, toggleSidebar, closeSidebar };
});
