/**
 * 录制真实 SSE token 到达时间线，供渲染频率基准使用。
 *
 * 用法（需先启动后端）：
 *   node scripts/recordStreamTimeline.mjs "你的问题"
 * 产物：bench/stream-timeline.json —— [{ atMs, chars }]，atMs 为相对首个 delta 的毫秒数
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const question = process.argv[2] || '请用 600 字左右详细讲解 RAG 的检索、精排与生成三个阶段各自的作用。';
const port = process.env.SERVER_PORT || 8788;
const outputFile = path.resolve('bench/stream-timeline.json');

const response = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: question }] })
});

if (!response.ok || !response.body) {
  throw new Error(`请求失败：${response.status}`);
}

const reader = response.body.getReader();
const decoder = new TextDecoder('utf-8');
let buffer = '';
let startedAt = null;
const timeline = [];

while (true) {
  const { value, done } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const frames = buffer.split('\n\n');
  buffer = frames.pop() ?? '';

  for (const frame of frames) {
    const event = frame.match(/^event: (.+)$/m)?.[1];
    if (event !== 'delta') continue;

    const data = frame.match(/^data: (.+)$/m)?.[1];
    const text = data ? (JSON.parse(data).text ?? '') : '';
    if (!text) continue;

    const at = performance.now();
    if (startedAt === null) startedAt = at;
    timeline.push({ atMs: Number((at - startedAt).toFixed(2)), chars: text.length });
  }
}

await fs.mkdir(path.dirname(outputFile), { recursive: true });
await fs.writeFile(outputFile, JSON.stringify(timeline), 'utf-8');

const durationMs = timeline.at(-1)?.atMs ?? 0;
console.log(
  `已录制 ${timeline.length} 个 delta，时长 ${Math.round(durationMs)}ms，` +
    `平均到达频率 ${durationMs > 0 ? (timeline.length / (durationMs / 1000)).toFixed(1) : 0} 次/s`
);
console.log(`写入 ${outputFile}`);
