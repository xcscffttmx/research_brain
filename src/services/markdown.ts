import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
});

export function renderMarkdown(content: string) {
  return DOMPurify.sanitize(md.render(content));
}
