/**
 * 服务端通用工具函数。
 * 这些函数在被抽出前散落在 mcp-server 顶部，属于纯函数、无副作用。
 */

/** 生成带前缀的唯一 ID */
export function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** 折叠所有连续空白并去掉首尾空格 */
export function normalizeWhitespace(value: unknown = ''): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从 XML/HTML 片段中取第一个匹配的标签文本 */
export function pickText(raw: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = raw.match(regex);
  return normalizeWhitespace(match?.[1] || '');
}

/** 从 XML/HTML 片段中取所有匹配标签的文本列表 */
export function pickAllTexts(raw: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const values: string[] = [];
  let match = regex.exec(raw);
  while (match) {
    values.push(normalizeWhitespace(match[1]));
    match = regex.exec(raw);
  }
  return values.filter(Boolean);
}
