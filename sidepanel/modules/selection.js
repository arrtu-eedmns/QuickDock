// Módulo central de seleção
//
// Comportamento:
//   Clique simples em card        → abre modal (gerenciado em documents.js)
//   Ctrl + clique em card         → toggle de seleção individual
//   Shift + clique em card        → intervalo a partir do último Ctrl+clicado
//   Arrastar em espaço vazio      → rubber band / retângulo de seleção
//   Clique em espaço vazio        → limpa seleção
//   Escape                        → limpa seleção

const DRAG_THRESHOLD = 5;

// ── Estado ───────────────────────────────────────────────────────────────────
let _grid     = null;
let _dropZone = null;
let _onChange = null;

let selectedIds   = new Set();
let lastClickedId = null;

const rb = {
  active:     false,
  dragged:    false,
  startX:     0,
  startY:     0,
  el:         null,
  targetCard: null,
};

// ── API pública ───────────────────────────────────────────────────────────────
export function initSelection(grid, dropZone, onChange) {
  _grid     = grid;
  _dropZone = dropZone;
  _onChange = onChange;

  _dropZone.addEventListener('mousedown', _onMouseDown);
  document.addEventListener('mousemove',  _onMouseMove);
  document.addEventListener('mouseup',    _onMouseUp);
  document.addEventListener('keydown',    _onKeyDown);
}

export function clearSelection() {
  _clearVisual();
  _onChange?.();
}

export function getSelectedIds()    { return new Set(selectedIds); }
export function getSelectedMetas() {
  if (!_grid) return [];
  return [..._grid.querySelectorAll('.doc-card.selected')].map(c => ({
    id:   Number(c.dataset.id),
    name: c.dataset.name,
    type: c.dataset.filetype,
  }));
}

// ── Helpers internos ──────────────────────────────────────────────────────────
function _clearVisual() {
  _grid?.querySelectorAll('.doc-card.selected')
        .forEach(c => c.classList.remove('selected'));
  selectedIds.clear();
  lastClickedId = null;
}

function _select(id) {
  selectedIds.add(id);
  _grid?.querySelector(`.doc-card[data-id="${id}"]`)?.classList.add('selected');
}

function _deselect(id) {
  selectedIds.delete(id);
  _grid?.querySelector(`.doc-card[data-id="${id}"]`)?.classList.remove('selected');
}

function _selectOnly(id) {
  _clearVisual();
  _select(id);
}

function _orderedIds() {
  return [...(_grid?.querySelectorAll('.doc-card') ?? [])].map(c => Number(c.dataset.id));
}

function _selectRange(fromId, toId) {
  const ids = _orderedIds();
  const a = ids.indexOf(fromId);
  const b = ids.indexOf(toId);
  if (a === -1 || b === -1) { _selectOnly(toId); return; }
  const [lo, hi] = a < b ? [a, b] : [b, a];
  _clearVisual();
  for (let i = lo; i <= hi; i++) _select(ids[i]);
}

function _rectsIntersect(a, b) {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

// ── Handlers ──────────────────────────────────────────────────────────────────
function _onMouseDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest('.doc-delete, .doc-inject')) return;

  const card = e.target.closest('.doc-card');

  // ── Clique em card ──
  if (card) {
    const id = Number(card.dataset.id);

    if (e.ctrlKey || e.metaKey) {
      selectedIds.has(id) ? _deselect(id) : _select(id);
      if (selectedIds.has(id)) lastClickedId = id;
      _onChange?.();
      e.preventDefault();
    } else if (e.shiftKey && lastClickedId !== null) {
      _selectRange(lastClickedId, id);
      _onChange?.();
      e.preventDefault();
    }
    // Sem modificador → não mexe na seleção; documents.js abre o modal via click
    return;
  }

  // ── Clique / arrasto em espaço vazio ──
  e.preventDefault();

  // Limpa seleção anterior e prepara rubber band (com ou sem Ctrl)
  _clearVisual();
  // Não chama _onChange aqui — evita layout shift durante o arrasto
  rb.active     = true;
  rb.dragged    = false;
  rb.startX     = e.clientX;
  rb.startY     = e.clientY;
  rb.targetCard = null;
  rb.el         = null;
}

function _onMouseMove(e) {
  if (!rb.active) return;

  const dx = Math.abs(e.clientX - rb.startX);
  const dy = Math.abs(e.clientY - rb.startY);
  if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;

  rb.dragged = true;

  if (!rb.el) {
    rb.el = document.createElement('div');
    rb.el.className = 'rubber-band';
    document.body.appendChild(rb.el);
  }

  const x = Math.min(e.clientX, rb.startX);
  const y = Math.min(e.clientY, rb.startY);
  const w = Math.abs(e.clientX - rb.startX);
  const h = Math.abs(e.clientY - rb.startY);

  rb.el.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;

  const sel = { left: x, top: y, right: x + w, bottom: y + h };

  _grid?.querySelectorAll('.doc-card').forEach(card => {
    const r  = card.getBoundingClientRect();
    const id = Number(card.dataset.id);
    _rectsIntersect(sel, r) ? _select(id) : _deselect(id);
  });

  // Não chama _onChange durante o arrasto para não deslocar o layout.
}

function _onMouseUp() {
  if (!rb.active) return;

  rb.active = false;
  rb.dragged = false;
  rb.targetCard = null;
  if (rb.el) { rb.el.remove(); rb.el = null; }

  // Drag encerrado: agora é seguro mostrar/ocultar a group bar.
  _onChange?.();
}

function _onKeyDown(e) {
  if (e.key !== 'Escape' || selectedIds.size === 0) return;
  // Não limpa seleção se o modal estiver aberto (Escape fecha o modal primeiro)
  const modal = document.getElementById('modal');
  if (modal && !modal.classList.contains('hidden')) return;
  clearSelection();
}
