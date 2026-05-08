import type { ChatMessage } from '@/types/chat';

export async function* streamText(text: string): AsyncGenerator<string, void, unknown> {
  const encoder = new TextEncoder();
  const payload = encoder.encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0;
      const pump = () => {
        if (index >= payload.length) {
          controller.close();
          return;
        }

        const chunkSize = Math.min(payload.length - index, 12 + Math.floor(Math.random() * 16));
        controller.enqueue(payload.slice(index, index + chunkSize));
        index += chunkSize;
        window.setTimeout(pump, 30 + Math.random() * 40);
      };

      pump();
    }
  });

  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    yield decoder.decode(value, { stream: true });
  }
}

export function buildConversationSummary(messages: ChatMessage[]) {
  return messages
    .slice(-6)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');
}
