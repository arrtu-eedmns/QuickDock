// ── popover.js ─────────────────────────────────────────────────────────────
// Posicionamento de popover ancorado. Vive separado porque três módulos
// precisam dele (abas, menu "⋯" e modelos), e deixá-lo em qualquer um deles
// criaria import circular.

// Abre pro lado com mais espaço e limita a altura ao que cabe, prendendo a
// posição dentro da janela nas duas pontas — um menu alto perto da borda
// ficaria cortado, com as últimas opções inalcançáveis.
export function positionPopover(el, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const gap = 4;
  const margin = 8;

  const below = window.innerHeight - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  const openDown = below >= above;
  const avail = Math.max(80, openDown ? below : above);

  el.style.maxHeight = `${avail}px`;
  el.style.overflowY = 'auto';

  const height = Math.min(el.scrollHeight, avail);
  let top = openDown ? rect.bottom + gap : rect.top - gap - height;
  top = Math.max(margin, Math.min(top, window.innerHeight - margin - height));

  el.style.top  = `${top}px`;
  el.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - el.offsetWidth - margin))}px`;
}
