// ── blocks.js ──────────────────────────────────────────────────────────────
// Modelo de blocos do editor de notas (estilo Notion) e conversão a partir do
// markdown de texto puro que as versões anteriores salvavam (migração).

let uidCounter = 0;
export function uid() {
  return `b${Date.now().toString(36)}${(uidCounter++).toString(36)}`;
}

export function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Markdown inline → HTML real (usado só na migração de notas antigas) ──────
// Mesma regra do itálico de antes: sem espaço colado no asterisco, pra não
// colidir com "*" de multiplicação.
const INLINE_MD = [
  { re: /`([^`\n]+?)`/g, tag: 'code' },
  { re: /\*\*([^\n]+?)\*\*/g, tag: 'strong' },
  { re: /~~([^\n]+?)~~/g, tag: 's' },
  { re: /(?<!\*)\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?!\*)/g, tag: 'em' },
];

function parseInlineMarkdown(text) {
  const matches = [];
  for (const { re, tag } of INLINE_MD) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index, end = start + m[0].length;
      if (matches.some(e => e.start < end && e.end > start)) continue;
      matches.push({ start, end, tag, content: m[1] });
    }
  }
  matches.sort((a, b) => a.start - b.start);

  let html = '', pos = 0;
  for (const m of matches) {
    html += escHtml(text.slice(pos, m.start));
    html += `<${m.tag}>${escHtml(m.content)}</${m.tag}>`;
    pos = m.end;
  }
  html += escHtml(text.slice(pos));
  return html;
}

// ── Markdown (string) → blocos ────────────────────────────────────────────────
export function parseMarkdownToBlocks(markdown) {
  const lines = (markdown ?? '').split('\n');
  const blocks = [];
  let m;

  for (const line of lines) {
    if ((m = /^(#{1,6}) (.+)$/.exec(line))) {
      blocks.push({ id: uid(), type: `heading${m[1].length}`, html: parseInlineMarkdown(m[2]) });
    } else if ((m = /^([-*]) \[([ xX])\] (.+)$/.exec(line))) {
      blocks.push({ id: uid(), type: 'checklist', checked: /[xX]/.test(m[2]), html: parseInlineMarkdown(m[3]) });
    } else if ((m = /^[-*] (.+)$/.exec(line))) {
      blocks.push({ id: uid(), type: 'bullet', html: parseInlineMarkdown(m[1]) });
    } else if ((m = /^\d+\. (.+)$/.exec(line))) {
      blocks.push({ id: uid(), type: 'number', html: parseInlineMarkdown(m[1]) });
    } else if ((m = /^> ?(.+)$/.exec(line))) {
      blocks.push({ id: uid(), type: 'quote', html: parseInlineMarkdown(m[1]) });
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      blocks.push({ id: uid(), type: 'divider' });
    } else {
      blocks.push({ id: uid(), type: 'paragraph', html: parseInlineMarkdown(line) });
    }
  }

  if (blocks.length === 0) blocks.push({ id: uid(), type: 'paragraph', html: '' });
  return blocks;
}

// ── Blocos → texto simples (guardado só pra portabilidade/backup, não precisa
// reconstruir o markdown com perfeição) ───────────────────────────────────────
function htmlToPlainText(html) {
  const div = document.createElement('div');
  div.innerHTML = html ?? '';
  return div.textContent;
}

export function blocksToPlainText(blocks) {
  return (blocks ?? []).map(b => {
    const text = htmlToPlainText(b.html);
    switch (b.type) {
      case 'heading1': return `# ${text}`;
      case 'heading2': return `## ${text}`;
      case 'heading3': return `### ${text}`;
      case 'heading4': return `#### ${text}`;
      case 'heading5': return `##### ${text}`;
      case 'heading6': return `###### ${text}`;
      case 'bullet':   return `- ${text}`;
      case 'number':   return `1. ${text}`;
      case 'checklist':return `- [${b.checked ? 'x' : ' '}] ${text}`;
      case 'quote':    return `> ${text}`;
      case 'divider':  return '---';
      default:         return text;
    }
  }).join('\n');
}
