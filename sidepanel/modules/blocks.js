// ── blocks.js ──────────────────────────────────────────────────────────────
// Modelo de blocos do editor de notas e conversão a partir do
// markdown de texto puro que as versões anteriores salvavam (migração).

let uidCounter = 0;
export function uid() {
  return `b${Date.now().toString(36)}${(uidCounter++).toString(36)}`;
}

export function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Só http(s) e mailto. Vale tanto pro que o usuário digita quanto pro que vem
// de um .md importado — um "javascript:" ali viraria execução de script dentro
// do editor. Devolve null quando não dá pra confiar.
export function safeHref(raw) {
  const url = (raw ?? '').trim();
  if (!url) return null;
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (/^[\w.-]+\.\w{2,}([/?#]|$)/.test(url)) return `https://${url}`;  // digitou só o domínio
  return null;
}

// ── Markdown inline → HTML real (usado só na migração de notas antigas) ──────
// Mesma regra do itálico de antes: sem espaço colado no asterisco, pra não
// colidir com "*" de multiplicação.
// `code` vem primeiro pra que uma marcação dentro de crase continue literal.
// O link vem antes de negrito/itálico pra que o "*" de uma URL não seja lido
// como ênfase — o conteúdo do link não aceita formatação aninhada, mesma
// limitação dos outros.
const INLINE_MD = [
  { re: /`([^`\n]+?)`/g, tag: 'code' },
  { re: /\[([^\]\n]+)\]\(([^)\s]+)\)/g, tag: 'a' },
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
      matches.push({ start, end, tag, content: m[1], href: m[2] });
    }
  }
  matches.sort((a, b) => a.start - b.start);

  let html = '', pos = 0;
  for (const m of matches) {
    html += escHtml(text.slice(pos, m.start));
    if (m.tag === 'a') {
      const href = safeHref(m.href);
      // Endereço recusado: mantém o texto original visível em vez de descartar
      // silenciosamente o que a pessoa escreveu.
      html += href
        ? `<a href="${escHtml(href)}">${escHtml(m.content)}</a>`
        : escHtml(text.slice(m.start, m.end));
    } else {
      html += `<${m.tag}>${escHtml(m.content)}</${m.tag}>`;
    }
    pos = m.end;
  }
  html += escHtml(text.slice(pos));
  return html;
}

// ── Tabelas em markdown (GFM) ─────────────────────────────────────────────────
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|[\s:|-]+\|\s*$/;

// Divide na barra que não está escapada; o "\|" dentro da célula vira "|".
function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => parseInlineMarkdown(cell.trim().replace(/\\\|/g, '|')));
}

function tableToMarkdown(rows) {
  if (!rows?.length) return '';
  const cells = rows.map(row => row.map(html =>
    htmlToMarkdownInline(html).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()));
  const cols = Math.max(...cells.map(r => r.length));
  const line = row => `| ${[...row, ...Array(cols - row.length).fill('')].join(' | ')} |`;
  const sep  = `| ${Array(cols).fill('---').join(' | ')} |`;
  return [line(cells[0]), sep, ...cells.slice(1).map(line)].join('\n');
}

// ── Markdown (string) → blocos ────────────────────────────────────────────────
export function parseMarkdownToBlocks(markdown) {
  // Normaliza quebras de linha (Windows manda \r\n) — sem isso, cada linha
  // fica com um \r sobrando no final e os regexes ancorados em "$" falham
  // silenciosamente, caindo pro parágrafo padrão.
  const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let m;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Tabela GFM: linha com pipes seguida da linha separadora (|---|---|).
    // É o único bloco que ocupa várias linhas, por isso o laço é indexado.
    if (TABLE_ROW_RE.test(line) && TABLE_SEP_RE.test(lines[i + 1] ?? '')) {
      const rows = [splitTableRow(line)];
      i++; // consome o separador
      while (TABLE_ROW_RE.test(lines[i + 1] ?? '')) rows.push(splitTableRow(lines[++i]));
      blocks.push({ id: uid(), type: 'table', rows });
      continue;
    }

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
      case 'A': {
        const href = child.getAttribute('href');
        out += href ? `[${inner}](${href})` : inner;
        break;
      }
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
    if (b.type === 'table')   return tableToMarkdown(b.rows);
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
    if (b.type === 'table') {
      return (b.rows ?? []).map(row => row.map(htmlToPlainText).join('\t')).join('\n');
    }
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
