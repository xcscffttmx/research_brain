<template>
  <main class="research-agent-page">
    <div v-if="store.sidebarOpen" class="mobile-mask" @click="store.closeSidebar"></div>

    <section class="app-layout">
      <aside class="sidebar-shell" :class="{ 'sidebar-open': store.sidebarOpen }">
        <!-- 顶部 Logo -->
        <div class="sidebar-branding">
          <div class="logo-glyph" aria-hidden="true">
            <span class="logo-core">✦</span>
            <span class="logo-orbit logo-orbit-a"></span>
            <span class="logo-orbit logo-orbit-b"></span>
          </div>
          <div class="brand-copy">
            <p class="sidebar-overline">research-agent workspace</p>
            <h2>research-agent</h2>
            <span class="brand-subline">多 Agent 科研小助手</span>
          </div>
        </div>

        <!-- 新对话按钮 -->
        <el-button
          class="new-chat-btn"
          type="primary"
          size="large"
          :disabled="store.isResponding"
          @click="handleNewChat"
        >
          <span class="new-chat-icon" aria-hidden="true">＋</span>
          <span>新对话</span>
        </el-button>

        <!-- 导航菜单 -->
        <nav class="sidebar-nav-menu" aria-label="主导航">
          <button type="button" class="nav-menu-item" @click="goToKnowledgeBase">
            <span class="nav-menu-icon" aria-hidden="true">
              <svg class="icon-svg icon-svg--22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 19.5A2.5 2.5 0 016.5 17H20" stroke-linecap="round" />
                <path
                  d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <span>向量知识库</span>
          </button>
          <button type="button" class="nav-menu-item" @click="toggleAgentPanel">
            <span class="nav-menu-icon" aria-hidden="true">
              <svg class="icon-svg icon-svg--22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="8" width="12" height="10" rx="2" />
                <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" />
                <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" />
                <path d="M9 16h6" stroke-linecap="round" />
                <path d="M12 8V6M10 4h4" stroke-linecap="round" />
              </svg>
            </span>
            <span>科研 Agent</span>
            <span class="nav-menu-arrow" aria-hidden="true">›</span>
          </button>
          <button type="button" class="nav-menu-item" disabled>
            <span class="nav-menu-icon" aria-hidden="true">
              <svg class="icon-svg icon-svg--22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3" />
                <path
                  d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
                  stroke-linecap="round"
                />
              </svg>
            </span>
            <span>更多</span>
            <span class="nav-menu-arrow" aria-hidden="true">›</span>
          </button>
        </nav>

        <!-- 历史会话 -->
        <div class="history-section">
          <div class="history-header">
            <span class="history-label">历史对话</span>
          </div>
          <el-scrollbar class="history-list">
            <div
              v-for="session in store.sessionList"
              :key="session.id"
              class="history-row"
              :class="{ 'history-item-active': session.id === store.activeConversationId }"
            >
              <button type="button" class="history-item-main" @click="store.switchSession(session.id)">
                <span class="history-item-icon" aria-hidden="true">
                  <svg
                    class="icon-svg icon-svg--20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke-linejoin="round" />
                  </svg>
                </span>
                <span class="history-item-title">{{ session.title || '新对话' }}</span>
              </button>
              <el-popconfirm
                title="删除这个会话？删除后不可恢复。"
                confirm-button-text="删除"
                cancel-button-text="取消"
                confirm-button-type="danger"
                @confirm="store.deleteSession(session.id)"
              >
                <template #reference>
                  <button type="button" class="history-item-delete" aria-label="删除会话" @click.stop>
                    <svg
                      class="icon-svg icon-svg--20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      aria-hidden="true"
                    >
                      <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" />
                    </svg>
                  </button>
                </template>
              </el-popconfirm>
            </div>
            <el-empty v-if="store.sessionList.length === 0" description="暂无历史对话" :image-size="48" />
          </el-scrollbar>
        </div>
      </aside>

      <section class="main-shell">
        <TopBar
          :conversation-id="store.activeConversationId"
          :disabled="store.isResponding"
          :document-count="store.documentCount"
          :is-responding="store.isResponding"
          :message-count="store.messageCount"
          :rag-enabled="store.ragEnabled"
          @menu="store.toggleSidebar"
          @new-session="handleNewChat"
          @stop="store.stopStreaming"
          @toggle-rag="store.toggleRag"
        />

        <AgentTimeline :stage="store.agentStage" :plan="store.activePlan" :verification="store.answerVerification" />

        <AsyncChatPanel :messages="store.messages" />

        <el-alert
          v-if="store.noticeMessage"
          class="notice-banner"
          type="info"
          :title="store.noticeMessage"
          :closable="false"
          show-icon
        />
        <el-alert
          v-if="store.errorMessage"
          class="error-banner"
          type="error"
          :title="store.errorMessage"
          :closable="false"
          show-icon
        />

        <ComposerPanel
          v-model="store.input"
          :disabled="store.isResponding"
          :document-count="store.documentCount"
          :rag-enabled="store.ragEnabled"
          :voice-error="speech.error.value"
          :voice-status="speech.status.value"
          :voice-supported="speech.supported.value"
          @submit="store.sendMessage()"
          @voice="handleVoice"
        />
      </section>
    </section>

    <!-- Agent 选择弹窗 -->
    <el-dialog v-model="showAgentPanel" title="选择科研 Agent" width="520px" align-center>
      <div class="agent-modal-list">
        <button
          v-for="agent in agents"
          :key="agent.id"
          type="button"
          class="agent-modal-item"
          @click="selectAgent(agent.id)"
        >
          <div class="agent-modal-icon" aria-hidden="true">{{ agent.badge }}</div>
          <div class="agent-modal-info">
            <strong>{{ agent.name }}</strong>
            <p>{{ agent.description }}</p>
          </div>
        </button>
      </div>
    </el-dialog>
  </main>
</template>

<script setup lang="ts">
import { ref, defineAsyncComponent, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import ComposerPanel from '@/components/ComposerPanel.vue';
import AgentTimeline from '@/components/AgentTimeline.vue';
import TopBar from '@/components/TopBar.vue';
import { useSpeechRecognition } from '@/composables/useSpeechRecognition';
import { useChatStore } from '@/stores/chat';

const AsyncChatPanel = defineAsyncComponent(() => import('@/components/ChatPanel.vue'));

const store = useChatStore();
const router = useRouter();
const speech = useSpeechRecognition((text) => {
  store.appendInput(text);
});

const showAgentPanel = ref(false);

const agents = [
  {
    id: 'literature-agent',
    name: '文献检索 Agent',
    description: '负责学术文献的搜索、分析和管理',
    badge: '文'
  },
  {
    id: 'writing-agent',
    name: '论文写作 Agent',
    description: '辅助科研论文的撰写、修改和优化',
    badge: '写'
  },
  {
    id: 'formula-agent',
    name: '公式推导 Agent',
    description: '支持数学公式的推导、验证和解释',
    badge: '式'
  }
];

onMounted(() => {
  store.refreshDocuments();
});

function handleNewChat() {
  store.startFreshConversation();
}

function handleVoice() {
  if (speech.status.value === 'recording') {
    speech.stop();
    return;
  }

  if (speech.status.value === 'idle') {
    speech.start();
  }
}

function goToKnowledgeBase() {
  router.push('/knowledge-base');
}

function toggleAgentPanel() {
  showAgentPanel.value = !showAgentPanel.value;
}

function selectAgent(agentId: string) {
  const agent = agents.find((a) => a.id === agentId);
  if (agent) {
    store.appendInput(`请使用 ${agent.name} 来帮助我`);
  }
  showAgentPanel.value = false;
}
</script>
