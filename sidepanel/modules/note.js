import { getNoteById, updateNoteContentById } from './storage.js';
import { tryParseMath } from './math-parser.js';

const noteSection = document.querySelector('.note-section');
const textarea    = document.getElementById('note-textarea');
const highlight   = document.getElementById('note-highlight');
const indicator   = document.getElementById('save-indicator');

let debounceTimer   = null;
let indicatorTimer  = null;
let isCtrlHeld      = false;
let activeMenu      = null;
let currentNoteId   = null; // nota atualmente carregada no editor
const mathCache    = new Map(); // expr raw → resultado parseado

// ── Utilitários de data ───────────────────────────────────────────────────────
function parseDate(raw) {
  const s = raw.trim();
  let day, month, year;

  if (/^\d{8}$/.test(s)) {
    // YYYYMMDD
    year = +s.slice(0, 4); month = +s.slice(4, 6); day = +s.slice(6, 8);
  } else if (/^\d{4}[-\/]\d{2}[-\/]\d{2}$/.test(s)) {
    // YYYY-MM-DD ou YYYY/MM/DD
    [year, month, day] = s.split(/[-\/]/).map(Number);
  } else if (/^\d{2}[\/\-\. ]\d{2}[\/\-\. ]\d{4}$/.test(s)) {
    // DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, DD MM YYYY
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

// ── Separador "ate/até" (aceita com ou sem acento) ───────────────────────────
const ATE_RE = /[ \t]+at[eé][ \t]+/i;

// ── Intervalo de datas ────────────────────────────────────────────────────────
function parseDateRange(raw) {
  const parts = raw.split(ATE_RE);
  if (parts.length !== 2) return null;
  const d1 = parseDate(parts[0].trim());
  const d2 = parseDate(parts[1].trim());
  if (!d1 || !d2) return null;
  const days = Math.round((d2 - d1) / 86400000);
  return { d1, d2, days };
}

// ── Intervalo de horas ────────────────────────────────────────────────────────
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

// ── Intervalo de data+hora ────────────────────────────────────────────────────
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

// Formata diferença em segundos como "X dias Xh Xmin"
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

// ── Formatadores ──────────────────────────────────────────────────────────────
function onlyDigits(str) { return str.replace(/\D/g, ''); }

function maskCPF(n)   { return `${n.slice(0,3)}.${n.slice(3,6)}.${n.slice(6,9)}-${n.slice(9)}`; }
function maskCNPJ(n)  { return `${n.slice(0,2)}.${n.slice(2,5)}.${n.slice(5,8)}/${n.slice(8,12)}-${n.slice(12)}`; }

// ── Validação de CPF ──────────────────────────────────────────────────────────
function validateCPF(raw) {
  const n = raw.replace(/\D/g, '');
  if (n.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(n)) return false; // todos dígitos iguais
  const d = n.split('').map(Number);
  const dig = (len, base) => {
    const r = d.slice(0, len).reduce((s, v, i) => s + v * (base - i), 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dig(9, 10) === d[9] && dig(10, 11) === d[10];
}

// ── Validação de CNPJ (formato numérico atual + novo alfanumérico IN RFB 2229/2024) ──
// Conversão de caracteres: código ASCII − 48  →  '0'=0 … '9'=9, 'A'=17 … 'Z'=42
// Pesos 1º DV: [5,4,3,2,9,8,7,6,5,4,3,2]  |  Pesos 2º DV: [6,5,4,3,2,9,8,7,6,5,4,3,2]
function validateCNPJ(raw) {
  const n = raw.replace(/[.\-\/]/g, '').toUpperCase();
  if (n.length !== 14) return false;
  if (/^(.)\1{13}$/.test(n)) return false;          // todos caracteres iguais
  if (!/^[A-Z0-9]{12}\d{2}$/.test(n)) return false; // últimas 2 posições devem ser dígitos
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

// ── Opções de cópia por tipo ──────────────────────────────────────────────────
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
      // strip mask only (pode conter letras no novo formato alfanumérico)
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
      const { d1, d2, days, raw1, raw2 } = range;
      const abs = Math.abs(days);
      const inv = days < 0 ? ' (invertido)' : '';

      const opts = [];

      // Dias totais
      const dStr = `${abs} ${abs === 1 ? 'dia' : 'dias'}${inv}`;
      opts.push({ label: dStr, hint: 'total em dias', value: dStr });

      // Semanas + dias
      if (abs >= 7) {
        const w = Math.floor(abs / 7), rd = abs % 7;
        const wStr = `${w} ${w === 1 ? 'semana' : 'semanas'}${rd ? ` e ${rd} ${rd === 1 ? 'dia' : 'dias'}` : ''}${inv}`;
        opts.push({ label: wStr, hint: 'em semanas', value: wStr });
      }

      // Meses do calendário + dias restantes
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

      // Anos + meses
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

      // Período completo como texto
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

// ── Padrões de Markdown (formatação visual, não são dados clicáveis) ──────────
// Itálico exige que não haja espaço colado no asterisco (regra do CommonMark) —
// evita colidir com "*" usado como multiplicação em expressões matemáticas
// (ex.: "2 * 3 * 4" não deve virar itálico).
const MD_DETECTORS = [
  { type: 'md-code',    re: /`([^`\n]+?)`/g,                                   parts: () => ({ open: '`',  close: '`'  }) },
  { type: 'md-bold',    re: /\*\*([^\n]+?)\*\*/g,                              parts: () => ({ open: '**', close: '**' }) },
  { type: 'md-strike',  re: /~~([^\n]+?)~~/g,                                  parts: () => ({ open: '~~', close: '~~' }) },
  { type: 'md-italic',  re: /(?<!\*)\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?!\*)/g, parts: () => ({ open: '*',  close: '*'  }) },
  { type: 'md-heading', re: /^(#{1,3}) (.+)$/gm,                               parts: m => ({ open: `${m[1]} `, close: '', level: m[1].length }) },
];

// ── Padrões de detecção ───────────────────────────────────────────────────────
// Ordem: mais específico/longo primeiro para evitar sobreposição
const DETECTORS = [
  { type: 'email', re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },  // E-mail
  { type: 'cnpj',  re: /[A-Z0-9]{2}\.[A-Z0-9]{3}\.[A-Z0-9]{3}\/[A-Z0-9]{4}-\d{2}/gi }, // CNPJ com máscara (novo formato alfanumérico IN RFB 2229/2024)
  { type: 'cpf',   re: /\d{3}\.\d{3}\.\d{3}-\d{2}/g                         },  // CPF com máscara
  { type: 'cep',           re: /\b\d{5}-\d{3}\b/g },
  { type: 'datetimerange', re: /\b\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4}[ \t]+\d{1,2}:\d{2}(?::\d{2})?[ \t]+at[eé][ \t]+\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4}[ \t]+\d{1,2}:\d{2}(?::\d{2})?\b/gi },
  { type: 'daterange',     re: /\b\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4}[ \t]+at[eé][ \t]+\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4}\b/gi },
  { type: 'timerange',     re: /\b\d{1,2}:\d{2}(?::\d{2})?[ \t]+at[eé][ \t]+\d{1,2}:\d{2}(?::\d{2})?\b/gi },
  { type: 'date',          re: /\b\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4}\b/g },
  { type: 'date',  re: /\b\d{4}-\d{2}-\d{2}\b/g                             },  // YYYY-MM-DD
  { type: 'date',  re: /\b\d{2} \d{2} \d{4}\b/g                             },  // DD MM YYYY
  { type: 'phone', re: /\(?\d{2}\)?[\s]?\d{4,5}-\d{4}/g                     },  // Telefone com máscara
  { type: 'date',  re: /\b(?:19|20)\d{6}\b/g                                 },  // YYYYMMDD compacto
  { type: 'cnpj',  re: /\b\d{14}\b/g                                         },  // CNPJ sem máscara
  { type: 'cpf',   re: /\b\d{11}\b/g                                         },  // CPF sem máscara
  { type: 'phone', re: /\b\d{10}\b/g                                          },  // Telefone sem máscara
  { type: 'cep',   re: /\b\d{8}\b/g                                           },  // CEP sem máscara
  { type: 'math',  re: /\(*-?\d+(?:[.,]\d+)*[)%]*(?:\s*(?:\*\*|[-+×÷*/^])\s*\(*-?\d+(?:[.,]\d+)*[)%]*)+/g }, // Expressão matemática
];

// ── Renderização do highlight ─────────────────────────────────────────────────
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildHighlightHtml(text) {
  const matches = [];
  mathCache.clear();

  // Markdown primeiro: tem prioridade sobre os detectores de dados quando sobrepõe.
  for (const { type, re, parts } of MD_DETECTORS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end   = start + m[0].length;
      const p = parts(m);
      const overlaps = matches.some(e => e.start < end && e.end > start);
      if (!overlaps) {
        const cls = type === 'md-heading' ? `md-h${p.level}` : type;
        matches.push({ start, end, kind: 'md', cls, openLen: p.open.length, closeLen: p.close.length });
      }
    }
  }

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
      if (!overlaps) matches.push({ start, end, kind: 'data', raw: m[0], type });
    }
  }

  matches.sort((a, b) => a.start - b.start);

  let html = '';
  let pos  = 0;

  for (const item of matches) {
    html += escHtml(text.slice(pos, item.start));

    if (item.kind === 'md') {
      const full     = text.slice(item.start, item.end);
      const openStr  = full.slice(0, item.openLen);
      const closeStr = item.closeLen ? full.slice(full.length - item.closeLen) : '';
      const innerStr = full.slice(item.openLen, full.length - item.closeLen);
      html += `<span class="md-marker">${escHtml(openStr)}</span>`;
      html += `<span class="md-content ${item.cls}">${escHtml(innerStr)}</span>`;
      if (closeStr) html += `<span class="md-marker">${escHtml(closeStr)}</span>`;
    } else {
      let cls = item.type;
      if (item.type === 'cpf')  cls += validateCPF(item.raw)  ? ' valid' : ' invalid';
      if (item.type === 'cnpj') cls += validateCNPJ(item.raw) ? ' valid' : ' invalid';
      html += `<mark class="${cls}" data-type="${item.type}" data-value="${escHtml(item.raw)}">${escHtml(item.raw)}</mark>`;
    }
    pos = item.end;
  }
  let result = html + escHtml(text.slice(pos));
  // Browsers collapse a trailing \n inside <div> even with white-space:pre-wrap,
  // making the highlight shorter than the textarea → scroll misalignment.
  // A sentinel space forces the div to expand the same number of lines.
  if (text.endsWith('\n')) result += ' ';
  return result;
}

function syncHighlight() {
  highlight.innerHTML  = buildHighlightHtml(textarea.value);
  highlight.scrollTop  = textarea.scrollTop;
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

  // Cabeçalho com o tipo detectado
  const header = document.createElement('div');
  header.className   = 'copy-menu-header';
  header.textContent = TYPE_LABELS[type] || 'Valor detectado';
  menu.appendChild(header);

  // Badge de validação para CPF e CNPJ
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
    // mousedown: evita que o clique fora feche o menu antes do click disparar
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

// Fecha ao clicar fora
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

// ── Autosave ──────────────────────────────────────────────────────────────────
function showSaved() {
  indicator.textContent = 'salvo ✓';
  indicator.classList.add('visible');
  clearTimeout(indicatorTimer);
  indicatorTimer = setTimeout(() => indicator.classList.remove('visible'), 2200);
}

textarea.addEventListener('input', () => {
  syncHighlight();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    if (currentNoteId == null) return;
    await updateNoteContentById(currentNoteId, textarea.value);
    showSaved();
  }, 800);
});

textarea.addEventListener('scroll', () => {
  highlight.scrollTop = textarea.scrollTop;
});

// ── Ctrl: ativa modo de seleção ───────────────────────────────────────────────
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

// ── Clique no highlight ───────────────────────────────────────────────────────
highlight.addEventListener('click', e => {
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

// ── Transformações de texto ───────────────────────────────────────────────────
const EMAIL_RE_GLOBAL = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Aplica fn apenas nos trechos que não são e-mail, preservando os e-mails intactos
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
  btn.addEventListener('mousedown', e => e.preventDefault()); // mantém foco/seleção na textarea
  btn.addEventListener('click', () => {
    const start = textarea.selectionStart;
    const end   = textarea.selectionEnd;
    if (start === end) return;
    const original    = textarea.value;
    const transformed = applySkipEmails(original.slice(start, end), t.fn);
    textarea.value          = original.slice(0, start) + transformed + original.slice(end);
    textarea.selectionStart = start;
    textarea.selectionEnd   = start + transformed.length;
    textarea.dispatchEvent(new Event('input'));
    textarea.focus();
  });
  ttBar.appendChild(btn);
}

// ── Formatação Markdown ───────────────────────────────────────────────────────
function wrapSelection(before, after) {
  const start    = textarea.selectionStart;
  const end      = textarea.selectionEnd;
  const original = textarea.value;
  const selected = original.slice(start, end);

  textarea.value = original.slice(0, start) + before + selected + after + original.slice(end);
  textarea.selectionStart = start + before.length;
  textarea.selectionEnd   = start + before.length + selected.length;
  textarea.dispatchEvent(new Event('input'));
  textarea.focus();
}

function prefixLine(prefix) {
  const start    = textarea.selectionStart;
  const original = textarea.value;
  const lineStart = original.lastIndexOf('\n', start - 1) + 1;

  textarea.value = original.slice(0, lineStart) + prefix + original.slice(lineStart);
  textarea.selectionStart = textarea.selectionEnd = start + prefix.length;
  textarea.dispatchEvent(new Event('input'));
  textarea.focus();
}

const MD_BUTTONS = [
  { label: 'B',    title: 'Negrito (**texto**)',           before: '**', after: '**' },
  { label: 'I',    title: 'Itálico (*texto*)',             before: '*',  after: '*'  },
  { label: 'S',    title: 'Riscado (~~texto~~)',           before: '~~', after: '~~' },
  { label: '</>',  title: 'Código (`texto`)',               before: '`',  after: '`'  },
  { label: 'H',    title: 'Título (no início da linha)',    linePrefix: '# '          },
];

const mdSep = document.createElement('div');
mdSep.className = 'tt-sep';
ttBar.appendChild(mdSep);

for (const b of MD_BUTTONS) {
  const btn = document.createElement('button');
  btn.className   = 'tt-btn';
  btn.title       = b.title;
  btn.textContent = b.label;
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', () => {
    if (b.linePrefix) prefixLine(b.linePrefix);
    else wrapSelection(b.before, b.after);
  });
  ttBar.appendChild(btn);
}

// ── Menu de cálculo ───────────────────────────────────────────────────────────
function showMathMenu(parsed, anchorRect) {
  closeCopyMenu();
  const { raw, resultFmt, steps } = parsed;
  const menu = document.createElement('div');
  menu.className = 'copy-menu math-menu';

  // Cabeçalho
  const hdr = document.createElement('div');
  hdr.className   = 'copy-menu-header';
  hdr.textContent = 'Cálculo';
  menu.appendChild(hdr);

  // Expressão (monospace)
  const exprEl = document.createElement('div');
  exprEl.className   = 'math-expr';
  exprEl.textContent = raw;
  menu.appendChild(exprEl);

  // Passo a passo
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

  // Resultado em destaque (clicável para copiar)
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

  // Divisor
  const addDiv = () => menu.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));
  addDiv();

  // Botões de cópia
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

// ── Troca de nota ativa (usado pelo notes-tabs.js) ─────────────────────────────

// Salva imediatamente o conteúdo da nota atual, sem esperar o debounce.
export async function flushSave() {
  clearTimeout(debounceTimer);
  if (currentNoteId != null) {
    await updateNoteContentById(currentNoteId, textarea.value);
  }
}

// Salva a nota atual e carrega outra no editor.
export async function switchToNote(id) {
  await flushSave();
  currentNoteId = id;
  const note = await getNoteById(id);
  textarea.value = note?.content ?? '';
  syncHighlight();
}
