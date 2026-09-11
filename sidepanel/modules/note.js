import { getNoteById, updateNoteBlocksById } from './storage.js';
import { tryParseMath } from './math-parser.js';
import { uid, escHtml, parseMarkdownToBlocks, blocksToMarkdown } from './blocks.js';

const noteSection  = document.querySelector('.note-section');
const noteEditorEl = document.querySelector('.note-editor');
const root         = document.getElementById('note-editor-blocks');
const indicator    = document.getElementById('save-indicator');

let currentNoteId  = null;
let isCtrlHeld     = false;
let activeMenu     = null;
let indicatorTimer = null;
let saveTimer      = null;
let rescanTimer    = null;
let rescanBlock    = null;
const mathCache    = new Map(); // expr raw → resultado parseado

// ── Utilitários de data ───────────────────────────────────────────────────────
function parseDate(raw) {
  const s = raw.trim();
  let day, month, year;

  if (/^\d{8}$/.test(s)) {
    year = +s.slice(0, 4); month = +s.slice(4, 6); day = +s.slice(6, 8);
  } else if (/^\d{4}[-\/]\d{2}[-\/]\d{2}$/.test(s)) {
    [year, month, day] = s.split(/[-\/]/).map(Number);
  } else if (/^\d{2}[\/\-\. ]\d{2}[\/\-\. ]\d{4}$/.test(s)) {
    [day, month, year] = s.split(/[\/\-\. ]/).map(Number);
  } else {
    return null;
  }

  if (!day || !month || !year) return null;
  if (month < 1 || month > 12) return null;
  if (day   < 1 || day   > 31) return null;
  if (year  < 1900 || year > new Date().getFullYear()) return null;

  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

function calculateAge(date) {
  const now = new Date();
  let age   = now.getFullYear() - date.getFullYear();
  const m   = now.getMonth() - date.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < date.getDate())) age--;
  return age;
}

function formatDateBR(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${date.getFullYear()}`;
}

const ATE_RE = /[ \t]+at[eé][ \t]+/i;

function parseDateRange(raw) {
  const parts = raw.split(ATE_RE);
  if (parts.length !== 2) return null;
  const d1 = parseDate(parts[0].trim());
  const d2 = parseDate(parts[1].trim());
  if (!d1 || !d2) return null;
  const days = Math.round((d2 - d1) / 86400000);
  return { d1, d2, days };
}

function parseTime(raw) {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = +m[1], min = +m[2], sec = m[3] ? +m[3] : 0;
  if (h > 23 || min > 59 || sec > 59) return null;
  return { h, min, sec, totalSec: h * 3600 + min * 60 + sec };
}

function fmtTime(t) {
  return `${String(t.h).padStart(2,'0')}:${String(t.min).padStart(2,'0')}`;
}

function parseTimeRange(raw) {
  const parts = raw.split(ATE_RE);
  if (parts.length !== 2) return null;
  const t1 = parseTime(parts[0].trim());
  const t2 = parseTime(parts[1].trim());
  if (!t1 || !t2) return null;
  return { t1, t2, diffSec: t2.totalSec - t1.totalSec };
}

function parseDateTime(raw) {
  const m = raw.trim().match(/^(\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4})[ \t]+(\d{1,2}:\d{2}(?::\d{2})?)$/);
  if (!m) return null;
  const d = parseDate(m[1]);
  const t = parseTime(m[2]);
  if (!d || !t) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.h, t.min, t.sec);
}

function parseDateTimeRange(raw) {
  const parts = raw.split(ATE_RE);
  if (parts.length !== 2) return null;
  const dt1 = parseDateTime(parts[0].trim());
  const dt2 = parseDateTime(parts[1].trim());
  if (!dt1 || !dt2) return null;
  return { dt1, dt2, diffSec: Math.round((dt2 - dt1) / 1000) };
}

function fmtTimeDiff(absSec) {
  const d   = Math.floor(absSec / 86400);
  const rem = absSec % 86400;
  const h   = Math.floor(rem / 3600);
  const min = Math.floor((rem % 3600) / 60);
  const parts = [];
  if (d   > 0)              parts.push(`${d} ${d === 1 ? 'dia' : 'dias'}`);
  if (h   > 0)              parts.push(`${h}h`);
  if (min > 0 || d + h === 0) parts.push(`${min}min`);
  return parts.join(' ');
}

function onlyDigits(str) { return str.replace(/\D/g, ''); }

function maskCPF(n)   { return `${n.slice(0,3)}.${n.slice(3,6)}.${n.slice(6,9)}-${n.slice(9)}`; }
function maskCNPJ(n)  { return `${n.slice(0,2)}.${n.slice(2,5)}.${n.slice(5,8)}/${n.slice(8,12)}-${n.slice(12)}`; }

function validateCPF(raw) {
  const n = raw.replace(/\D/g, '');
  if (n.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(n)) return false;
  const d = n.split('').map(Number);
  const dig = (len, base) => {
    const r = d.slice(0, len).reduce((s, v, i) => s + v * (base - i), 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dig(9, 10) === d[9] && dig(10, 11) === d[10];
}

function validateCNPJ(raw) {
  const n = raw.replace(/[.\-\/]/g, '').toUpperCase();
  if (n.length !== 14) return false;
  if (/^(.)\1{13}$/.test(n)) return false;
  if (!/^[A-Z0-9]{12}\d{2}$/.test(n)) return false;
  const val = c => c.charCodeAt(0) - 48;
  const chars = n.split('');
  const dig = (len, w) => {
    const r = chars.slice(0, len).reduce((s, c, i) => s + val(c) * w[i], 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dig(12, [5,4,3,2,9,8,7,6,5,4,3,2]) === +n[12] &&
         dig(13, [6,5,4,3,2,9,8,7,6,5,4,3,2]) === +n[13];
}
function maskCEP(n)   { return `${n.slice(0,5)}-${n.slice(5)}`; }
function maskPhone(n) {
  if (n.length === 11) return `(${n.slice(0,2)}) ${n.slice(2,7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0,2)}) ${n.slice(2,6)}-${n.slice(6)}`;
  return n;
}

const TYPE_LABELS = { cpf: 'CPF', cnpj: 'CNPJ', phone: 'Telefone', date: 'Data', daterange: 'Período', timerange: 'Intervalo de horas', datetimerange: 'Período com hora', cep: 'CEP', email: 'E-mail', math: 'Cálculo' };

function buildCopyOptions(type, raw) {
  const d = onlyDigits(raw);

  switch (type) {
    case 'cpf': {
      const masked = d.length === 11 ? maskCPF(d) : raw;
      return [
        { label: masked, hint: 'com máscara', value: masked },
        { label: d,      hint: 'só números',  value: d      },
      ];
    }
    case 'cnpj': {
      const stripped = raw.replace(/[.\-\/]/g, '').toUpperCase();
      const masked = stripped.length === 14 ? maskCNPJ(stripped) : raw;
      return [
        { label: masked,   hint: 'com máscara', value: masked   },
        { label: stripped, hint: 'sem máscara', value: stripped },
      ];
    }
    case 'phone': {
      const formatted = maskPhone(d.slice(0, 11));
      return [
        { label: formatted, hint: 'formatado BR', value: formatted },
        { label: d,         hint: 'só números',   value: d         },
      ];
    }
    case 'date': {
      const date = parseDate(raw);
      if (!date) return [{ label: raw, hint: 'data', value: raw }];
      const age    = calculateAge(date);
      const dateBR = formatDateBR(date);
      return [
        { label: dateBR,        hint: 'data',       value: dateBR        },
        { label: `${age} anos`, hint: 'idade',      value: `${age} anos` },
        { label: String(age),   hint: 'só a idade', value: String(age)   },
      ];
    }
    case 'cep': {
      const digits = onlyDigits(raw);
      const masked = digits.length === 8 ? maskCEP(digits) : raw;
      return [
        { label: masked,  hint: 'com máscara', value: masked  },
        { label: digits,  hint: 'só números',  value: digits  },
      ];
    }
    case 'daterange': {
      const range = parseDateRange(raw);
      if (!range) return [{ label: raw, hint: 'período', value: raw }];
      const { d1, d2, days } = range;
      const abs = Math.abs(days);
      const inv = days < 0 ? ' (invertido)' : '';

      const opts = [];

      const dStr = `${abs} ${abs === 1 ? 'dia' : 'dias'}${inv}`;
      opts.push({ label: dStr, hint: 'total em dias', value: dStr });

      if (abs >= 7) {
        const w = Math.floor(abs / 7), rd = abs % 7;
        const wStr = `${w} ${w === 1 ? 'semana' : 'semanas'}${rd ? ` e ${rd} ${rd === 1 ? 'dia' : 'dias'}` : ''}${inv}`;
        opts.push({ label: wStr, hint: 'em semanas', value: wStr });
      }

      if (abs >= 28) {
        const [lo, hi] = days >= 0 ? [d1, d2] : [d2, d1];
        let m = (hi.getFullYear() - lo.getFullYear()) * 12 + (hi.getMonth() - lo.getMonth());
        const pivot = new Date(lo.getFullYear(), lo.getMonth() + m, lo.getDate());
        if (pivot > hi) m--;
        const pivot2 = new Date(lo.getFullYear(), lo.getMonth() + m, lo.getDate());
        const rd = Math.round((hi - pivot2) / 86400000);
        const mStr = `${m} ${m === 1 ? 'mês' : 'meses'}${rd ? ` e ${rd} ${rd === 1 ? 'dia' : 'dias'}` : ''}${inv}`;
        opts.push({ label: mStr, hint: 'em meses', value: mStr });
      }

      if (abs >= 365) {
        const [lo, hi] = days >= 0 ? [d1, d2] : [d2, d1];
        let y = hi.getFullYear() - lo.getFullYear();
        const pivot = new Date(lo.getFullYear() + y, lo.getMonth(), lo.getDate());
        if (pivot > hi) y--;
        const pivot2 = new Date(lo.getFullYear() + y, lo.getMonth(), lo.getDate());
        let rm = (hi.getFullYear() - pivot2.getFullYear()) * 12 + (hi.getMonth() - pivot2.getMonth());
        const yStr = `${y} ${y === 1 ? 'ano' : 'anos'}${rm ? ` e ${rm} ${rm === 1 ? 'mês' : 'meses'}` : ''}${inv}`;
        opts.push({ label: yStr, hint: 'em anos', value: yStr });
      }

      opts.push({ label: `${formatDateBR(d1)} até ${formatDateBR(d2)}`, hint: 'período formatado', value: `${formatDateBR(d1)} até ${formatDateBR(d2)}` });

      return opts;
    }
    case 'timerange': {
      const r = parseTimeRange(raw);
      if (!r) return [{ label: raw, hint: 'intervalo', value: raw }];
      const abs = Math.abs(r.diffSec);
      const inv = r.diffSec < 0 ? ' (invertido)' : '';
      const opts = [];
      const totalMin = Math.round(abs / 60);
      const h = Math.floor(totalMin / 60), m = totalMin % 60;
      if (h > 0) {
        const s = `${h}h${m > 0 ? ` ${m}min` : ''}${inv}`;
        opts.push({ label: s, hint: 'duração', value: s });
      }
      const ms = `${totalMin} ${totalMin === 1 ? 'minuto' : 'minutos'}${inv}`;
      opts.push({ label: ms, hint: 'em minutos', value: ms });
      opts.push({ label: `${fmtTime(r.t1)} até ${fmtTime(r.t2)}`, hint: 'período', value: `${fmtTime(r.t1)} até ${fmtTime(r.t2)}` });
      return opts;
    }
    case 'datetimerange': {
      const r = parseDateTimeRange(raw);
      if (!r) return [{ label: raw, hint: 'período', value: raw }];
      const abs = Math.abs(r.diffSec);
      const inv = r.diffSec < 0 ? ' (invertido)' : '';
      const opts = [];
      opts.push({ label: `${fmtTimeDiff(abs)}${inv}`, hint: 'duração', value: `${fmtTimeDiff(abs)}${inv}` });
      const totalH = Math.floor(abs / 3600), remMin = Math.round((abs % 3600) / 60);
      const hs = `${totalH}h${remMin > 0 ? ` ${remMin}min` : ''}${inv}`;
      opts.push({ label: hs, hint: 'total em horas', value: hs });
      const totalMin = Math.round(abs / 60);
      opts.push({ label: `${totalMin} minutos${inv}`, hint: 'total em minutos', value: `${totalMin} minutos${inv}` });
      opts.push({ label: raw, hint: 'período', value: raw });
      return opts;
    }
    case 'email': {
      const lower = raw.toLowerCase();
      const opts = [{ label: raw, hint: 'email', value: raw }];
      if (lower !== raw) opts.push({ label: lower, hint: 'minúsculas', value: lower });
      return opts;
    }
    default:
      return [{ label: raw, hint: '', value: raw }];
  }
}

// ── Detecção inteligente (CPF / CNPJ / telefone / data / CEP / e-mail / cálculo) ──
const DETECTORS = [
  { type: 'email', re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  { type: 'cnpj',  re: /[A-Z0-9]{2}\.[A-Z0-9]{3}\.[A-Z0-9]{3}\/[A-Z0-9]{4}-\d{2}/gi },
  { type: 'cpf',   re: /\d{3}\.\d{3}\.\d{3}-\d{2}/g                         },
  { type: 'cep',           re: /\b\d{5}-\d{3}\b/g },
  { type: 'datetimerange', re: /\b\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4}[ \t]+\d{1,2}:\d{2}(?::\d{2})?[ \t]+at[eé][ \t]+\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4}[ \t]+\d{1,2}:\d{2}(?::\d{2})?\b/gi },
  { type: 'daterange',     re: /\b\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4}[ \t]+at[eé][ \t]+\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4}\b/gi },
  { type: 'timerange',     re: /\b\d{1,2}:\d{2}(?::\d{2})?[ \t]+at[eé][ \t]+\d{1,2}:\d{2}(?::\d{2})?\b/gi },
  { type: 'date',          re: /\b\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4}\b/g },
  { type: 'date',  re: /\b\d{4}-\d{2}-\d{2}\b/g                             },
  { type: 'date',  re: /\b\d{2} \d{2} \d{4}\b/g                             },
  { type: 'phone', re: /\(?\d{2}\)?[\s]?\d{4,5}-\d{4}/g                     },
  { type: 'date',  re: /\b(?:19|20)\d{6}\b/g                                 },
  { type: 'cnpj',  re: /\b\d{14}\b/g                                         },
  { type: 'cpf',   re: /\b\d{11}\b/g                                         },
  { type: 'phone', re: /\b\d{10}\b/g                                          },
  { type: 'cep',   re: /\b\d{8}\b/g                                           },
  { type: 'math',  re: /\(*-?\d+(?:[.,]\d+)*[)%]*(?:\s*(?:\*\*|[-+×÷*/^])\s*\(*-?\d+(?:[.,]\d+)*[)%]*)+/g },
];

function findDetectionMatches(text) {
  const matches = [];
  for (const { type, re } of DETECTORS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end   = start + m[0].length;
      if (type === 'date'          && !parseDate(m[0]))          continue;
      if (type === 'daterange'     && !parseDateRange(m[0]))     continue;
      if (type === 'timerange'     && !parseTimeRange(m[0]))     continue;
      if (type === 'datetimerange' && !parseDateTimeRange(m[0])) continue;
      if (type === 'math') {
        const p = tryParseMath(m[0]);
        if (!p) continue;
        mathCache.set(m[0], p);
      }
      const overlaps = matches.some(e => e.start < end && e.end > start);
      if (!overlaps) matches.push({ start, end, type, raw: m[0] });
    }
  }
  matches.sort((a, b) => a.start - b.start);
  return matches;
}

// Remove marcações antigas de um bloco, deixando só o texto/formatação real.
function unwrapMarks(el) {
  el.querySelectorAll('mark').forEach(mark => mark.replaceWith(...mark.childNodes));
  el.normalize();
}

// Reaplica <mark> nos trechos de texto puro do bloco (não mexe no que já é
// negrito/itálico/código real — só varre os nós de texto).
function applyDetectionMarks(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  for (const textNode of textNodes) {
    const text = textNode.data;
    const matches = findDetectionMatches(text);
    if (matches.length === 0) continue;

    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const m of matches) {
      if (m.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, m.start)));
      const mark = document.createElement('mark');
      let cls = m.type;
      if (m.type === 'cpf')  cls += validateCPF(m.raw)  ? ' valid' : ' invalid';
      if (m.type === 'cnpj') cls += validateCNPJ(m.raw) ? ' valid' : ' invalid';
      mark.className = cls;
      mark.dataset.type = m.type;
      mark.dataset.value = m.raw;
      mark.textContent = m.raw;
      frag.appendChild(mark);
      pos = m.end;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    textNode.replaceWith(frag);
  }
}

// ── Cursor / offsets de texto dentro de um bloco ──────────────────────────────
function pointAtOffset(contentEl, offset) {
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
  let node, acc = 0, last = null;
  while ((node = walker.nextNode())) {
    last = node;
    const len = node.data.length;
    if (acc + len >= offset) return { node, offset: offset - acc };
    acc += len;
  }
  if (last) return { node: last, offset: last.data.length };
  return { node: contentEl, offset: 0 };
}

function rangeFromOffsets(contentEl, start, end) {
  const a = pointAtOffset(contentEl, start);
  const b = pointAtOffset(contentEl, end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

function getCaretOffset(contentEl) {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  if (!contentEl.contains(range.startContainer)) return 0;
  const pre = range.cloneRange();
  pre.selectNodeContents(contentEl);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function setCaretOffset(contentEl, offset) {
  const p = pointAtOffset(contentEl, offset);
  const range = document.createRange();
  range.setStart(p.node, p.offset);
  range.collapse(true);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// ── Modelo de blocos ───────────────────────────────────────────────────────────
const HEADING_TAGS = { heading1: 'h1', heading2: 'h2', heading3: 'h3', heading4: 'h4', heading5: 'h5', heading6: 'h6' };

function createBlockEl(type, innerHTML = '', checked = false) {
  let el;

  if (HEADING_TAGS[type]) {
    el = document.createElement(HEADING_TAGS[type]);
    el.className = 'block';
    el.contentEditable = 'true';
    el.innerHTML = innerHTML;

  } else if (type === 'quote') {
    el = document.createElement('blockquote');
    el.className = 'block';
    el.contentEditable = 'true';
    el.innerHTML = innerHTML;

  } else if (type === 'bullet' || type === 'number' || type === 'checklist') {
    el = document.createElement('div');
    el.className = 'block block-list' + (type === 'checklist' ? ' block-checklist' : '');
    const marker = document.createElement('span');
    marker.className = 'block-marker';
    marker.contentEditable = 'false';
    if (type === 'checklist') {
      marker.classList.add('cb-wrap');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!checked;
      marker.appendChild(cb);
      el.dataset.checked = checked ? 'true' : 'false';
    } else {
      marker.textContent = type === 'bullet' ? '•' : '1.';
    }
    const content = document.createElement('span');
    content.className = 'block-content';
    content.contentEditable = 'true';
    content.innerHTML = innerHTML;
    el.append(marker, content);

  } else if (type === 'code') {
    el = document.createElement('div');
    el.className = 'block block-code';
    const content = document.createElement('span');
    content.className = 'block-content';
    content.contentEditable = 'true';
    content.innerHTML = innerHTML;
    el.appendChild(content);

  } else if (type === 'divider') {
    el = document.createElement('div');
    el.className = 'block block-divider';
    el.contentEditable = 'false';
    el.appendChild(document.createElement('hr'));

  } else {
    el = document.createElement('p');
    el.className = 'block';
    el.contentEditable = 'true';
    el.innerHTML = innerHTML;
  }

  el.dataset.type = type;
  el.dataset.id = uid();

  // Um elemento editável totalmente vazio (sem nem um nó de texto) não fica
  // clicável/digitável de forma confiável em alguns navegadores — sobretudo
  // o <span> de conteúdo de listas/checklist/código, que colapsa a altura
  // zero quando vazio. Um <br> "segura" o espaço pro cursor.
  if (type !== 'divider') {
    const contentEl = getContentEl(el);
    if (!contentEl.hasChildNodes()) contentEl.appendChild(document.createElement('br'));
  }

  return el;
}

function getContentEl(blockEl) {
  return blockEl.querySelector(':scope > .block-content') || blockEl;
}

// Esvazia o conteúdo de um bloco mantendo o <br> de segurança (ver createBlockEl).
function clearContent(el) {
  el.innerHTML = '';
  el.appendChild(document.createElement('br'));
}

function convertBlockType(blockEl, newType, checked = false) {
  const oldContent = getContentEl(blockEl);
  const newBlock = createBlockEl(newType, oldContent.innerHTML, checked);
  blockEl.replaceWith(newBlock);
  return newBlock;
}

function getBlockFromNode(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== root && !el.classList?.contains('block')) el = el.parentElement;
  return el === root ? null : el;
}

function currentBlock() {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  return getBlockFromNode(sel.anchorNode);
}

function focusBlockStart(block) {
  const content = getContentEl(block);
  content.focus();
  setCaretOffset(content, 0);
}

function renumberLists() {
  let n = 0;
  for (const block of root.children) {
    if (block.dataset.type === 'number') {
      n++;
      const marker = block.querySelector('.block-marker');
      if (marker) marker.textContent = `${n}.`;
    } else {
      n = 0;
    }
  }
}

// ── Undo / redo próprios ──────────────────────────────────────────────────────
// O undo nativo do navegador só entende edição de texto simples — ele não
// sabe desfazer as trocas de tipo de bloco (viram elementos novos via
// replaceWith), então precisa de um histórico próprio por nota.
const UNDO_LIMIT = 100;
let undoStack = [];
let redoStack = [];
let pendingTypingSnapshot = null;
let typingSnapshotTimer   = null;

function snapshotState() {
  return root.innerHTML;
}

function pushUndoSnapshot(html) {
  undoStack.push(html);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
}

// Chama antes de qualquer mudança estrutural (conversão de tipo, enter,
// backspace, colar, divisor…) — captura o estado imediatamente anterior.
function captureUndoPoint() {
  clearTimeout(typingSnapshotTimer);
  pendingTypingSnapshot = null;
  pushUndoSnapshot(snapshotState());
}

// Para digitação contínua: grava só um ponto no início de cada "rajada" de
// teclas (debounce), não a cada caractere.
function captureTypingUndoPoint() {
  if (pendingTypingSnapshot === null) {
    pendingTypingSnapshot = snapshotState();
    pushUndoSnapshot(pendingTypingSnapshot);
  }
  clearTimeout(typingSnapshotTimer);
  typingSnapshotTimer = setTimeout(() => { pendingTypingSnapshot = null; }, 600);
}

function resetUndoHistory() {
  undoStack = [];
  redoStack = [];
  pendingTypingSnapshot = null;
  clearTimeout(typingSnapshotTimer);
}

function restoreSnapshot(html) {
  root.innerHTML = html;

  // O atributo "checked" do <input> não acompanha sozinho o innerHTML (é uma
  // propriedade viva, não refletida) — sincroniza a partir do data-checked,
  // que é um atributo de verdade e volta certinho.
  root.querySelectorAll('.block-checklist').forEach(block => {
    const cb = block.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = block.dataset.checked === 'true';
  });

  renumberLists();

  const last = root.lastElementChild;
  if (last) {
    const c = getContentEl(last);
    c.focus();
    setCaretOffset(c, c.textContent.length);
  }
  scheduleSave();
}

function performUndo() {
  if (undoStack.length === 0) return;
  pendingTypingSnapshot = null;
  clearTimeout(typingSnapshotTimer);
  const current = snapshotState();
  const prev = undoStack.pop();
  redoStack.push(current);
  restoreSnapshot(prev);
}

function performRedo() {
  if (redoStack.length === 0) return;
  const current = snapshotState();
  const next = redoStack.pop();
  undoStack.push(current);
  restoreSnapshot(next);
}

// ── Detecção com debounce (não recalcula a cada tecla, só quando pausa) ──────
function scheduleRescan(block) {
  rescanBlock = block;
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(flushRescan, 500);
}

function flushRescan() {
  clearTimeout(rescanTimer);
  if (!rescanBlock) return;
  const block = rescanBlock;
  rescanBlock = null;
  if (!document.body.contains(block)) return;
  if (block.dataset.type === 'code' || block.dataset.type === 'divider') return;

  const content = getContentEl(block);
  const sel = document.getSelection();
  const hadFocus = sel && content.contains(sel.anchorNode);
  const caretOffset = hadFocus ? getCaretOffset(content) : null;

  unwrapMarks(content);
  applyDetectionMarks(content);

  if (hadFocus && caretOffset !== null) setCaretOffset(content, caretOffset);
}

root.addEventListener('blur', flushRescan, true);

// ── Salvamento ────────────────────────────────────────────────────────────────
// `keepBreaks` mantém <br> real (bloco de código, onde é quebra de linha de
// verdade); nos outros tipos o <br> é só o "segurador" de cursor de um bloco
// vazio (ver createBlockEl/clearContent) e não deve ser persistido.
function sanitizeForSave(html, keepBreaks = false) {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('mark').forEach(m => m.replaceWith(...m.childNodes));
  if (!keepBreaks) div.querySelectorAll('br').forEach(br => br.remove());
  div.normalize();
  return div.innerHTML;
}

function serializeBlocks() {
  return [...root.children].map(block => {
    const type = block.dataset.type;
    const b = { id: block.dataset.id, type };
    if (type === 'divider') return b;
    b.html = sanitizeForSave(getContentEl(block).innerHTML, type === 'code');
    if (type === 'checklist') b.checked = block.dataset.checked === 'true';
    return b;
  });
}

// Blocos da nota atual, prontos pra exportar/copiar (blocksToMarkdown /
// blocksToPlainText, em blocks.js) — lê direto do DOM ao vivo, sempre atual.
export function getCurrentBlocks() {
  return serializeBlocks();
}

function showSaved() {
  indicator.textContent = 'salvo ✓';
  indicator.classList.add('visible');
  clearTimeout(indicatorTimer);
  indicatorTimer = setTimeout(() => indicator.classList.remove('visible'), 2200);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 800);
}

export async function flushSave() {
  clearTimeout(saveTimer);
  flushRescan();
  if (currentNoteId == null) return;
  const blocks = serializeBlocks();
  // Markdown completo (não só texto simples) — é o que permite recuperar
  // negrito/itálico/etc. se a nota precisar ser reconstruída a partir desse
  // campo (fallback de portabilidade).
  const content = blocksToMarkdown(blocks);
  await updateNoteBlocksById(currentNoteId, blocks, content);
  showSaved();
}

// ── Carregar / trocar de nota ───────────────────────────────────────────────────
function renderBlocks(blocks) {
  root.innerHTML = '';
  for (const b of blocks) {
    const el = createBlockEl(b.type, b.html ?? '', b.checked ?? false);
    if (b.id) el.dataset.id = b.id;
    root.appendChild(el);
  }
  if (root.children.length === 0) root.appendChild(createBlockEl('paragraph'));
  renumberLists();

  for (const block of root.children) {
    if (block.dataset.type === 'code' || block.dataset.type === 'divider') continue;
    applyDetectionMarks(getContentEl(block));
  }

  resetUndoHistory(); // histórico de undo é por nota, não deve vazar de uma pra outra
}

export async function switchToNote(id) {
  await flushSave();
  currentNoteId = id;
  const note = await getNoteById(id);
  const blocks = (note?.blocks?.length) ? note.blocks : parseMarkdownToBlocks(note?.content ?? '');
  renderBlocks(blocks);
}

// ── Posicionamento de menus ───────────────────────────────────────────────────
function positionMenu(menu, anchorRect) {
  const mh  = menu.offsetHeight;
  const mw  = menu.offsetWidth;
  const gap = 6;
  const top = anchorRect.bottom + gap + mh > window.innerHeight
    ? anchorRect.top - mh - gap
    : anchorRect.bottom + gap;
  menu.style.top  = `${Math.max(4, top)}px`;
  menu.style.left = `${Math.max(4, Math.min(anchorRect.left, window.innerWidth - mw - 4))}px`;
}

// ── Menu de cópia ─────────────────────────────────────────────────────────────
function closeCopyMenu() {
  activeMenu?.remove();
  activeMenu = null;
}

function showCopyMenu(type, raw, anchorRect) {
  closeCopyMenu();

  const options = buildCopyOptions(type, raw);
  const menu    = document.createElement('div');
  menu.className = 'copy-menu';

  const header = document.createElement('div');
  header.className   = 'copy-menu-header';
  header.textContent = TYPE_LABELS[type] || 'Valor detectado';
  menu.appendChild(header);

  if (type === 'cpf' || type === 'cnpj') {
    const valid  = type === 'cpf' ? validateCPF(raw) : validateCNPJ(raw);
    const badge  = document.createElement('div');
    badge.className   = `copy-menu-badge ${valid ? 'valid' : 'invalid'}`;
    badge.textContent = valid ? '✓ Válido' : '✗ Inválido';
    menu.appendChild(badge);
  }

  for (const { label, hint, value } of options) {
    const btn = document.createElement('button');
    btn.className = 'copy-opt';
    btn.innerHTML = `
      <span class="copy-opt-value">${escHtml(label)}</span>
      ${hint ? `<span class="copy-opt-hint">${escHtml(hint)}</span>` : ''}
    `;
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(value).then(() => {
        showFeedback('copiado!');
        closeCopyMenu();
      });
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  activeMenu = menu;
  positionMenu(menu, anchorRect);
}

document.addEventListener('mousedown', e => {
  if (activeMenu && !activeMenu.contains(e.target)) closeCopyMenu();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeCopyMenu();
});

// ── Feedback visual ───────────────────────────────────────────────────────────
function showFeedback(msg) {
  indicator.textContent = msg;
  indicator.classList.add('visible');
  clearTimeout(indicatorTimer);
  indicatorTimer = setTimeout(() => {
    indicator.classList.remove('visible');
    if (isCtrlHeld) {
      indicator.textContent = 'Ctrl+clique para copiar';
      indicator.classList.add('visible');
    }
  }, 1400);
}

// ── Ctrl: ativa modo de cópia rápida ──────────────────────────────────────────
function setCtrl(active) {
  if (isCtrlHeld === active) return;
  isCtrlHeld = active;
  noteSection.classList.toggle('ctrl-active', active);

  if (active) {
    showFeedback('Ctrl+clique para copiar');
  } else {
    if (!activeMenu) indicator.classList.remove('visible');
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Control' || e.key === 'Meta') setCtrl(true);
});
document.addEventListener('keyup', e => {
  if (e.key === 'Control' || e.key === 'Meta') setCtrl(false);
});
window.addEventListener('blur', () => setCtrl(false));

// ── Clique em marcação detectada (CPF, data, cálculo…) ────────────────────────
root.addEventListener('click', e => {
  if (!isCtrlHeld) return;
  const mark = e.target.closest('mark');
  if (!mark) { closeCopyMenu(); return; }

  const type = mark.dataset.type;
  const raw  = mark.dataset.value;
  const rect = mark.getBoundingClientRect();

  if (type === 'math') {
    const parsed = mathCache.get(raw);
    if (parsed) showMathMenu(parsed, rect);
    return;
  }
  showCopyMenu(type, raw, rect);
});

// ── Checklist: clique direto na caixa (sem precisar de Ctrl) ──────────────────
root.addEventListener('change', e => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  const block = getBlockFromNode(e.target);
  if (!block) return;
  block.dataset.checked = e.target.checked ? 'true' : 'false';
  scheduleSave();
});

// ── Copiar ─────────────────────────────────────────────────────────────────
// Cada linha da nota é um elemento de bloco separado (<p>, <div>…) — o
// navegador, ao copiar uma seleção que atravessa vários blocos, insere uma
// linha em branco entre cada um (é assim que ele serializa "parágrafos" em
// texto puro). Aqui a gente monta o texto copiado na mão, uma quebra de
// linha simples por bloco, pra colar em outro lugar sair igual ao que
// aparece na tela.
function textForBlockInSelection(block, isFirst, isLast, range) {
  const content = getContentEl(block);
  const sub = document.createRange();

  if (isFirst) sub.setStart(range.startContainer, range.startOffset);
  else         sub.setStart(content, 0);

  if (isLast) sub.setEnd(range.endContainer, range.endOffset);
  else        sub.setEnd(content, content.childNodes.length);

  if (block.dataset.type === 'code') {
    const frag = sub.cloneContents();
    frag.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    return frag.textContent ?? '';
  }
  return sub.toString();
}

root.addEventListener('copy', e => {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== root) return;

  const blocks = getSelectedBlocks();
  if (blocks.length === 0) return;

  const text = blocks
    .map((b, i) => textForBlockInSelection(b, i === 0, i === blocks.length - 1, range))
    .join('\n');

  e.clipboardData.setData('text/plain', text);
  e.preventDefault();
});

// ── Menu "/" (trocar tipo de bloco, estilo Notion) ────────────────────────────
const SLASH_ITEMS = [
  { key: 'texto',      label: 'Texto',                 hint: 'parágrafo',  type: 'paragraph' },
  { key: 'titulo1',    label: 'Título 1',               hint: '#',          type: 'heading1'  },
  { key: 'titulo2',    label: 'Título 2',               hint: '##',         type: 'heading2'  },
  { key: 'titulo3',    label: 'Título 3',               hint: '###',        type: 'heading3'  },
  { key: 'lista',      label: 'Lista com marcadores',   hint: '-',          type: 'bullet'    },
  { key: 'numerada',   label: 'Lista numerada',         hint: '1.',         type: 'number'    },
  { key: 'checklist',  label: 'Checklist',              hint: '[ ]',        type: 'checklist' },
  { key: 'citacao',    label: 'Citação',                hint: '>',          type: 'quote'     },
  { key: 'codigo',     label: 'Código',                 hint: '```',        type: 'code'      },
  { key: 'divisor',    label: 'Divisor',                hint: '---',        type: 'divider'   },
];

let slashMenuEl = null;
let slashItems  = [];
let slashIndex  = 0;
let slashBlock  = null;

function closeSlashMenuEl() { slashMenuEl?.remove(); slashMenuEl = null; }
function closeSlashMenu() { closeSlashMenuEl(); slashItems = []; slashBlock = null; }

function cancelSlashMenu() {
  if (slashBlock) clearContent(getContentEl(slashBlock));
  closeSlashMenu();
}

function renderSlashMenu(block) {
  closeSlashMenuEl();
  const menu = document.createElement('div');
  menu.className = 'copy-menu slash-menu';

  slashItems.forEach((it, i) => {
    const btn = document.createElement('button');
    btn.className = 'copy-opt slash-opt' + (i === slashIndex ? ' active' : '');
    btn.innerHTML = `<span class="copy-opt-value">${escHtml(it.label)}</span><span class="copy-opt-hint">${escHtml(it.hint)}</span>`;
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => { slashIndex = i; confirmSlashSelection(); });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  slashMenuEl = menu;
  positionMenu(menu, block.getBoundingClientRect());
}

function moveSlashSelection(delta) {
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  renderSlashMenu(slashBlock);
}

function confirmSlashSelection() {
  const item  = slashItems[slashIndex];
  const block = slashBlock;
  closeSlashMenu();
  if (!item || !block) return;

  captureUndoPoint();

  if (item.type === 'divider') {
    const divider = createBlockEl('divider');
    block.replaceWith(divider);
    const para = createBlockEl('paragraph');
    divider.after(para);
    focusBlockStart(para);
  } else {
    const newBlock = convertBlockType(block, item.type);
    clearContent(getContentEl(newBlock));
    focusBlockStart(newBlock);
  }
  renumberLists();
}

function checkSlashMenu(block) {
  const text = getContentEl(block).textContent;
  const m = /^\/(\w*)$/.exec(text);
  if (!m) { closeSlashMenu(); return; }

  const filter = m[1].toLowerCase();
  slashItems = SLASH_ITEMS.filter(it => it.label.toLowerCase().includes(filter) || it.key.includes(filter));
  if (slashItems.length === 0) { closeSlashMenu(); return; }

  slashBlock = block;
  slashIndex = 0;
  renderSlashMenu(block);
}

// ── Atalhos de Markdown → tipo de bloco (estilo Notion) ───────────────────────
const BLOCK_SHORTCUTS = [
  { re: /^(#{1,6}) $/, type: m => `heading${m[1].length}` },
  { re: /^([-*]) \[([ xX])\] $/, type: () => 'checklist', checked: m => /[xX]/.test(m[2]) },
  { re: /^[-*] $/, type: () => 'bullet' },
  { re: /^\d+\. $/, type: () => 'number' },
  { re: /^> $/, type: () => 'quote' },
  { re: /^```$/, type: () => 'code' },
];

function checkDividerShortcut(block) {
  const content = getContentEl(block);
  if (!/^(-{3,}|\*{3,}|_{3,})$/.test(content.textContent)) return false;

  const divider = createBlockEl('divider');
  block.replaceWith(divider);
  const para = createBlockEl('paragraph');
  divider.after(para);
  focusBlockStart(para);
  renumberLists();
  return true;
}

function checkBlockShortcut(block) {
  const text = getContentEl(block).textContent;
  for (const s of BLOCK_SHORTCUTS) {
    const m = s.re.exec(text);
    if (!m) continue;
    const type = s.type(m);
    const checked = s.checked ? s.checked(m) : false;
    const newBlock = convertBlockType(block, type, checked);
    clearContent(getContentEl(newBlock));
    focusBlockStart(newBlock);
    renumberLists();
    closeSlashMenu();
    return true;
  }
  return false;
}

// ── Formatação inline automática (**negrito**, *itálico*, `código`, ~~riscado~~) ──
const INLINE_SHORTCUTS = [
  { re: /`([^`\n]+?)`$/, tag: 'code' },
  { re: /\*\*([^\n]+?)\*\*$/, tag: 'strong' },
  { re: /~~([^\n]+?)~~$/, tag: 's' },
  { re: /(?<!\*)\*(?![\s*])([^*\n]+?)(?<![\s*])\*$/, tag: 'em' },
];

function replaceRangeWithTag(contentEl, start, end, tag, innerText) {
  const range = rangeFromOffsets(contentEl, start, end);
  range.deleteContents();
  const el = document.createElement(tag);
  el.textContent = innerText;
  range.insertNode(el);

  const after = document.createRange();
  after.setStartAfter(el);
  after.collapse(true);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(after);
}

function tryAutoFormatInline(contentEl) {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
  if (!contentEl.contains(sel.anchorNode)) return;

  const offset = getCaretOffset(contentEl);
  const before = contentEl.textContent.slice(0, offset);

  for (const { re, tag } of INLINE_SHORTCUTS) {
    const m = re.exec(before);
    if (!m) continue;
    replaceRangeWithTag(contentEl, offset - m[0].length, offset, tag, m[1]);
    return;
  }
}

// ── Enter / Backspace ─────────────────────────────────────────────────────────
function htmlOfFragment(fragment) {
  const div = document.createElement('div');
  div.appendChild(fragment);
  return div.innerHTML;
}

function handleEnter(block) {
  captureUndoPoint();
  const content  = getContentEl(block);
  const offset   = getCaretOffset(content);
  const type     = block.dataset.type;
  const isListish = type === 'bullet' || type === 'number' || type === 'checklist';
  const isEmpty   = content.textContent.trim() === '';

  if (isListish && isEmpty) {
    const para = convertBlockType(block, 'paragraph');
    focusBlockStart(para);
    renumberLists();
    return;
  }

  const start = pointAtOffset(content, offset);
  const afterRange = document.createRange();
  afterRange.setStart(start.node, start.offset);
  afterRange.setEndAfter(content.lastChild ?? content.firstChild ?? content);
  const afterHTML = htmlOfFragment(afterRange.extractContents());

  const nextType = isListish ? type : 'paragraph';
  const newBlock = createBlockEl(nextType, afterHTML, false);
  block.after(newBlock);
  focusBlockStart(newBlock);
  renumberLists();
}

function handleBackspaceAtStart(block) {
  captureUndoPoint();
  const type    = block.dataset.type;
  const content = getContentEl(block);
  const isEmpty = content.textContent.trim() === '';

  // Bloco especial COM texto: primeiro Backspace só tira a formatação
  // (volta a parágrafo), preserva o conteúdo — evita apagar sem querer.
  // Já vazio (ex.: checklist sem texto), pula direto pra mesclar/remover —
  // não faz sentido exigir um Backspace a mais só pra "desformatar o nada".
  if (type !== 'paragraph' && !isEmpty) {
    const para = convertBlockType(block, 'paragraph');
    focusBlockStart(para);
    renumberLists();
    return;
  }

  const prev = block.previousElementSibling;
  if (!prev) {
    if (type !== 'paragraph') {
      const para = convertBlockType(block, 'paragraph');
      focusBlockStart(para);
      renumberLists();
    }
    return;
  }

  if (prev.dataset.type === 'divider') {
    prev.remove();
    renumberLists();
    return;
  }

  const prevContent = getContentEl(prev);
  const joinOffset  = prevContent.textContent.length;

  if (!isEmpty) {
    while (content.firstChild) prevContent.appendChild(content.firstChild);
  }
  block.remove();

  prevContent.focus();
  setCaretOffset(prevContent, joinOffset);
  renumberLists();
}

// ── Eventos principais do editor ──────────────────────────────────────────────
// Dispara antes da mudança entrar no DOM — é o único ponto em que dá pra
// capturar o estado "antes" da digitação normal (o 'input' já roda depois).
// Enter/Backspace/colar já têm sua própria captura (são interceptados com
// preventDefault antes de gerar beforeinput).
root.addEventListener('beforeinput', () => {
  captureTypingUndoPoint();
});

root.addEventListener('input', () => {
  const block = currentBlock();
  if (!block) return;

  if (block.dataset.type === 'paragraph') {
    if (checkDividerShortcut(block)) { scheduleSave(); return; }
    if (checkBlockShortcut(block))   { scheduleSave(); return; }
    checkSlashMenu(block);
  } else {
    closeSlashMenu();
  }

  if (block.dataset.type !== 'code') {
    tryAutoFormatInline(getContentEl(block));
  }

  scheduleRescan(block);
  scheduleSave();
});

root.addEventListener('keydown', e => {
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z') {
    e.preventDefault();
    performUndo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (key === 'y' || (e.shiftKey && key === 'z'))) {
    e.preventDefault();
    performRedo();
    return;
  }

  if ((e.key === 'Backspace' || e.key === 'Delete') && selectedBlockIds.size > 0) {
    e.preventDefault();
    const first = findBlockById([...selectedBlockIds][0]);
    if (first) deleteBlocksOrOne(first);
    return;
  }
  if (e.key === 'Escape' && selectedBlockIds.size > 0) {
    e.preventDefault();
    clearBlockSelection();
    return;
  }

  if (slashMenuEl) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSlashSelection(1);  return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveSlashSelection(-1); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); confirmSlashSelection(); return; }
    if (e.key === 'Escape') { e.preventDefault(); cancelSlashMenu(); return; }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    const block = currentBlock();
    if (!block || block.dataset.type === 'code') return;
    e.preventDefault();
    handleEnter(block);
    scheduleSave();
    return;
  }

  if (e.key === 'Backspace') {
    const sel = document.getSelection();
    if (!sel || !sel.isCollapsed) return;
    const block = currentBlock();
    if (!block) return;
    const content = getContentEl(block);
    if (getCaretOffset(content) !== 0) return;
    e.preventDefault();
    handleBackspaceAtStart(block);
    scheduleSave();
    return;
  }

  if (e.key === 'Tab') {
    e.preventDefault();
  }
});

root.addEventListener('paste', e => {
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!text) return;

  if (text.includes('\n')) {
    pasteMultilineText(text);
  } else {
    pasteInlineText(text);
  }
});

// Colagem de uma linha só: insere como texto simples via Range (não usa
// execCommand — comportamento inconsistente entre versões do Chrome), sem
// mexer na estrutura do bloco atual. Se não há uma seleção válida dentro do
// editor (ex.: foco perdido), cola no fim do último bloco em vez de não
// fazer nada.
function pasteInlineText(text) {
  const sel = document.getSelection();
  let range = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0) : null;
  if (!range || !root.contains(range.commonAncestorContainer)) {
    const last = root.lastElementChild;
    if (!last) return;
    const c = getContentEl(last);
    c.focus();
    range = document.createRange();
    range.selectNodeContents(c);
    range.collapse(false);
  }

  const block = getBlockFromNode(range.commonAncestorContainer);
  captureUndoPoint();

  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);

  const after = document.createRange();
  after.setStartAfter(node);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);

  if (block) scheduleRescan(block);
  scheduleSave();
}

// Colagem de texto com várias linhas: reaproveita o mesmo parser da migração
// de notas antigas pra reconhecer "# título", "- [ ] tarefa", listas etc. e
// já colar como blocos de verdade, não como texto solto. Se não há bloco com
// foco (currentBlock() falha), cola no fim da nota em vez de não fazer nada.
function pasteMultilineText(text) {
  const block = currentBlock() ?? root.lastElementChild;
  if (!block) return;

  captureUndoPoint();
  const parsed = parseMarkdownToBlocks(text);
  const newEls = parsed.map(b => createBlockEl(b.type, b.html ?? '', b.checked ?? false));

  const content = getContentEl(block);
  const isEmpty = content.textContent.trim() === '';

  let anchor = block;
  for (const el of newEls) { anchor.after(el); anchor = el; }
  if (isEmpty && block.dataset.type === 'paragraph') block.remove();

  const last = newEls[newEls.length - 1];
  const lastContent = getContentEl(last);
  lastContent.focus();
  setCaretOffset(lastContent, lastContent.textContent.length);

  renumberLists();
  for (const el of newEls) {
    if (el.dataset.type !== 'code' && el.dataset.type !== 'divider') {
      applyDetectionMarks(getContentEl(el));
    }
  }
  scheduleSave();
}

// ── Transformações de texto (maiúsculo, minúsculo, etc.) ─────────────────────
const EMAIL_RE_GLOBAL = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

function applySkipEmails(s, fn) {
  const segments = [];
  let pos = 0;
  EMAIL_RE_GLOBAL.lastIndex = 0;
  let m;
  while ((m = EMAIL_RE_GLOBAL.exec(s)) !== null) {
    if (m.index > pos) segments.push({ text: s.slice(pos, m.index), isEmail: false });
    segments.push({ text: m[0], isEmail: true });
    pos = m.index + m[0].length;
  }
  if (pos < s.length) segments.push({ text: s.slice(pos), isEmail: false });
  return segments.map(seg => seg.isEmail ? seg.text : fn(seg.text)).join('');
}

function ttTitleCase(s)    { return s.replace(/(?<!\p{L})\p{L}/gu, c => c.toUpperCase()); }
function ttSentenceCase(s) { return s.toLowerCase().replace(/(^|[.!?…]\s+)(\p{L})/gu, (_, p, c) => p + c.toUpperCase()); }
function ttParaCase(s)     { return s.replace(/(^|\n)([ \t]*)(\p{L})/gu, (_, nl, sp, c) => nl + sp + c.toUpperCase()); }
function ttInvertCase(s)   { return [...s].map(c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join(''); }
function ttNoAccents(s)    { return s.normalize('NFD').replace(/\p{Mn}/gu, ''); }
function ttCleanSpaces(s)  { return s.replace(/[^\S\n]+/g, ' '); }

function applyTransformToSelection(fn) {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;

  captureUndoPoint();
  const block = getBlockFromNode(range.commonAncestorContainer);
  const transformed = applySkipEmails(range.toString(), fn);

  range.deleteContents();
  const textNode = document.createTextNode(transformed);
  range.insertNode(textNode);

  const newRange = document.createRange();
  newRange.selectNode(textNode);
  sel.removeAllRanges();
  sel.addRange(newRange);

  if (block) scheduleRescan(block);
  scheduleSave();
}

const TRANSFORMS = [
  { label: 'AA', title: 'MAIÚSCULO',                      fn: s => s.toUpperCase() },
  { label: 'aa', title: 'minúsculo',                      fn: s => s.toLowerCase() },
  { label: 'Aa', title: 'Primeira letra de cada palavra', fn: ttTitleCase          },
  null,
  { label: 'A.', title: 'Após pontuação',                 fn: ttSentenceCase       },
  { label: '¶A', title: 'Primeira letra do parágrafo',    fn: ttParaCase           },
  null,
  { label: 'aA', title: 'Inverter maiúsculas/minúsculas', fn: ttInvertCase         },
  { label: 'Á',  title: 'Remover acentos',                fn: ttNoAccents          },
  { label: '⎵',  title: 'Limpar espaços duplicados',      fn: ttCleanSpaces        },
];

const ttBar = document.createElement('div');
ttBar.className = 'note-toolbar';
noteSection.appendChild(ttBar);

for (const t of TRANSFORMS) {
  if (t === null) {
    const sep = document.createElement('div');
    sep.className = 'tt-sep';
    ttBar.appendChild(sep);
    continue;
  }
  const btn = document.createElement('button');
  btn.className   = 'tt-btn';
  btn.title       = t.title;
  btn.textContent = t.label;
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', () => applyTransformToSelection(t.fn));
  ttBar.appendChild(btn);
}

// ── Formatação Markdown / troca de tipo de bloco (segunda barra) ─────────────
function execFormat(command) {
  captureUndoPoint();
  document.execCommand(command, false, null);
  const block = currentBlock();
  if (block) scheduleRescan(block);
  scheduleSave();
}

function wrapSelectionInTag(tag) {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;

  captureUndoPoint();
  const el = document.createElement(tag);
  el.appendChild(range.extractContents());
  range.insertNode(el);

  sel.removeAllRanges();
  const r = document.createRange();
  r.selectNode(el);
  sel.addRange(r);

  const block = getBlockFromNode(el);
  if (block) scheduleRescan(block);
  scheduleSave();
}

// Todos os blocos tocados pela seleção atual, na ordem em que aparecem no
// editor (usado pra converter tipo de vários blocos de uma vez — cada linha
// vira um item independente, já que cada uma já é o seu próprio bloco).
function getSelectedBlocks() {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  const startBlock = getBlockFromNode(range.startContainer);
  const endBlock   = getBlockFromNode(range.endContainer);
  if (!startBlock) return [];
  if (!endBlock || startBlock === endBlock) return [startBlock];

  const blocks = [];
  for (let el = startBlock; el; el = el.nextElementSibling) {
    blocks.push(el);
    if (el === endBlock) break;
  }
  return blocks;
}

function convertSelectedBlocks(type) {
  const blocks = getSelectedBlocks();
  if (blocks.length === 0) return;

  captureUndoPoint();

  if (blocks.length === 1) {
    const block   = blocks[0];
    const content = getContentEl(block);
    const offset  = getCaretOffset(content);

    const newBlock   = convertBlockType(block, type, block.dataset.checked === 'true');
    const newContent = getContentEl(newBlock);
    newContent.focus();
    setCaretOffset(newContent, offset);
  } else {
    const newBlocks  = blocks.map(b => convertBlockType(b, type, b.dataset.checked === 'true'));
    const lastContent = getContentEl(newBlocks[newBlocks.length - 1]);
    lastContent.focus();
    setCaretOffset(lastContent, lastContent.textContent.length);
  }

  renumberLists();
  scheduleSave();
}

function insertDividerAtCursor() {
  const block = currentBlock();
  if (!block) return;
  captureUndoPoint();
  const divider = createBlockEl('divider');
  block.after(divider);
  const para = createBlockEl('paragraph');
  divider.after(para);
  focusBlockStart(para);
  renumberLists();
  scheduleSave();
}

const MD_BUTTONS = [
  { label: 'B',   title: 'Negrito (selecione o texto)',   action: () => execFormat('bold') },
  { label: 'I',   title: 'Itálico (selecione o texto)',   action: () => execFormat('italic') },
  { label: 'S',   title: 'Riscado (selecione o texto)',   action: () => execFormat('strikeThrough') },
  { label: '</>', title: 'Código (selecione o texto)',     action: () => wrapSelectionInTag('code') },
  null,
  { label: 'T',   title: 'Texto normal (remove a formatação do bloco)', action: () => convertSelectedBlocks('paragraph') },
  { label: 'H1',  title: 'Título 1',                       action: () => convertSelectedBlocks('heading1') },
  { label: 'H2',  title: 'Título 2',                       action: () => convertSelectedBlocks('heading2') },
  { label: 'H3',  title: 'Título 3',                       action: () => convertSelectedBlocks('heading3') },
  null,
  { label: '•',   title: 'Lista com marcadores',           action: () => convertSelectedBlocks('bullet') },
  { label: '1.',  title: 'Lista numerada',                 action: () => convertSelectedBlocks('number') },
  { label: '☐',   title: 'Checklist',                      action: () => convertSelectedBlocks('checklist') },
  null,
  { label: '"',   title: 'Citação',                        action: () => convertSelectedBlocks('quote') },
  { label: '—',   title: 'Linha horizontal',                action: () => insertDividerAtCursor() },
];

const mdBar = document.createElement('div');
mdBar.className = 'note-toolbar';
noteSection.appendChild(mdBar);

for (const b of MD_BUTTONS) {
  if (b === null) {
    const sep = document.createElement('div');
    sep.className = 'tt-sep';
    mdBar.appendChild(sep);
    continue;
  }
  const btn = document.createElement('button');
  btn.className   = 'tt-btn';
  btn.title       = b.title;
  btn.textContent = b.label;
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', b.action);
  mdBar.appendChild(btn);
}

// ── Menu de cálculo ───────────────────────────────────────────────────────────
function showMathMenu(parsed, anchorRect) {
  closeCopyMenu();
  const { raw, resultFmt, steps } = parsed;
  const menu = document.createElement('div');
  menu.className = 'copy-menu math-menu';

  const hdr = document.createElement('div');
  hdr.className   = 'copy-menu-header';
  hdr.textContent = 'Cálculo';
  menu.appendChild(hdr);

  const exprEl = document.createElement('div');
  exprEl.className   = 'math-expr';
  exprEl.textContent = raw;
  menu.appendChild(exprEl);

  if (steps.length > 0) {
    const sl = document.createElement('div');
    sl.className   = 'math-section-label';
    sl.textContent = 'Passo a passo';
    menu.appendChild(sl);
    for (const s of steps) {
      const el = document.createElement('div');
      el.className   = 'math-step';
      el.textContent = s;
      menu.appendChild(el);
    }
  }

  const resRow = document.createElement('div');
  resRow.className = 'math-result-row';
  resRow.innerHTML =
    `<span class="math-result-label">Resultado</span>` +
    `<span class="math-result-value" title="Clique para copiar">${escHtml(resultFmt)}</span>`;
  resRow.querySelector('.math-result-value').addEventListener('mousedown', e => e.stopPropagation());
  resRow.querySelector('.math-result-value').addEventListener('click', () => {
    navigator.clipboard.writeText(resultFmt).then(() => { showFeedback('copiado!'); closeCopyMenu(); });
  });
  menu.appendChild(resRow);

  const addDiv = () => menu.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));
  addDiv();

  const calcText = `${raw}\n${steps.join('\n')}\n= ${resultFmt}`;
  for (const { label, hint, value } of [
    { label: resultFmt,          hint: 'resultado',    value: resultFmt },
    { label: raw,                hint: 'expressão',    value: raw       },
    { label: 'Cálculo completo', hint: 'com passos',   value: calcText  },
  ]) {
    const btn = document.createElement('button');
    btn.className = 'copy-opt';
    btn.innerHTML =
      `<span class="copy-opt-value">${escHtml(label)}</span>` +
      `<span class="copy-opt-hint">${escHtml(hint)}</span>`;
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(value).then(() => { showFeedback('copiado!'); closeCopyMenu(); });
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  activeMenu = menu;
  positionMenu(menu, anchorRect);
}

// ── Controles de bloco ao passar o mouse (＋ / ⠿, estilo Notion) ──────────────
// Overlay único e flutuante (não embrulha cada bloco) que acompanha o mouse
// e se posiciona à esquerda do bloco sob o cursor. Fica FORA do editável
// (`root`), como irmão dele dentro de `.note-editor` — assim não interfere
// com o `root.children` que o resto do código assume ser só blocos.
const blockControls = document.createElement('div');
blockControls.className = 'block-controls';
blockControls.hidden = true;

const blockAddBtn = document.createElement('button');
blockAddBtn.className = 'block-add-btn';
blockAddBtn.textContent = '+';
blockAddBtn.title = 'Adicionar bloco abaixo (Ctrl+clique: acima)';

const blockHandleBtn = document.createElement('button');
blockHandleBtn.className = 'block-handle-btn';
blockHandleBtn.textContent = '⠿';
blockHandleBtn.title = 'Clique: opções do bloco · Arrastar: mover · Ctrl+arrastar (em qualquer lugar do bloco): selecionar vários';

blockControls.append(blockAddBtn, blockHandleBtn);
noteEditorEl.appendChild(blockControls);

let hoveredBlock = null;

function positionBlockControls(block) {
  hoveredBlock = block;
  const blockRect     = block.getBoundingClientRect();
  const containerRect = noteEditorEl.getBoundingClientRect();
  blockControls.style.top = `${blockRect.top - containerRect.top}px`;
  blockControls.hidden = false;
}

function hideBlockControls() {
  blockControls.hidden = true;
  hoveredBlock = null;
}

root.addEventListener('mousemove', e => {
  if (pointerDown || ctrlPointerDown) return; // decidindo ou já em arrasto — não reposiciona o overlay de hover
  // Bloco mais próximo verticalmente do cursor, não o que está exatamente
  // por baixo — a margem esquerda (onde os ícones aparecem) não pertence a
  // nenhum .block específico, então hover lá nunca batia em nada antes.
  const target = blockNearestToY(e.clientY);
  if (!target || target === hoveredBlock) return;
  positionBlockControls(target);
});

// No container que engloba texto + controles (não só o texto) — senão mover
// o mouse do bloco até os botões já contava como "saiu" e escondia tudo
// antes de dar tempo de clicar.
noteEditorEl.addEventListener('mouseleave', () => {
  if (!blockMenuEl) hideBlockControls();
});

root.addEventListener('scroll', () => {
  blockControls.hidden = true;
});

blockAddBtn.addEventListener('mousedown', e => e.preventDefault());
blockAddBtn.addEventListener('click', e => {
  if (!hoveredBlock) return;
  captureUndoPoint();
  const newBlock = createBlockEl('paragraph');
  if (e.ctrlKey || e.metaKey) hoveredBlock.before(newBlock);
  else hoveredBlock.after(newBlock);
  renumberLists();
  focusBlockStart(newBlock);
  scheduleSave();
});

// ── Seleção múltipla de blocos (Shift+clique na alça) ─────────────────────────
let selectedBlockIds     = new Set();
let lastHandleClickedId  = null;

function findBlockById(id) {
  return [...root.children].find(el => el.classList?.contains('block') && el.dataset.id === id) || null;
}

function orderedBlocks() {
  return [...root.children].filter(el => el.classList?.contains('block'));
}

function setBlockSelection(ids) {
  root.querySelectorAll('.block.block-selected').forEach(b => b.classList.remove('block-selected'));
  selectedBlockIds = new Set(ids);
  for (const b of orderedBlocks()) {
    if (selectedBlockIds.has(b.dataset.id)) b.classList.add('block-selected');
  }
}

function clearBlockSelection() {
  setBlockSelection([]);
  lastHandleClickedId = null;
}

function selectBlockRange(fromBlock, toBlock) {
  const all = orderedBlocks();
  const a = all.indexOf(fromBlock), b = all.indexOf(toBlock);
  if (a === -1 || b === -1) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  setBlockSelection(all.slice(lo, hi + 1).map(el => el.dataset.id));
}

// Blocos-alvo de uma ação do menu: se o bloco clicado faz parte de uma
// seleção múltipla ativa, a ação vale pra todos ela; senão, só pra ele.
function targetBlocksFor(block) {
  if (selectedBlockIds.size > 1 && selectedBlockIds.has(block.dataset.id)) {
    return orderedBlocks().filter(el => selectedBlockIds.has(el.dataset.id));
  }
  return [block];
}

document.addEventListener('mousedown', e => {
  if (selectedBlockIds.size === 0) return;
  if (blockMenuEl && blockMenuEl.contains(e.target)) return;
  if (e.target === blockHandleBtn || e.target === blockAddBtn) return;
  clearBlockSelection();
});

// ── Menu do bloco (alça): Transformar em / Duplicar / Excluir ────────────────
let blockMenuEl = null;
function closeBlockMenu() { blockMenuEl?.remove(); blockMenuEl = null; }

function getTransformTypes() {
  return SLASH_ITEMS.filter(it => it.type !== 'divider');
}

function openBlockMenu(block, anchorEl) {
  closeBlockMenu();
  const menu = document.createElement('div');
  menu.className = 'copy-menu block-menu';

  const scopeCount = (selectedBlockIds.size > 1 && selectedBlockIds.has(block.dataset.id))
    ? selectedBlockIds.size : 1;

  // Divisor não tem conteúdo — não faz sentido "transformar" ele em título,
  // lista etc. (e nem o inverso: não existe like target aqui, ver getTransformTypes).
  const canTransform = block.dataset.type !== 'divider';

  if (canTransform) {
    const header = document.createElement('div');
    header.className   = 'copy-menu-header';
    header.textContent = scopeCount > 1 ? `Transformar em (${scopeCount} blocos)` : 'Transformar em';
    menu.appendChild(header);

    for (const it of getTransformTypes()) {
      const btn = document.createElement('button');
      btn.className = 'copy-opt';
      btn.innerHTML = `<span class="copy-opt-value">${escHtml(it.label)}</span><span class="copy-opt-hint">${escHtml(it.hint)}</span>`;
      btn.addEventListener('mousedown', e => e.stopPropagation());
      btn.addEventListener('click', () => { closeBlockMenu(); transformBlocks(block, it.type); });
      menu.appendChild(btn);
    }

    menu.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));
  }

  const dupBtn = document.createElement('button');
  dupBtn.className = 'copy-opt';
  dupBtn.innerHTML = `<span class="copy-opt-value">Duplicar${scopeCount > 1 ? ` (${scopeCount})` : ''}</span>`;
  dupBtn.addEventListener('mousedown', e => e.stopPropagation());
  dupBtn.addEventListener('click', () => { closeBlockMenu(); duplicateBlocks(block); });
  menu.appendChild(dupBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'copy-opt';
  delBtn.innerHTML = `<span class="copy-opt-value">Excluir${scopeCount > 1 ? ` (${scopeCount})` : ''}</span>`;
  delBtn.addEventListener('mousedown', e => e.stopPropagation());
  delBtn.addEventListener('click', () => { closeBlockMenu(); deleteBlocksOrOne(block); });
  menu.appendChild(delBtn);

  document.body.appendChild(menu);
  blockMenuEl = menu;
  positionMenu(menu, anchorEl.getBoundingClientRect());
}

function transformBlocks(block, type) {
  // Divisor nunca entra como origem de conversão, mesmo se fizer parte de
  // uma seleção múltipla junto com outros blocos — não tem conteúdo pra
  // preservar (converter geraria um <hr> preso dentro de um título/lista).
  const targets = targetBlocksFor(block).filter(b => b.dataset.type !== 'divider');
  if (targets.length === 0) return;

  captureUndoPoint();
  const converted = targets.map(b => convertBlockType(b, type, b.dataset.checked === 'true'));
  renumberLists();
  clearBlockSelection();
  hideBlockControls();
  const lastContent = getContentEl(converted[converted.length - 1]);
  lastContent.focus();
  setCaretOffset(lastContent, lastContent.textContent.length);
  scheduleSave();
}

function duplicateBlocks(block) {
  const targets = targetBlocksFor(block);
  captureUndoPoint();
  let anchor = targets[targets.length - 1];
  for (const b of targets) {
    const clone = createBlockEl(b.dataset.type, getContentEl(b).innerHTML, b.dataset.checked === 'true');
    anchor.after(clone);
    anchor = clone;
  }
  renumberLists();
  clearBlockSelection();
  hideBlockControls();
  scheduleSave();
}

function deleteBlocksOrOne(block) {
  const targets = targetBlocksFor(block);
  captureUndoPoint();

  const prev = targets[0].previousElementSibling;
  targets.forEach(b => b.remove());
  if (root.children.length === 0) root.appendChild(createBlockEl('paragraph'));

  renumberLists();
  clearBlockSelection();
  hideBlockControls();

  const focusTarget = (prev && document.body.contains(prev)) ? prev : root.firstElementChild;
  if (focusTarget) {
    const c = getContentEl(focusTarget);
    c.focus();
    setCaretOffset(c, c.textContent.length);
  }
  scheduleSave();
}

// ── Alça "⠿": clique (menu), Ctrl+clique (seleção), arrastar (mover) ─────────
// Tudo passa por mousedown/mousemove/mouseup — só decide se virou arrasto
// depois de um deslocamento mínimo; sem movimento, trata como clique normal.
// Ctrl (não Shift) pra combinar com o "arrastar pra selecionar" do Windows.
let pointerDown     = null; // { block, startX, startY, ctrl, moved }
let reorderState    = null; // { targets, indicator, dropTarget, dropBefore }
let rangeSelectState = null; // { anchorBlock }

function blockNearestToY(y, exclude = []) {
  let closest = null, closestDist = Infinity;
  for (const b of orderedBlocks()) {
    if (exclude.includes(b)) continue;
    const rect = b.getBoundingClientRect();
    const mid  = rect.top + rect.height / 2;
    const dist = Math.abs(y - mid);
    if (dist < closestDist) { closestDist = dist; closest = b; }
  }
  return closest;
}

function handleHandleClick(block, ctrl) {
  if (ctrl) {
    if (lastHandleClickedId) {
      const anchor = findBlockById(lastHandleClickedId);
      if (anchor) selectBlockRange(anchor, block);
      else setBlockSelection([block.dataset.id]);
    } else {
      setBlockSelection([block.dataset.id]);
    }
    lastHandleClickedId = block.dataset.id;
    return;
  }

  if (!(selectedBlockIds.size > 1 && selectedBlockIds.has(block.dataset.id))) {
    setBlockSelection([block.dataset.id]);
  }
  lastHandleClickedId = block.dataset.id;
  openBlockMenu(block, blockHandleBtn);
}

// ── Arrastar pra reordenar (um bloco, ou o grupo selecionado) ────────────────
function startBlockReorderDrag(block) {
  const targets = targetBlocksFor(block);
  const indicator = document.createElement('div');
  indicator.className = 'block-drop-indicator';
  indicator.hidden = true;
  noteEditorEl.appendChild(indicator);
  targets.forEach(b => b.classList.add('block-dragging'));
  document.body.style.cursor = 'grabbing';
  reorderState = { targets, indicator, dropTarget: null, dropBefore: true };
}

function updateBlockReorderDrag(e) {
  if (!reorderState) return;
  const { targets, indicator } = reorderState;
  const closest = blockNearestToY(e.clientY, targets);
  reorderState.dropTarget = closest;

  if (!closest) { indicator.hidden = true; return; }

  const rect = closest.getBoundingClientRect();
  const before = e.clientY < rect.top + rect.height / 2;
  reorderState.dropBefore = before;

  const containerRect = noteEditorEl.getBoundingClientRect();
  indicator.style.top = `${(before ? rect.top : rect.bottom) - containerRect.top}px`;
  indicator.hidden = false;
}

function finishBlockReorderDrag() {
  if (!reorderState) return;
  const { targets, indicator, dropTarget, dropBefore } = reorderState;

  targets.forEach(b => b.classList.remove('block-dragging'));
  indicator.remove();
  document.body.style.cursor = '';

  if (dropTarget) {
    captureUndoPoint();
    if (dropBefore) {
      targets.forEach(b => dropTarget.before(b));
    } else {
      let anchor = dropTarget;
      for (const b of targets) { anchor.after(b); anchor = b; }
    }
    renumberLists();
    scheduleSave();
  }

  reorderState = null;
}

// ── Ctrl+arrastar pra selecionar um intervalo contínuo ────────────────────────
// Funciona a partir de qualquer ponto do bloco (não só em cima da alça) —
// como o "arrastar pra selecionar" do Windows Explorer, só que em blocos.
function startRangeSelectDrag(block) {
  rangeSelectState = { anchorBlock: block };
  setBlockSelection([block.dataset.id]);
}

function updateRangeSelectDrag(e) {
  if (!rangeSelectState) return;
  const target = blockNearestToY(e.clientY);
  if (!target) return;
  selectBlockRange(rangeSelectState.anchorBlock, target);
}

function finishRangeSelectDrag() {
  if (!rangeSelectState) return;
  lastHandleClickedId = rangeSelectState.anchorBlock.dataset.id;
  rangeSelectState = null;
}

blockHandleBtn.addEventListener('mousedown', e => {
  if (!hoveredBlock) return;
  e.preventDefault();
  pointerDown = { block: hoveredBlock, startX: e.clientX, startY: e.clientY, ctrl: e.ctrlKey || e.metaKey, moved: false };
});

function finishPointerGesture() {
  if (!pointerDown) return;
  if (pointerDown.moved) {
    if (pointerDown.ctrl) finishRangeSelectDrag();
    else                  finishBlockReorderDrag();
  } else {
    handleHandleClick(pointerDown.block, pointerDown.ctrl);
  }
  pointerDown = null;
}

document.addEventListener('mousemove', e => {
  if (!pointerDown) return;

  // Botão já não está mais pressionado (ex.: soltou fora da janela, que é
  // bem fácil de acontecer num painel lateral estreito) — o 'mouseup' pode
  // nunca chegar; encerra o gesto aqui em vez de deixar preso.
  if (e.buttons === 0) { finishPointerGesture(); return; }

  if (!pointerDown.moved) {
    const dx = Math.abs(e.clientX - pointerDown.startX);
    const dy = Math.abs(e.clientY - pointerDown.startY);
    if (dx < 4 && dy < 4) return;
    pointerDown.moved = true;
    hideBlockControls();
    if (pointerDown.ctrl) startRangeSelectDrag(pointerDown.block);
    else                  startBlockReorderDrag(pointerDown.block);
  }

  if (pointerDown.ctrl) updateRangeSelectDrag(e);
  else                  updateBlockReorderDrag(e);
});

document.addEventListener('mouseup', finishPointerGesture);

// ── Ctrl+arrastar a partir de qualquer lugar do bloco (não só a alça) ────────
// Só ativa como seleção quando o mouse realmente se move — um Ctrl+clique
// parado continua funcionando normalmente pro menu de cópia de CPF/data/etc.
let ctrlPointerDown = null; // { startX, startY, moved, anchorBlock }

root.addEventListener('mousedown', e => {
  if (pointerDown) return; // já é um gesto iniciado pela alça
  if (!(e.ctrlKey || e.metaKey)) return;
  const target = e.target.closest('.block');
  if (!target) return;
  // Evita que o navegador comece a selecionar texto nativamente enquanto
  // arrasta; não afeta o Ctrl+clique parado em cima de um <mark> (CPF/data/
  // cálculo) — aquele menu depende do evento 'click', que ainda dispara normalmente.
  e.preventDefault();
  ctrlPointerDown = { startX: e.clientX, startY: e.clientY, moved: false, anchorBlock: target };
});

document.addEventListener('mousemove', e => {
  if (!ctrlPointerDown) return;

  if (e.buttons === 0) { ctrlPointerDown = null; return; }

  if (!ctrlPointerDown.moved) {
    const dx = Math.abs(e.clientX - ctrlPointerDown.startX);
    const dy = Math.abs(e.clientY - ctrlPointerDown.startY);
    if (dx < 4 && dy < 4) return;
    ctrlPointerDown.moved = true;
    hideBlockControls();
    startRangeSelectDrag(ctrlPointerDown.anchorBlock);
  }

  updateRangeSelectDrag(e);
});

document.addEventListener('mouseup', () => {
  if (!ctrlPointerDown) return;
  if (ctrlPointerDown.moved) finishRangeSelectDrag();
  ctrlPointerDown = null;
});

document.addEventListener('mousedown', e => {
  if (blockMenuEl && !blockMenuEl.contains(e.target) && e.target !== blockHandleBtn) closeBlockMenu();
});
