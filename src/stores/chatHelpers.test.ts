import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ACTIVE_SESSION_KEY,
  SESSION_STORAGE_KEY,
  buildSessionTitle,
  createSession,
  deserializeSessions,
  mergeTool,
  serializeSessions,
  toConversationMessages
} from './chatHelpers';
import type { ChatMessage, ToolInvocation } from '@/types/chat';

function message(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: `${role}-${content}`, role, content, createdAt: 0, status: 'done' };
}

/** node 环境没有 localStorage/crypto，这里装一个最小实现 */
function installBrowserStubs() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear()
  });
  vi.stubGlobal('window', { localStorage });
  return store;
}

describe('toConversationMessages', () => {
  it('过滤掉 system/tool 消息', () => {
    const result = toConversationMessages([
      message('system', '系统提示'),
      message('user', '问题'),
      message('tool', '工具输出'),
      message('assistant', '回答')
    ]);

    expect(result).toEqual([
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答' }
    ]);
  });

  it('只保留最近 12 条', () => {
    const many = Array.from({ length: 30 }, (_, index) => message('user', `第 ${index} 条`));
    const result = toConversationMessages(many);

    expect(result).toHaveLength(12);
    expect(result[0].content).toBe('第 18 条');
    expect(result.at(-1)!.content).toBe('第 29 条');
  });
});

describe('buildSessionTitle', () => {
  it('取首条非空用户消息', () => {
    expect(buildSessionTitle([message('assistant', '欢迎'), message('user', '什么是 RAG')])).toBe('什么是 RAG');
  });

  it('超长标题截断到 24 字', () => {
    const long = 'x'.repeat(50);
    expect(buildSessionTitle([message('user', long)])).toHaveLength(24);
  });

  it('没有用户消息时回落到默认标题', () => {
    expect(buildSessionTitle([message('assistant', '欢迎')])).toBe('新对话');
    expect(buildSessionTitle([message('user', '   ')])).toBe('新对话');
  });
});

describe('mergeTool', () => {
  const base: ToolInvocation = { id: 'tool-1', name: 'retrieve_knowledge', args: {}, status: 'running' };

  it('同 id 就地更新而不是追加', () => {
    const tools = [{ ...base }];
    mergeTool(tools, { ...base, status: 'success', result: 'ok' });

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ status: 'success', result: 'ok' });
  });

  it('新 id 追加到末尾', () => {
    const tools = [{ ...base }];
    mergeTool(tools, { ...base, id: 'tool-2' });

    expect(tools.map((tool) => tool.id)).toEqual(['tool-1', 'tool-2']);
  });
});

describe('deserializeSessions', () => {
  beforeEach(() => {
    installBrowserStubs();
    vi.stubGlobal('crypto', { randomUUID: () => 'fixed-uuid' });
  });

  it('没有存储记录时创建初始会话', () => {
    const result = deserializeSessions();

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].messages).toHaveLength(1);
    expect(result.activeSessionId).toBe(result.sessions[0].id);
  });

  it('脏 JSON 不会抛异常，回落到新会话', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, '{ not json');

    const result = deserializeSessions();
    expect(result.sessions).toHaveLength(1);
  });

  it('缺字段的记录被补齐', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify([{ id: 'session-old', title: '  ', messages: [] }]));

    const result = deserializeSessions();
    expect(result.sessions[0].title).toBe('新对话');
    expect(result.sessions[0].messages).toHaveLength(1);
    expect(typeof result.sessions[0].createdAt).toBe('number');
    expect(typeof result.sessions[0].updatedAt).toBe('number');
  });

  it('存储的 activeSessionId 不存在时回落到第一条', () => {
    const session = createSession();
    serializeSessions([session]);
    localStorage.setItem(ACTIVE_SESSION_KEY, 'session-not-exist');

    const result = deserializeSessions();
    expect(result.activeSessionId).toBe(session.id);
  });
});
