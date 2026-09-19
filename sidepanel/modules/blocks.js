// ── blocks.js ──────────────────────────────────────────────────────────────
// Modelo de blocos do editor de notas e conversão a partir do
// markdown de texto puro que as versões anteriores salvavam (migração).

import { evaluateSheet } from './calc.js';

const QUEBRA = String.fromCharCode(10);

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
  // Âncora pra um título da própria nota. Não sai da nota e não executa nada,
  // então entra na lista — quem resolve pra onde ela leva é o editor.
  if (/^#\S/.test(url)) return url;
  // Link para outra nota interna do QuickDock: nota:uid ou nota:titulo
  if (/^nota:/i.test(url)) return url;
  if (/^[\w.-]+\.\w{2,}([/?#]|$)/.test(url)) return `https://${url}`;  // digitou só o domínio
  return null;
}

// ── Âncoras de título ─────────────────────────────────────────────────────────
// O apelido de um título, pra que "[ir](#minha-seção)" saiba aonde ir. Mesma
// ideia do markdown de sites de documentação: minúsculas, pontuação fora,
// espaço vira hífen.
//
// A comparação na hora de resolver é sem acento e sem caixa, porque cada
// gerador de markdown trata acento e alfabeto grego de um jeito — e errar o
// destino por causa de um "ç" seria pior que não linkar.
export function headingSlug(texto) {
  return (texto ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/\p{Mn}/gu, '')       // tira acento
    .replace(/[^\p{L}\p{N}\s-]/gu, '')              // tira pontuação
    .replace(/\s+/g, '-')                           // espaço (inclusive duplo) vira hífen
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Apelido de cada título, na ordem em que aparecem. Títulos repetidos ganham
 * sufixo — é o que faz o segundo "Observações" da nota ser alcançável.
 * @param textos string[] — o texto de cada título
 */
export function headingSlugs(textos) {
  const vistos = new Map();
  return (textos ?? []).map(t => {
    const base = headingSlug(t);
    const n = vistos.get(base) ?? 0;
    vistos.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  });
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
  { re: /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, tag: 'wikilink' },
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
      if (tag === 'wikilink') {
        matches.push({ start, end, tag, content: m[1], alias: m[2] });
      } else {
        matches.push({ start, end, tag, content: m[1], href: m[2] });
      }
    }
  }
  matches.sort((a, b) => a.start - b.start);

  let html = '', pos = 0;
  for (const m of matches) {
    html += escHtml(text.slice(pos, m.start));
    if (m.tag === 'wikilink') {
      const target = (m.content || '').trim();
      const display = (m.alias || target).trim();
      html += `<a href="nota:${escHtml(target)}" class="note-internal-link" data-note-title="${escHtml(target)}">${escHtml(display)}</a>`;
    } else if (m.tag === 'a') {
      const href = safeHref(m.href);
      if (href && /^nota:/i.test(href)) {
        const target = href.replace(/^nota:/i, '');
        html += `<a href="${escHtml(href)}" class="note-internal-link" data-note-format="md" data-note-uid="${escHtml(target)}">${escHtml(m.content)}</a>`;
      } else {
        // Endereço recusado: mantém o texto original visível em vez de descartar
        // silenciosamente o que a pessoa escreveu.
        html += href
          ? `<a href="${escHtml(href)}">${escHtml(m.content)}</a>`
          : escHtml(text.slice(m.start, m.end));
      }
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

function tableToMarkdown(rows, pad = '') {
  if (!rows?.length) return '';
  const cells = rows.map(row => row.map(html =>
    htmlToMarkdownInline(html).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()));
  const cols = Math.max(...cells.map(r => r.length));
  const line = row => `${pad}| ${[...row, ...Array(cols - row.length).fill('')].join(' | ')} |`;
  const sep  = `${pad}| ${Array(cols).fill('---').join(' | ')} |`;
  return [line(cells[0]), sep, ...cells.slice(1).map(line)].join('\n');
}

// ── Indentação → profundidade ─────────────────────────────────────────────────
// O modelo é plano: cada bloco carrega um `depth` e o pai é implícito (o bloco
// anterior com profundidade menor). Isso mantém a lista de blocos sendo uma
// lista — arrastar, selecionar vários, desfazer e renumerar continuam valendo
// sem precisar andar numa árvore.
export const MAX_DEPTH = 5;

function indentWidth(raw) {
  let w = 0;
  for (const ch of raw) w += ch === '\t' ? 4 : 1;
  // Um espaço solto é desleixo de digitação, não um nível. Sem esse piso, um
  // markdown como "> *texto*" (com dois espaços depois do >) ganharia uma
  // indentação que ninguém pediu.
  return w < 2 ? 0 : w;
}

// A largura absoluta não importa, só a sequência. Assim um arquivo indentado
// com 2 espaços, outro com 4 e outro com tab produzem a mesma escada — em vez
// de níveis diferentes conforme o editor de quem escreveu.
function makeDepthTracker() {
  const larguras = [0];
  return width => {
    while (larguras.length > 1 && width < larguras[larguras.length - 1]) larguras.pop();
    if (width > larguras[larguras.length - 1]) larguras.push(width);
    return Math.min(larguras.length - 1, MAX_DEPTH);
  };
}

// ── Imagens ───────────────────────────────────────────────────────────────────
// A imagem da nota é guardada como Blob na tabela `files`, e o bloco só
// carrega o id. Base64 dentro do bloco pareceria mais simples e seria a
// escolha errada: a nota inteira é regravada a cada autosave, então um print
// de 2 MB embutido viraria 2 MB reescritos a cada pausa na digitação.
//
// O endereço `quickdock:file/12` é a referência interna. Ela aparece no campo
// `content` (a rede de recuperação da nota) e é lida de volta aqui. Na
// O endereço `quickdock:file/12` é a referência interna local do IndexedDB.
// Ela aparece no campo `content` rápido, mas NUNCA pode viajar para outros
// aparelhos na sincronização: o arquivo 12 em outra máquina é outra imagem qualquer.
// Para sincronizar, grava-se o marcador neutro `quickdock:nao-sincronizado`.
const FILE_REF_RE = /^quickdock:file\/(\d+)$/;
const UNSYNCED_IMAGE_RE = /^quickdock:(?:nao-sincronizado|unsynced|imagem-local)$/;
export const SYNC_IMAGE_RE = /^(?:\.\.\/)*imagens\/([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]+)?)$/;
const IMAGE_MD_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

export function imageSrcOf(b, opts = {}) {
  if (b.dataUrl) return b.dataUrl;
  // Se houver mapa de tradução fornecido pelo motor de sync (fileId -> ../imagens/<hash>.ext)
  if (opts.mapaImagens && b.fileId != null && opts.mapaImagens.has(b.fileId)) {
    return opts.mapaImagens.get(b.fileId);
  }
  // Se o bloco já traz o caminho relativo de uma imagem sincronizada baixada
  if (b.imagePath && SYNC_IMAGE_RE.test(b.imagePath)) {
    return b.imagePath;
  }
  if (b.src && SYNC_IMAGE_RE.test(b.src)) {
    return b.src;
  }
  // Ao serializar para sincronização, a chave primária local não viaja.
  // Se ainda não tem arquivo de hash associado, grava o marcador neutro de espera.
  if (opts.sync || opts.paraSync) {
    if (b.fileId != null || b.unsynced || b.missing) return 'quickdock:nao-sincronizado';
  }
  if (b.unsynced || b.missing || b.src === 'quickdock:nao-sincronizado') {
    return 'quickdock:nao-sincronizado';
  }
  if (b.fileId != null) return `quickdock:file/${b.fileId}`;
  return b.src ?? '';
}

// Endereço remoto NÃO vira imagem: abrir a nota faria o navegador buscar o
// arquivo no servidor de terceiro, entregando o IP e o momento exato da
// leitura a quem hospedou. Vira link — o endereço continua ali, clicável, e
// quem quiser a imagem decide baixá-la.
// Imagens não-sincronizadas preservam o texto alternativo mas nunca recebem fileId.
// Imagens com caminho relativo na pasta imagens/ guardam o imagePath para download preguiçoso.
function parseImageLine(alt, src) {
  const ref = FILE_REF_RE.exec(src);
  if (ref) return { type: 'image', fileId: Number(ref[1]), alt };
  if (/^data:image\//i.test(src)) return { type: 'image', dataUrl: src, alt };
  if (UNSYNCED_IMAGE_RE.test(src)) return { type: 'image', alt, unsynced: true };
  if (SYNC_IMAGE_RE.test(src)) return { type: 'image', alt, imagePath: src };
  return null;
}

// ── Blocos cercados (``` ... ```) ────────────────────────────────────────────
// Código e cálculo saem cercados. A marca depois da cerca diz qual é: sem
// marca é código, "calc" é folha de cálculo.
//
// A diferença entre os dois é de forma, não de ideia: o bloco de código é UM
// bloco com várias linhas dentro, e a folha de cálculo é uma linha por bloco
// (cada linha precisa do seu próprio resultado ao lado). Então o código abre e
// fecha a cerca sozinho, e o cálculo abre na primeira linha da sequência e
// fecha na última.
const FENCE_RE = /^(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)\s*$/;

// Resultado de cada linha de cálculo, por índice do bloco. Só é usado na
// exportação: no salvamento o resultado não acompanha a conta de propósito —
// guardar o número criaria a chance de ele discordar dela.
function resultadosDeCalculo(lista) {
  const porIndice = new Map();
  for (let i = 0; i < lista.length; i++) {
    if (lista[i].type !== 'calc') continue;
    let fim = i;
    while (fim + 1 < lista.length && lista[fim + 1].type === 'calc') fim++;
    const linhas = lista.slice(i, fim + 1).map(b => htmlToPlainText(b.html));
    evaluateSheet(linhas).forEach((r, k) => {
      if (r.tipo === 'valor')     porIndice.set(i + k, r.fmt);
      else if (r.tipo === 'erro') porIndice.set(i + k, `! ${r.erro}`);
    });
    i = fim;
  }
  return porIndice;
}

// ── Citação ───────────────────────────────────────────────────────────────────
// Citação é decoração, não tipo: um bloco ganha `quoted: true` de forma
// independente do seu `type`. É isso que faz "> #### Resultado" virar um
// título de verdade dentro da citação, em vez de um parágrafo com "####"
// literal na frente — e o mesmo vale pra lista, checklist e tudo mais.
//
// Pega os ">" do começo (inclusive repetidos) e, de cada um, no máximo um
// espaço: o que sobrar de espaço é indentação de verdade e vira profundidade.
const QUOTE_RE = /^((?:>[ \t]?)+)([ \t]*)(.*)$/;

// ── Destaque (callout) ────────────────────────────────────────────────────────
// O bloco de aviso colorido que todo site de documentação tem. No markdown do
// GitHub ele não é um tipo novo: é uma citação cuja primeira linha traz um
// marcador. Por isso aqui ele é mais uma decoração em cima de `quoted`, e não
// uma estrutura à parte — a nota continua sendo markdown padrão, e o mesmo
// arquivo renderiza colorido no GitHub.
//
// As palavras-chave ficam em inglês porque é o que o formato define; o que
// aparece na tela é traduzido (ver CALLOUT_LABELS).
export const CALLOUT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'];
const CALLOUT_RE = /^\[!(note|tip|important|warning|caution)\][ \t]*$/i;

export const CALLOUT_LABELS = {
  note:      'Nota',
  tip:       'Dica',
  important: 'Importante',
  warning:   'Atenção',
  caution:   'Cuidado',
};

// O tipo antigo `quote` continua sendo lido: na leitura vira parágrafo
// decorado, e é a forma nova que volta a ser gravada quando a pessoa editar.
// Nota antiga abre igual, sem migração varrendo o banco.
export function normalizeBlock(b) {
  if (b?.type !== 'quote') return b;
  return { ...b, type: 'paragraph', quoted: true };
}

// ── Markdown (string) → blocos ────────────────────────────────────────────────
export function parseMarkdownToBlocks(markdown) {
  // Normaliza quebras de linha (Windows manda \r\n) — sem isso, cada linha
  // fica com um \r sobrando no final e os regexes ancorados em "$" falham
  // silenciosamente, caindo pro parágrafo padrão.
  const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const depthOf = makeDepthTracker();
  let callout = null;   // destaque em curso; vale até a citação terminar
  let m;

  for (let i = 0; i < lines.length; i++) {
    const [, indent, semIndent] = /^([ \t]*)(.*)$/.exec(lines[i]);

    // Citação sai da frente antes de qualquer outra coisa, e o que sobra volta
    // a ser uma linha comum — é o passo que faz o conteúdo dentro da citação
    // ser lido de verdade.
    const q      = QUOTE_RE.exec(semIndent);
    const quoted = !!q;
    const rest   = q ? q[3] : semIndent;
    // Quando a linha é citada, a indentação pode estar antes do ">" (gerada por
    // blocksToMarkdown como "  > ") ou depois do ">" (como ">   "). Priorizamos a
    // indentação externa para não perder o depth de callouts e listas citadas.
    const recuo  = indentWidth(indent) > 0 ? indent : (q ? q[2] : indent);

    // O marcador de destaque só existe dentro de uma citação, e vale dali até
    // a citação acabar. Ele mesmo não vira bloco nenhum — é só o rótulo.
    if (!quoted) {
      callout = null;
    } else if ((m = CALLOUT_RE.exec(rest))) {
      callout = m[1].toLowerCase();
      continue;
    }

    // Linha em branco não mexe na escada: uma linha vazia entre dois itens
    // aninhados é markdown normal e não pode zerar o nível do que vem depois.
    if (rest === '') {
      const vazio = { id: uid(), type: 'paragraph', html: '' };
      blocks.push(quoted
        ? { ...vazio, quoted: true, ...(callout ? { callout } : {}) }
        : vazio);
      continue;
    }

    const depth = depthOf(indentWidth(recuo));
    const add = b => blocks.push({
      id: uid(), ...b,
      ...(depth   ? { depth }        : {}),
      ...(quoted  ? { quoted: true } : {}),
      ...(callout ? { callout }      : {}),
    });

    // Bloco cercado: consome até a cerca de fechamento. Sem marca é código
    // (um bloco só, com as linhas dentro); com a marca "calc" é folha de
    // cálculo (uma linha por bloco). O comentário de resultado que a
    // exportação escreve à direita é descartado aqui — o valor é sempre
    // recalculado, então dentro da extensão nunca existe número desatualizado.
    //
    // Quando a cerca abre dentro de uma citação ou com recuo, as linhas internas
    // e a cerca de fechamento também trazem o mesmo prefixo de citação/recuo.
    // Sem despir o marcador de citação de cada linha, a cerca final não é
    // reconhecida (continua consumindo até o fim do arquivo) e o ">" vira &gt;
    // dentro do HTML do bloco a cada ciclo — corrosão clássica.
    if ((m = FENCE_RE.exec(rest))) {
      const marca = (m[2] || '').toLowerCase();
      const corpo = [];
      const prefixoIndent = indent;
      i++;
      while (i < lines.length) {
        let linha = lines[i];
        if (prefixoIndent && linha.startsWith(prefixoIndent)) {
          linha = linha.slice(prefixoIndent.length);
        }
        if (quoted) {
          const lq = QUOTE_RE.exec(linha.trimStart());
          if (lq) linha = lq[3];
        }
        if (FENCE_RE.test(linha.trim())) break;
        corpo.push(linha);
        i++;
      }

      if (marca === 'calc') {
        for (const linha of corpo) {
          add({ type: 'calc', html: parseInlineMarkdown(linha.replace(/\s{2,}\/\/.*$/, '').trimEnd()) });
        }
      } else {
        add({ type: 'code', html: corpo.map(escHtml).join('<br>') });
      }
      continue;
    }

    // Tabela GFM: linha com pipes seguida da linha separadora (|---|---|).
    // É o único bloco que ocupa várias linhas, por isso o laço é indexado.
    // Se estiver dentro de citação, as linhas seguintes também trazem "> ".
    {
      const prox = lines[i + 1] ?? '';
      const proxRest = quoted ? (QUOTE_RE.exec(prox.trimStart())?.[3] ?? prox) : prox;
      if (TABLE_ROW_RE.test(rest) && TABLE_SEP_RE.test(proxRest)) {
        const rows = [splitTableRow(rest)];
        i++; // consome o separador
        while (i + 1 < lines.length) {
          const proxLinha = lines[i + 1];
          const proxLinhaRest = quoted ? (QUOTE_RE.exec(proxLinha.trimStart())?.[3] ?? proxLinha) : proxLinha;
          if (!TABLE_ROW_RE.test(proxLinhaRest)) break;
          rows.push(splitTableRow(proxLinhaRest));
          i++;
        }
        add({ type: 'table', rows });
        continue;
      }
    }

    // Imagem sozinha na linha vira bloco de imagem. Se o endereço for remoto,
    // parseImageLine devolve null e a linha segue o caminho normal — acaba
    // virando um link, que é a decisão de privacidade explicada lá em cima.
    if ((m = IMAGE_MD_RE.exec(rest))) {
      const img = parseImageLine(m[1], m[2]);
      if (img) { add(img); continue; }
      // Endereço remoto: vira link, e sem o "!" sobrando na frente — se
      // caísse no parser de linha normal, o "!" viraria texto solto.
      const href = safeHref(m[2]);
      if (href) {
        add({ type: 'paragraph', html: `<a href="${escHtml(href)}">${escHtml(m[1] || href)}</a>` });
        continue;
      }
    }

    // Título sublinhado (setext): o texto numa linha e "===" ou "---" na de
    // baixo. É markdown de verdade — a própria forma original de escrever
    // título 1 e 2 —, e o traço embaixo é literalmente o sublinhado.
    //
    // Só vale depois de uma linha de texto comum. É o que separa "Texto" +
    // "---" (título sublinhado) de "---" sozinho (divisor).
    {
      let abaixo = (lines[i + 1] ?? '').trim();
      if (quoted) {
        const aq = QUOTE_RE.exec(abaixo);
        if (aq) abaixo = aq[3].trim();
      }
      const eSetext = /^=+$/.test(abaixo) || /^-+$/.test(abaixo);
      const eTextoComum = rest.trim() !== '' && !/^(#{1,6} |[-*] |\d+\. |\||>|`{3,}|~{3,})/.test(rest);
      if (eSetext && eTextoComum) {
        add({
          type: abaixo.startsWith('=') ? 'heading1' : 'heading2',
          html: parseInlineMarkdown(rest),
          underlined: true,
        });
        i++;   // consome a linha do traço
        continue;
      }
    }

    if ((m = /^(#{1,6}) (.+)$/.exec(rest))) {
      add({ type: `heading${m[1].length}`, html: parseInlineMarkdown(m[2]) });
    } else if ((m = /^([-*]) \[([ xX])\] (.+)$/.exec(rest))) {
      add({ type: 'checklist', checked: /[xX]/.test(m[2]), html: parseInlineMarkdown(m[3]) });
    } else if ((m = /^[-*] (.+)$/.exec(rest))) {
      add({ type: 'bullet', html: parseInlineMarkdown(m[1]) });
    } else if ((m = /^\d+\. (.+)$/.exec(rest))) {
      add({ type: 'number', html: parseInlineMarkdown(m[1]) });
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(rest)) {
      add({ type: 'divider' });
    } else {
      add({ type: 'paragraph', html: parseInlineMarkdown(rest) });
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
        if (href && /^nota:/i.test(href)) {
          if (child.getAttribute('data-note-format') === 'md') {
            out += `[${inner}](${href})`;
            break;
          }
          const target = child.getAttribute('data-note-title') || href.replace(/^nota:/i, '');
          if (!inner || inner === target) {
            out += `[[${target}]]`;
          } else {
            out += `[[${target}|${inner}]]`;
          }
          break;
        }
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
// Dois espaços por nível: é o que o markdown espera e o que qualquer outro
// editor vai ler de volta como aninhamento.
function indentOf(b) {
  return '  '.repeat(Math.min(Math.max(b.depth ?? 0, 0), MAX_DEPTH));
}

// Um destaque abre quando o bloco anterior não faz parte do mesmo: é aí que o
// marcador "> [!NOTE]" é emitido, sozinho na sua linha.
function abreCallout(b, anterior) {
  return !!b.callout && !(anterior?.callout === b.callout && (anterior?.quoted || anterior?.callout));
}

/**
 * @param opts.comentarResultados  escreve o resultado de cada linha de cálculo
 *        à direita, em comentário. Só na exportação: no `content` interno o
 *        resultado não vai junto (ver resultadosDeCalculo).
 */
export function blocksToMarkdown(blocks, opts = {}) {
  const lista = blocks ?? [];
  const calculados = opts.comentarResultados ? resultadosDeCalculo(lista) : null;
  return lista.map((b, i) => {
    const pad = indentOf(b);
    // O ">" vem depois da indentação e antes do marcador do tipo: é assim que
    // "  > - item" volta a ser lido como item de lista dentro de uma citação.
    // O tipo antigo `quote` também entra aqui, pra que um registro que nunca
    // passou pelo editor continue saindo como citação.
    const q = (b.quoted || b.callout || b.type === 'quote') ? '> ' : '';
    const marcador = abreCallout(b, lista[i - 1])
      ? `${pad}> [!${b.callout.toUpperCase()}]\n`
      : '';
    const linha = () => {
      // Código é um bloco só com as linhas dentro — abre e fecha a cerca sozinho.
      if (b.type === 'code') {
        const corpo = htmlToPlainText((b.html ?? '').replace(/<br\s*\/?>/gi, '\n'));
        return [
          `${pad}${q}\`\`\``,
          ...corpo.split('\n').map(l => `${pad}${q}${l}`),
          `${pad}${q}\`\`\``,
        ].join('\n');
      }

      // Cálculo é uma linha por bloco: a cerca abre na primeira da sequência e
      // fecha na última.
      if (b.type === 'calc') {
        const texto = htmlToPlainText(b.html ?? '');
        const res   = calculados?.get(i);
        const corpo = `${pad}${q}${res ? `${texto}  // ${res}` : texto}`;
        const abre  = lista[i - 1]?.type !== 'calc' ? `${pad}${q}\`\`\`calc\n` : '';
        const fecha = lista[i + 1]?.type !== 'calc' ? `\n${pad}${q}\`\`\`` : '';
        return `${abre}${corpo}${fecha}`;
      }

      if (b.type === 'divider') {
        // "---" logo abaixo de uma linha de texto é lido de volta como
        // sublinhado de título, não como divisor. "***" é o mesmo divisor pro
        // markdown e não tem essa ambiguidade — só é usado quando ela existe.
        const acima = lista[i - 1];
        const ambiguo = !!acima
          && !['divider', 'table', 'image', 'code', 'calc'].includes(acima.type)
          && htmlToPlainText(acima.html ?? '').trim() !== '';
        return `${pad}${q}${ambiguo ? '***' : '---'}`;
      }
      if (b.type === 'table')   return tableToMarkdown(b.rows, `${pad}${q}`);
      if (b.type === 'image')   return `${pad}${q}![${(b.alt ?? '').replace(/[\[\]]/g, '')}](${imageSrcOf(b, opts)})`;
      const text = htmlToMarkdownInline(b.html);
      switch (b.type) {
        // Sublinhado sai como setext — a forma do markdown que desenha o
        // traço embaixo. Sem sublinhado continua a forma com cerquilha.
        case 'heading1':
          return b.underlined ? `${pad}${q}${text}
${pad}${q}===` : `${pad}${q}# ${text}`;
        case 'heading2':
          return b.underlined ? `${pad}${q}${text}
${pad}${q}---` : `${pad}${q}## ${text}`;
        case 'heading3': return `${pad}${q}### ${text}`;
        case 'heading4': return `${pad}${q}#### ${text}`;
        case 'heading5': return `${pad}${q}##### ${text}`;
        case 'heading6': return `${pad}${q}###### ${text}`;
        case 'bullet':   return `${pad}${q}- ${text}`;
        case 'number':   return `${pad}${q}1. ${text}`;
        case 'checklist':return `${pad}${q}- [${b.checked ? 'x' : ' '}] ${text}`;
        // Parágrafo vazio sai vazio de verdade: uma linha só com espaços
        // reapareceria como indentação na leitura de volta. Vazio E citado sai
        // só como ">", que é a linha em branco de dentro da citação.
        case 'quote':    return `${pad}> ${text}`;
        default:
          if (text !== '') return `${pad}${q}${text}`;
          return q ? `${pad}>` : '';
      }
    };
    return marcador + linha();
  }).join('\n');
}

// Exportação: a imagem sai embutida em base64, o que faz o .md abrir em
// qualquer lugar sem depender do banco do QuickDock. É assíncrono porque
// precisa ler o Blob — por isso não é o mesmo blocksToMarkdown que roda a
// cada autosave, onde embutir megabytes seria justamente o erro a evitar.
//
// `lerArquivoComoDataUrl` entra por parâmetro pra manter este módulo sem
// dependência de banco (e testável fora do navegador).
export async function blocksToMarkdownForExport(blocks, lerArquivoComoDataUrl) {
  const resolvidos = [];
  for (const b of blocks ?? []) {
    if (b.type === 'image' && b.fileId != null && !b.dataUrl) {
      const dataUrl = await lerArquivoComoDataUrl(b.fileId);
      // Arquivo sumido (faxina, banco limpo): mantém o bloco com o texto
      // alternativo em vez de engolir a linha inteira.
      resolvidos.push(dataUrl ? { ...b, dataUrl } : { ...b, src: '' });
      continue;
    }
    resolvidos.push(b);
  }
  // O resultado do cálculo só entra aqui, na saída — mesma divisão da imagem,
  // que guarda referência dentro e vira base64 só ao sair.
  return blocksToMarkdown(resolvidos, { comentarResultados: true });
}

// Texto realmente simples — sem nenhum caractere de markdown, só marcadores
// legíveis (•, ☐/☑, aspas) e numeração de verdade nas listas numeradas.
// Marcador diferente por nível, como em qualquer lista aninhada — num painel
// estreito é o que deixa a escada legível sem contar os espaços. Exportado
// porque o editor precisa desenhar exatamente o mesmo marcador.
export const BULLET_GLYPHS = ['•', '◦', '▪'];

export function blocksToPlainText(blocks) {
  // Um contador por nível: entrar num nível mais fundo não zera o de fora, e
  // sair dele recomeça o de dentro.
  const contadores = [];
  const lista = blocks ?? [];
  // Texto simples é sempre um caminho de saída (copiar, baixar .txt), então
  // aqui o resultado do cálculo vai junto — quem lê não tem como recalcular.
  const calculados = resultadosDeCalculo(lista);
  return lista.map((b, i) => {
    const depth = Math.min(Math.max(b.depth ?? 0, 0), MAX_DEPTH);
    const pad   = '  '.repeat(depth);

    let num = 0;
    if (b.type === 'number') {
      num = (contadores[depth] ?? 0) + 1;
      contadores[depth] = num;
      contadores.length = depth + 1;
    } else {
      contadores.length = depth;  // bloco não-numerado quebra a contagem dali pra dentro
    }

    // No texto simples a citação vira uma barra — aspas por linha ficariam
    // abrindo e fechando a cada linha da mesma citação.
    const q = (b.quoted || b.callout || b.type === 'quote') ? '| ' : '';

    // O rótulo do destaque vai numa linha só dele, como no markdown. Aqui em
    // português: quem lê um texto copiado não precisa saber a palavra-chave.
    const marcador = abreCallout(b, lista[i - 1])
      ? `${pad}| ${(CALLOUT_LABELS[b.callout] ?? b.callout).toUpperCase()}\n`
      : '';

    const linha = () => {
      if (b.type === 'calc') {
        const texto = htmlToPlainText(b.html ?? '');
        const res   = calculados.get(i);
        return `${pad}${q}${res ? `${texto}  = ${res}` : texto}`;
      }
      if (b.type === 'image')   return `${pad}${q}[imagem${b.alt ? `: ${b.alt}` : ''}]`;
      if (b.type === 'divider') return `${pad}${q}──────────`;
      if (b.type === 'table') {
        return (b.rows ?? []).map(row => `${pad}${q}${row.map(htmlToPlainText).join('\t')}`).join('\n');
      }
      // Código guarda as quebras de linha como <br>; sem trocar por quebra de
      // verdade, o texto copiado vinha com todas as linhas grudadas.
      if (b.type === 'code') {
        const linhas = (b.html ?? '').split(/<br\s*\/?>/i).map(htmlToPlainText);
        return linhas.map(l => `${pad}${q}${l}`).join(QUEBRA);
      }
      const text = htmlToPlainText(b.html);
      switch (b.type) {
        case 'bullet':    return `${pad}${q}${BULLET_GLYPHS[depth % BULLET_GLYPHS.length]} ${text}`;
        case 'number':    return `${pad}${q}${num}. ${text}`;
        case 'checklist': return `${pad}${q}${b.checked ? '☑' : '☐'} ${text}`;
        case 'quote':     return `${pad}| ${text}`;
        default:          return text === '' ? (q ? `${pad}|` : '') : `${pad}${q}${text}`;
      }
    };
    return marcador + linha();
  }).join('\n');
}
