import {
  getNoteById, updateNoteBlocksById, saveFile, loadFileBlob, moveInlineFileToDocuments,
} from './storage.js';
import { refreshDocuments, setDocsCollapsed } from './documents.js';
import { setActiveArea, isNoteActive } from './active-area.js';
import { openModal } from './modal.js';
import { tryParseMath } from './math-parser.js';
import { evaluateSheet } from './calc.js';
import {
  uid, escHtml, safeHref, parseMarkdownToBlocks, blocksToMarkdown, blocksToPlainText,
  MAX_DEPTH, BULLET_GLYPHS, normalizeBlock, blocksToMarkdownForExport,
  CALLOUT_TYPES, CALLOUT_LABELS, headingSlug, headingSlugs,
} from './blocks.js';
import { blockTemplates, openSaveBlockTemplate } from './templates.js';
import { copyBlocksAsImage, downloadBlocksAsImage } from './snapshot.js';
import { iconSvg, createIcon } from './icons.js';

const noteSection  = document.querySelector('.note-section');
const noteEditorEl = document.querySelector('.note-editor');
const root         = document.getElementById('note-editor-blocks');
const indicator    = document.getElementById('save-indicator');
const btnTouchSelect = document.getElementById('btn-touch-select');

let currentNoteId  = null;
let isCtrlHeld     = false;
let touchSelectionActive = false;

// ── Modo de seleção por toque (em telas com dedo / pointer: coarse) ─────────
export function isTouchSelectionMode() {
  return touchSelectionActive;
}

export function setTouchSelectionMode(active) {
  if (touchSelectionActive === active) return;
  touchSelectionActive = active;
  noteSection.classList.toggle('touch-selection-active', active);
  noteSection.classList.toggle('ctrl-active', active || isCtrlHeld);
  if (btnTouchSelect) {
    btnTouchSelect.classList.toggle('is-active', active);
    btnTouchSelect.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  if (active) {
    showFeedback('Modo seleção ativo · toque para selecionar');
  } else {
    if (!activeMenu) indicator.classList.remove('visible');
  }
}

export function toggleTouchSelectionMode() {
  setTouchSelectionMode(!touchSelectionActive);
}

if (btnTouchSelect) {
  btnTouchSelect.addEventListener('click', e => {
    e.stopPropagation();
    toggleTouchSelectionMode();
  });
}
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

// Blocos que não passam pela detecção de CPF/data/cálculo: código é literal,
// divisor não tem texto e a tabela não tem um conteúdo único — são N células.
// Numa folha de cálculo a linha inteira já é conta: a detecção de conta solta
// no meio do texto não tem o que fazer ali dentro.
const NO_DETECTION = new Set(['code', 'divider', 'table', 'image', 'calc']);

// Blocos sem um conteúdo de texto único: getContentEl devolve o próprio bloco
// neles, então perguntar pelo texto não faz sentido.
const NO_TEXT_TYPES = new Set(['divider', 'table', 'image']);

// Âncora invisível do cursor. Fica aqui em cima porque sanitizeForSave a usa
// muito antes do ponto onde ela é criada — ver replaceRangeWithTag, que é onde
// está explicado por que ela existe.
const ANCORA = '​';

function createBlockEl(type, innerHTML = '', checked = false, rows = null) {
  let el;

  // "quote" deixou de ser um tipo e virou decoração. Um registro antigo que
  // escape da normalização ainda chega aqui — vira parágrafo citado, que é a
  // forma nova do mesmo conteúdo.
  if (type === 'quote') {
    const p = createBlockEl('paragraph', innerHTML);
    setBlockQuoted(p, true);
    return p;
  }

  if (type === 'image') {
    el = document.createElement('div');
    el.className = 'block block-image';
    // Não editável, como a tabela e o divisor: o que se edita aqui é o texto
    // alternativo, por botão, não o conteúdo do bloco.
    el.contentEditable = 'false';
    const img = document.createElement('img');
    img.draggable = false;
    img.alt = '';
    el.append(img, buildImageTools());
    el.dataset.type = type;
    el.dataset.id = uid();
    return el;
  }

  if (type === 'table') {
    el = document.createElement('div');
    el.className = 'block block-table';
    // O bloco não é editável; cada célula é a sua própria ilha editável. É isso
    // que mantém a tabela fora das regras de Enter/Backspace dos outros blocos.
    el.contentEditable = 'false';
    el.append(buildTableEl(rows), buildTableTools());
    el.dataset.type = type;
    el.dataset.id = uid();
    return el;
  }

  if (HEADING_TAGS[type]) {
    el = document.createElement(HEADING_TAGS[type]);
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

  } else if (type === 'calc') {
    el = document.createElement('div');
    el.className = 'block block-calc';
    const content = document.createElement('span');
    content.className = 'block-content';
    content.contentEditable = 'true';
    content.innerHTML = innerHTML;
    // O resultado fica fora do editável, na mesma estrutura de dois elementos
    // que lista e checklist usam. É o que impede o cursor de entrar nele ou de
    // apagá-lo sem querer — e o que faz getContentEl continuar valendo.
    const res = document.createElement('span');
    res.className = 'calc-result';
    res.contentEditable = 'false';
    el.append(content, res);

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

// Ponto único pra criar um bloco a partir de dado serializado. Existe porque
// createBlockEl tem parâmetros posicionais e é fácil esquecer o último — foi
// exatamente assim que uma tabela colada virava uma tabela vazia. Campo novo
// no modelo entra aqui e todas as chamadas passam a respeitá-lo de uma vez.
function createBlockElFrom(bruto) {
  const b  = normalizeBlock(bruto);
  const el = createBlockEl(b.type, b.html ?? '', b.checked ?? false, b.rows ?? null);
  if (b.id) el.dataset.id = b.id;
  setBlockDepth(el, b.depth ?? 0);
  setBlockQuoted(el, !!b.quoted);
  setBlockCallout(el, b.callout);
  setBlockUnderlined(el, !!b.underlined);
  if (b.type === 'image') setImageData(el, b);
  return el;
}

// ── Citação (decoração) ───────────────────────────────────────────────────────
// Citação não é um tipo de bloco: é uma marca que qualquer bloco pode ter. É
// isso que faz título, lista e checklist funcionarem DENTRO de uma citação, em
// vez de o conteúdo virar texto literal com ">" na frente.
function isBlockQuoted(el) {
  return el?.dataset?.quoted === 'true';
}

function setBlockQuoted(el, on) {
  if (on) el.dataset.quoted = 'true';
  else { delete el.dataset.quoted; delete el.dataset.callout; }
}

// Destaque (callout) é uma segunda camada em cima da citação: a caixa colorida
// com rótulo dos sites de documentação. No markdown ela é exatamente isso —
// uma citação com um marcador na primeira linha —, então tirar a citação tira
// o destaque junto (ver setBlockQuoted).
// Título sublinhado. Também é decoração, não tipo — senão seriam mais duas
// entradas num menu que já estava grande demais. No arquivo isso vira setext
// (o texto com === ou --- embaixo), que é markdown de verdade.
//
// Só título 1 e 2: é o que o setext alcança, e é onde um traço embaixo lê bem.
const PODE_SUBLINHAR = new Set(['heading1', 'heading2']);

function isBlockUnderlined(el) {
  return el?.dataset?.underlined === 'true';
}

function setBlockUnderlined(el, on) {
  if (on && PODE_SUBLINHAR.has(el.dataset.type)) el.dataset.underlined = 'true';
  else delete el.dataset.underlined;
}

function setBlockCallout(el, tipo) {
  if (tipo && CALLOUT_TYPES.includes(tipo)) {
    el.dataset.quoted  = 'true';
    el.dataset.callout = tipo;
  } else {
    delete el.dataset.callout;
  }
}

// ── Profundidade (indentação) ─────────────────────────────────────────────────
// O nível vive num atributo de verdade (data-depth), não numa propriedade do
// elemento: o desfazer restaura por innerHTML, e só atributo volta junto.
// Nível 0 não escreve atributo nenhum — a nota de quem nunca indentou nada
// continua exatamente com a mesma forma de antes.
function blockDepth(el) {
  const d = Number(el?.dataset?.depth) || 0;
  return Math.min(Math.max(d, 0), MAX_DEPTH);
}

function setBlockDepth(el, depth) {
  const d = Math.min(Math.max(Math.round(depth) || 0, 0), MAX_DEPTH);
  if (d) el.dataset.depth = String(d);
  else delete el.dataset.depth;
}

// Fecha a escada depois de qualquer mudança de ordem — arrastar um bloco de
// nível 2 pro topo deixaria um nível sem pai.
function normalizeDepths() {
  let anterior = -1;
  for (const block of root.children) {
    const d = Math.min(blockDepth(block), anterior + 1);
    setBlockDepth(block, d);
    anterior = d;
  }
}

// Move os blocos um nível, pra dentro ou pra fora.
//
// A regra que decide tudo é quem é passageiro e quem tem vida própria:
//
// - Um bloco NÃO selecionado que está dentro de um selecionado é passageiro.
//   Acompanha o dono, senão ficaria órfão num nível que deixou de existir.
// - Um bloco SELECIONADO responde por si, mesmo sendo filho de outro
//   selecionado. É isso que faz Shift+Tab num grupo indentado inteiro subir um
//   nível por vez: antes o primeiro bloco do grupo era tratado como dono de
//   todos, e como ele já estava na margem e não tinha pra onde subir, ele
//   travava o grupo inteiro e a tecla não fazia nada.
function indentBlocks(blocks, delta) {
  const selecionados = new Set(blocks);
  const novos = new Map();
  const depthDe = b => (novos.has(b) ? novos.get(b) : blockDepth(b));

  // Teto olhando a profundidade NOVA do bloco anterior: num grupo que desce
  // junto, o primeiro já desceu quando chega a vez do segundo.
  const tetoPara = b => {
    const prev = b.previousElementSibling;
    return prev ? Math.min(depthDe(prev) + 1, MAX_DEPTH) : 0;
  };

  let dono = null;
  let deslocamento = 0;

  for (const b of orderedBlocks()) {
    const atual = blockDepth(b);
    if (dono && atual <= blockDepth(dono)) dono = null;   // saiu de dentro do dono

    if (selecionados.has(b)) {
      const novo = delta > 0 ? Math.min(atual + 1, tetoPara(b)) : Math.max(atual - 1, 0);
      novos.set(b, novo);
      dono = b;
      deslocamento = novo - atual;
      continue;
    }

    if (dono && deslocamento !== 0) {
      novos.set(b, Math.min(Math.max(atual + deslocamento, 0), MAX_DEPTH));
    }
  }

  let mudou = false;
  for (const [b, novo] of novos) {
    if (novo === blockDepth(b)) continue;
    setBlockDepth(b, novo);
    mudou = true;
  }
  return mudou;
}

// Blocos que o Tab deve mover: a seleção múltipla quando existe, senão o
// bloco do cursor.
function blocksForIndent() {
  if (selectedBlockIds.size > 0) {
    return orderedBlocks().filter(b => selectedBlockIds.has(b.dataset.id));
  }
  const block = currentBlock();
  return block ? [block] : [];
}

function getContentEl(blockEl) {
  return blockEl.querySelector(':scope > .block-content') || blockEl;
}

// ── Imagem na nota ────────────────────────────────────────────────────────────
// O bloco guarda só o id do arquivo; o Blob mora na tabela `files` com a marca
// `inline`. O que aparece na tela é um objectURL, criado sob demanda.
//
// Revogar ao trocar de nota é obrigatório: sem isso cada troca de aba deixa um
// Blob inteiro preso na memória, e uma sessão de trabalho acumula todos.
const imageURLs = new Map();   // fileId → objectURL

function revokeImageURLs() {
  for (const url of imageURLs.values()) URL.revokeObjectURL(url);
  imageURLs.clear();
}

function loadInlineImage(imgEl, fileId) {
  const cached = imageURLs.get(fileId);
  if (cached) { imgEl.src = cached; return; }

  loadFileBlob(fileId).then(blob => {
    if (!blob) {
      imgEl.closest('.block-image')?.classList.add('block-image-missing');
      return;
    }
    const url = URL.createObjectURL(blob);
    // A nota pode ter mudado enquanto o banco respondia. Sem esta checagem, a
    // URL nova ficaria presa num elemento que já saiu da tela.
    if (!root.contains(imgEl)) { URL.revokeObjectURL(url); return; }
    imageURLs.set(fileId, url);
    imgEl.src = url;
  });
}

let imageResolver = null;
export function setImageResolver(fn) {
  imageResolver = fn;
}

function setImageData(el, { fileId, alt, dataUrl, imagePath, src }) {
  const img = el.querySelector('img');
  if (alt) el.dataset.alt = alt;
  else delete el.dataset.alt;
  if (img) img.alt = alt ?? '';
  if (fileId != null && Number.isFinite(Number(fileId))) {
    el.dataset.fileId = String(fileId);
    delete el.dataset.imagePath;
    el.classList.remove('block-image-missing');
    if (img) loadInlineImage(img, Number(fileId));
  } else if (dataUrl) {
    delete el.dataset.fileId;
    delete el.dataset.imagePath;
    el.classList.remove('block-image-missing');
    if (img) img.src = dataUrl;
  } else {
    delete el.dataset.fileId;
    const caminho = imagePath || (src && /^(\.\.\/)?imagens\//.test(src) ? src : null);
    if (caminho) {
      el.dataset.imagePath = caminho;
      el.classList.add('block-image-missing');
      // Download sob demanda (preguiçoso): busca o arquivo na pasta imagens/
      // e renderiza assim que o resolvedor (SyncController) salvar no Dexie local.
      if (typeof imageResolver === 'function') {
        imageResolver(caminho, currentNoteId).then(res => {
          if (!root.contains(el)) return;
          if (res && res.fileId != null) {
            setImageData(el, { fileId: res.fileId, alt });
          }
        }).catch(() => {});
      }
    } else {
      delete el.dataset.imagePath;
      el.classList.add('block-image-missing');
    }
  }
}

function buildImageTools() {
  const bar = document.createElement('div');
  bar.className = 'image-tools';
  bar.contentEditable = 'false';
  const acts = [
    ['to-docs', 'Mover p/ Documentos', 'Tirar da nota e guardar na seção Documentos', 'image-btn-accent'],
    ['replace', 'Trocar',  'Trocar por outra imagem'],
    ['alt',     'Texto',   'Descrever a imagem (texto alternativo)'],
    ['remove',  'Remover', 'Remover a imagem da nota'],
  ];
  for (const [act, label, title, extra] of acts) {
    const btn = document.createElement('button');
    btn.className   = `image-btn ${extra ?? ''}`.trim();
    btn.dataset.act = act;
    btn.textContent = label;
    btn.title       = title;
    bar.appendChild(btn);
  }
  return bar;
}

// Base64 → arquivo. Chega assim de um .md importado, de uma colagem de texto
// ou de um modelo compartilhado. A decodificação é na mão (atob) em vez de
// fetch('data:...') pra não depender da política de conexão da extensão.
function dataUrlToFile(dataUrl, alt) {
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(dataUrl ?? '');
  if (!m) return null;
  const [, mime, base64, dados] = m;
  try {
    let bytes;
    if (base64) {
      const bin = atob(dados);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(dados));
    }
    const ext  = ({ jpeg: 'jpg' }[mime.split('/')[1]] ?? mime.split('/')[1] ?? 'png');
    const nome = `${(alt || 'imagem').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 40)}.${ext}`;
    return new File([bytes], nome, { type: mime });
  } catch {
    return null;   // base64 truncado num .md editado à mão
  }
}

// Toda imagem que entra por markdown de fora vira arquivo ANTES de chegar ao
// DOM. Base64 dentro do bloco significaria a nota inteira regravada a cada
// pausa na digitação e cada instantâneo de desfazer carregando megabytes.
export async function absorbDataUrls(blocks, noteId = undefined) {
  if (!blocks.some(b => b.type === 'image' && b.dataUrl)) return blocks;

  const destino = noteId === undefined ? currentNoteId : noteId;
  const out = [];
  for (const b of blocks) {
    if (b.type !== 'image' || !b.dataUrl) { out.push(b); continue; }
    const file = dataUrlToFile(b.dataUrl, b.alt);
    if (!file) { out.push({ ...b, dataUrl: undefined }); continue; }
    const fileId = await saveFile(file, destino, { inline: true });
    out.push({ type: 'image', alt: b.alt, fileId, depth: b.depth, quoted: b.quoted });
  }
  return out;
}

// Um arquivo de imagem (colado, arrastado ou escolhido) vira bloco na nota.
async function insertImageFile(file, atBlock) {
  const fileId = await saveFile(file, currentNoteId, { inline: true });
  const bloco  = atBlock ?? currentBlock() ?? root.lastElementChild;
  if (!bloco) return null;

  captureUndoPoint();
  const el = createBlockElFrom({ type: 'image', fileId, alt: '', depth: blockDepth(bloco) });

  const vazio = !NO_TEXT_TYPES.has(bloco.dataset.type)
    && !getContentEl(bloco).textContent.trim();
  if (vazio) bloco.replaceWith(el);
  else bloco.after(el);

  // Sempre deixa uma linha logo abaixo: senão não há onde continuar a escrever
  // quando a imagem é o último bloco da nota.
  if (!el.nextElementSibling) el.after(createBlockEl('paragraph'));
  focusBlockEnd(el.nextElementSibling);
  renumberLists();
  scheduleSave();
  return el;
}

// Leva o cursor pro fim do bloco. Tabela e divisor não têm "fim" onde o cursor
// caiba: na tabela o destino é a primeira célula, e depois de um divisor a
// gente garante um parágrafo em que dê pra escrever.
function focusBlockEnd(block) {
  if (!block) return;
  if (block.dataset.type === 'table') {
    focusCell(block.querySelector('.table-cell'));
    return;
  }
  // Divisor e imagem não recebem cursor: o destino é a linha seguinte, e se
  // não houver uma, cria.
  if (block.dataset.type === 'divider' || block.dataset.type === 'image') {
    let next = block.nextElementSibling;
    if (!next || next.dataset.type === 'divider' || next.dataset.type === 'image') {
      next = createBlockEl('paragraph');
      block.after(next);
    }
    focusBlockEnd(next);
    return;
  }
  const content = getContentEl(block);
  content.focus();
  setCaretOffset(content, content.textContent.length);
}

// ── Tabela ────────────────────────────────────────────────────────────────────
const DEFAULT_TABLE = [['', ''], ['', '']];

function buildCell(isHeader, html) {
  const cell = document.createElement(isHeader ? 'th' : 'td');
  cell.className = 'table-cell';
  cell.contentEditable = 'true';
  cell.innerHTML = html || '<br>';
  return cell;
}

function buildTableEl(rows) {
  const data   = rows?.length ? rows : DEFAULT_TABLE;
  const scroll = document.createElement('div');
  scroll.className = 'table-scroll';
  const table = document.createElement('table');

  data.forEach((row, r) => {
    const tr = document.createElement('tr');
    row.forEach(html => tr.appendChild(buildCell(r === 0, html)));
    table.appendChild(tr);
  });

  scroll.appendChild(table);
  return scroll;
}

function buildTableTools() {
  const bar = document.createElement('div');
  bar.className = 'table-tools';
  bar.contentEditable = 'false';
  const acts = [
    ['add-row', '+ linha',  'Adicionar linha abaixo da atual'],
    ['add-col', '+ coluna', 'Adicionar coluna à direita da atual'],
    ['del-row', '− linha',  'Remover a linha do cursor'],
    ['del-col', '− coluna', 'Remover a coluna do cursor'],
  ];
  for (const [act, label, title] of acts) {
    const btn = document.createElement('button');
    btn.className   = 'table-btn';
    btn.dataset.act = act;
    btn.textContent = label;
    btn.title       = title;
    bar.appendChild(btn);
  }
  return bar;
}

function focusedCell() {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const cell = node?.closest?.('.table-cell');
  return cell && root.contains(cell) ? cell : null;
}

function focusCell(cell) {
  if (!cell) return;
  cell.focus();
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function addTableRow(table, afterIndex) {
  const cols = table.rows[0]?.cells.length ?? 2;
  const tr   = table.insertRow(Math.min(afterIndex + 1, table.rows.length));
  for (let i = 0; i < cols; i++) tr.appendChild(buildCell(false, ''));
  return tr;
}

function addTableCol(table, afterIndex) {
  [...table.rows].forEach((tr, r) => {
    tr.insertBefore(buildCell(r === 0, ''), tr.cells[afterIndex + 1] ?? null);
  });
}

// A primeira linha é o cabeçalho e o markdown exige pelo menos uma linha de
// dados, então o piso é duas linhas e uma coluna.
function delTableRow(table, index) {
  if (table.rows.length <= 2 || index === 0) return;
  table.deleteRow(index);
}

function delTableCol(table, index) {
  if ((table.rows[0]?.cells.length ?? 0) <= 1) return;
  [...table.rows].forEach(tr => tr.cells[index]?.remove());
}

function moveCell(cell, delta) {
  const table = cell.closest('table');
  const cells = [...table.querySelectorAll('.table-cell')];
  const i     = cells.indexOf(cell);

  // Tab na última célula cria uma linha, em vez de sair da tabela.
  if (delta > 0 && i === cells.length - 1) {
    captureUndoPoint();
    addTableRow(table, table.rows.length - 1);
    scheduleSave();
    focusCell([...table.querySelectorAll('.table-cell')][i + 1]);
    return;
  }
  focusCell(cells[i + delta]);
}

// Esvazia o conteúdo de um bloco mantendo o <br> de segurança (ver createBlockEl).
function clearContent(el) {
  el.innerHTML = '';
  el.appendChild(document.createElement('br'));
}

function convertBlockType(blockEl, newType, checked = false) {
  // "Citação" não troca o tipo do bloco, liga a decoração: um título citado
  // continua sendo um título. É o que o menu "/" e o "Transformar em" acabam
  // pedindo quando se escolhe Citação.
  if (newType === 'quote') {
    setBlockQuoted(blockEl, true);
    return blockEl;
  }

  // Destaque também não troca o tipo: é decoração sobre a citação.
  if (newType.startsWith('callout:')) {
    setBlockCallout(blockEl, newType.slice('callout:'.length));
    return blockEl;
  }

  const oldContent = getContentEl(blockEl);
  const newBlock = createBlockEl(newType, oldContent.innerHTML, checked);
  setBlockDepth(newBlock, blockDepth(blockEl));
  setBlockQuoted(newBlock, isBlockQuoted(blockEl));
  setBlockCallout(newBlock, blockEl.dataset.callout);
  // O sublinhado só sobrevive entre tipos que o suportam — virar parágrafo o
  // descarta, que é o esperado.
  setBlockUnderlined(newBlock, isBlockUnderlined(blockEl));
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

// Marcadores de lista. Roda depois de qualquer mudança estrutural, então é
// também onde a escada de indentação é fechada — assim a regra vale nos 25
// pontos que já chamavam esta função, sem precisar lembrar de cada um.
// Marca a primeira e a última linha de cada sequência de destaque. São elas que
// recebem o rótulo e os cantos arredondados, pra que várias linhas seguidas
// leiam como uma caixa só.
//
// Isso não é feito em CSS porque "não vir depois de um destaque DO MESMO TIPO"
// exigiria uma regra por tipo — e ainda assim erraria com dois destaques de
// tipos diferentes colados, que é justamente quando o rótulo mais importa.
function markCalloutEdges() {
  const blocos = [...root.children];
  for (let i = 0; i < blocos.length; i++) {
    const tipo = blocos[i].dataset.callout ?? null;
    if (!tipo) {
      delete blocos[i].dataset.calloutFirst;
      delete blocos[i].dataset.calloutLast;
      continue;
    }
    if (tipo !== (blocos[i - 1]?.dataset.callout ?? null)) blocos[i].dataset.calloutFirst = 'true';
    else delete blocos[i].dataset.calloutFirst;

    if (tipo !== (blocos[i + 1]?.dataset.callout ?? null)) blocos[i].dataset.calloutLast = 'true';
    else delete blocos[i].dataset.calloutLast;
  }
}

// Avalia cada folha de cálculo e escreve o resultado ao lado de cada linha.
//
// A folha é a sequência contígua de blocos `calc` — mesma ideia das pontas do
// destaque. É ela o escopo das variáveis: uma linha de texto ou um parágrafo
// no meio encerram uma folha e começam outra, então nada de um bloco lá em
// cima mexer numa conta muito abaixo.
function recalcCalcSheets() {
  const blocos = [...root.children];

  for (let i = 0; i < blocos.length; i++) {
    if (blocos[i].dataset.type !== 'calc') continue;

    let fim = i;
    while (fim + 1 < blocos.length && blocos[fim + 1].dataset.type === 'calc') fim++;
    const folha = blocos.slice(i, fim + 1);

    const resultado = evaluateSheet(folha.map(b => getContentEl(b).textContent));

    folha.forEach((bloco, k) => {
      const r  = resultado[k];
      const el = bloco.querySelector(':scope > .calc-result');
      if (el) {
        el.textContent = r.tipo === 'valor' ? r.fmt : (r.tipo === 'erro' ? r.erro : '');
        el.classList.remove('copiado');
        // O título só existe quando há um valor: é ele, junto com o cursor de
        // mão, que promete "clique pra copiar". Erro e linha de texto não têm
        // o que copiar, e um alvo que promete e não entrega é pior que alvo
        // nenhum.
        if (r.tipo === 'valor') el.title = 'Clique para copiar';
        else el.removeAttribute('title');
      }

      if (r.tipo === 'erro') bloco.dataset.calcErro = 'true';
      else delete bloco.dataset.calcErro;

      // Pontas da folha: é o que faz uma sequência ler como um quadro só.
      if (k === 0) bloco.dataset.calcFirst = 'true'; else delete bloco.dataset.calcFirst;
      if (k === folha.length - 1) bloco.dataset.calcLast = 'true'; else delete bloco.dataset.calcLast;
    });

    i = fim;
  }
}

function renumberLists() {
  normalizeDepths();
  markCalloutEdges();
  recalcCalcSheets();

  // Um contador por nível: entrar num nível mais fundo não zera o de fora, e
  // sair dele recomeça o de dentro.
  const contadores = [];

  for (const block of root.children) {
    const depth  = blockDepth(block);
    const marker = block.querySelector(':scope > .block-marker');

    if (block.dataset.type === 'number') {
      const n = (contadores[depth] ?? 0) + 1;
      contadores[depth] = n;
      contadores.length = depth + 1;
      if (marker) marker.textContent = `${n}.`;
      continue;
    }

    contadores.length = depth;  // bloco não-numerado quebra a contagem dali pra dentro
    if (block.dataset.type === 'bullet' && marker) {
      marker.textContent = BULLET_GLYPHS[depth % BULLET_GLYPHS.length];
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
// `html` permite capturar um estado colhido antes de saber se a mudança ia
// mesmo acontecer — é o caso do Tab, que às vezes não tem pra onde indentar e
// não deve sujar o histórico.
function captureUndoPoint(html = null) {
  clearTimeout(typingSnapshotTimer);
  pendingTypingSnapshot = null;
  pushUndoSnapshot(html ?? snapshotState());
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
  refreshChecklistStates();   // o "meio marcado" também é propriedade viva

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
  if (NO_DETECTION.has(block.dataset.type)) return;

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
  // Link é o único elemento que carrega dado do usuário num atributo. Aqui é o
  // funil por onde passa tudo que é persistido — inclusive HTML colado de fora
  // —, então é onde href hostil e atributos de evento morrem.
  div.querySelectorAll('a').forEach(a => {
    const href = safeHref(a.getAttribute('href'));
    if (!href) { a.replaceWith(...a.childNodes); return; }
    [...a.attributes].forEach(attr => a.removeAttribute(attr.name));
    a.setAttribute('href', href);
  });
  if (!keepBreaks) div.querySelectorAll('br').forEach(br => br.remove());
  // Âncora invisível da formatação ao digitar (ver replaceRangeWithTag): ela é
  // um detalhe do cursor e nunca pode virar conteúdo salvo. Aqui é o funil por
  // onde tudo passa, então é o lugar certo pra garantir isso.
  div.innerHTML = div.innerHTML.split(ANCORA).join('');
  div.normalize();
  return div.innerHTML;
}

function serializeBlockEl(block) {
  const type = block.dataset.type;
  const b = { id: block.dataset.id, type };
  const depth = blockDepth(block);
  if (depth) b.depth = depth;   // ausente = nível 0, que é o formato de antes
  if (isBlockQuoted(block)) b.quoted = true;
  if (block.dataset.callout) b.callout = block.dataset.callout;
  if (isBlockUnderlined(block)) b.underlined = true;
  if (type === 'divider') return b;
  if (type === 'image') {
    const fileId = Number(block.dataset.fileId);
    if (Number.isFinite(fileId)) b.fileId = fileId;
    if (block.dataset.imagePath) b.imagePath = block.dataset.imagePath;
    if (block.dataset.alt) b.alt = block.dataset.alt;
    return b;
  }
  if (type === 'table') {
    b.rows = [...block.querySelectorAll('tr')].map(tr =>
      [...tr.children].map(cell => sanitizeForSave(cell.innerHTML)));
    return b;
  }
  b.html = sanitizeForSave(getContentEl(block).innerHTML, type === 'code');
  if (type === 'checklist') b.checked = block.dataset.checked === 'true';
  return b;
}

function serializeBlocks() {
  return [...root.children].map(serializeBlockEl);
}

// Blocos da nota atual, prontos pra exportar/copiar (blocksToMarkdown /
// blocksToPlainText, em blocks.js) — lê direto do DOM ao vivo, sempre atual.
export function getCurrentBlocks() {
  return serializeBlocks();
}

function showSaved() {
  indicator.innerHTML = `salvo ${iconSvg('check')}`;
  indicator.classList.add('visible');
  clearTimeout(indicatorTimer);
  indicatorTimer = setTimeout(() => indicator.classList.remove('visible'), 2200);
}

// ── Modo modelo ───────────────────────────────────────────────────────────────
// Editar um modelo usa o editor de verdade, não um textarea de markdown: o
// usuário mexe em checkbox, tabela e menu "/" do mesmo jeito que numa nota.
// A diferença é que aqui não há autosave — modelo só grava no botão Salvar,
// senão "Cancelar" não teria como voltar atrás.
let editingTemplate = null;

export function isEditingTemplate() { return !!editingTemplate; }

export async function openTemplateInEditor(tpl) {
  await flushSave();                 // grava a nota que estava aberta
  editingTemplate = { id: tpl.id };
  renderBlocks(await absorbDataUrls(parseMarkdownToBlocks(tpl.content ?? '')));
  resetUndoHistory();
  focusBlockStart(root.firstElementChild);
}

export function currentTemplateMarkdown() {
  return blocksToMarkdown(serializeBlocks());
}

// Markdown pronto pra sair da extensão: a imagem vai embutida em base64, pra
// que o arquivo abra em qualquer lugar sem depender do banco daqui.
export async function blocksToExportMarkdown(blocks) {
  return blocksToMarkdownForExport(blocks, async fileId => {
    const blob = await loadFileBlob(fileId);
    if (!blob) return null;
    return new Promise(resolve => {
      const leitor = new FileReader();
      leitor.onload  = () => resolve(leitor.result);
      leitor.onerror = () => resolve(null);
      leitor.readAsDataURL(blob);
    });
  });
}

export function clearTemplateEditing() { editingTemplate = null; }

function scheduleSave() {
  if (editingTemplate) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 800);
}

export async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  flushRescan();
  if (editingTemplate || currentNoteId == null) return;
  const blocks = serializeBlocks();
  // Markdown completo (não só texto simples) — é o que permite recuperar
  // negrito/itálico/etc. se a nota precisar ser reconstruída a partir desse
  // campo (fallback de portabilidade).
  const content = blocksToMarkdown(blocks);
  await updateNoteBlocksById(currentNoteId, blocks, content);
  showSaved();
}

export function getCurrentNoteId() {
  return currentNoteId;
}

export function isEditorFocused() {
  return !!noteEditorEl?.contains(document.activeElement);
}

export function hasPendingSave() {
  return saveTimer !== null;
}

export function canSafelyReloadCurrentNote() {
  return !isEditingTemplate() && !isEditorFocused() && !hasPendingSave();
}

// Esvazia a nota aberta. Tem que passar pelo editor: escrever direto no banco
// não adianta, porque o autosave seguinte serializaria o DOM antigo por cima.
export async function clearCurrentNote() {
  clearTimeout(saveTimer);
  renderBlocks(parseMarkdownToBlocks(''));
  await flushSave();
}

// ── Carregar / trocar de nota ───────────────────────────────────────────────────
function renderBlocks(blocks) {
  revokeImageURLs();
  root.innerHTML = '';
  for (const b of blocks) root.appendChild(createBlockElFrom(b));
  if (root.children.length === 0) root.appendChild(createBlockEl('paragraph'));
  renumberLists();
  refreshChecklistStates();

  for (const block of root.children) {
    if (NO_DETECTION.has(block.dataset.type)) continue;
    applyDetectionMarks(getContentEl(block));
  }

  resetUndoHistory(); // histórico de undo é por nota, não deve vazar de uma pra outra
}

// `descartarDom`: o banco passa a ser a verdade e o que está no editor é jogado
// fora. Só a sincronização usa isso, e ela precisa.
//
// O `flushSave()` abaixo existe para quem TROCA de nota: salva o que você estava
// escrevendo antes de sair. Mas quando a sincronização acaba de gravar a versão
// nova da MESMA nota e manda recarregar, esse flush serializa o DOM antigo por
// cima do que acabou de descer — e o editor então lê de volta justamente o texto
// velho. Na rodada seguinte ele sobe como "alteração local" e desfaz a edição
// feita no outro aparelho. Era isso que estava revertendo as notas.
export async function switchToNote(id, { descartarDom = false } = {}) {
  if (descartarDom) {
    // Sem isso, um autosave já agendado dispararia depois do render e gravaria
    // o DOM antigo assim mesmo.
    clearTimeout(saveTimer);
    saveTimer = null;
  } else {
    await flushSave();
  }
  editingTemplate = null;            // trocar de nota abandona o modo modelo
  currentNoteId = id;
  const note = await getNoteById(id);
  const blocks = (note?.blocks?.length) ? note.blocks : parseMarkdownToBlocks(note?.content ?? '');
  renderBlocks(blocks);
  updateMobileToolbarState();
}

// ── Posicionamento de menus ───────────────────────────────────────────────────
// Abre pro lado com mais espaço e limita a altura ao que realmente cabe. Sem o
// limite, um menu alto (o "/" tem 11 tipos, "Transformar em" tem 9) passa da
// borda da janela e as últimas opções ficam inalcançáveis — o max-height fixo
// do CSS não resolve, porque o que falta é espaço, não altura de conteúdo.
function positionMenu(menu, anchorRect) {
  if (menu.classList.contains('is-bottom-sheet')) return;
  const gap = 6;
  const margin = 8;
  const below = window.innerHeight - anchorRect.bottom - gap - margin;
  const above = anchorRect.top - gap - margin;
  const openDown = below >= above;
  const avail = Math.max(80, openDown ? below : above);

  menu.style.maxHeight = `${avail}px`;
  menu.style.overflowY = 'auto';

  const height = Math.min(menu.scrollHeight, avail);
  // Prende dentro da janela nas duas pontas: num painel bem baixo o espaço do
  // lado escolhido pode ser menor que o piso, e sem isto o menu vazaria.
  let top = openDown ? anchorRect.bottom + gap : anchorRect.top - gap - height;
  top = Math.max(margin, Math.min(top, window.innerHeight - margin - height));

  menu.style.top  = `${top}px`;
  menu.style.left = `${Math.max(margin, Math.min(anchorRect.left, window.innerWidth - menu.offsetWidth - margin))}px`;
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
  if (e.key === 'Escape') {
    closeCopyMenu();
    if (touchSelectionActive) setTouchSelectionMode(false);
  }
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
    } else if (touchSelectionActive) {
      indicator.textContent = 'Modo seleção ativo · toque para selecionar';
      indicator.classList.add('visible');
    }
  }, 1400);
}

// ── Ctrl: ativa modo de cópia rápida ──────────────────────────────────────────
function setCtrl(active) {
  if (isCtrlHeld === active) return;
  isCtrlHeld = active;
  noteSection.classList.toggle('ctrl-active', active || touchSelectionActive);

  if (active) {
    showFeedback('Ctrl+clique para copiar');
  } else {
    if (!activeMenu && !touchSelectionActive) indicator.classList.remove('visible');
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Control' || e.key === 'Meta') setCtrl(true);
});
document.addEventListener('keyup', e => {
  if (e.key === 'Control' || e.key === 'Meta') setCtrl(false);
});
window.addEventListener('blur', () => setCtrl(false));

// ── Clique em marcação detectada (CPF, data, cálculo…) ou seleção por toque ──
root.addEventListener('click', e => {
  if (!isCtrlHeld && !touchSelectionActive && !isBlockSelectActive) return;

  // Mesmo gesto que abre o menu de CPF/data: com Ctrl ou modo de seleção por toque, clique em link navega.
  // Sem Ctrl/modo toque o clique só posiciona o cursor — senão não dá pra editar o texto.
  const link = e.target.closest('a');
  if (link && root.contains(link)) {
    const href = safeHref(link.getAttribute('href'));
    if (!href) return;
    // Âncora não abre aba nenhuma: rola até o título da própria nota.
    if (href.startsWith('#')) irParaTitulo(href.slice(1));
    else window.open(href, '_blank', 'noopener');
    return;
  }

  const mark = e.target.closest('mark');
  if (!mark) {
    if (isBlockSelectActive) {
      const block = e.target.closest('.block');
      if (block && root.contains(block)) {
        e.preventDefault();
        e.stopPropagation();
        if (selectedBlockIds.has(block.dataset.id)) {
          selectedBlockIds.delete(block.dataset.id);
          setBlockSelection([...selectedBlockIds]);
        } else {
          selectedBlockIds.add(block.dataset.id);
          setBlockSelection([...selectedBlockIds]);
          lastHandleClickedId = block.dataset.id;
        }
        return;
      }
    } else if (touchSelectionActive) {
      // No modo de seleção por toque, tocar em um bloco (fora de link/mark) seleciona o bloco
      const block = e.target.closest('.block');
      if (block && root.contains(block)) {
        handleHandleClick(block, true);
        e.preventDefault();
      }
    }
    closeCopyMenu();
    return;
  }

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

// ── Tabela: botões de linha/coluna ───────────────────────────────────────────
// mousedown em capture com preventDefault mantém o cursor na célula — é ele que
// diz qual linha/coluna a ação atinge — e impede que o gesto de arrastar bloco
// interprete o clique como início de arraste.
root.addEventListener('mousedown', e => {
  if (!e.target.closest('.table-btn')) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

root.addEventListener('click', e => {
  const btn = e.target.closest('.table-btn');
  if (!btn) return;
  const table = btn.closest('.block-table')?.querySelector('table');
  if (!table) return;

  // Sem cursor em célula, a ação cai na última linha/coluna.
  const cell = focusedCell();
  const r = cell?.closest('tr')?.rowIndex ?? table.rows.length - 1;
  const c = cell?.cellIndex ?? (table.rows[0].cells.length - 1);

  captureUndoPoint();
  switch (btn.dataset.act) {
    case 'add-row': addTableRow(table, r); break;
    case 'add-col': addTableCol(table, c); break;
    case 'del-row': delTableRow(table, r); break;
    case 'del-col': delTableCol(table, c); break;
  }
  scheduleSave();
});

// ── Âncora: pular pro título da própria nota ──────────────────────────────────
// Os títulos da nota aberta e o apelido de cada um. É calculado na hora do
// clique, e não guardado: renomear um título muda o apelido, e um mapa gravado
// ficaria desatualizado sem ninguém perceber.
function titulosDaNota() {
  const titulos = [...root.children].filter(b => HEADING_TAGS[b.dataset.type]);
  const apelidos = headingSlugs(titulos.map(b => getContentEl(b).textContent));
  return titulos.map((el, i) => ({ el, slug: apelidos[i] }));
}

function irParaTitulo(alvoBruto) {
  const alvo = headingSlug(decodeURIComponent(alvoBruto));
  const achado = titulosDaNota().find(t => t.slug === alvo)
    // Sem correspondência exata: tenta sem o sufixo de repetição, pra que um
    // "#secao-1" ainda caia na seção certa quando o título deixou de repetir.
    ?? titulosDaNota().find(t => t.slug === alvo.replace(/-\d+$/, ''));

  if (!achado) { showFeedback('não achei esse título na nota'); return; }

  achado.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // Um pisca-pisca curto: sem ele, num título parecido com os vizinhos, não dá
  // pra saber se a rolagem parou no lugar certo.
  achado.el.classList.add('heading-alvo');
  setTimeout(() => achado.el.classList.remove('heading-alvo'), 1200);
}

// ── Cálculo: clique no resultado copia ────────────────────────────────────────
// O mousedown é cancelado em captura pra que o cursor não saia de onde estava:
// o valor vai pra área de transferência sem tirar a pessoa da linha que ela
// estava escrevendo.
root.addEventListener('mousedown', e => {
  const alvo = e.target.closest('.calc-result');
  if (!alvo || !alvo.title) return;   // sem título = erro ou linha de texto
  e.preventDefault();
}, true);

root.addEventListener('click', async e => {
  const alvo = e.target.closest('.calc-result');
  if (!alvo || !alvo.title) return;

  const valor = alvo.textContent.trim();
  if (!valor) return;
  e.stopPropagation();

  try {
    await navigator.clipboard.writeText(valor);
    // O aviso mais útil é no próprio lugar em que se clicou; o indicador de
    // baixo é o segundo, pra quem estava olhando pra lá.
    alvo.classList.add('copiado');
    setTimeout(() => alvo.classList.remove('copiado'), 900);
    showFeedback('copiado!');
  } catch {
    showFeedback('não deu pra copiar');
  }
});

// ── Imagem: botões de ação e visualizador ─────────────────────────────────────
// O seletor de arquivo é um só, reaproveitado — quem o pediu fica guardado em
// `imagePickerTarget`: null quer dizer "inserir nova", um bloco quer dizer
// "trocar a imagem deste".
const imagePicker = document.createElement('input');
imagePicker.type   = 'file';
imagePicker.accept = 'image/*';
imagePicker.hidden = true;
document.body.appendChild(imagePicker);
let imagePickerIntent = null;   // { trocar: bloco } ou { inserirEm: bloco }

function pedirImagem(intent) {
  imagePickerIntent = intent;
  imagePicker.value = '';
  imagePicker.click();
}

imagePicker.addEventListener('change', async () => {
  const file = imagePicker.files?.[0];
  imagePicker.value = '';
  const intent = imagePickerIntent;
  imagePickerIntent = null;
  if (!file || !file.type.startsWith('image/') || !intent) return;

  if (intent.inserirEm) {
    await insertImageFile(file, intent.inserirEm);
    return;
  }

  // Trocar: o arquivo antigo não é apagado aqui de propósito — Ctrl+Z traz o
  // bloco anterior de volta e ele precisa achar o arquivo. A faxina de imagem
  // órfã roda na próxima abertura do painel (gcInlineFiles).
  captureUndoPoint();
  const fileId = await saveFile(file, currentNoteId, { inline: true });
  setImageData(intent.trocar, { fileId, alt: intent.trocar.dataset.alt ?? '' });
  scheduleSave();
});

// mousedown em capture: impede que o clique num botão da imagem seja lido como
// começo de arraste de bloco.
root.addEventListener('mousedown', e => {
  if (!e.target.closest('.image-btn')) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

root.addEventListener('click', e => {
  const btn = e.target.closest('.image-btn');
  if (btn) {
    const bloco = btn.closest('.block-image');
    if (!bloco) return;
    e.stopPropagation();

    if (btn.dataset.act === 'replace') { pedirImagem({ trocar: bloco }); return; }

    // Nem toda imagem quer ficar no meio do texto. Aqui ela sai da nota e vira
    // um documento normal, vinculado à mesma nota — some daqui e aparece na
    // seção de baixo, que é onde a pessoa vai procurar por ela em seguida.
    if (btn.dataset.act === 'to-docs') { moverImagemParaDocumentos(bloco); return; }

    if (btn.dataset.act === 'alt') {
      openAltMenu(bloco, btn.getBoundingClientRect());
      return;
    }

    if (btn.dataset.act === 'remove') {
      captureUndoPoint();
      const seguinte = bloco.nextElementSibling ?? bloco.previousElementSibling;
      bloco.remove();
      if (root.children.length === 0) root.appendChild(createBlockEl('paragraph'));
      focusBlockEnd(seguinte ?? root.lastElementChild);
      renumberLists();
      scheduleSave();
    }
    return;
  }

  // Clique na própria imagem abre o visualizador, com as outras imagens da
  // nota disponíveis nas setas.
  const img = e.target.closest('.block-image img');
  if (!img) return;
  const bloco  = img.closest('.block-image');
  const fileId = Number(bloco?.dataset.fileId);
  if (!Number.isFinite(fileId)) return;

  const galeria = [...root.querySelectorAll('.block-image')]
    .map(el => ({ id: Number(el.dataset.fileId), name: el.dataset.alt || 'Imagem', type: 'image/*' }))
    .filter(g => Number.isFinite(g.id));

  openModal(fileId, bloco.dataset.alt || 'Imagem', 'image/*', galeria);
});

async function moverImagemParaDocumentos(bloco) {
  const fileId = Number(bloco.dataset.fileId);
  if (!Number.isFinite(fileId)) return;

  const movido = await moveInlineFileToDocuments(fileId);
  if (!movido) { showFeedback('não achei o arquivo desta imagem'); return; }

  // O arquivo deixa de ser inline ANTES do bloco sair, pra que a faxina de
  // imagem órfã (gcInlineFiles) nunca o veja sem dono. Um Ctrl+Z aqui traz o
  // bloco de volta e a imagem continua aparecendo — só que agora ela também
  // está nos Documentos, que é o preço de poder desfazer.
  captureUndoPoint();
  const seguinte = bloco.nextElementSibling ?? bloco.previousElementSibling;
  bloco.remove();
  if (root.children.length === 0) root.appendChild(createBlockEl('paragraph'));
  focusBlockEnd(seguinte ?? root.lastElementChild);
  renumberLists();
  await flushSave();

  await refreshDocuments();
  showFeedback('imagem movida para Documentos');
}

// Texto alternativo: menu dentro da extensão, não um dialog da página.
let altMenuEl = null;
function closeAltMenu() { altMenuEl?.remove(); altMenuEl = null; }

function openAltMenu(bloco, anchorRect) {
  closeAltMenu();
  const menu = document.createElement('div');
  menu.className = 'copy-menu alt-menu';

  const head = document.createElement('div');
  head.className = 'copy-menu-header';
  head.textContent = 'Texto alternativo';

  const dica = document.createElement('div');
  dica.className = 'alt-menu-hint';
  dica.textContent = 'Descreve a imagem pra quem usa leitor de tela — e é o que aparece se o arquivo se perder.';

  const campo = document.createElement('input');
  campo.className = 'link-input';
  campo.type = 'text';
  campo.value = bloco.dataset.alt ?? '';
  campo.placeholder = 'Ex.: print do protocolo aberto';

  const aplicar = () => {
    captureUndoPoint();
    setImageData(bloco, { alt: campo.value.trim() });
    closeAltMenu();
    scheduleSave();
  };

  campo.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); aplicar(); }
    if (e.key === 'Escape') { e.preventDefault(); closeAltMenu(); }
  });

  const ok = document.createElement('button');
  ok.className = 'copy-opt';
  ok.innerHTML = '<span class="copy-opt-value">Salvar</span>';
  ok.addEventListener('mousedown', e => e.stopPropagation());
  ok.addEventListener('click', aplicar);

  menu.append(head, dica, campo, ok);
  menu.addEventListener('mousedown', e => e.stopPropagation());
  document.body.appendChild(menu);
  altMenuEl = menu;
  positionMenu(menu, anchorRect);
  campo.focus();
  campo.select();
}

document.addEventListener('mousedown', () => closeAltMenu());
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAltMenu(); });

// ── Arrastar imagem pra dentro do editor ──────────────────────────────────────
root.addEventListener('dragover', e => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  root.classList.add('editor-drop');
});

root.addEventListener('dragleave', e => {
  if (!root.contains(e.relatedTarget)) root.classList.remove('editor-drop');
});

root.addEventListener('drop', async e => {
  root.classList.remove('editor-drop');
  const imagens = [...(e.dataTransfer?.files ?? [])].filter(f => f.type.startsWith('image/'));
  if (imagens.length === 0) return;   // outro tipo de arquivo é assunto dos Documentos

  e.preventDefault();
  e.stopPropagation();
  let alvo = blockNearestToY(e.clientY) ?? root.lastElementChild;
  for (const file of imagens) alvo = (await insertImageFile(file, alvo)) ?? alvo;
});

// ── Checklist aninhada ────────────────────────────────────────────────────────
// Marcar um item marca tudo que está dentro dele, e completar os itens de
// dentro completa o de fora. Isso é comportamento de edição, não formato: o
// que fica gravado continua sendo "- [x]" comum, então um .md exportado daqui
// abre igual em qualquer lugar — markdown não tem (nem teria como ter) essa
// relação entre linhas.
//
// O "meio marcado" do pai (o tracinho) é só visual: não existe em markdown e
// sai como "- [ ]" na exportação, que é a única forma fiel possível.

function checkboxDe(block) {
  return block.querySelector(':scope > .block-marker input[type="checkbox"]');
}

// Filhos diretos: os checklists exatamente um nível abaixo, até onde a escada
// voltar pro nível do próprio bloco.
function checklistFilhos(block) {
  const base = blockDepth(block);
  const filhos = [];
  for (let n = block.nextElementSibling; n && blockDepth(n) > base; n = n.nextElementSibling) {
    if (blockDepth(n) === base + 1 && n.dataset.type === 'checklist') filhos.push(n);
  }
  return filhos;
}

function checklistPai(block) {
  const base = blockDepth(block);
  if (base === 0) return null;
  for (let n = block.previousElementSibling; n; n = n.previousElementSibling) {
    if (blockDepth(n) < base) return n.dataset.type === 'checklist' ? n : null;
  }
  return null;
}

function marcarChecklist(block, checked) {
  block.dataset.checked = checked ? 'true' : 'false';
  const cb = checkboxDe(block);
  if (cb) { cb.checked = checked; cb.indeterminate = false; }
}

function propagarParaBaixo(block, checked) {
  for (const filho of checklistFilhos(block)) {
    marcarChecklist(filho, checked);
    propagarParaBaixo(filho, checked);
  }
}

// Sobe recalculando: o pai fica marcado só quando todos os filhos estão, e
// "meio marcado" quando alguns estão (ou quando algum filho está meio marcado).
function propagarParaCima(block) {
  for (let pai = checklistPai(block); pai; pai = checklistPai(pai)) {
    const filhos = checklistFilhos(pai);
    if (filhos.length === 0) return;

    const marcados = filhos.filter(f => f.dataset.checked === 'true').length;
    const parciais = filhos.some(f => checkboxDe(f)?.indeterminate);
    const todos    = marcados === filhos.length && !parciais;

    marcarChecklist(pai, todos);
    const cb = checkboxDe(pai);
    if (cb && !todos && (marcados > 0 || parciais)) cb.indeterminate = true;
  }
}

// Ao abrir a nota, o "meio marcado" é recalculado a partir dos filhos — ele é
// estado de tela e não existe no que foi gravado. O que NÃO se faz aqui é
// mexer no marcado/desmarcado de ninguém: abrir uma nota não pode alterar o
// que está escrito nela.
function refreshChecklistStates() {
  for (const block of root.children) {
    if (block.dataset.type !== 'checklist') continue;
    const cb = checkboxDe(block);
    if (!cb || block.dataset.checked === 'true') continue;
    const filhos = checklistFilhos(block);
    cb.indeterminate = filhos.length > 0 && filhos.some(f => f.dataset.checked === 'true');
  }
}

// ── Checklist: clique direto na caixa (sem precisar de Ctrl) ──────────────────
root.addEventListener('change', e => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  const block = getBlockFromNode(e.target);
  if (!block) return;

  // Um clique pode mexer em vários blocos, então vira um passo só de desfazer.
  captureUndoPoint();
  marcarChecklist(block, e.target.checked);
  propagarParaBaixo(block, e.target.checked);
  propagarParaCima(block);
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
  // Tabela, imagem e divisor têm botões de ferramenta dentro do bloco. Ler o
  // "texto do bloco" traria "+ linha" e "Remover" junto com o conteúdo — o
  // texto certo desses é o que o serializador produz.
  if (NO_TEXT_TYPES.has(block.dataset.type)) {
    return blocksToPlainText([serializeBlockEl(block)]);
  }

  const content = getContentEl(block);
  const sub = document.createRange();

  // A faixa fica presa dentro do conteúdo do bloco. Vários blocos têm irmãos
  // fora do editável — o resultado da folha de cálculo, o marcador da lista, a
  // caixa da checklist — e arrastar a seleção por cima deles trazia esse texto
  // junto: copiar uma linha de cálculo dava "boleto = R$ 1.000,00R$ 1.000,00",
  // e copiar um item de lista vinha com o bolinha na frente.
  const dentro = no => no === content || content.contains(no);

  if (isFirst && dentro(range.startContainer)) sub.setStart(range.startContainer, range.startOffset);
  else                                         sub.setStart(content, 0);

  if (isLast && dentro(range.endContainer)) sub.setEnd(range.endContainer, range.endOffset);
  else                                      sub.setEnd(content, content.childNodes.length);

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

// ── Menu "/" (trocar tipo de bloco) ───────────────────────────────────────────
// Os tipos de bloco, em grade e agrupados.
//
// Eram dezoito numa lista de uma coluna, e o menu virou uma rolagem sem fim —
// achar "Tabela" custava mais que criar a tabela. Em três colunas os mesmos
// dezoito cabem em sete linhas, e o grupo diz de cara em que vizinhança
// procurar.
//
// `label` é o nome inteiro: é o que o filtro casa e o que aparece ao passar o
// mouse. `short` é o que cabe embaixo do ícone.
const CALLOUT_ICONS = {
  note: 'info', tip: 'lightbulb', important: 'priority_high',
  warning: 'warning', caution: 'dangerous',
};

const SLASH_ITEMS = [
  { key: 'texto',     label: 'Texto',               short: 'Texto',     hint: 'parágrafo', icon: 'notes',                 grupo: 'Texto',     type: 'paragraph' },
  { key: 'titulo1',   label: 'Título 1',            short: 'Título 1',  hint: '#',         icon: 'format_h1',             grupo: 'Texto',     type: 'heading1'  },
  { key: 'titulo2',   label: 'Título 2',            short: 'Título 2',  hint: '##',        icon: 'format_h2',             grupo: 'Texto',     type: 'heading2'  },
  { key: 'titulo3',   label: 'Título 3',            short: 'Título 3',  hint: '###',       icon: 'format_h3',             grupo: 'Texto',     type: 'heading3'  },

  { key: 'lista',     label: 'Lista com marcadores', short: 'Lista',    hint: '-',         icon: 'format_list_bulleted',  grupo: 'Listas',    type: 'bullet'    },
  { key: 'numerada',  label: 'Lista numerada',       short: 'Numerada', hint: '1.',        icon: 'format_list_numbered',  grupo: 'Listas',    type: 'number'    },
  { key: 'checklist', label: 'Checklist',            short: 'Checklist',hint: '[ ]',       icon: 'checklist',             grupo: 'Listas',    type: 'checklist' },

  { key: 'citacao',   label: 'Citação',              short: 'Citação',  hint: '>',         icon: 'format_quote',          grupo: 'Destaques', type: 'quote'     },
  ...CALLOUT_TYPES.map(t => ({
    key:   CALLOUT_LABELS[t].toLowerCase(),
    label: `Destaque · ${CALLOUT_LABELS[t]}`,
    short: CALLOUT_LABELS[t],
    hint:  `[!${t}]`,
    icon:  CALLOUT_ICONS[t],
    grupo: 'Destaques',
    type:  `callout:${t}`,
  })),

  { key: 'codigo',    label: 'Código',               short: 'Código',   hint: '```',       icon: 'code',                  grupo: 'Blocos',    type: 'code'      },
  { key: 'calculo',   label: 'Cálculo',              short: 'Cálculo',  hint: '= ao vivo', icon: 'calculate',             grupo: 'Blocos',    type: 'calc'      },
  { key: 'tabela',    label: 'Tabela',               short: 'Tabela',   hint: '| |',       icon: 'table',                 grupo: 'Blocos',    type: 'table'     },
  { key: 'imagem',    label: 'Imagem',               short: 'Imagem',   hint: 'arquivo',   icon: 'image',                 grupo: 'Blocos',    type: 'image'     },
  { key: 'divisor',   label: 'Divisor',              short: 'Divisor',  hint: '---',       icon: 'horizontal_rule',       grupo: 'Blocos',    type: 'divider'   },
];

// Monta a grade de tipos, com um cabeçalho por grupo. Serve o menu "/" e o
// "Transformar em" — os dois mostram a mesma lista e tinham o mesmo problema.
function buildTypeGrid(itens, aoEscolher) {
  const wrap = document.createElement('div');
  wrap.className = 'type-grid-wrap';

  let grupoAtual = null;
  let grade = null;

  itens.forEach((it, i) => {
    if (it.grupo !== grupoAtual) {
      grupoAtual = it.grupo;
      const cab = document.createElement('div');
      cab.className = 'copy-menu-header';
      cab.textContent = grupoAtual;
      wrap.appendChild(cab);
      grade = document.createElement('div');
      grade.className = 'type-grid';
      wrap.appendChild(grade);
    }

    const btn = document.createElement('button');
    btn.className = 'type-cell';
    btn.title = it.hint ? `${it.label} · ${it.hint}` : it.label;
    const ico = createIcon(it.icon, 'type-cell-icon');
    const nome = document.createElement('span');
    nome.className = 'type-cell-label';
    nome.textContent = it.short;   // textContent: nome de modelo é texto do usuário
    btn.append(ico, nome);
    btn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('touchstart', e => { e.stopPropagation(); }, { passive: true });
    btn.addEventListener('click', e => { e.stopPropagation(); aoEscolher(i); });
    grade.appendChild(btn);
  });

  return wrap;
}

// Tipos que não são conversão de um parágrafo, e sim inserção de uma estrutura
// própria: substituem o bloco e abrem um parágrafo livre logo abaixo.
const INSERTED_TYPES = new Set(['divider', 'table', 'image']);

// ── Modelos de bloco ──────────────────────────────────────────────────────────
// O markdown do modelo passa pelo mesmo parser da importação, então checklist,
// título e tabela chegam como blocos de verdade, não como texto.
async function insertTemplateBlocks(markdown, atBlock) {
  const els = (await absorbDataUrls(parseMarkdownToBlocks(markdown))).map(createBlockElFrom);
  if (els.length === 0 || !atBlock) return;

  // Numa linha vazia o modelo ocupa o lugar dela, em vez de deixar um
  // parágrafo em branco pendurado acima.
  const vazio = atBlock.dataset.type !== 'table' && !getContentEl(atBlock).textContent.trim();
  let ref = atBlock;
  if (vazio) {
    atBlock.replaceWith(els[0]);
    ref = els[0];
    for (const el of els.slice(1)) { ref.after(el); ref = el; }
  } else {
    for (const el of els) { ref.after(el); ref = el; }
  }

  for (const el of els) {
    if (!NO_DETECTION.has(el.dataset.type)) applyDetectionMarks(getContentEl(el));
  }

  focusBlockEnd(els[els.length - 1]);

  renumberLists();
  scheduleSave();
}

// Modelos entram no menu "/" como itens normais, filtráveis pelo nome.
function slashItemsWithTemplates() {
  return [
    ...SLASH_ITEMS,
    ...blockTemplates().map(t => ({
      key:   t.name.toLowerCase(),
      label: t.name,
      short: t.name,
      hint:  'modelo',
      icon:  'bookmark',
      grupo: 'Modelos',
      template: t.content,
    })),
  ];
}

let slashMenuEl = null;
let slashItems  = [];
let slashIndex  = 0;
let slashBlock  = null;

let slashBackdropEl = null;
function closeSlashBackdrop() {
  slashBackdropEl?.remove();
  slashBackdropEl = null;
}

function closeSlashMenuEl() {
  closeSlashBackdrop();
  slashMenuEl?.remove();
  slashMenuEl = null;
}
function closeSlashMenu() { closeSlashMenuEl(); slashItems = []; slashBlock = null; }

function cancelSlashMenu() {
  if (slashBlock) clearContent(getContentEl(slashBlock));
  closeSlashMenu();
}

function renderSlashMenu(block) {
  closeSlashMenuEl();
  const menu = document.createElement('div');
  menu.className = 'copy-menu slash-menu';

  const isMobile = document.documentElement.dataset.platform === 'mobile';
  if (isMobile) {
    menu.classList.add('is-bottom-sheet');
    slashBackdropEl = document.createElement('div');
    slashBackdropEl.className = 'bottom-sheet-backdrop';
    slashBackdropEl.addEventListener('click', cancelSlashMenu);
    document.body.appendChild(slashBackdropEl);

    const pill = document.createElement('div');
    pill.className = 'bottom-sheet-drag-pill';
    const head = document.createElement('div');
    head.className = 'bottom-sheet-header';
    head.innerHTML = `<span class="bottom-sheet-title">Inserir bloco</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'icon-btn bottom-sheet-close';
    closeBtn.innerHTML = '✕';
    closeBtn.title = 'Fechar';
    closeBtn.setAttribute('aria-label', 'Fechar menu de blocos');
    closeBtn.addEventListener('click', cancelSlashMenu);
    head.appendChild(closeBtn);
    menu.prepend(pill, head);
  }

  menu.appendChild(buildTypeGrid(slashItems, i => { slashIndex = i; confirmSlashSelection(); }));

  document.body.appendChild(menu);
  slashMenuEl = menu;
  if (!isMobile) {
    positionMenu(menu, block.getBoundingClientRect());
  }
  highlightSlashItem();
}

// Andar com as setas só troca o destaque — não reconstrói o menu. Reconstruir
// significa tirar o elemento do DOM e recolocar, e era isso que fazia o menu
// piscar a cada tecla. Reconstruir só faz sentido quando a LISTA muda, que é
// quando a pessoa digita mais uma letra depois da barra.
function highlightSlashItem() {
  if (!slashMenuEl) return;
  const celulas = slashMenuEl.querySelectorAll('.type-cell');
  celulas.forEach((btn, i) => btn.classList.toggle('active', i === slashIndex));
  // Sem isto o item ativo some da vista quando a grade é mais alta que o menu.
  celulas[slashIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Esquerda/direita andam item a item na ordem da lista.
function moveSlashSelection(delta) {
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  highlightSlashItem();
}

// Cima/baixo pulam de linha. A linha é descoberta pela posição na tela, e não
// contando "de três em três": os grupos têm tamanhos diferentes, então a
// última linha de um grupo quase nunca está cheia, e contar erraria toda vez
// que a seta cruzasse de um grupo pro outro.
function moveSlashRow(direcao) {
  if (!slashMenuEl) return;
  const celulas = [...slashMenuEl.querySelectorAll('.type-cell')];
  const atual = celulas[slashIndex];
  if (!atual) return;

  const r = atual.getBoundingClientRect();
  let melhor = -1, menorDistancia = Infinity;

  celulas.forEach((c, i) => {
    const cr = c.getBoundingClientRect();
    const dy = cr.top - r.top;
    if (direcao > 0 ? dy <= 1 : dy >= -1) return;   // não está na direção pedida
    // A linha pesa mil vezes mais que a coluna: primeiro a linha mais próxima,
    // e dentro dela a célula mais alinhada horizontalmente.
    const dist = Math.abs(dy) * 1000 + Math.abs(cr.left - r.left);
    if (dist < menorDistancia) { menorDistancia = dist; melhor = i; }
  });

  // Sem linha na direção pedida: vai pra ponta, como numa lista.
  slashIndex = melhor !== -1 ? melhor : (direcao > 0 ? 0 : celulas.length - 1);
  highlightSlashItem();
}

function confirmSlashSelection() {
  const item  = slashItems[slashIndex];
  const block = slashBlock;
  closeSlashMenu();
  if (!item || !block) return;

  captureUndoPoint();

  if (item.template) {
    // Tira o "/nome-do-modelo" que ficou digitado ANTES de inserir: com o
    // texto ainda ali, insertTemplateBlocks não reconhecia a linha como vazia
    // e pendurava o modelo abaixo dela, deixando a barra na nota.
    clearContent(getContentEl(block));
    insertTemplateBlocks(item.template, block);
    return;
  }

  // Imagem não insere bloco vazio: o bloco nasce junto com o arquivo, quando
  // ele for escolhido. Aqui só se limpa o "/imagem" que ficou digitado.
  if (item.type === 'image') {
    clearContent(getContentEl(block));
    pedirImagem({ inserirEm: block });
    return;
  }

  if (INSERTED_TYPES.has(item.type)) {
    const inserted = createBlockEl(item.type);
    block.replaceWith(inserted);
    const para = createBlockEl('paragraph');
    inserted.after(para);
    if (item.type === 'table') focusCell(inserted.querySelector('.table-cell'));
    else focusBlockStart(para);
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
  slashItems = slashItemsWithTemplates()
    .filter(it => it.label.toLowerCase().includes(filter) || it.key.includes(filter));
  if (slashItems.length === 0) { closeSlashMenu(); return; }

  slashBlock = block;
  slashIndex = 0;
  renderSlashMenu(block);
}

// ── Atalhos de Markdown → tipo de bloco ───────────────────────────────────────
const BLOCK_SHORTCUTS = [
  { re: /^(#{1,6}) $/, type: m => `heading${m[1].length}` },
  // Sem hífen na frente de propósito: "- [ ] " nunca dispara, porque "- "
  // sozinho já vira lista de marcador antes de "[ ] " terminar de ser digitado
  // (o atalho roda a cada tecla). "[]"/"[ ]"/"[x] " direto evita a corrida.
  { re: /^\[([ xX]?)\] $/, type: () => 'checklist', checked: m => /[xX]/.test(m[1]) },
  { re: /^[-*] $/, type: () => 'bullet' },
  { re: /^\d+\. $/, type: () => 'number' },
  { re: /^> $/, type: () => 'quote' },
  // A palavra-chave é a do markdown (inglês), igual à que vai pro arquivo.
  { re: /^\[!(note|tip|important|warning|caution)\] $/i, type: m => `callout:${m[1].toLowerCase()}` },
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
  // Link ao digitar: "[texto](endereço)" vira link assim que o parêntese
  // fecha. É o único atalho que precisa de um segundo grupo (o endereço) e de
  // um atributo no elemento — daí o `attrs`.
  //
  // O "!" da frente é consumido de propósito: sem isso, digitar "![alt](url)"
  // deixaria um "!" solto antes do link. Imagem por endereço remoto não vira
  // <img> por decisão de privacidade (ver blocks.js) — vira link, que é
  // exatamente o mesmo resultado de colar a mesma linha.
  {
    re: /!?\[([^\]\n]+)\]\(([^)\s]+)\)$/,
    tag: 'a',
    attrs: m => {
      const href = safeHref(m[2]);
      return href ? { href } : null;   // endereço recusado: deixa o texto como está
    },
  },
  { re: /\*\*([^\n]+?)\*\*$/, tag: 'strong' },
  { re: /~~([^\n]+?)~~$/, tag: 's' },
  { re: /(?<!\*)\*(?![\s*])([^*\n]+?)(?<![\s*])\*$/, tag: 'em' },
];

// Âncora invisível. O cursor precisa cair num nó de texto DE VERDADE fora do
// elemento recém-criado. Numa posição de fronteira — logo depois do <em>, sem
// nada adiante — o Chrome estende o elemento anterior ao digitar, e a ênfase
// que devia ter terminado no "*" de fechamento engole o resto da frase. Não é
// só aparência: o que fica gravado vira "*teste e o resto*" em vez de
// "*teste* e o resto", que é outro texto.
//
// Ela é temporária: some assim que a primeira letra de verdade entra ao lado
// (limparAncoras, no início do 'input'), e sanitizeForSave a remove como rede
// de segurança pra que nunca chegue ao banco em nenhum caminho.
function replaceRangeWithTag(contentEl, start, end, tag, innerText, attrs = {}) {
  const range = rangeFromOffsets(contentEl, start, end);
  range.deleteContents();
  const el = document.createElement(tag);
  el.textContent = innerText;
  for (const [nome, valor] of Object.entries(attrs)) el.setAttribute(nome, valor);
  range.insertNode(el);

  const ancora = document.createTextNode(ANCORA);
  el.after(ancora);

  const after = document.createRange();
  after.setStart(ancora, 1);
  after.collapse(true);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(after);
}

// Uma âncora sozinha no nó ainda está segurando o cursor. Uma âncora com texto
// ao lado já cumpriu o papel e precisa sair — senão sobra invisível no meio da
// frase e desalinha a contagem de posição, a detecção de CPF e a exportação.
function limparAncoras(contentEl) {
  if (!contentEl.textContent.includes(ANCORA)) return;

  const sel = document.getSelection();
  const cursorAqui = sel?.rangeCount > 0 && contentEl.contains(sel.anchorNode);
  const caret = cursorAqui ? getCaretOffset(contentEl) : null;

  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
  const nos = [];
  for (let n; (n = walker.nextNode()); ) nos.push(n);

  let pos = 0, removidasAntes = 0, mexeu = false;
  for (const no of nos) {
    const dados = no.data;
    if (dados.length > 1 && dados.includes(ANCORA)) {
      if (caret !== null) {
        for (let i = 0; i < dados.length; i++) {
          if (dados[i] === ANCORA && pos + i < caret) removidasAntes++;
        }
      }
      no.data = dados.split(ANCORA).join('');
      mexeu = true;
    }
    pos += dados.length;
  }

  if (mexeu && caret !== null) setCaretOffset(contentEl, Math.max(0, caret - removidasAntes));
}

function tryAutoFormatInline(contentEl) {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
  if (!contentEl.contains(sel.anchorNode)) return;

  const offset = getCaretOffset(contentEl);
  const before = contentEl.textContent.slice(0, offset);

  for (const { re, tag, attrs } of INLINE_SHORTCUTS) {
    const m = re.exec(before);
    if (!m) continue;
    // `attrs` devolvendo null quer dizer "este atalho não se aplica" — é assim
    // que um endereço inválido deixa o texto digitado intacto em vez de sumir.
    const atributos = attrs ? attrs(m) : {};
    if (atributos === null) continue;
    replaceRangeWithTag(contentEl, offset - m[0].length, offset, tag, m[1], atributos);
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
  // A folha de cálculo se repete no Enter como uma lista se repete, e sai pelo
  // mesmo gesto: Enter numa linha vazia.
  const repete    = isListish || type === 'calc';
  const isEmpty   = content.textContent.trim() === '';

  if (repete && isEmpty) {
    // Indentado, o Enter num item vazio sai um nível — só no nível 0 é que
    // ele desiste da lista e vira parágrafo. É o caminho de saída natural de
    // uma lista aninhada, sem precisar de Shift+Tab.
    if (blockDepth(block) > 0) {
      indentBlocks([block], -1);
      renumberLists();
      focusBlockStart(block);
      return;
    }
    const para = convertBlockType(block, 'paragraph');
    focusBlockStart(para);
    renumberLists();
    return;
  }

  // Enter numa linha citada vazia sai da citação, do mesmo jeito que sai de
  // uma lista — é o caminho de saída sem precisar procurar menu.
  if (isBlockQuoted(block) && isEmpty) {
    setBlockQuoted(block, false);
    renumberLists();
    focusBlockStart(block);
    return;
  }

  const start = pointAtOffset(content, offset);
  const afterRange = document.createRange();
  afterRange.setStart(start.node, start.offset);
  afterRange.setEndAfter(content.lastChild ?? content.firstChild ?? content);
  const afterHTML = htmlOfFragment(afterRange.extractContents());

  const nextType = repete ? type : 'paragraph';
  const newBlock = createBlockEl(nextType, afterHTML, false);
  setBlockDepth(newBlock, blockDepth(block));
  setBlockQuoted(newBlock, isBlockQuoted(block));
  setBlockCallout(newBlock, block.dataset.callout);   // Enter continua dentro do destaque
  block.after(newBlock);
  focusBlockStart(newBlock);
  renumberLists();
}

function handleBackspaceAtStart(block) {
  captureUndoPoint();
  const type    = block.dataset.type;
  const content = getContentEl(block);
  const isEmpty = content.textContent.trim() === '';

  // Citado: o primeiro Backspace tira a citação, sem mexer no conteúdo — o
  // mesmo gesto que já tirava qualquer outra formatação de bloco.
  if (isBlockQuoted(block)) {
    setBlockQuoted(block, false);
    renumberLists();
    focusBlockStart(block);
    return;
  }

  // Indentado: o Backspace seguinte sai um nível. É o inverso do Tab e evita
  // que apagar no início engula o bloco de cima.
  if (blockDepth(block) > 0) {
    indentBlocks([block], -1);
    renumberLists();
    focusBlockStart(block);
    return;
  }

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

  // Tabela e imagem não têm um texto único onde este bloco possa ser fundido —
  // seguir daqui despejaria o conteúdo dentro da tabela. Backspace no começo da
  // linha simplesmente não faz nada aqui; pra apagar a tabela ou a imagem
  // existem o menu do bloco e o botão Remover.
  if (NO_TEXT_TYPES.has(prev.dataset.type)) return;

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

// Mexeu no editor — por clique ou por teclado —, a nota volta a ser a área da
// vez. É o que decide pra onde vai a próxima imagem colada.
root.addEventListener('mousedown', () => setActiveArea('note'), true);
root.addEventListener('focusin',   () => setActiveArea('note'));

root.addEventListener('input', () => {
  const block = currentBlock();
  if (!block) return;

  // Primeiro de tudo: a âncora invisível da formatação anterior já cumpriu o
  // papel assim que esta tecla entrou ao lado dela. Sai daqui antes que
  // qualquer atalho ou detecção leia o texto do bloco e a conte como caractere.
  if (block.dataset.type !== 'table') limparAncoras(getContentEl(block));

  // Célula de tabela só salva: atalho de bloco e menu "/" não fazem sentido
  // dentro dela, e a detecção varreria o bloco inteiro em vez da célula.
  if (block.dataset.type === 'table') { scheduleSave(); return; }

  if (block.dataset.type === 'paragraph') {
    if (checkDividerShortcut(block)) { scheduleSave(); return; }
    if (checkBlockShortcut(block))   { scheduleSave(); return; }
    checkSlashMenu(block);
  } else {
    closeSlashMenu();
  }

  // Folha de cálculo: recalcula a cada tecla (é o "tempo real") e não passa
  // pela formatação inline — asterisco ali é multiplicação, não itálico.
  if (block.dataset.type === 'calc') {
    recalcCalcSheets();
    scheduleSave();
    return;
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

  if ((e.ctrlKey || e.metaKey) && key === 'k') {
    e.preventDefault();
    applyLink();
    return;
  }

  // Apagar blocos inteiros é o gesto de uma seleção de BLOCOS (alça ou
  // Ctrl+arrastar), onde não existe texto selecionado. Numa seleção espelhada
  // de texto, Backspace tem que apagar o texto marcado e mais nada — selecionar
  // do meio de uma linha até o meio da seguinte e apagar as duas por inteiro
  // seria perder o que ninguém mandou apagar.
  if ((e.key === 'Backspace' || e.key === 'Delete')
      && selectedBlockIds.size > 0 && !selecaoEspelhada) {
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
    if (e.key === 'ArrowDown')  { e.preventDefault(); moveSlashRow(1);  return; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); moveSlashRow(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); moveSlashSelection(1);  return; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); moveSlashSelection(-1); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); confirmSlashSelection(); return; }
    if (e.key === 'Escape') { e.preventDefault(); cancelSlashMenu(); return; }
  }

  // Numa célula de tabela, Enter quebra linha dentro da célula — nunca cria um
  // bloco novo, que jogaria um parágrafo pra fora da tabela.
  if (e.key === 'Enter' && focusedCell()) {
    e.preventDefault();
    document.execCommand('insertLineBreak');
    scheduleSave();
    return;
  }

  if (e.key === 'Tab') {
    const cell = focusedCell();
    if (cell) {
      e.preventDefault();
      moveCell(cell, e.shiftKey ? -1 : 1);
      return;
    }
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
    // Backspace no início de uma célula vazia não pode fundir blocos.
    if (focusedCell()) return;
    const block = currentBlock();
    if (!block) return;
    const content = getContentEl(block);
    if (getCaretOffset(content) !== 0) return;
    e.preventDefault();
    handleBackspaceAtStart(block);
    scheduleSave();
    return;
  }

  // Tab tem três donos, nesta ordem: célula de tabela (acima), item do menu
  // "/" (acima) e, aqui, indentar. Chegar até este ponto já quer dizer que os
  // dois primeiros não quiseram a tecla.
  if (e.key === 'Tab') {
    e.preventDefault();
    const alvos = blocksForIndent();
    if (alvos.length === 0) return;
    const antes = snapshotState();
    if (!indentBlocks(alvos, e.shiftKey ? -1 : 1)) return;
    captureUndoPoint(antes);
    renumberLists();
    scheduleSave();
  }
});

// Precedência de colagem. Existem dois ouvintes de `paste`: este, em `root`, e
// o de documents.js, em `document`. Como este não interrompia a propagação, os
// dois rodavam na mesma colagem — hoje isso é inofensivo só porque a nota não
// trata imagem. `claim()` marca explicitamente o que a nota assumiu, e o que
// ela não assume continua subindo pra seção Documentos.
root.addEventListener('paste', e => {
  const claim = () => e.stopPropagation();
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') ?? '';

  // Excel e Google Sheets mandam a seleção como <table> em text/html e como
  // TSV em text/plain. Dentro de uma célula não vale — colar tabela em tabela
  // não tem para onde ir, então ali entra como texto.
  if (!focusedCell()) {
    const grid = parseClipboardTable(e.clipboardData?.getData('text/html') ?? '')
              ?? parseTsvTable(text);
    if (grid) { claim(); insertTableBlock(grid); return; }
  }

  // Imagem entra na nota quando foi na nota que a pessoa clicou por último.
  // Conferir o foco não serviria: a seleção por arrasto dos documentos cancela
  // o mousedown, e um mousedown cancelado deixa o foco onde estava — o editor
  // continuava "focado" mesmo com a pessoa mexendo nos documentos (ver
  // active-area.js). Dentro de uma célula de tabela a imagem não cabe, então
  // ali ela também segue pros Documentos.
  const imagem = [...(e.clipboardData?.items ?? [])].find(it => it.type.startsWith('image/'));
  if (imagem && isNoteActive() && !focusedCell()) {
    const blob = imagem.getAsFile();
    if (blob) {
      claim();
      const carimbo = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
      const ext = ({ jpeg: 'jpg' }[blob.type.split('/')[1]] ?? blob.type.split('/')[1] ?? 'png');
      insertImageFile(new File([blob], `colado_${carimbo}.${ext}`, { type: blob.type }), currentBlock());
      return;
    }
  }

  if (!text) return;   // nada que a nota saiba tratar — segue pros Documentos
  claim();

  // URL colada vira link direto: com texto selecionado o endereço envolve a
  // seleção; sem seleção o link entra rotulado com o que foi colado, então
  // colar "www.aaa.com" dá [www.aaa.com](https://www.aaa.com).
  const single = text.trim();
  if (!single.includes('\n') && !/\s/.test(single)) {
    const href = safeHref(single);
    if (href) { pasteLink(single, href); return; }
  }

  if (text.includes('\n')) {
    pasteMultilineText(text);
  } else {
    pasteInlineText(text);
  }
});

// ── Colar planilha ────────────────────────────────────────────────────────────
// Só o texto das células: o HTML do Excel vem cheio de <font>, style inline e
// atributos próprios, que poluiriam a nota e não acrescentam nada aqui.
function cellText(el) {
  return escHtml(el.textContent.replace(/\s+/g, ' ').trim());
}

// Iguala o número de colunas e garante o mínimo de duas linhas — a primeira é
// cabeçalho e o markdown exige ao menos uma linha de dados.
function normalizeGrid(rows) {
  const cols = Math.max(...rows.map(r => r.length));
  const out = rows.map(r => [...r, ...Array(cols - r.length).fill('')]);
  if (out.length === 1) out.push(Array(cols).fill(''));
  return out;
}

function parseClipboardTable(html) {
  if (!html || !/<table/i.test(html)) return null;
  const table = new DOMParser().parseFromString(html, 'text/html').querySelector('table');
  if (!table) return null;
  const rows = [...table.rows].map(tr => [...tr.cells].map(cellText));
  if (!rows.length || !rows[0].length) return null;
  return normalizeGrid(rows);
}

function parseTsvTable(text) {
  if (!text.includes('\t')) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.length > 0);
  if (lines.length < 2) return null;
  return normalizeGrid(lines.map(l => l.split('\t').map(c => escHtml(c.trim()))));
}

function insertTableBlock(rows) {
  const block = currentBlock() ?? root.lastElementChild;
  if (!block) return;

  captureUndoPoint();
  const table = createBlockEl('table', '', false, rows);

  // Cola por cima do bloco atual quando ele está vazio, em vez de deixar uma
  // linha em branco órfã acima da tabela.
  const empty = block.dataset.type !== 'table' && !getContentEl(block).textContent.trim();
  if (empty) block.replaceWith(table);
  else block.after(table);

  if (!table.nextElementSibling) table.after(createBlockEl('paragraph'));
  focusCell(table.querySelector('.table-cell'));
  renumberLists();
  scheduleSave();
}

function pasteLink(label, href) {
  const sel = document.getSelection();
  const range = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0) : null;
  if (!range || !root.contains(range.commonAncestorContainer)) { pasteInlineText(label); return; }

  captureUndoPoint();

  const a = document.createElement('a');
  a.setAttribute('href', href);
  if (!range.collapsed) a.appendChild(range.extractContents());
  if (!a.textContent.trim()) a.textContent = label;
  range.insertNode(a);

  const after = document.createRange();
  after.setStartAfter(a);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);

  const block = getBlockFromNode(a);
  if (block) scheduleRescan(block);
  scheduleSave();
}

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
async function pasteMultilineText(text) {
  const block = currentBlock() ?? root.lastElementChild;
  if (!block) return;

  // Imagem em base64 vira arquivo antes de entrar no DOM (ver absorbDataUrls).
  const parsed = await absorbDataUrls(parseMarkdownToBlocks(text));

  captureUndoPoint();
  const base = blockDepth(block);
  const newEls = parsed
    .map(b => createBlockElFrom(base ? { ...b, depth: (b.depth ?? 0) + base } : b));

  const content = block.dataset.type === 'table' ? null : getContentEl(block);
  const isEmpty = content ? content.textContent.trim() === '' : false;

  let anchor = block;
  for (const el of newEls) { anchor.after(el); anchor = el; }
  if (isEmpty && block.dataset.type === 'paragraph') block.remove();

  renumberLists();
  for (const el of newEls) {
    if (!NO_DETECTION.has(el.dataset.type)) applyDetectionMarks(getContentEl(el));
  }
  focusBlockEnd(newEls[newEls.length - 1]);
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

// ── Formatação Markdown / troca de tipo de bloco ─────────────────────────────
function execFormat(command) {
  captureUndoPoint();
  document.execCommand(command, false, null);
  const block = currentBlock();
  if (block) scheduleRescan(block);
  scheduleSave();
}

// ── Links ─────────────────────────────────────────────────────────────────────
function currentLinkEl() {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const a = node?.closest?.('a');
  return a && root.contains(a) ? a : null;
}

// Menu de link — dentro da extensão, não um prompt() do navegador.
let linkMenuEl = null;
function closeLinkMenu() { linkMenuEl?.remove(); linkMenuEl = null; }

function openLinkMenu(anchorRect, { href = '', texto = '', canRemove = false, onApply, onRemove }) {
  closeLinkMenu();
  const menu = document.createElement('div');
  menu.className = 'copy-menu link-menu';

  const header = document.createElement('div');
  header.className   = 'copy-menu-header';
  header.textContent = canRemove ? 'Editar link' : 'Novo link';

  // Dois campos, com rótulo: só o endereço não bastava — trocar a palavra que
  // aparece na nota obrigava a apagar o link e refazer.
  const campo = (rotulo, valor, placeholder) => {
    const wrap = document.createElement('label');
    wrap.className = 'link-field';
    const nome = document.createElement('span');
    nome.className = 'link-field-label';
    nome.textContent = rotulo;
    const input = document.createElement('input');
    input.className   = 'link-input';
    input.type        = 'text';
    input.value       = valor;
    input.placeholder = placeholder;
    wrap.append(nome, input);
    return { wrap, input };
  };

  const campoTexto = campo('Texto',    texto, 'o que aparece na nota');
  const campoHref  = campo('Endereço', href,  'exemplo.com.br');
  const input = campoHref.input;

  const error = document.createElement('div');
  error.className   = 'link-error';
  error.textContent = 'Endereço inválido';
  error.hidden      = true;

  const apply = () => {
    const url = safeHref(input.value);
    if (!url) { error.hidden = false; input.focus(); return; }
    closeLinkMenu();
    // Texto vazio: o endereço vira o rótulo, como já acontece ao colar uma URL
    // sem nada selecionado.
    onApply(url, campoTexto.input.value.trim() || url);
  };

  for (const { input: campoEl } of [campoTexto, campoHref]) {
    campoEl.addEventListener('mousedown', e => e.stopPropagation());
    campoEl.addEventListener('input', () => { error.hidden = true; });
    campoEl.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter')  { e.preventDefault(); apply(); }
      if (e.key === 'Escape') { e.preventDefault(); closeLinkMenu(); }
    });
  }

  const actions = document.createElement('div');
  actions.className = 'link-actions';

  const okBtn = document.createElement('button');
  okBtn.className   = 'link-btn link-apply';
  okBtn.textContent = 'Aplicar';
  okBtn.addEventListener('mousedown', e => e.preventDefault());
  okBtn.addEventListener('click', apply);
  actions.appendChild(okBtn);

  if (canRemove) {
    const rmBtn = document.createElement('button');
    rmBtn.className   = 'link-btn link-remove';
    rmBtn.textContent = 'Remover';
    rmBtn.addEventListener('mousedown', e => e.preventDefault());
    rmBtn.addEventListener('click', () => { closeLinkMenu(); onRemove(); });
    actions.appendChild(rmBtn);
  }

  menu.append(header, campoTexto.wrap, campoHref.wrap, error, actions);
  document.body.appendChild(menu);
  linkMenuEl = menu;
  positionMenu(menu, anchorRect);

  // O foco vai pro campo que falta preencher: com texto já vindo da seleção,
  // o que a pessoa veio fazer é digitar o endereço.
  const primeiro = texto ? campoHref.input : campoTexto.input;
  primeiro.focus();
  primeiro.select();
}

document.addEventListener('mousedown', e => {
  if (linkMenuEl && !linkMenuEl.contains(e.target)) closeLinkMenu();
});

function applyLink() {
  const sel      = document.getSelection();
  const existing = currentLinkEl();
  const dentro   = sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).commonAncestorContainer);
  const hasText  = dentro && !sel.isCollapsed;

  // Sem seleção e sem link não é mais recusa: agora existe um campo de texto,
  // então dá pra criar o link inteiro pelo menu.
  if (!existing && !dentro) { showFeedback('Ponha o cursor na nota primeiro'); return; }

  // O range e o bloco são guardados agora: abrir o menu tira o foco do editor
  // e a seleção deixa de existir quando o callback roda.
  const range = dentro ? sel.getRangeAt(0).cloneRange() : null;
  const block = getBlockFromNode(existing ?? range.commonAncestorContainer);
  const rect  = (existing ?? range).getBoundingClientRect();

  const done = () => {
    if (block) scheduleRescan(block);
    scheduleSave();
  };

  openLinkMenu(rect, {
    href:  existing?.getAttribute('href') ?? '',
    texto: existing?.textContent ?? (hasText ? range.toString() : ''),
    canRemove: !!existing,
    onApply: (url, novoTexto) => {
      captureUndoPoint();
      if (existing) {
        existing.setAttribute('href', url);
        // Só reescreve o texto se ele mudou de verdade: um link com negrito
        // dentro perderia a formatação à toa se fosse refeito a cada ajuste
        // de endereço.
        if (novoTexto !== existing.textContent) existing.textContent = novoTexto;
      } else {
        const a = document.createElement('a');
        a.setAttribute('href', url);
        if (hasText && novoTexto === range.toString()) {
          // Texto inalterado: move o conteúdo original pra dentro do link e
          // preserva o negrito/itálico que já estava lá.
          a.appendChild(range.extractContents());
        } else {
          range.deleteContents();
          a.textContent = novoTexto;
        }
        range.insertNode(a);
      }
      done();
    },
    onRemove: () => {
      captureUndoPoint();
      existing.replaceWith(...existing.childNodes);
      done();
    },
  });
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

// Na barra de formatação o botão de citação liga e desliga — é o que se
// espera de um botão de barra, e é o caminho visível pra tirar a citação (o
// outro é Backspace no começo da linha). Com vários blocos só desliga quando
// todos já estão citados: numa seleção meio-a-meio, alternar cada um
// embaralharia em vez de resolver.
function toggleQuotedOnSelection() {
  const blocks = getSelectedBlocks();
  if (blocks.length === 0) return;
  captureUndoPoint();
  const todosCitados = blocks.every(isBlockQuoted);
  for (const b of blocks) setBlockQuoted(b, !todosCitados);
  renumberLists();
  scheduleSave();
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

// ── Seleção múltipla de blocos ────────────────────────────────────────────────
let selectedBlockIds     = new Set();
let lastHandleClickedId  = null;
let selecaoEspelhada     = false;   // a seleção de blocos nasceu de uma seleção de texto
let isBlockSelectActive  = false;   // modo de seleção explícito ativo no mobile

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
  root.classList.toggle('blocks-selected', selectedBlockIds.size > 1);
  updateMobileToolbarState();
}

function clearBlockSelection() {
  isBlockSelectActive = false;
  setBlockSelection([]);
  lastHandleClickedId = null;
  selecaoEspelhada = false;
  if (noteSection) noteSection.classList.remove('touch-selection-active');
}

function selectBlockRange(fromBlock, toBlock) {
  const all = orderedBlocks();
  const a = all.indexOf(fromBlock), b = all.indexOf(toBlock);
  if (a === -1 || b === -1) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  setBlockSelection(all.slice(lo, hi + 1).map(el => el.dataset.id));
}

function targetBlocksFor(block) {
  if (selectedBlockIds.size > 1 && selectedBlockIds.has(block.dataset.id)) {
    return orderedBlocks().filter(el => selectedBlockIds.has(el.dataset.id));
  }
  return [block];
}

function getSelectedBlockElements() {
  if (selectedBlockIds.size > 0) {
    return orderedBlocks().filter(b => selectedBlockIds.has(b.dataset.id));
  }
  const curr = currentBlock() || lastFocusedBlock;
  return curr ? [curr] : [];
}

function downloadTextFile(filename, text, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getSuggestedBlockFilename(blocks, defaultName = 'nota') {
  const alvos = blocks && blocks.length > 0 ? blocks : getSelectedBlockElements();
  const text = alvos
    .filter(b => !NO_TEXT_TYPES.has(b.dataset.type))
    .map(b => getContentEl(b)?.textContent?.trim())
    .find(Boolean) ?? defaultName;
  return text.slice(0, 30).replace(/[\\/:*?"<>|]+/g, '-').trim() || defaultName;
}

// ── Barra Contextual Estilo Notion (Dual-State & No-Scrim Sheets) ────────────
let lastFocusedBlock = null;

const mobileNotionToolbar = document.createElement('div');
mobileNotionToolbar.className = 'mobile-notion-toolbar';
mobileNotionToolbar.id = 'mobile-notion-toolbar';

// Estado 1: Formatação de Texto (quando texto estiver selecionado)
const mobileFormatBar = document.createElement('div');
mobileFormatBar.className = 'mobile-toolbar-inner mobile-format-bar';
mobileFormatBar.hidden = true;
mobileFormatBar.style.display = 'none';

// Estado 2: Ações de Bloco (quando NÃO houver texto selecionado)
const mobileBlockBar = document.createElement('div');
mobileBlockBar.className = 'mobile-toolbar-inner mobile-block-bar';
mobileBlockBar.style.display = 'flex';

// Estado 3: Seleção de Blocos (quando blocos estiverem selecionados ou modo seleção ativo)
const mobileSelectBar = document.createElement('div');
mobileSelectBar.className = 'mobile-toolbar-inner mobile-select-bar';
mobileSelectBar.hidden = true;
mobileSelectBar.style.display = 'none';

// Popover: Adicionar bloco (Acima ou Abaixo)
const mobileAddPopover = document.createElement('div');
mobileAddPopover.className = 'mobile-add-popover';
mobileAddPopover.hidden = true;
mobileAddPopover.innerHTML = `
  <button class="mob-popover-item" data-pos="above">
    <span class="qd-icon material-symbols-rounded">arrow_upward</span>
    <span>Adicionar acima</span>
  </button>
  <button class="mob-popover-item" data-pos="below">
    <span class="qd-icon material-symbols-rounded">arrow_downward</span>
    <span>Adicionar abaixo</span>
  </button>
`;

// Popover: Cores / Destaque
const mobileColorPopover = document.createElement('div');
mobileColorPopover.className = 'mobile-color-popover';
mobileColorPopover.hidden = true;
const HIGHLIGHT_COLORS = [
  { name: 'Sem cor', color: 'transparent', border: true },
  { name: 'Amarelo', color: '#fef08a' },
  { name: 'Verde', color: '#bbf7d0' },
  { name: 'Azul', color: '#bfdbfe' },
  { name: 'Rosa', color: '#fbcfe8' },
  { name: 'Laranja', color: '#fed7aa' },
  { name: 'Roxo', color: '#e9d5ff' },
];
mobileColorPopover.innerHTML = HIGHLIGHT_COLORS.map(c =>
  `<button class="mob-color-dot" data-color="${c.color}" title="${c.name}" style="background-color: ${c.color}; ${c.border ? 'border: 1px dashed var(--border);' : ''}"></button>`
).join('');

// Sheet: Formatar texto (transformações de texto QuickDock)
const mobileTextFormatSheet = document.createElement('div');
mobileTextFormatSheet.className = 'mobile-text-format-sheet';
mobileTextFormatSheet.hidden = true;
mobileTextFormatSheet.innerHTML = `
  <div class="mob-tf-header">
    <span class="mob-tf-title">Formatar texto</span>
    <button class="mob-tf-close" id="mob-tf-close" aria-label="Fechar">✕</button>
  </div>
  <div class="mob-tf-grid">
    <button class="mob-tf-btn" data-act="upper"><b>AA</b><span>MAIÚSCULAS</span></button>
    <button class="mob-tf-btn" data-act="lower"><b>aa</b><span>minúsculas</span></button>
    <button class="mob-tf-btn" data-act="title"><b>Aa</b><span>Cada palavra</span></button>
    <button class="mob-tf-btn" data-act="sentence"><b>A.</b><span>Frase</span></button>
    <button class="mob-tf-btn" data-act="para"><b>¶A</b><span>Parágrafo</span></button>
    <button class="mob-tf-btn" data-act="invert"><b>aA</b><span>Inverter</span></button>
    <button class="mob-tf-btn" data-act="no-accents"><b>Á</b><span>Sem acentos</span></button>
    <button class="mob-tf-btn" data-act="clean-spaces"><b>⎵</b><span>Espaços</span></button>
  </div>
`;

// Bottom Sheet: Trocar Tipo de Bloco (Sem modal e SEM scrim)
const mobileTypeSheet = document.createElement('div');
mobileTypeSheet.className = 'mobile-type-sheet-no-scrim';
mobileTypeSheet.hidden = true;
mobileTypeSheet.innerHTML = `
  <div class="mob-sheet-handle"></div>
  <div class="mob-sheet-header">
    <span class="mob-sheet-title">Trocar tipo de bloco</span>
    <button class="mob-sheet-close" id="mob-type-close" aria-label="Fechar">✕</button>
  </div>
  <div class="mob-sheet-grid" id="mob-sheet-grid"></div>
`;

const MOBILE_BLOCK_TYPES = [
  { type: 'paragraph',         label: 'Texto',       icon: 'notes' },
  { type: 'heading1',          label: 'Título 1',    icon: 'format_h1' },
  { type: 'heading2',          label: 'Título 2',    icon: 'format_h2' },
  { type: 'heading3',          label: 'Título 3',    icon: 'format_h3' },
  { type: 'bullet',            label: 'Marcadores',  icon: 'format_list_bulleted' },
  { type: 'number',            label: 'Numerada',    icon: 'format_list_numbered' },
  { type: 'checklist',         label: 'Checklist',   icon: 'checklist' },
  { type: 'quote',             label: 'Citação',     icon: 'format_quote' },
  { type: 'callout:note',      label: 'Nota',        icon: 'info' },
  { type: 'callout:tip',       label: 'Dica',        icon: 'lightbulb' },
  { type: 'callout:important', label: 'Importante',  icon: 'priority_high' },
  { type: 'callout:warning',   label: 'Alerta',      icon: 'warning' },
  { type: 'code',              label: 'Código',      icon: 'code' },
  { type: 'table',             label: 'Tabela',      icon: 'table' },
  { type: 'divider',           label: 'Divisor',     icon: 'horizontal_rule' },
];

const mobSheetGrid = mobileTypeSheet.querySelector('#mob-sheet-grid');
for (const it of MOBILE_BLOCK_TYPES) {
  const itemBtn = document.createElement('button');
  itemBtn.className = 'mob-sheet-item';
  itemBtn.innerHTML = `<span class="qd-icon material-symbols-rounded">${it.icon}</span><span>${escHtml(it.label)}</span>`;
  itemBtn.addEventListener('mousedown', e => e.preventDefault());
  itemBtn.addEventListener('click', e => {
    e.stopPropagation();
    applyMobileBlockType(it.type);
  });
  mobSheetGrid.appendChild(itemBtn);
}

function applyMobileBlockType(type) {
  const block = currentBlock() || lastFocusedBlock || root.querySelector('.block');
  closeMobileTypeSheet();
  if (!block || !root.contains(block)) return;

  if (type === 'divider') {
    insertDividerAtCursor();
  } else if (type === 'table') {
    const inserted = createBlockEl('table');
    block.after(inserted);
    if (!inserted.nextElementSibling) inserted.after(createBlockEl('paragraph'));
    focusCell(inserted.querySelector('.table-cell'));
    renumberLists();
    scheduleSave();
  } else {
    transformBlocks(block, type);
  }
}

// Bottom Sheet: Modelos de Bloco (Sem modal e SEM scrim, totalmente separado de tipo)
const mobileTemplateSheet = document.createElement('div');
mobileTemplateSheet.className = 'mobile-template-sheet-no-scrim';
mobileTemplateSheet.hidden = true;
mobileTemplateSheet.innerHTML = `
  <div class="mob-sheet-handle"></div>
  <div class="mob-sheet-header">
    <span class="mob-sheet-title">Modelos de bloco</span>
    <button class="mob-sheet-close" id="mob-template-close" aria-label="Fechar">✕</button>
  </div>
  <div class="mob-template-list" id="mob-template-list"></div>
  <div class="mob-template-footer">
    <button class="mob-template-save-btn" id="mob-template-save-btn">
      <span class="qd-icon material-symbols-rounded">bookmark_add</span>
      <span>Salvar bloco atual como modelo</span>
    </button>
  </div>
`;

function renderMobileTemplateList() {
  const listEl = mobileTemplateSheet.querySelector('#mob-template-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  const tpls = blockTemplates();
  if (tpls.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mob-template-empty';
    empty.textContent = 'Nenhum modelo de bloco salvo ainda';
    listEl.appendChild(empty);
    return;
  }

  for (const tpl of tpls) {
    const itemBtn = document.createElement('button');
    itemBtn.className = 'mob-template-item';
    itemBtn.innerHTML = `
      <span class="qd-icon material-symbols-rounded">bookmark</span>
      <span class="mob-template-name">${escHtml(tpl.name)}</span>
    `;
    itemBtn.addEventListener('mousedown', e => e.preventDefault());
    itemBtn.addEventListener('click', e => {
      e.stopPropagation();
      closeMobileTemplateSheet();
      captureUndoPoint();
      const target = currentBlock() || lastFocusedBlock || root.lastElementChild;
      insertTemplateBlocks(tpl.content, target);
    });
    listEl.appendChild(itemBtn);
  }
}

function closeMobileTemplateSheet() {
  mobileTemplateSheet.hidden = true;
}

function toggleMobileTemplateSheet() {
  if (mobileTemplateSheet.hidden) {
    const block = currentBlock();
    if (block) lastFocusedBlock = block;
    renderMobileTemplateList();
    mobileTemplateSheet.hidden = false;
    closeMobileAddPopover();
    closeMobileTypeSheet();
    closeMobileTextFormatSheet();
    closeMobileColorPopover();
  } else {
    mobileTemplateSheet.hidden = true;
  }
}

mobileTemplateSheet.querySelector('#mob-template-close')?.addEventListener('click', e => {
  e.stopPropagation();
  closeMobileTemplateSheet();
});

mobileTemplateSheet.querySelector('#mob-template-save-btn')?.addEventListener('click', e => {
  e.stopPropagation();
  const alvos = getSelectedBlockElements();
  if (alvos.length === 0) {
    showFeedback('Nenhum bloco para salvar');
    return;
  }
  const targets = alvos.length > 1 ? alvos : targetBlocksFor(alvos[0]);
  const markdown = blocksToMarkdown(targets.map(serializeBlockEl));
  if (!markdown.trim()) {
    showFeedback('Nada para salvar');
    return;
  }
  closeMobileTemplateSheet();
  openSaveBlockTemplate(mobBtnTemplates, markdown, nome => {
    showFeedback(`Modelo "${nome}" salvo`);
    renderMobileTemplateList();
  });
});

// ── Botões do Estado 1: Formatação de Texto ──────────────────────────────────
function createMobToolbarBtn(act, html, title, clickFn) {
  const btn = document.createElement('button');
  btn.className = 'mob-btn';
  btn.dataset.act = act;
  btn.title = title;
  btn.innerHTML = html;
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', e => {
    e.stopPropagation();
    clickFn(e);
  });
  return btn;
}

const mobBtnBold = createMobToolbarBtn('bold', '<b>B</b>', 'Negrito', () => execFormat('bold'));
const mobBtnItalic = createMobToolbarBtn('italic', '<i>I</i>', 'Itálico', () => execFormat('italic'));
const mobBtnUnderline = createMobToolbarBtn('underline', '<u>U</u>', 'Sublinhado', () => execFormat('underline'));
const mobBtnStrike = createMobToolbarBtn('strike', '<s>S</s>', 'Tachado', () => execFormat('strikeThrough'));
const mobBtnCode = createMobToolbarBtn('code', '&lt;/&gt;', 'Código em linha', () => wrapSelectionInTag('code'));
const mobBtnLink = createMobToolbarBtn('link', '<span class="qd-icon material-symbols-rounded">link</span>', 'Link', () => applyLink());
const mobBtnColor = createMobToolbarBtn('color', '<span class="qd-icon material-symbols-rounded">palette</span>', 'Cor e destaque', () => {
  toggleMobileColorPopover();
});

const mobBtnTextFormat = createMobToolbarBtn(
  'text-format',
  '<span class="qd-icon material-symbols-rounded">text_format</span><span class="mob-btn-label">Formatar</span>',
  'Formatar texto',
  () => {
    toggleMobileTextFormatSheet();
  }
);

const mobBtnFmtCopyImg = createMobToolbarBtn(
  'fmt-copy-img',
  '<span class="qd-icon material-symbols-rounded">image</span>',
  'Copiar bloco como imagem',
  () => {
    const b = currentBlock() || lastFocusedBlock;
    if (b) printBlocks(b, 'clipboard');
  }
);

const mobBtnFmtDownloadImg = createMobToolbarBtn(
  'fmt-down-img',
  '<span class="qd-icon material-symbols-rounded">download</span>',
  'Baixar bloco como imagem',
  () => {
    const b = currentBlock() || lastFocusedBlock;
    if (b) printBlocks(b, 'download');
  }
);

const mobBtnFmtDownloadMd = createMobToolbarBtn(
  'fmt-down-md',
  '<span class="qd-icon material-symbols-rounded">description</span><span class="mob-btn-label">.md</span>',
  'Baixar bloco como Markdown',
  async () => {
    const b = currentBlock() || lastFocusedBlock;
    if (!b) return;
    const targets = targetBlocksFor(b).map(serializeBlockEl);
    const text = await blocksToExportMarkdown(targets);
    const nome = getSuggestedBlockFilename([b], 'bloco');
    downloadTextFile(`${nome}.md`, text, 'text/markdown;charset=utf-8');
    showFeedback('Markdown baixado!');
  }
);

const mobBtnFmtDownloadTxt = createMobToolbarBtn(
  'fmt-down-txt',
  '<span class="qd-icon material-symbols-rounded">text_snippet</span><span class="mob-btn-label">.txt</span>',
  'Baixar bloco como Texto',
  () => {
    const b = currentBlock() || lastFocusedBlock;
    if (!b) return;
    const targets = targetBlocksFor(b).map(serializeBlockEl);
    const text = blocksToPlainText(targets);
    const nome = getSuggestedBlockFilename([b], 'bloco');
    downloadTextFile(`${nome}.txt`, text, 'text/plain;charset=utf-8');
    showFeedback('Texto baixado!');
  }
);

mobileFormatBar.append(
  mobBtnBold,
  mobBtnItalic,
  mobBtnUnderline,
  mobBtnStrike,
  mobBtnCode,
  mobBtnLink,
  mobBtnColor,
  Object.assign(document.createElement('div'), { className: 'mob-sep' }),
  mobBtnTextFormat,
  Object.assign(document.createElement('div'), { className: 'mob-sep' }),
  mobBtnFmtCopyImg,
  mobBtnFmtDownloadImg,
  mobBtnFmtDownloadMd,
  mobBtnFmtDownloadTxt
);

// ── Botões do Estado 2: Ações de Bloco ───────────────────────────────────────
const mobBtnAdd = createMobToolbarBtn(
  'add-menu',
  '<span class="qd-icon material-symbols-rounded">add</span>',
  'Adicionar bloco (acima ou abaixo)',
  () => {
    toggleMobileAddPopover();
  }
);
mobBtnAdd.classList.add('mob-btn-add');

const mobUndoBtn = createMobToolbarBtn(
  'undo',
  '<span class="qd-icon material-symbols-rounded">undo</span>',
  'Desfazer',
  () => {
    performUndo();
    updateMobileToolbarState();
  }
);

const mobRedoBtn = createMobToolbarBtn(
  'redo',
  '<span class="qd-icon material-symbols-rounded">redo</span>',
  'Refazer',
  () => {
    performRedo();
    updateMobileToolbarState();
  }
);

const mobMoveUpBtn = createMobToolbarBtn(
  'move-up',
  '<span class="qd-icon material-symbols-rounded">arrow_upward</span>',
  'Mover bloco para cima',
  () => {
    moveActiveBlock(-1);
  }
);

const mobMoveDownBtn = createMobToolbarBtn(
  'move-down',
  '<span class="qd-icon material-symbols-rounded">arrow_downward</span>',
  'Mover bloco para baixo',
  () => {
    moveActiveBlock(1);
  }
);

const mobOutdentBtn = createMobToolbarBtn(
  'outdent',
  '<span class="qd-icon material-symbols-rounded">format_indent_decrease</span>',
  'Desindentar',
  () => {
    indentActiveBlock(-1);
  }
);

const mobIndentBtn = createMobToolbarBtn(
  'indent',
  '<span class="qd-icon material-symbols-rounded">format_indent_increase</span>',
  'Indentar',
  () => {
    indentActiveBlock(1);
  }
);

const mobBtnType = createMobToolbarBtn(
  'change-type',
  '<span class="qd-icon material-symbols-rounded">interests</span><span class="mob-btn-label">Tipo</span>',
  'Trocar tipo de bloco',
  () => {
    toggleMobileTypeSheet();
  }
);

const mobBtnTemplates = createMobToolbarBtn(
  'templates',
  '<span class="qd-icon material-symbols-rounded">bookmark</span><span class="mob-btn-label">Modelos</span>',
  'Modelos de bloco',
  () => {
    toggleMobileTemplateSheet();
  }
);

const mobBtnSelect = createMobToolbarBtn(
  'select-blocks',
  '<span class="qd-icon material-symbols-rounded">checklist</span><span class="mob-btn-label">Selecionar</span>',
  'Selecionar blocos',
  () => {
    toggleBlockSelectMode();
  }
);

mobileBlockBar.append(
  mobBtnAdd,
  Object.assign(document.createElement('div'), { className: 'mob-sep' }),
  mobUndoBtn,
  mobRedoBtn,
  Object.assign(document.createElement('div'), { className: 'mob-sep' }),
  mobMoveUpBtn,
  mobMoveDownBtn,
  Object.assign(document.createElement('div'), { className: 'mob-sep' }),
  mobOutdentBtn,
  mobIndentBtn,
  Object.assign(document.createElement('div'), { className: 'mob-sep' }),
  mobBtnType,
  Object.assign(document.createElement('div'), { className: 'mob-sep' }),
  mobBtnTemplates,
  Object.assign(document.createElement('div'), { className: 'mob-sep' }),
  mobBtnSelect
);

// ── Botões do Estado 3: Seleção de Blocos (mobileSelectBar) ─────────────────
const mobSelectCount = document.createElement('span');
mobSelectCount.className = 'mob-select-count';
mobSelectCount.textContent = '1 bloco';

const mobBtnCopyText = createMobToolbarBtn(
  'sel-copy-text',
  '<span class="qd-icon material-symbols-rounded">content_copy</span><span class="mob-btn-label">Copiar</span>',
  'Copiar texto dos blocos',
  () => copySelectedBlocksAsText()
);

const mobBtnCopyImg = createMobToolbarBtn(
  'sel-copy-img',
  '<span class="qd-icon material-symbols-rounded">image</span><span class="mob-btn-label">Copiar img</span>',
  'Copiar blocos como imagem',
  () => copySelectedBlocksAsImage()
);

const mobBtnDownloadImg = createMobToolbarBtn(
  'sel-down-img',
  '<span class="qd-icon material-symbols-rounded">download</span><span class="mob-btn-label">Baixar img</span>',
  'Baixar blocos como imagem',
  () => downloadSelectedBlocksAsImage()
);

const mobBtnDownloadMd = createMobToolbarBtn(
  'sel-down-md',
  '<span class="qd-icon material-symbols-rounded">description</span><span class="mob-btn-label">.md</span>',
  'Baixar blocos como Markdown (.md)',
  () => downloadSelectedBlocksAsMd()
);

const mobBtnDownloadTxt = createMobToolbarBtn(
  'sel-down-txt',
  '<span class="qd-icon material-symbols-rounded">text_snippet</span><span class="mob-btn-label">.txt</span>',
  'Baixar blocos como Texto (.txt)',
  () => downloadSelectedBlocksAsTxt()
);

const mobBtnSaveTpl = createMobToolbarBtn(
  'sel-save-tpl',
  '<span class="qd-icon material-symbols-rounded">bookmark_add</span><span class="mob-btn-label">Modelo</span>',
  'Salvar blocos como modelo',
  () => saveSelectedBlocksAsTemplate()
);

const mobBtnDeleteBlocks = createMobToolbarBtn(
  'sel-delete',
  '<span class="qd-icon material-symbols-rounded">delete</span>',
  'Excluir blocos',
  () => deleteSelectedBlocks()
);
mobBtnDeleteBlocks.classList.add('mob-btn-danger');

const mobBtnCloseSelect = createMobToolbarBtn(
  'sel-done',
  '<span class="qd-icon material-symbols-rounded">check</span><span class="mob-btn-label">Concluir</span>',
  'Concluir seleção',
  () => exitBlockSelectMode()
);

mobileSelectBar.append(
  mobSelectCount,
  mobBtnCopyText,
  mobBtnCopyImg,
  mobBtnDownloadImg,
  mobBtnDownloadMd,
  mobBtnDownloadTxt,
  Object.assign(document.createElement('div'), { className: 'mob-sep' }),
  mobBtnSaveTpl,
  mobBtnDeleteBlocks,
  Object.assign(document.createElement('div'), { className: 'mob-sep' }),
  mobBtnCloseSelect
);

// ── Handlers das Ações de Bloco ─────────────────────────────────────────────
function moveActiveBlock(direction) {
  const block = currentBlock() || lastFocusedBlock;
  if (!block || !root.contains(block)) return;
  captureUndoPoint();
  if (direction === -1) {
    const prev = block.previousElementSibling;
    if (prev && prev.classList?.contains('block')) {
      prev.before(block);
      renumberLists();
      scheduleSave();
      block.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  } else if (direction === 1) {
    const next = block.nextElementSibling;
    if (next && next.classList?.contains('block')) {
      next.after(block);
      renumberLists();
      scheduleSave();
      block.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}

function indentActiveBlock(delta) {
  const block = currentBlock() || lastFocusedBlock;
  if (!block || !root.contains(block)) return;
  const antes = snapshotState();
  const alvos = targetBlocksFor(block);
  if (indentBlocks(alvos, delta)) {
    captureUndoPoint(antes);
    renumberLists();
    scheduleSave();
  }
}

function addBlockRelative(position) {
  const block = currentBlock() || lastFocusedBlock || root.lastElementChild;
  captureUndoPoint();
  const newBlock = createBlockEl('paragraph');
  if (position === 'above') {
    if (block) block.before(newBlock);
    else root.prepend(newBlock);
  } else {
    if (block) block.after(newBlock);
    else root.appendChild(newBlock);
  }
  renumberLists();
  focusBlockStart(newBlock);
  scheduleSave();
  lastFocusedBlock = newBlock;
}

// ── Ações de Seleção de Blocos ───────────────────────────────────────────────
function enterBlockSelectMode(initialBlock) {
  isBlockSelectActive = true;
  noteSection.classList.add('touch-selection-active');
  const target = initialBlock || currentBlock() || lastFocusedBlock || root.firstElementChild;
  if (target && target.dataset.id) {
    setBlockSelection([target.dataset.id]);
    lastHandleClickedId = target.dataset.id;
  } else {
    setBlockSelection([]);
  }
  updateMobileToolbarState();
  showFeedback('Modo seleção ativo · toque nos blocos para selecionar');
}

function exitBlockSelectMode() {
  isBlockSelectActive = false;
  noteSection.classList.remove('touch-selection-active');
  clearBlockSelection();
  updateMobileToolbarState();
}

function toggleBlockSelectMode() {
  if (isBlockSelectActive) {
    exitBlockSelectMode();
  } else {
    enterBlockSelectMode();
  }
}

async function copySelectedBlocksAsText() {
  const alvos = getSelectedBlockElements();
  if (alvos.length === 0) {
    showFeedback('Nenhum bloco selecionado');
    return;
  }
  const targets = alvos.map(serializeBlockEl);
  const text = blocksToPlainText(targets);
  await navigator.clipboard.writeText(text);
  showFeedback('Texto copiado!');
}

async function copySelectedBlocksAsImage() {
  const alvos = getSelectedBlockElements();
  if (alvos.length === 0) {
    showFeedback('Nenhum bloco selecionado');
    return;
  }
  showFeedback('Gerando imagem…');
  try {
    const ok = await copyBlocksAsImage(alvos);
    showFeedback(ok ? 'Imagem copiada!' : 'Erro ao copiar imagem');
  } catch (_) {
    showFeedback('Erro ao copiar imagem');
  }
}

async function downloadSelectedBlocksAsImage() {
  const alvos = getSelectedBlockElements();
  if (alvos.length === 0) {
    showFeedback('Nenhum bloco selecionado');
    return;
  }
  const nome = getSuggestedBlockFilename(alvos, 'nota');
  showFeedback('Gerando imagem…');
  try {
    const ok = await downloadBlocksAsImage(alvos, nome);
    showFeedback(ok ? 'Imagem baixada!' : 'Erro ao baixar imagem');
  } catch (_) {
    showFeedback('Erro ao baixar imagem');
  }
}

async function downloadSelectedBlocksAsMd() {
  const alvos = getSelectedBlockElements();
  if (alvos.length === 0) {
    showFeedback('Nenhum bloco selecionado');
    return;
  }
  const targets = alvos.map(serializeBlockEl);
  const text = await blocksToExportMarkdown(targets);
  const nome = getSuggestedBlockFilename(alvos, 'blocos');
  downloadTextFile(`${nome}.md`, text, 'text/markdown;charset=utf-8');
  showFeedback('Markdown baixado!');
}

function downloadSelectedBlocksAsTxt() {
  const alvos = getSelectedBlockElements();
  if (alvos.length === 0) {
    showFeedback('Nenhum bloco selecionado');
    return;
  }
  const targets = alvos.map(serializeBlockEl);
  const text = blocksToPlainText(targets);
  const nome = getSuggestedBlockFilename(alvos, 'blocos');
  downloadTextFile(`${nome}.txt`, text, 'text/plain;charset=utf-8');
  showFeedback('Texto baixado!');
}

function saveSelectedBlocksAsTemplate() {
  const alvos = getSelectedBlockElements();
  if (alvos.length === 0) {
    showFeedback('Nenhum bloco selecionado');
    return;
  }
  const targets = alvos.length > 1 ? alvos : targetBlocksFor(alvos[0]);
  const markdown = blocksToMarkdown(targets.map(serializeBlockEl));
  if (!markdown.trim()) {
    showFeedback('Nada para salvar');
    return;
  }
  openSaveBlockTemplate(mobBtnSaveTpl, markdown, nome => {
    showFeedback(`Modelo "${nome}" salvo`);
    renderMobileTemplateList();
  });
}

function deleteSelectedBlocks() {
  const alvos = getSelectedBlockElements();
  if (alvos.length === 0) return;
  captureUndoPoint();
  const prev = alvos[0].previousElementSibling;
  alvos.forEach(b => b.remove());
  if (root.children.length === 0) root.appendChild(createBlockEl('paragraph'));
  renumberLists();
  exitBlockSelectMode();
  const focusTarget = (prev && document.body.contains(prev)) ? prev : root.firstElementChild;
  if (focusTarget) {
    const c = getContentEl(focusTarget);
    c.focus();
    setCaretOffset(c, c.textContent.length);
  }
  scheduleSave();
}

// ── Toque Longo em Blocos no Mobile para Seleção ─────────────────────────────
let touchSelectTimer = null;
let touchSelectStart = null;

root.addEventListener('pointerdown', e => {
  const isMobile = typeof document !== 'undefined' && document.documentElement.dataset.platform === 'mobile';
  if (!isMobile) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;

  const targetBlock = e.target.closest('.block');
  if (!targetBlock || !root.contains(targetBlock)) return;

  if (e.target.closest('a, button, input, .block-checkbox, mark')) return;

  touchSelectStart = { x: e.clientX, y: e.clientY, block: targetBlock };
  clearTimeout(touchSelectTimer);

  touchSelectTimer = setTimeout(() => {
    if (!touchSelectStart) return;
    const blk = touchSelectStart.block;
    if (blk && root.contains(blk)) {
      if (navigator.vibrate) {
        try { navigator.vibrate(40); } catch (_) {}
      }
      enterBlockSelectMode(blk);
    }
    touchSelectStart = null;
  }, 450);
}, { passive: true });

root.addEventListener('pointermove', e => {
  if (!touchSelectStart) return;
  const dx = Math.abs(e.clientX - touchSelectStart.x);
  const dy = Math.abs(e.clientY - touchSelectStart.y);
  if (dx > 10 || dy > 10) {
    clearTimeout(touchSelectTimer);
    touchSelectStart = null;
  }
}, { passive: true });

root.addEventListener('pointerup', () => {
  clearTimeout(touchSelectTimer);
  touchSelectStart = null;
}, { passive: true });

root.addEventListener('pointercancel', () => {
  clearTimeout(touchSelectTimer);
  touchSelectStart = null;
}, { passive: true });

// Handlers do Popover Adicionar
mobileAddPopover.querySelectorAll('.mob-popover-item').forEach(btn => {
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const pos = btn.dataset.pos;
    addBlockRelative(pos);
    closeMobileAddPopover();
  });
});

// Handlers do Popover Cores
mobileColorPopover.querySelectorAll('.mob-color-dot').forEach(dot => {
  dot.addEventListener('mousedown', e => e.preventDefault());
  dot.addEventListener('click', e => {
    e.stopPropagation();
    const color = dot.dataset.color;
    if (color === 'transparent') {
      document.execCommand('removeFormat', false, null);
    } else {
      document.execCommand('hiliteColor', false, color);
    }
    closeMobileColorPopover();
    scheduleSave();
  });
});

// Handlers do Painel Formatar Texto
mobileTextFormatSheet.querySelectorAll('.mob-tf-btn').forEach(btn => {
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'upper') applyTransformToSelection(s => s.toUpperCase());
    else if (act === 'lower') applyTransformToSelection(s => s.toLowerCase());
    else if (act === 'title') applyTransformToSelection(ttTitleCase);
    else if (act === 'sentence') applyTransformToSelection(ttSentenceCase);
    else if (act === 'para') applyTransformToSelection(ttParaCase);
    else if (act === 'invert') applyTransformToSelection(ttInvertCase);
    else if (act === 'no-accents') applyTransformToSelection(ttNoAccents);
    else if (act === 'clean-spaces') applyTransformToSelection(ttCleanSpaces);
    closeMobileTextFormatSheet();
  });
});

mobileTextFormatSheet.querySelector('#mob-tf-close')?.addEventListener('click', e => {
  e.stopPropagation();
  closeMobileTextFormatSheet();
});

mobileTypeSheet.querySelector('#mob-type-close')?.addEventListener('click', e => {
  e.stopPropagation();
  closeMobileTypeSheet();
});

function closeMobileAddPopover() {
  mobileAddPopover.hidden = true;
}
function toggleMobileAddPopover() {
  mobileAddPopover.hidden = !mobileAddPopover.hidden;
  if (!mobileAddPopover.hidden) {
    closeMobileTypeSheet();
    closeMobileTemplateSheet();
    closeMobileTextFormatSheet();
    closeMobileColorPopover();
  }
}

function closeMobileTextFormatSheet() {
  mobileTextFormatSheet.hidden = true;
}
function toggleMobileTextFormatSheet() {
  mobileTextFormatSheet.hidden = !mobileTextFormatSheet.hidden;
  if (!mobileTextFormatSheet.hidden) {
    closeMobileColorPopover();
  }
}

function closeMobileColorPopover() {
  mobileColorPopover.hidden = true;
}
function toggleMobileColorPopover() {
  mobileColorPopover.hidden = !mobileColorPopover.hidden;
  if (!mobileColorPopover.hidden) {
    closeMobileTextFormatSheet();
  }
}

function closeMobileTypeSheet() {
  mobileTypeSheet.hidden = true;
}
function toggleMobileTypeSheet() {
  if (mobileTypeSheet.hidden) {
    const block = currentBlock();
    if (block) lastFocusedBlock = block;
    mobileTypeSheet.hidden = false;
    closeMobileAddPopover();
    closeMobileTemplateSheet();
    closeMobileTextFormatSheet();
    closeMobileColorPopover();
  } else {
    mobileTypeSheet.hidden = true;
  }
}

// Fecha popovers ao tocar fora
document.addEventListener('pointerdown', e => {
  if (typeof document === 'undefined') return;
  if (!mobileAddPopover.hidden && !mobileAddPopover.contains(e.target) && !mobBtnAdd.contains(e.target)) {
    closeMobileAddPopover();
  }
  if (!mobileTextFormatSheet.hidden && !mobileTextFormatSheet.contains(e.target) && !mobBtnTextFormat.contains(e.target)) {
    closeMobileTextFormatSheet();
  }
  if (!mobileColorPopover.hidden && !mobileColorPopover.contains(e.target) && !mobBtnColor.contains(e.target)) {
    closeMobileColorPopover();
  }
  if (!mobileTypeSheet.hidden && !mobileTypeSheet.contains(e.target) && !mobBtnType.contains(e.target)) {
    closeMobileTypeSheet();
  }
  if (!mobileTemplateSheet.hidden && !mobileTemplateSheet.contains(e.target) && !mobBtnTemplates.contains(e.target)) {
    closeMobileTemplateSheet();
  }
});

// Atualiza o estado da barra contextual (Texto Selecionado vs Ações de Bloco vs Seleção de Blocos)
function updateMobileToolbarState() {
  if (typeof document === 'undefined') return;

  if (selectedBlockIds.size > 0 || isBlockSelectActive) {
    mobileBlockBar.hidden = true;
    mobileBlockBar.style.display = 'none';
    mobileFormatBar.hidden = true;
    mobileFormatBar.style.display = 'none';
    mobileSelectBar.hidden = false;
    mobileSelectBar.style.display = 'flex';

    closeMobileAddPopover();
    closeMobileTypeSheet();
    closeMobileTemplateSheet();
    closeMobileTextFormatSheet();
    closeMobileColorPopover();

    const count = selectedBlockIds.size;
    mobSelectCount.textContent = count === 1 ? '1 bloco' : `${count} blocos`;
    return;
  }

  mobileSelectBar.hidden = true;
  mobileSelectBar.style.display = 'none';

  const sel = document.getSelection();
  const hasSelection = sel && !sel.isCollapsed && sel.rangeCount > 0 && root.contains(sel.anchorNode);

  if (hasSelection) {
    mobileBlockBar.hidden = true;
    mobileBlockBar.style.display = 'none';
    mobileFormatBar.hidden = false;
    mobileFormatBar.style.display = 'flex';
    closeMobileAddPopover();
    closeMobileTypeSheet();
    closeMobileTemplateSheet();
  } else {
    mobileFormatBar.hidden = true;
    mobileFormatBar.style.display = 'none';
    mobileBlockBar.hidden = false;
    mobileBlockBar.style.display = 'flex';
    closeMobileTextFormatSheet();
    closeMobileColorPopover();

    const blk = currentBlock();
    if (blk) lastFocusedBlock = blk;

    mobUndoBtn.disabled = undoStack.length === 0;
    mobRedoBtn.disabled = redoStack.length === 0;
  }
}

document.addEventListener('selectionchange', updateMobileToolbarState);

root.addEventListener('scroll', () => {
  closeMobileAddPopover();
  closeMobileTextFormatSheet();
  closeMobileColorPopover();
  closeMobileTypeSheet();
  closeMobileTemplateSheet();
}, { passive: true });

// Monta os elementos no DOM
mobileNotionToolbar.append(
  mobileAddPopover,
  mobileColorPopover,
  mobileTextFormatSheet,
  mobileFormatBar,
  mobileBlockBar,
  mobileSelectBar
);
noteSection.appendChild(mobileNotionToolbar);
document.body.appendChild(mobileTypeSheet);
document.body.appendChild(mobileTemplateSheet);
updateMobileToolbarState();

// ── Sincronização do Teclado Virtual (Notion Mobile Toolbar & VisualViewport) ──
function syncVisualViewport() {
  if (typeof window === 'undefined' || !window.visualViewport) return;
  const isMobile = typeof document !== 'undefined' && document.documentElement.dataset.platform === 'mobile';
  const app = document.getElementById('app');
  const vv = window.visualViewport;

  if (!isMobile) {
    if (app) {
      app.style.height = '';
      app.style.transform = '';
    }
    document.documentElement.style.removeProperty('--vv-height');
    document.documentElement.style.removeProperty('--keyboard-offset');
    return;
  }

  const vvHeight = vv.height;
  const keyboardOffset = Math.max(0, window.innerHeight - vv.height - (vv.offsetTop || 0));

  document.documentElement.style.setProperty('--vv-height', `${vvHeight}px`);
  document.documentElement.style.setProperty('--keyboard-offset', `${keyboardOffset}px`);

  if (app) {
    app.style.height = `${vvHeight}px`;
    app.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
  }

  // Quando o teclado sobe, garante que o bloco em edição continue visível acima da barra
  if (document.activeElement && root && root.contains(document.activeElement)) {
    const blk = currentBlock() || lastFocusedBlock;
    if (blk) {
      requestAnimationFrame(() => {
        blk.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }
}

if (typeof window !== 'undefined' && window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncVisualViewport);
  window.visualViewport.addEventListener('scroll', syncVisualViewport);
  window.addEventListener('resize', syncVisualViewport);
  window.addEventListener('orientationchange', syncVisualViewport);
}

// Ao tocar no editor no mobile, se documentos estiver aberto, recolhe-o suavemente
root.addEventListener('pointerdown', () => {
  const isMobile = typeof document !== 'undefined' && document.documentElement.dataset.platform === 'mobile';
  if (isMobile) {
    const docsSec = document.querySelector('.docs-section');
    if (docsSec && !docsSec.classList.contains('is-collapsed')) {
      setDocsCollapsed(true);
    }
  }
});

root.addEventListener('focusin', () => {
  syncVisualViewport();
  updateMobileToolbarState();
});

root.addEventListener('focusout', () => {
  setTimeout(syncVisualViewport, 120);
});

syncVisualViewport();

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

// ── Controles de bloco ao passar o mouse (＋ / ⠿) ─────────────────────────────
// Overlay único e flutuante (não embrulha cada bloco) que acompanha o mouse
// e se posiciona à esquerda do bloco sob o cursor. Fica FORA do editável
// (`root`), como irmão dele dentro de `.note-editor` — assim não interfere
// com o `root.children` que o resto do código assume ser só blocos.
const blockControls = document.createElement('div');
blockControls.className = 'block-controls';
blockControls.hidden = true;

const blockAddBtn = document.createElement('button');
blockAddBtn.className = 'block-add-btn';
blockAddBtn.innerHTML = iconSvg('add');
blockAddBtn.title = 'Adicionar bloco abaixo (Ctrl+clique: acima)';
blockAddBtn.setAttribute('aria-label', 'Adicionar bloco');

const blockHandleBtn = document.createElement('button');
blockHandleBtn.className = 'block-handle-btn';
blockHandleBtn.innerHTML = iconSvg('drag_indicator');
blockHandleBtn.title = 'Clique: opções do bloco · Arrastar: mover · Ctrl+arrastar (em qualquer lugar do bloco): selecionar vários';
blockHandleBtn.setAttribute('aria-label', 'Opções e movimentação do bloco');

blockControls.append(blockAddBtn, blockHandleBtn);
noteEditorEl.appendChild(blockControls);

let hoveredBlock = null;

function positionBlockControls(block) {
  if (typeof document !== 'undefined' && document?.documentElement?.dataset?.platform === 'mobile') {
    blockControls.hidden = true;
    return;
  }
  hoveredBlock = block;

  const blockRect     = block.getBoundingClientRect();
  const containerRect = noteEditorEl.getBoundingClientRect();
  const viewRect      = root.getBoundingClientRect();   // área visível do editor (ele rola)

  // Bloco rolou pra fora da vista: esconde, em vez de deixar os ícones
  // encostados na borda apontando pra nada.
  if (blockRect.bottom < viewRect.top || blockRect.top > viewRect.bottom) {
    blockControls.hidden = true;
    return;
  }

  blockControls.hidden = false;   // precisa estar visível pra poder ser medido

  // Horizontal: os ícones acompanham a indentação do bloco. Com um `left`
  // fixo, um item aninhado ganhava ícones lá na margem esquerda, longe do
  // bloco a que se referem — e dois blocos de níveis diferentes ficavam
  // indistinguíveis, já que a escolha do bloco é só pela altura do cursor.
  const largura = blockControls.offsetWidth || 31;
  const left = Math.max(0, blockRect.left - containerRect.left - largura + 1);

  // Vertical: alinhado com a primeira linha do bloco, mas preso dentro da
  // área visível. Um bloco alto (imagem) costuma ter o topo fora da tela, e
  // sem o limite os ícones subiam por cima da barra de abas.
  const topoVisivel = viewRect.top - containerRect.top;
  const baseVisivel = viewRect.bottom - containerRect.top - blockControls.offsetHeight;
  const top = Math.min(
    Math.max(blockRect.top - containerRect.top, topoVisivel),
    Math.max(topoVisivel, baseVisivel),
  );

  blockControls.style.left = `${left}px`;
  blockControls.style.top  = `${top}px`;
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
  if (!target) return;
  // O "&& !hidden" importa: os controles podem ter sido escondidos por outro
  // caminho (rolagem levou o bloco pra fora da vista) sem que o bloco sob o
  // cursor tenha mudado. Sem isso, eles não voltavam mais.
  if (target === hoveredBlock && !blockControls.hidden) return;
  positionBlockControls(target);
});

// No container que engloba texto + controles (não só o texto) — senão mover
// o mouse do bloco até os botões já contava como "saiu" e escondia tudo
// antes de dar tempo de clicar.
noteEditorEl.addEventListener('mouseleave', () => {
  if (!blockMenuEl) hideBlockControls();
});

// Rolar sem mover o mouse: reposiciona em vez de esconder. Escondendo, os
// ícones só voltavam quando o cursor passasse por OUTRO bloco (o mousemove
// sai cedo quando o alvo é o mesmo de antes) — então rolar por cima de um
// bloco alto fazia os controles sumirem e não voltarem mais.
root.addEventListener('scroll', () => {
  if (hoveredBlock && root.contains(hoveredBlock)) positionBlockControls(hoveredBlock);
  else blockControls.hidden = true;
}, { passive: true });

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

  if (window.innerWidth < 768) {
    slashItems = slashItemsWithTemplates();
    slashBlock = newBlock;
    slashIndex = 0;
    renderSlashMenu(newBlock);
  }
});

// (A lógica principal de seleção de blocos foi inicializada acima, junto com as barras de atalhos)

document.addEventListener('mousedown', e => {
  if (selectedBlockIds.size === 0) return;
  if (blockMenuEl && blockMenuEl.contains(e.target)) return;
  if (typeof mobileNotionToolbar !== 'undefined' && mobileNotionToolbar.contains(e.target)) return;
  if (typeof mobileTemplateSheet !== 'undefined' && mobileTemplateSheet.contains(e.target)) return;
  if (typeof mobileTypeSheet !== 'undefined' && mobileTypeSheet.contains(e.target)) return;
  if (isBlockSelectActive && root.contains(e.target)) return;
  // .contains(), não === : o alvo real do clique é o <span> do ícone dentro
  // do botão, nunca o próprio <button>. Com === isso nunca batia, e clicar na
  // alça sempre limpava o grupo antes de handleHandleClick chegar a lê-lo.
  if (blockHandleBtn.contains(e.target) || blockAddBtn.contains(e.target)) return;
  clearBlockSelection();
});

let blockMenuEl = null;
let blockMenuBackdropEl = null;
function closeBlockMenuBackdrop() {
  blockMenuBackdropEl?.remove();
  blockMenuBackdropEl = null;
}

function closeBlockMenu() {
  closeBlockMenuBackdrop();
  blockMenuEl?.remove();
  blockMenuEl = null;
}

function getTransformTypes() {
  return SLASH_ITEMS.filter(it => !INSERTED_TYPES.has(it.type));
}

function openBlockMenu(block, anchorEl) {
  closeBlockMenu();
  const menu = document.createElement('div');
  menu.className = 'copy-menu block-menu';

  const isMobile = document.documentElement.dataset.platform === 'mobile';
  if (isMobile) {
    menu.classList.add('is-bottom-sheet');
    blockMenuBackdropEl = document.createElement('div');
    blockMenuBackdropEl.className = 'bottom-sheet-backdrop';
    blockMenuBackdropEl.addEventListener('click', closeBlockMenu);
    document.body.appendChild(blockMenuBackdropEl);

    const pill = document.createElement('div');
    pill.className = 'bottom-sheet-drag-pill';
    const head = document.createElement('div');
    head.className = 'bottom-sheet-header';
    head.innerHTML = `<span class="bottom-sheet-title">Opções do bloco</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'icon-btn bottom-sheet-close';
    closeBtn.innerHTML = '✕';
    closeBtn.title = 'Fechar';
    closeBtn.setAttribute('aria-label', 'Fechar opções do bloco');
    closeBtn.addEventListener('click', closeBlockMenu);
    head.appendChild(closeBtn);
    menu.prepend(pill, head);
  }

  const scopeCount = (selectedBlockIds.size > 1 && selectedBlockIds.has(block.dataset.id))
    ? selectedBlockIds.size : 1;

  // ── Barra de ações rápidas, presa no topo ────────────────────────────────
  // O que se faz o tempo todo vira ícone e fica sempre à vista, mesmo quando a
  // lista de "Transformar em" está rolando por baixo. O resto continua escrito
  // por extenso na lista — ícone sozinho só funciona pro que é óbvio.
  const barra = document.createElement('div');
  barra.className = 'block-menu-quickbar';

  const acaoRapida = (icone, titulo, run, extra = '') => {
    const btn = document.createElement('button');
    btn.className = `block-menu-quick ${extra}`.trim();
    btn.title = scopeCount > 1 ? `${titulo} (${scopeCount} blocos)` : titulo;
    btn.innerHTML = iconSvg(icone);
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', e => { e.stopPropagation(); closeBlockMenu(); run(); });
    barra.appendChild(btn);
  };

  acaoRapida('content_copy', 'Copiar como texto', () => copyBlocksAs(block, 'text'));
  acaoRapida('image',        'Copiar imagem',     () => printBlocks(block, 'clipboard'));
  acaoRapida('library_add',  'Duplicar',          () => duplicateBlocks(block));
  acaoRapida('delete',       'Excluir',           () => deleteBlocksOrOne(block), 'is-danger');

  menu.appendChild(barra);

  // Divisor não tem conteúdo e tabela não tem um conteúdo único — converter
  // qualquer um dos dois em título/lista não teria o que preservar (e, no caso
  // da tabela, despejaria o HTML dela inteiro dentro de um parágrafo).
  const canTransform = !INSERTED_TYPES.has(block.dataset.type);

  if (canTransform) {
    const header = document.createElement('div');
    header.className   = 'copy-menu-header';
    header.textContent = scopeCount > 1 ? `Transformar em (${scopeCount} blocos)` : 'Transformar em';
    menu.appendChild(header);

    // A mesma grade do menu "/": é a mesma lista, e tinha o mesmo problema de
    // virar uma coluna comprida demais pra achar qualquer coisa nela.
    const tipos = getTransformTypes();
    menu.appendChild(buildTypeGrid(tipos, i => {
      closeBlockMenu();
      transformBlocks(block, tipos[i].type);
    }));

    menu.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));
  }

  // Sublinhado só existe pra título 1 e 2 — é o que o markdown alcança com o
  // traço embaixo. Interruptor contextual em vez de dois tipos novos no menu.
  if (PODE_SUBLINHAR.has(block.dataset.type)) {
    const sublinhado = isBlockUnderlined(block);
    const btn = document.createElement('button');
    btn.className = 'copy-opt';
    btn.innerHTML = `<span class="copy-opt-value">${sublinhado ? 'Tirar sublinhado' : 'Sublinhar título'}</span><span class="copy-opt-hint">${sublinhado ? '#' : '==='}</span>`;
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', e => {
      e.stopPropagation();
      closeBlockMenu();
      captureUndoPoint();
      for (const b of targetBlocksFor(block)) setBlockUnderlined(b, !sublinhado);
      scheduleSave();
    });
    menu.appendChild(btn);

    menu.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));
  }

  // Modelos de bloco: mesma lista do menu "/", aqui pra quem prefere a alça.
  const tpls = blockTemplates();
  if (tpls.length > 0) {
    const tplHead = document.createElement('div');
    tplHead.className = 'copy-menu-header';
    tplHead.textContent = 'Inserir modelo';
    menu.appendChild(tplHead);

    for (const tpl of tpls) {
      const btn = document.createElement('button');
      btn.className = 'copy-opt';
      const span = document.createElement('span');
      span.className = 'copy-opt-value';
      span.textContent = tpl.name;
      btn.appendChild(span);
      btn.addEventListener('mousedown', e => e.stopPropagation());
      btn.addEventListener('click', () => {
        closeBlockMenu();
        captureUndoPoint();
        insertTemplateBlocks(tpl.content, block);
      });
      menu.appendChild(btn);
    }

    menu.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));
  }

  const saveTplBtn = document.createElement('button');
  saveTplBtn.className = 'copy-opt';
  saveTplBtn.innerHTML = `<span class="copy-opt-value">Salvar como modelo de bloco${scopeCount > 1 ? ` (${scopeCount})` : ''}</span>`;
  saveTplBtn.addEventListener('mousedown', e => e.stopPropagation());
  saveTplBtn.addEventListener('click', () => {
    closeBlockMenu();
    const markdown = blocksToMarkdown(targetBlocksFor(block).map(serializeBlockEl));
    if (!markdown.trim()) { showFeedback('Nada para salvar'); return; }
    openSaveBlockTemplate(anchorEl, markdown, nome => showFeedback(`modelo "${nome}" salvo`));
  });
  menu.appendChild(saveTplBtn);

  const copyMdBtn = document.createElement('button');
  copyMdBtn.className = 'copy-opt';
  copyMdBtn.innerHTML = `<span class="copy-opt-value">Copiar como Markdown${scopeCount > 1 ? ` (${scopeCount})` : ''}</span>`;
  copyMdBtn.addEventListener('mousedown', e => e.stopPropagation());
  copyMdBtn.addEventListener('click', () => { closeBlockMenu(); copyBlocksAs(block, 'markdown'); });
  menu.appendChild(copyMdBtn);

  // "Copiar como texto" e "Copiar imagem" moraram aqui e subiram pra barra de
  // ícones do topo — são as duas mais usadas. O que fica na lista é o que
  // precisa do nome por extenso pra não virar adivinhação.
  const saveImgBtn = document.createElement('button');
  saveImgBtn.className = 'copy-opt';
  saveImgBtn.innerHTML = `<span class="copy-opt-value">Baixar imagem (.png)${scopeCount > 1 ? ` (${scopeCount})` : ''}</span>`;
  saveImgBtn.addEventListener('mousedown', e => e.stopPropagation());
  saveImgBtn.addEventListener('click', () => { closeBlockMenu(); printBlocks(block, 'download'); });
  menu.appendChild(saveImgBtn);

  // Duplicar e Excluir também subiram pra barra de ícones.

  document.body.appendChild(menu);
  blockMenuEl = menu;
  if (!isMobile) {
    positionMenu(menu, anchorEl.getBoundingClientRect());
  }
}

// Copia o(s) bloco(s)-alvo (o clicado, ou toda a seleção múltipla se ele
// fizer parte de uma) como Markdown de verdade ou como texto simples —
// mesma dupla de formatos que já existe pra nota inteira no menu "⋯" da aba.
// Print dos blocos. A seleção é desfeita antes de desenhar: o realce azul é
// estado da edição, não conteúdo da nota, e ninguém quer mandar um print com
// ele. (O snapshot.js também tira, por garantia — aqui é pra que a tela
// acompanhe o que saiu na imagem.)
async function printBlocks(block, destino) {
  const alvos = targetBlocksFor(block);
  if (alvos.length === 0) return;

  clearBlockSelection();
  hideBlockControls();
  closeCopyMenu();

  // Nome do arquivo: o primeiro texto que aparecer no print. É o que a pessoa
  // reconhece na pasta de downloads — "nota.png" não diz nada.
  const nome = alvos
    .filter(b => !NO_TEXT_TYPES.has(b.dataset.type))
    .map(b => getContentEl(b).textContent.trim())
    .find(Boolean) ?? 'nota';

  showFeedback('gerando imagem…');
  try {
    const ok = destino === 'clipboard'
      ? await copyBlocksAsImage(alvos)
      : await downloadBlocksAsImage(alvos, nome);
    showFeedback(ok
      ? (destino === 'clipboard' ? 'imagem copiada!' : 'imagem baixada!')
      : 'não deu pra gerar a imagem');
  } catch {
    // Copiar imagem depende de permissão da área de transferência, que o
    // navegador só concede com o painel em foco. Baixar sempre funciona.
    showFeedback(destino === 'clipboard'
      ? 'não deu pra copiar — tente "Baixar imagem"'
      : 'não deu pra gerar a imagem');
  }
}

async function copyBlocksAs(block, format) {
  const targets = targetBlocksFor(block).map(serializeBlockEl);
  // Markdown sai pra fora da extensão, então a imagem vai embutida — colar num
  // editor de markdown qualquer tem que mostrar a imagem, não uma referência
  // interna que só o QuickDock entende.
  const text = format === 'markdown'
    ? await blocksToExportMarkdown(targets)
    : blocksToPlainText(targets);
  await navigator.clipboard.writeText(text);
  showFeedback('copiado!');
}

function transformBlocks(block, type) {
  // Divisor e tabela nunca entram como origem de conversão, mesmo dentro de
  // uma seleção múltipla — não têm conteúdo de linha pra preservar.
  const targets = targetBlocksFor(block).filter(b => !INSERTED_TYPES.has(b.dataset.type));
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
    // Passa pela serialização em vez de copiar innerHTML na mão: é o que faz
    // duplicar uma tabela duplicar as células, e não devolver uma tabela vazia.
    const clone = createBlockElFrom({ ...serializeBlockEl(b), id: null });
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

    // O bloco que contém o cursor ganha na hora. A conta antiga era pela
    // distância até o MEIO do bloco, e o meio de uma imagem de 200px fica a
    // 100px do topo dela — resultado: passar o mouse na metade de cima de uma
    // imagem trazia os controles do parágrafo de cima, que está mais perto do
    // próprio meio. Com blocos de uma linha só isso nunca aparecia.
    if (y >= rect.top && y <= rect.bottom) return b;

    // Fora de qualquer bloco (a margem esquerda, ou acima/abaixo de tudo):
    // vale a distância até a BORDA mais próxima, não até o meio — de novo,
    // pelo mesmo motivo.
    const dist = y < rect.top ? rect.top - y : y - rect.bottom;
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
  selecaoEspelhada = false;          // esta veio do Ctrl, não de seleção de texto
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

// ── Toque na alça de bloco (dedo / pointer: coarse) ──────────────────────────
// Diferencia toque rápido (abre menu / seleciona) de toque longo (~350ms) para
// arrastar e reordenar blocos sem brigar com a rolagem natural da página.
let touchDragTimer = null;
let touchDragState = null; // { block, startX, startY, moved, dragging }

blockHandleBtn.addEventListener('touchstart', e => {
  if (!hoveredBlock) return;
  const touch = e.touches[0];
  const block = hoveredBlock;
  touchDragState = {
    block,
    startX: touch.clientX,
    startY: touch.clientY,
    moved: false,
    dragging: false,
  };

  clearTimeout(touchDragTimer);
  touchDragTimer = setTimeout(() => {
    if (!touchDragState) return;
    touchDragState.dragging = true;
    hideBlockControls();
    if (touchSelectionActive) {
      startRangeSelectDrag(block);
    } else {
      startBlockReorderDrag(block);
    }
    if (navigator.vibrate) {
      try { navigator.vibrate(40); } catch (_) {}
    }
  }, 350);
}, { passive: true });

blockHandleBtn.addEventListener('touchmove', e => {
  if (!touchDragState) return;
  const touch = e.touches[0];
  const dx = Math.abs(touch.clientX - touchDragState.startX);
  const dy = Math.abs(touch.clientY - touchDragState.startY);

  // Se moveu mais de 8px antes dos 350ms, o usuário estava rolando a página: cancela
  if (!touchDragState.dragging) {
    if (dx > 8 || dy > 8) {
      clearTimeout(touchDragTimer);
      touchDragState = null;
    }
    return;
  }

  // Toque longo confirmado: arrasto ativo, previne rolagem nativa
  e.preventDefault();
  if (touchSelectionActive) {
    updateRangeSelectDrag(touch);
  } else {
    updateBlockReorderDrag(touch);
  }
}, { passive: false });

function finishTouchDrag() {
  clearTimeout(touchDragTimer);
  if (!touchDragState) return;
  if (touchDragState.dragging) {
    if (touchSelectionActive) finishRangeSelectDrag();
    else finishBlockReorderDrag();
  } else {
    // Toque rápido (soltou antes dos 350ms sem mover): abre o menu ou seleciona
    handleHandleClick(touchDragState.block, touchSelectionActive);
  }
  touchDragState = null;
}

blockHandleBtn.addEventListener('touchend', finishTouchDrag);
blockHandleBtn.addEventListener('touchcancel', () => {
  clearTimeout(touchDragTimer);
  if (touchDragState?.dragging) {
    if (touchSelectionActive) finishRangeSelectDrag();
    else finishBlockReorderDrag();
  }
  touchDragState = null;
});

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

// ── Selecionar um grupo de blocos sem tecla nenhuma ───────────────────────────
// Arrastar o texto por cima de mais de um bloco já quer dizer "é este grupo".
// Aqui essa seleção de texto passa a valer também como seleção de blocos — e é
// ela que a alça de arrastar consulta pra mover o grupo inteiro. Então mover
// vários blocos vira: selecionar por cima e arrastar pela alça de qualquer um
// deles, sem Ctrl, Shift nem Alt.
//
// Mover o grupo já funcionava; o que faltava era poder formar o grupo sem
// tecla. O Ctrl+arrastar continua existindo — ele é o único jeito de agarrar
// um bloco que não tem texto pra arrastar por cima, como uma imagem sozinha.
//
// A seleção de texto não é desfeita de propósito: é dela que a barra de
// formatação e o "Transformar em" tiram o alcance da ação.
document.addEventListener('selectionchange', () => {
  // Gesto de arrastar em andamento tem dono — não mexe na seleção no meio dele.
  if (pointerDown || ctrlPointerDown || reorderState) return;

  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  if (!root.contains(sel.getRangeAt(0).commonAncestorContainer)) return;

  const blocos = sel.isCollapsed ? [] : getSelectedBlocks();

  if (blocos.length > 1) {
    const ids = blocos.map(b => b.dataset.id);
    // selectionchange dispara a cada pixel do arraste; só repinta se mudou.
    const mudou = ids.length !== selectedBlockIds.size || ids.some(id => !selectedBlockIds.has(id));
    if (mudou) setBlockSelection(ids);
    selecaoEspelhada = true;
    return;
  }

  // Voltou a ser um bloco só (ou um cursor): o grupo deixa de existir. Uma
  // seleção feita com Ctrl+arrastar não é espelhada e não se desfaz aqui —
  // ela tem os próprios caminhos de saída (Esc, clique fora).
  if (selecaoEspelhada) clearBlockSelection();
});

// ── Controles de bloco sem hover (toque e foco no celular) ───────────────────
// Em telas de toque (:hover não existe), posiciona os controles (+ / ⠿) ao tocar
// ou focar em um bloco qualquer, tornando as ações alcançáveis no celular.
root.addEventListener('focusin', e => {
  const block = e.target.closest('.block');
  if (block && root.contains(block)) {
    positionBlockControls(block);
  }
});

root.addEventListener('touchstart', e => {
  const block = e.target.closest('.block');
  if (block && root.contains(block)) {
    positionBlockControls(block);
  }
}, { passive: true });

// ── Teclado virtual: rolar para manter o cursor visível ao digitar ───────────
function scrollCursorIntoView() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  let rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    const el = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;
    if (el) rect = el.getBoundingClientRect();
  }
  if (!rect || (rect.top === 0 && rect.bottom === 0)) return;

  const vpBottom = window.visualViewport
    ? window.visualViewport.offsetTop + window.visualViewport.height
    : window.innerHeight;

  const margin = 50;
  if (rect.bottom > vpBottom - margin) {
    const diff = rect.bottom - (vpBottom - margin);
    root.scrollTop += diff;
  }
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', scrollCursorIntoView);
}
root.addEventListener('input', scrollCursorIntoView);

