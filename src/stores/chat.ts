import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { abortAgentRun, streamAgentChat } from '@/services/qwen';
import type { AgentPlan, AnswerVerification, ChatMessage, PlanStopEarly } from '@/types/chat';
import { useRenderBuffer } from '@/composables/useRenderBuffer';
import { useTypewriter } from '@/composables/useTypewriter';
import { readStopEarly } from '@/utils/agentStage';
import { createMessage, mergeTool, toConversationMessages, uid } from './chatHelpers';
import { useKnowledgeStore } from './knowledge';
import { useSessionStore } from './session';
import { useUiStore } from './ui';

/** 关闭 RAG 时插在历史最前面的软约束，比直接不给工具更少破坏模型规划 */
const RAG_DISABLED_HINT = '请注意：本轮对话用户关闭了 RAG，如果不是必须，不要调用 retrieve_knowledge。';

/**
 * 对话主 store：持有输入框、流式运行时状态与一次 Agent 回合的完整编排。
 *
 * 会话数据在 useSessionStore，知识库在 useKnowledgeStore，提示文案在 useUiStore；
 * 这里把它们再导出一遍，组件仍然只依赖 useChatStore 一个入口。
 */
export const useChatStore = defineStore('chat', () => {
  const ui = useUiStore();
  const sessionStore = useSessionStore();
  const knowledgeStore = useKnowledgeStore();

  const input = ref('');
  const isResponding = ref(false);
  const ragEnabled = ref(true);
  const abortController = ref<AbortController | null>(null);
  /** 当前 Agent run 的 id 与规划，用于精确取消和时间线展示 */
  const activeRunId = ref<string | null>(null);
  const activePlan = ref<AgentPlan | null>(null);
  const agentStage = ref('');
  /** 命中终止条件提前结束的信息，正常走完为 null */
  const planStopEarly = ref<PlanStopEarly | null>(null);
  /** 最近一轮回答的 groundedness 校验结果 */
  const answerVerification = ref<AnswerVerification | null>(null);
  /** 当前流的打字机与渲染缓冲实例，以及上一轮的刷新统计（性能演示用） */
  const typewriterRef = ref<ReturnType<typeof useTypewriter> | null>(null);
  const renderBufferRef = ref<ReturnType<typeof useRenderBuffer> | null>(null);
  const renderStats = ref<ReturnType<typeof useRenderBuffer>['stats'] | null>(null);

  function appendInput(text: string) {
    input.value = text;
  }

  function toggleRag() {
    ragEnabled.value = !ragEnabled.value;
    ui.notify(ragEnabled.value ? '已启用 RAG 检索。' : '已关闭 RAG 检索。');
  }

  function switchSession(sessionId: string) {
    sessionStore.switchSession(sessionId, isResponding.value);
    if (!isResponding.value) input.value = '';
  }

  function createNewSession() {
    sessionStore.createNewSession(isResponding.value);
    if (!isResponding.value) input.value = '';
  }

  function deleteSession(sessionId: string) {
    sessionStore.deleteSession(sessionId, isResponding.value);
  }

  function clearMessages() {
    sessionStore.clearMessages(isResponding.value);
    if (!isResponding.value) input.value = '';
  }

  function startFreshConversation() {
    createNewSession();
  }

  function stopStreaming() {
    // 先把打字机队列和缓冲里已收到的内容补出来，避免用户点停止后丢掉最后一小段
    typewriterRef.value?.flush();
    renderBufferRef.value?.flush();

    // 先显式通知服务端取消 run，再断开连接：让取消树能立刻回收在途工具调用
    if (activeRunId.value) {
      void abortAgentRun(activeRunId.value);
      activeRunId.value = null;
    }

    abortController.value?.abort();
    abortController.value = null;
    isResponding.value = false;

    const assistantMessage = [...sessionStore.activeSession.messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.status === 'streaming');
    if (assistantMessage) {
      assistantMessage.status = assistantMessage.content.trim() ? 'done' : 'error';
      if (!assistantMessage.content.trim()) {
        assistantMessage.content = '已停止本次输出。';
      }
    }

    ui.notify('已停止生成。');
    sessionStore.touch();
  }

  async function sendMessage(raw?: string) {
    const content = (raw ?? input.value).trim();
    if (!content || isResponding.value) {
      return;
    }

    ui.clearMessages();

    sessionStore.activeSession.messages.push(createMessage('user', content));
    input.value = '';
    isResponding.value = true;
    sessionStore.touch();

    const assistantMessageDraft: ChatMessage = {
      id: uid('assistant'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'streaming',
      citations: [],
      tools: []
    };

    sessionStore.activeSession.messages.push(assistantMessageDraft);
    const assistantMessage = sessionStore.activeSession.messages[
      sessionStore.activeSession.messages.length - 1
    ] as ChatMessage;
    sessionStore.touch();

    const controller = new AbortController();
    abortController.value = controller;
    activeRunId.value = null;
    activePlan.value = null;
    agentStage.value = '';
    planStopEarly.value = null;
    answerVerification.value = null;

    // 流式 token 先进缓冲队列，由 rAF 批量写回响应式状态，避免每个字符触发一次渲染
    const renderBuffer = useRenderBuffer((text) => {
      assistantMessage.content += text;
      sessionStore.touch();
    });
    renderBufferRef.value = renderBuffer;

    // 服务端会把多个 token 攒成一个 delta 下发，先拆成逐字输出再交给缓冲队列合并
    const typewriter = useTypewriter((text) => renderBuffer.push(text));
    typewriterRef.value = typewriter;

    try {
      await streamAgentChat(
        [
          ...(ragEnabled.value ? [] : [{ role: 'user' as const, content: RAG_DISABLED_HINT }]),
          ...toConversationMessages(sessionStore.activeSession.messages.slice(0, -1))
        ],
        (event) => {
          if (event.type === 'token' && event.token) {
            typewriter.push(event.token);
          }

          if (event.type === 'plan') {
            activeRunId.value = event.runId ?? null;
            activePlan.value = event.plan ?? null;
          }

          if (event.type === 'status') {
            agentStage.value = event.stage || '';
            if (event.stage === 'run_started' && event.detail?.runId) {
              activeRunId.value = String(event.detail.runId);
            }
            if (event.stage === 'plan_stopped_early') {
              planStopEarly.value = readStopEarly(event.detail);
            }
          }

          if (event.type === 'tool' && event.tool) {
            mergeTool(assistantMessage.tools ?? (assistantMessage.tools = []), event.tool);
            sessionStore.touch();
          }

          if (event.type === 'citations' && event.citations) {
            assistantMessage.citations = event.citations;
            sessionStore.touch();
          }

          if (event.type === 'error') {
            // 报错要覆盖已渲染内容，先丢掉打字机与缓冲里未输出的字符
            typewriter.reset();
            renderBuffer.reset();
            assistantMessage.status = 'error';
            assistantMessage.content = event.details
              ? `${event.message || '请求失败'}\n${event.details}`
              : event.message || '请求失败';
            ui.errorMessage = assistantMessage.content;
            sessionStore.touch();
          }

          if (event.type === 'done') {
            // 结束时把打字机与缓冲里剩下的内容立刻补齐，不等下一帧
            typewriter.flush();
            renderBuffer.flush();
            if (event.citations?.length) {
              assistantMessage.citations = event.citations;
            }
            if (event.tools?.length) {
              assistantMessage.tools = event.tools;
            }
            if (event.verification) {
              answerVerification.value = event.verification;
            }
            if (assistantMessage.status !== 'error') {
              assistantMessage.status = 'done';
            }
            sessionStore.touch();
          }
        },
        controller.signal,
        sessionStore.activeSession.id
      );

      typewriter.flush();
      renderBuffer.flush();
      renderStats.value = renderBuffer.stats;

      if (!controller.signal.aborted && assistantMessage.status !== 'error') {
        assistantMessage.status = 'done';
      }
    } catch (error) {
      typewriter.flush();
      renderBuffer.flush();

      if (controller.signal.aborted) {
        return;
      }

      assistantMessage.status = 'error';
      assistantMessage.content = error instanceof Error ? error.message : '请求失败，请稍后重试。';
      ui.errorMessage = assistantMessage.content;
    } finally {
      if (abortController.value === controller) {
        abortController.value = null;
      }
      renderBufferRef.value = null;
      typewriterRef.value = null;
      activeRunId.value = null;
      agentStage.value = '';
      isResponding.value = false;
      sessionStore.touch();
    }
  }

  return {
    // 流式运行时
    input,
    isResponding,
    ragEnabled,
    activeRunId,
    activePlan,
    agentStage,
    planStopEarly,
    answerVerification,
    renderStats,
    appendInput,
    toggleRag,
    sendMessage,
    stopStreaming,
    // 会话（转发 useSessionStore）
    activeConversationId: computed(() => sessionStore.activeConversationId),
    activeSession: computed(() => sessionStore.activeSession),
    messages: computed(() => sessionStore.messages),
    messageCount: computed(() => sessionStore.messageCount),
    sessionList: computed(() => sessionStore.sessionList),
    switchSession,
    createNewSession,
    deleteSession,
    clearMessages,
    startFreshConversation,
    // 知识库（转发 useKnowledgeStore）
    documents: computed(() => knowledgeStore.documents),
    documentCount: computed(() => knowledgeStore.documentCount),
    refreshDocuments: knowledgeStore.refreshDocuments,
    uploadKnowledge: knowledgeStore.uploadKnowledge,
    removeDocument: knowledgeStore.removeDocument,
    clearKnowledge: knowledgeStore.clearKnowledge,
    // 界面提示（转发 useUiStore）
    errorMessage: computed({
      get: () => ui.errorMessage,
      set: (value: string) => {
        ui.errorMessage = value;
      }
    }),
    noticeMessage: computed({
      get: () => ui.noticeMessage,
      set: (value: string) => {
        ui.noticeMessage = value;
      }
    }),
    sidebarOpen: computed(() => ui.sidebarOpen),
    toggleSidebar: ui.toggleSidebar,
    closeSidebar: ui.closeSidebar
  };
});
