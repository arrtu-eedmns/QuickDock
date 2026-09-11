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
  // Normaliza quebras de linha (Windows manda \r\n) — sem isso, cada linha
  // fica com um \r sobrando no final e os regexes ancorados em "$" falham
  // silenciosamente, caindo pro parágrafo padrão.
  const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
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

// ── Blocos → texto ─────────────────────────────────────────────────────────
function htmlToPlainText(html) {
  const div = document.createElement('div');
  div.innerHTML = html ?? '';
  return div.textContent;
}

// HTML → markdown inline (inverso de parseInlineMarkdown) — reconstrói
// **negrito**, *itálico*, ~~riscado~~, `código`. As marcações de detecção
// (<mark> de CPF/data/cálculo) não são formatação de verdade, só o texto
// interno importa.
function htmlToMarkdownInline(html) {
  const div = document.createElement('div');
  div.innerHTML = html ?? '';
  return nodeToMarkdown(div);
}

function nodeToMarkdown(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.data;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const inner = nodeToMarkdown(child);
    switch (child.tagName) {
      case 'STRONG': case 'B':          out += `**${inner}**`; break;
      case 'EM':     case 'I':          out += `*${inner}*`;   break;
      case 'S': case 'STRIKE': case 'DEL': out += `~~${inner}~~`; break;
      case 'CODE':                      out += `\`${inner}\``; break;
      case 'BR':                        out += '\n';           break;
      default:                          out += inner; // ex.: <mark> de detecção
    }
  }
  return out;
}

// Markdown completo (bloco + formatação inline) — usado como fallback de
// portabilidade da nota (campo `content`) e nas exportações/cópia como .md.
export function blocksToMarkdown(blocks) {
  return (blocks ?? []).map(b => {
    if (b.type === 'divider') return '---';
    const text = htmlToMarkdownInline(b.html);
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
      default:         return text;
    }
  }).join('\n');
}

// Texto realmente simples — sem nenhum caractere de markdown, só marcadores
// legíveis (•, ☐/☑, aspas) e numeração de verdade nas listas numeradas.
export function blocksToPlainText(blocks) {
  let num = 0;
  return (blocks ?? []).map(b => {
    num = b.type === 'number' ? num + 1 : 0;
    if (b.type === 'divider') return '──────────';
    const text = htmlToPlainText(b.html);
    switch (b.type) {
      case 'bullet':    return `• ${text}`;
      case 'number':    return `${num}. ${text}`;
      case 'checklist': return `${b.checked ? '☑' : '☐'} ${text}`;
      case 'quote':     return `"${text}"`;
      default:          return text;
    }
  }).join('\n');
}
