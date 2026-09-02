<template>
  <header class="topbar-shell">
    <div class="topbar-left">
      <el-button class="desktop-hidden" text circle aria-label="打开侧边菜单" @click="$emit('menu')">
        <svg
          class="icon-svg icon-svg--22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="M4 6h16M4 12h16M4 18h16" stroke-linecap="round" />
        </svg>
      </el-button>
      <div class="topbar-title-group">
        <h1>research-agent</h1>
        <p>{{ titleText }}</p>
      </div>
    </div>

    <div class="topbar-right">
      <el-button class="desktop-only-flex" text circle aria-label="展开侧边栏" @click="$emit('menu')">
        <svg
          class="icon-svg icon-svg--22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="M4 6h16M4 12h16M4 18h16" stroke-linecap="round" />
        </svg>
      </el-button>

      <el-tooltip :content="ragEnabled ? '关闭知识库检索' : '开启知识库检索'" placement="bottom">
        <el-switch
          :model-value="ragEnabled"
          active-text="RAG"
          aria-label="切换知识库检索"
          @change="$emit('toggle-rag')"
        />
      </el-tooltip>

      <el-tooltip :content="isDark ? '切换到亮色主题' : '切换到暗色主题'" placement="bottom">
        <el-button text circle aria-label="切换主题" @click="toggle">
          <svg
            class="icon-svg icon-svg--22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <path
              v-if="isDark"
              d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <template v-else>
              <circle cx="12" cy="12" r="4" />
              <path
                d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
                stroke-linecap="round"
              />
            </template>
          </svg>
        </el-button>
      </el-tooltip>

      <el-button :disabled="disabled" @click="$emit('new-session')">新对话</el-button>
      <el-button type="danger" plain :disabled="!isResponding" @click="$emit('stop')">停止输出</el-button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useTheme } from '@/composables/useTheme';

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

const { isDark, toggle } = useTheme();

const titleText = computed(
  () =>
    `research-agent · 会话 ${props.conversationId.slice(0, 8)} · ${props.messageCount} 条消息 · ${props.documentCount} 份知识文档`
);
</script>
