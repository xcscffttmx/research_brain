<template>
  <article class="message-row" :class="[`message-${message.role}`]">
    <div class="avatar-dot">{{ avatar }}</div>
    <div class="message-main">
      <div class="message-meta">
        <strong>{{ roleLabel }}</strong>
        <span>{{ timeLabel }}</span>
        <el-tag v-if="message.status === 'streaming'" type="primary" size="small" effect="light" round>
          流式输出中
        </el-tag>
        <el-tag v-else-if="message.status === 'error'" type="danger" size="small" effect="light" round>
          输出失败
        </el-tag>
      </div>

      <div class="message-content" v-html="html"></div>

      <el-collapse v-if="message.tools?.length" class="tool-panel">
        <el-collapse-item name="tools">
          <template #title>
            <span class="tool-panel-title">
              工具调用 {{ message.tools.length }} 次
              <el-tag v-for="(toolName, index) in toolNames" :key="`${toolName}-${index}`" size="small" effect="plain">
                {{ toolName }}
              </el-tag>
            </span>
          </template>
          <article v-for="tool in message.tools" :key="tool.id" class="tool-card">
            <div class="tool-topline">
              <strong>{{ tool.name }}</strong>
              <el-tag :type="TOOL_TAG_TYPE[tool.status]" size="small" effect="light">{{ tool.status }}</el-tag>
            </div>
            <pre>{{ JSON.stringify(tool.args, null, 2) }}</pre>
            <p v-if="tool.result">{{ tool.result }}</p>
          </article>
        </el-collapse-item>
      </el-collapse>

      <section v-if="message.citations?.length" class="source-panel">
        <div class="source-header">
          <strong>参考来源</strong>
          <span>{{ message.citations.length }} 条命中</span>
        </div>
        <article v-for="(citation, index) in message.citations" :key="citation.id" class="source-card">
          <div class="source-title-line">
            <el-tag size="small" effect="dark" round>{{ index + 1 }}</el-tag>
            <strong>{{ citation.title }}</strong>
            <el-tag v-if="citation.score" size="small" type="info" effect="plain">
              相关度 {{ citation.score }}
            </el-tag>
          </div>
          <p>{{ citation.snippet }}</p>
          <small>{{ citation.source }}</small>
        </article>
      </section>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '@/services/markdown';
import type { ChatMessage, ToolStatus } from '@/types/chat';

const props = defineProps<{
  message: ChatMessage;
}>();

/** 工具状态到 el-tag 语义色的映射 */
const TOOL_TAG_TYPE: Record<ToolStatus, 'info' | 'primary' | 'success' | 'danger'> = {
  pending: 'info',
  running: 'primary',
  success: 'success',
  error: 'danger'
};

const html = computed(() => renderMarkdown(props.message.content || (props.message.status === 'streaming' ? '正在思考中…' : '')));
const roleLabel = computed(() => (props.message.role === 'assistant' ? 'research-agent' : '你'));
const avatar = computed(() => (props.message.role === 'assistant' ? '✦' : '你'));
const timeLabel = computed(() =>
  new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(props.message.createdAt)
);

const toolNames = computed(() => {
  const names = (props.message.tools || []).map((tool) => tool.name).filter(Boolean);
  return Array.from(new Set(names));
});
</script>
