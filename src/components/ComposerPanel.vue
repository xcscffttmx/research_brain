<template>
  <section class="composer-shell">
    <div class="composer-toolbar">
      <div class="composer-status-group">
        <el-tag :type="ragEnabled ? 'primary' : 'info'" effect="light" round>
          {{ ragEnabled ? 'RAG 已启用' : 'RAG 已关闭' }}
        </el-tag>
        <el-tag type="info" effect="plain" round>{{ documentCount }} 份文档</el-tag>
      </div>
      <div class="composer-toolbox">
        <input
          ref="fileInput"
          class="composer-file-input"
          type="file"
          accept=".md,.markdown,.txt,.json,.pdf,.docx"
          multiple
          @change="handleFiles"
        />
        <el-button round @click="openFilePicker">上传文档</el-button>
        <el-button
          :type="voiceStatus === 'recording' ? 'danger' : 'default'"
          :disabled="!voiceSupported"
          :loading="voiceStatus === 'processing'"
          round
          @click="$emit('voice')"
        >
          {{ voiceButtonLabel }}
        </el-button>
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
      <p class="composer-hint">
        Enter 发送，Shift + Enter 换行
        <span v-if="voiceError"> · {{ voiceError }}</span>
      </p>
      <el-button type="primary" :loading="disabled" :disabled="disabled || !modelValue.trim()" @click="$emit('submit')">
        {{ disabled ? '思考中…' : '发送' }}
      </el-button>
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
/* 文件选择器由「上传文档」按钮触发，本身不可见 */
.composer-file-input {
  display: none;
}
</style>
