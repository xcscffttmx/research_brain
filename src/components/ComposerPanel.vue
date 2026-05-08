<template>
  <section class="composer-shell">
    <div class="composer-toolbar">
      <div class="composer-status-group">
        <span class="status-badge">{{ ragEnabled ? 'RAG 已启用' : 'RAG 已关闭' }}</span>
        <span class="status-badge soft">{{ documentCount }} 份文档</span>
      </div>
      <div class="composer-toolbox">
        <button class="tool-button" :class="[`voice-${voiceStatus}`]" :disabled="!voiceSupported" @click="$emit('voice')">
          {{ voiceButtonLabel }}
        </button>
      </div>
    </div>

    <textarea
      :value="modelValue"
      class="composer-input"
      placeholder="问问 research-agent：请结合知识库总结当前项目的 RAG 与工具调用链路"
      @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      @keydown.enter.exact.prevent="$emit('submit')"
    />

    <div class="composer-footer">
      <p class="composer-hint">
        Enter 发送，Shift + Enter 换行
        <span v-if="voiceError"> · {{ voiceError }}</span>
      </p>
      <button class="send-action" :disabled="disabled || !modelValue.trim()" @click="$emit('submit')">
        {{ disabled ? '思考中…' : '发送' }}
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { VoiceStatus } from '@/composables/useSpeechRecognition';

const props = defineProps<{
  modelValue: string;
  disabled: boolean;
  ragEnabled: boolean;
  documentCount: number;
  voiceSupported: boolean;
  voiceStatus: VoiceStatus;
  voiceError: string;
}>();

defineEmits<{
  'update:modelValue': [value: string];
  submit: [];
  voice: [];
}>();

const voiceButtonLabel = computed(() => {
  if (!props.voiceSupported) return '语音不可用';
  if (props.voiceStatus === 'recording') return '停止录音';
  if (props.voiceStatus === 'processing') return '识别中';
  return '语音输入';
});
</script>
