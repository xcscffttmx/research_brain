import type { ChatMessage, ChatSession, QwenMessage, ToolInvocation } from '@/types/chat';

/**
 * 会话数据的纯函数工具集。
 *
 * 从 store 里抽出来是为了可测试：这些逻辑（标题生成、历史裁剪、localStorage 容错）
 * 不依赖 Pinia 与浏览器状态机，单测直接调。
 */

export const SESSION_STORAGE_KEY = 'research-agent-chat-sessions-v2';
export const ACTIVE_SESSION_KEY = 'research-agent-active-session-id-v2';

/** 发给模型的历史条数上限，超出部分靠服务端的分层 Context 兜 */
const CONVERSATION_WINDOW = 12;
/** 会话标题取首条用户消息的前 N 个字符 */
const TITLE_MAX_CHARS = 24;

const WELCOME_TEXT =
  '你好，我是你的 research-agent 助手。你可以直接提问，也可以先上传资料，让我通过后端向量检索结合工具调用来回答。';

export function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function createMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id: uid(role),
    role,
    content,
    createdAt: Date.now(),
    status: 'idle'
  };
}

export function createInitialAssistantMessage(content: string) {
  const message = createMessage('assistant', content);
  message.status = 'done';
  return message;
}

export function createSession(title = '新对话'): ChatSession {
  const now = Date.now();
  return {
    id: uid('session'),
    title,
    createdAt: now,
    updatedAt: now,
    messages: [createInitialAssistantMessage(WELCOME_TEXT)]
  };
}

/** 只保留 user/assistant 的最近若干条，system/tool 消息不进模型上下文 */
export function toConversationMessages(messages: ChatMessage[]): QwenMessage[] {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-CONVERSATION_WINDOW)
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content
    }));
}

/** 同 id 的工具调用就地更新，否则追加：tool_call 与 tool_result 是两个事件 */
export function mergeTool(tools: ToolInvocation[], nextTool: ToolInvocation) {
  const current = tools.find((item) => item.id === nextTool.id);
  if (current) {
    Object.assign(current, nextTool);
    return;
  }

  tools.push(nextTool);
}

export function buildSessionTitle(messages: ChatMessage[]) {
  const userMessage = messages.find((message) => message.role === 'user' && message.content.trim());
  if (!userMessage) {
    return '新对话';
  }

  return userMessage.content.trim().slice(0, TITLE_MAX_CHARS) || '新对话';
}

export function serializeSessions(sessions: ChatSession[]) {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
}

/** 反序列化必须对脏数据免疫：早期版本写入的记录可能缺字段 */
export function deserializeSessions() {
  if (typeof window === 'undefined') {
    return { sessions: [createSession()], activeSessionId: '' };
  }

  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  const activeSessionId = localStorage.getItem(ACTIVE_SESSION_KEY) || '';

  if (!raw) {
    const session = createSession();
    return { sessions: [session], activeSessionId: session.id };
  }

  try {
    const parsed = JSON.parse(raw) as ChatSession[];
    if (!Array.isArray(parsed) || !parsed.length) {
      const session = createSession();
      return { sessions: [session], activeSessionId: session.id };
    }

    const normalized = parsed.map((session) => {
      const title = typeof session.title === 'string' && session.title.trim() ? session.title : '新对话';
      const messages =
        Array.isArray(session.messages) && session.messages.length
          ? session.messages
          : [createInitialAssistantMessage('你好，我是你的 research-agent 助手。')];

      return {
        ...session,
        title,
        messages,
        updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : Date.now(),
        createdAt: typeof session.createdAt === 'number' ? session.createdAt : Date.now()
      };
    });

    return {
      sessions: normalized,
      activeSessionId: normalized.some((session) => session.id === activeSessionId) ? activeSessionId : normalized[0].id
    };
  } catch {
    const session = createSession();
    return { sessions: [session], activeSessionId: session.id };
  }
}
