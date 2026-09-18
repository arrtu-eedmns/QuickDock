// ── icons.js ────────────────────────────────────────────────────────────────
// Ícones da interface via fonte variável Material Symbols Rounded do Google
// (carregada em index.html). Qualquer nome do catálogo funciona
// (https://fonts.google.com/icons) — não existe mais tabela local de SVGs
// pra manter sincronizada com o Google.

/**
 * Retorna string HTML com o ícone especificado pronto para injeção via innerHTML.
 * @param {string} name - Nome do ícone no catálogo Material Symbols.
 * @param {string} [extraClass=''] - Classes adicionais.
 * @param {object} [attrs={}] - Atributos extras (ex: title).
 * @returns {string} String com o elemento <span> do ícone.
 */
export function iconSvg(name, extraClass = '', attrs = {}) {
  if (!name) return '';
  const classes = `qd-icon material-symbols-rounded ${extraClass}`.trim();
  const attrStr = Object.entries(attrs).map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('');
  return `<span class="${classes}" aria-hidden="true"${attrStr}>${name}</span>`;
}

/**
 * Cria um nó DOM do ícone.
 * @param {string} name - Nome do ícone no catálogo Material Symbols.
 * @param {string} [extraClass=''] - Classes adicionais.
 * @param {object} [attrs={}] - Atributos extras.
 * @returns {HTMLSpanElement|null}
 */
export function createIcon(name, extraClass = '', attrs = {}) {
  if (!name || typeof document === 'undefined') return null;
  const span = document.createElement('span');
  span.className = `qd-icon material-symbols-rounded ${extraClass}`.trim();
  span.textContent = name;
  span.setAttribute('aria-hidden', 'true');
  for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  return span;
}
