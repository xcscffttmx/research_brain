import { computed, ref } from 'vue';

export type VoiceStatus = 'idle' | 'recording' | 'processing';

export function useSpeechRecognition(onText: (text: string) => void) {
  const status = ref<VoiceStatus>('idle');
  const error = ref('');
  let recognition: SpeechRecognition | null = null;

  const supported = computed(() => typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition));

  const stop = () => {
    recognition?.stop();
    status.value = 'processing';
  };

  const start = () => {
    error.value = '';

    const SpeechRecognitionConstructor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionConstructor) {
      error.value = '当前浏览器不支持语音识别';
      return;
    }

    recognition = new SpeechRecognitionConstructor();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join('');

      if (transcript.trim()) {
        onText(transcript.trim());
      }
    };

    recognition.onerror = (event) => {
      error.value = `语音识别失败：${event.error}`;
      status.value = 'idle';
    };

    recognition.onend = () => {
      status.value = 'idle';
    };

    recognition.start();
    status.value = 'recording';
  };

  return {
    error,
    start,
    status,
    stop,
    supported
  };
}
