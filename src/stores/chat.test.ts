import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * 门面校验：组件只依赖 useChatStore，拆分后转发出去的字段必须仍可读、可写。
 *
 * chatHelpers 在模块加载时就会读 localStorage，所以 stub 必须先装好再动态 import。
 */

async function loadStore() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear()
  });
  vi.stubGlobal('window', { localStorage });
  vi.stubGlobal('crypto', { randomUUID: () => `uuid-${store.size}-${Math.trunc(performance.now())}` });

  vi.resetModules();
  const { useChatStore } = await import('./chat');
  setActivePinia(createPinia());
  return useChatStore();
}

describe('useChatStore 门面', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('转发会话数据', async () => {
    const chat = await loadStore();

    expect(chat.messages.length).toBe(1);
    expect(chat.messageCount).toBe(1);
    expect(chat.sessionList.length).toBe(1);
    expect(chat.activeConversationId).toBe(chat.activeSession.id);
  });

  it('转发的提示文案可写', async () => {
    const chat = await loadStore();

    chat.errorMessage = '出错了';
    chat.noticeMessage = '提示';

    expect(chat.errorMessage).toBe('出错了');
    expect(chat.noticeMessage).toBe('提示');
  });

  it('新建会话后切到新会话并清空输入', async () => {
    const chat = await loadStore();
    const firstId = chat.activeConversationId;
    chat.appendInput('草稿');

    chat.createNewSession();

    expect(chat.activeConversationId).not.toBe(firstId);
    expect(chat.sessionList.length).toBe(2);
    expect(chat.input).toBe('');
    expect(chat.noticeMessage).toBe('已创建新的对话。');
  });

  it('删除会话后回落到剩余会话，且不允许删到零', async () => {
    const chat = await loadStore();
    chat.createNewSession();
    const current = chat.activeConversationId;

    chat.deleteSession(current);
    expect(chat.sessionList.length).toBe(1);
    expect(chat.activeConversationId).not.toBe(current);

    chat.deleteSession(chat.activeConversationId);
    expect(chat.sessionList.length).toBe(1);
  });

  it('响应中不允许切换或新建会话', async () => {
    const chat = await loadStore();
    const firstId = chat.activeConversationId;
    chat.createNewSession();
    const secondId = chat.activeConversationId;

    chat.isResponding = true;
    chat.switchSession(firstId);
    chat.createNewSession();

    expect(chat.activeConversationId).toBe(secondId);
    expect(chat.sessionList.length).toBe(2);
  });

  it('toggleRag 同时改状态与提示', async () => {
    const chat = await loadStore();

    chat.toggleRag();
    expect(chat.ragEnabled).toBe(false);
    expect(chat.noticeMessage).toBe('已关闭 RAG 检索。');

    chat.toggleRag();
    expect(chat.ragEnabled).toBe(true);
  });

  it('侧边栏开合经由 ui store 转发', async () => {
    const chat = await loadStore();

    expect(chat.sidebarOpen).toBe(false);
    chat.toggleSidebar();
    expect(chat.sidebarOpen).toBe(true);
    chat.closeSidebar();
    expect(chat.sidebarOpen).toBe(false);
  });
});
