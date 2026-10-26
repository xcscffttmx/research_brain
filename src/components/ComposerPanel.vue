<template>
  <section class="composer-shell">
    <div class="composer-toolbar">
      <div class="composer-status-group">
        <el-tag :type="ragEnabled ? 'primary' : 'info'" effect="light" round>
          {{ ragEnabled ? 'RAG 已启用' : 'RAG 已关闭' }}
        </el-tag>
        <el-tag type="info" effect="plain" round>{{ documentCount }} 份文档</el-tag>
      </div>
    </div>

    <el-input
      :model-value="modelValue"
      class="composer-input"
      type="textarea"
      :autosize="{ minRows: 3, maxRows: 8 }"
      resize="none"
      placeholder="问问 research-agent：请结合知识库总结当前项目的 RAG 与工具调用链路"
      @update:model-value="$emit('update:modelValue', $event)"
      @keydown.enter.exact.prevent="$emit('submit')"
    />

    <div class="composer-footer">
      <input
        ref="fileInput"
        class="composer-file-input"
        type="file"
        accept=".md,.markdown,.txt,.json,.pdf,.docx"
        multiple
        @change="handleFiles"
      />
      <!-- 左侧：上传附件「加号」图标 -->
      <button type="button" class="composer-icon-btn" title="上传文档" aria-label="上传文档" @click="openFilePicker">
        <svg class="composer-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 5v14M5 12h14" stroke-linecap="round" />
        </svg>
      </button>

      <p class="composer-hint">
        Enter 发送，Shift + Enter 换行
        <span v-if="voiceError"> · {{ voiceError }}</span>
      </p>

      <div class="composer-right-actions">
        <!-- 右侧：语音输入「话筒」图标 -->
        <button
          type="button"
          class="composer-icon-btn composer-voice-btn"
          :class="{ 'is-recording': voiceStatus === 'recording' }"
          :disabled="!voiceSupported || voiceStatus === 'processing'"
          :title="voiceButtonLabel"
          :aria-label="voiceButtonLabel"
          @click="$emit('voice')"
        >
          <svg class="composer-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="2.5" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0014 0" stroke-linecap="round" />
            <path d="M12 18v3" stroke-linecap="round" />
          </svg>
        </button>
        <el-button
          type="primary"
          :loading="disabled"
          :disabled="disabled || !modelValue.trim()"
          @click="$emit('submit')"
        >
          {{ disabled ? '思考中…' : '发送' }}
        </el-button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
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

const emit = defineEmits<{
  'update:modelValue': [value: string];
  submit: [];
  voice: [];
  upload: [files: FileList];
}>();

const fileInput = ref<HTMLInputElement | null>(null);

function openFilePicker() {
  fileInput.value?.click();
}

/** 选中文件后透传给上层上传；重置 input 以便再次选择同一文件 */
function handleFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) {
    emit('upload', input.files);
    input.value = '';
  }
}

const voiceButtonLabel = computed(() => {
  if (!props.voiceSupported) return '语音不可用';
  if (props.voiceStatus === 'recording') return '停止录音';
  if (props.voiceStatus === 'processing') return '识别中';
  return '语音输入';
});
</script>

<style scoped>
/* 文件选择器由「加号」按钮触发，本身不可见 */
.composer-file-input {
  display: none;
}

.composer-footer {
  margin-top: 4px;
}

.composer-footer .composer-hint {
  flex: 1;
  text-align: left;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.composer-right-actions {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.composer-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--panel-line, #e2e3e5);
  background: transparent;
  color: var(--heading, #202124);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease,
    border-color 0.15s ease;
}

.composer-icon-btn:hover {
  background: rgba(0, 0, 0, 0.05);
  border-color: rgba(0, 0, 0, 0.15);
}

.composer-icon-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.composer-icon {
  width: 18px;
  height: 18px;
}

.composer-voice-btn.is-recording {
  color: var(--danger, #f56c6c);
  border-color: var(--danger, #f56c6c);
  background: rgba(245, 108, 108, 0.12);
}
</style>
