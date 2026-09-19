// ── board/board.js ──────────────────────────────────────────────────────
// Motor do Quadro Infinito / Canvas Espacial em aba cheia dedicada.
// Zero frameworks, zero bundlers, 100% nativo.

import { db, saveBoardRecord, getBoardById, getBoardByUid, loadAllBoards } from '../sidepanel/modules/storage.js';
import { escHtml } from '../sidepanel/modules/blocks.js';

// ── Estado do Quadro ──────────────────────────────────────────────────────────
let currentBoard = {
  id: null,
  uid: null,
  title: 'Quadro de Ideias',
  viewport: { x: 0, y: 0, zoom: 1 },
  cards: [],
  arrows: []
};

let activeTool = 'select'; // 'select' | 'card' | 'arrow'
let isPanning = false;
let startPanX = 0;
let startPanY = 0;
let saveTimer = null;

// Rastreamento de Cartão
let draggedCard = null;
let dragCardOffset = { x: 0, y: 0 };
let resizingCard = null;
let resizeStart = { x: 0, y: 0, w: 0, h: 0 };

// Rastreamento de Seta
let connectingFrom = null;
let connectingHandlePos = null;

// Elementos do DOM
const container = document.getElementById('board-container');
const worldEl = document.getElementById('board-world');
const cardsLayer = document.getElementById('board-cards-layer');
const svgLayer = document.getElementById('board-svg');
const arrowsGroup = document.getElementById('board-svg-arrows');
const draftArrow = document.getElementById('board-draft-arrow');

const titleInput = document.getElementById('board-title-input');
const saveStatus = document.getElementById('board-save-status');
const zoomText = document.getElementById('zoom-level-text');

// ── Transformações de Coordenadas Puras ────────────────────────────────────────
export function screenToWorld(screenX, screenY, viewport = currentBoard.viewport) {
  const rect = container.getBoundingClientRect();
  return {
    x: (screenX - rect.left - viewport.x) / viewport.zoom,
    y: (screenY - rect.top - viewport.y) / viewport.zoom
  };
}

export function worldToScreen(worldX, worldY, viewport = currentBoard.viewport) {
  const rect = container.getBoundingClientRect();
  return {
    x: worldX * viewport.zoom + viewport.x + rect.left,
    y: worldY * viewport.zoom + viewport.y + rect.top
  };
}

// ── Inicialização ─────────────────────────────────────────────────────────────
async function init() {
  initTheme();
  setupEventListeners();
  await loadBoardFromUrlOrStorage();
  applyViewport();
  renderCards();
  renderArrows();
}

function initTheme() {
  const saved = localStorage.getItem('quickdock:theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}

function updateThemeIcon(theme) {
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', current);
  localStorage.setItem('quickdock:theme', current);
  updateThemeIcon(current);
}

// ── Carregamento e Salvamento ─────────────────────────────────────────────────
async function loadBoardFromUrlOrStorage() {
  const params = new URLSearchParams(window.location.search);
  const idParam = params.get('id');
  const uidParam = params.get('uid');

  let board = null;
  try {
    if (idParam) {
      board = await getBoardById(Number(idParam));
    } else if (uidParam) {
      board = await getBoardByUid(uidParam);
    } else {
      const all = await loadAllBoards();
      board = all[0] || null;
    }
  } catch (err) {
    console.warn('Erro ao carregar quadro do banco:', err);
  }

  if (board) {
    currentBoard = {
      id: board.id,
      uid: board.uid,
      title: board.title || 'Quadro Sem Título',
      viewport: board.viewport || { x: 0, y: 0, zoom: 1 },
      cards: board.cards || [],
      arrows: board.arrows || []
    };
  } else {
    // Cria quadro padrão inicial com 2 cartões demonstrativos conectados
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cx = w / 2;
    const cy = h / 2 - 50;

    currentBoard = {
      id: null,
      uid: `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title: 'Brainstorming Inicial',
      viewport: { x: cx - 200, y: cy - 100, zoom: 1 },
      cards: [
        { id: 'c1', x: 0, y: 0, w: 220, h: 120, text: '💡 Primeira Grande Ideia\nExplore livremente este espaço infinito.', color: 'yellow' },
        { id: 'c2', x: 300, y: 60, w: 220, h: 120, text: '🎯 Próximos Passos\nConecte cartões usando as alças de seta.', color: 'blue' }
      ],
      arrows: [
        { id: 'a1', from: 'c1', to: 'c2', style: 'solid' }
      ]
    };
    await persistBoard();
  }

  if (titleInput) titleInput.value = currentBoard.title;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  if (saveStatus) {
    saveStatus.innerHTML = '<span class="status-icon">⏳</span> salvando...';
  }
  saveTimer = setTimeout(persistBoard, 600);
}

async function persistBoard() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const savedId = await saveBoardRecord(currentBoard);
    if (!currentBoard.id && savedId) currentBoard.id = savedId;
    if (saveStatus) {
      saveStatus.innerHTML = '<span class="qd-icon material-symbols-rounded status-icon">check</span> salvo';
    }
  } catch (err) {
    console.error('Erro ao salvar quadro:', err);
    if (saveStatus) {
      saveStatus.textContent = 'erro ao salvar';
    }
  }
}

// ── Câmera e Viewport ─────────────────────────────────────────────────────────
function applyViewport() {
  const { x, y, zoom } = currentBoard.viewport;
  worldEl.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;

  // Atualiza escala do fundo pontilhado
  const bgSize = Math.max(12, Math.round(24 * zoom));
  container.style.backgroundSize = `${bgSize}px ${bgSize}px`;
  container.style.backgroundPosition = `${x % bgSize}px ${y % bgSize}px`;

  if (zoomText) zoomText.textContent = `${Math.round(zoom * 100)}%`;
  renderArrows();
}

function zoomBy(factor, centerX = null, centerY = null) {
  const rect = container.getBoundingClientRect();
  const cx = centerX ?? (rect.width / 2);
  const cy = centerY ?? (rect.height / 2);

  const vp = currentBoard.viewport;
  const newZoom = Math.max(0.15, Math.min(3.0, vp.zoom * factor));
  vp.x = cx - (cx - vp.x) * (newZoom / vp.zoom);
  vp.y = cy - (cy - vp.y) * (newZoom / vp.zoom);
  vp.zoom = newZoom;

  applyViewport();
  scheduleSave();
}

function resetZoomAndCenter() {
  if (currentBoard.cards.length === 0) {
    currentBoard.viewport = { x: container.clientWidth / 2, y: container.clientHeight / 2, zoom: 1 };
    applyViewport();
    scheduleSave();
    return;
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of currentBoard.cards) {
    if (c.x < minX) minX = c.x;
    if (c.x + c.w > maxX) maxX = c.x + c.w;
    if (c.y < minY) minY = c.y;
    if (c.y + c.h > maxY) maxY = c.y + c.h;
  }

  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const boundingW = Math.max(100, maxX - minX + 160);
  const boundingH = Math.max(100, maxY - minY + 160);

  const scale = Math.max(0.25, Math.min(1.2, Math.min(cw / boundingW, ch / boundingH)));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  currentBoard.viewport = {
    x: cw / 2 - centerX * scale,
    y: ch / 2 - centerY * scale,
    zoom: scale
  };
  applyViewport();
  scheduleSave();
}

// ── Gestão de Cartões ─────────────────────────────────────────────────────────
export function addCard(worldX, worldY, text = '', color = 'default') {
  const cardId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const newCard = {
    id: cardId,
    x: Math.round(worldX),
    y: Math.round(worldY),
    w: 220,
    h: 130,
    text,
    color
  };
  currentBoard.cards.push(newCard);
  renderCards();
  renderArrows();
  scheduleSave();

  // Foca imediatamente o corpo do novo cartão
  setTimeout(() => {
    const el = document.querySelector(`[data-card-id="${cardId}"] .board-card-body`);
    el?.focus();
  }, 50);
}

function renderCards() {
  cardsLayer.innerHTML = '';
  for (const card of currentBoard.cards) {
    cardsLayer.appendChild(createCardElement(card));
  }
}

function createCardElement(card) {
  const el = document.createElement('div');
  el.className = 'board-card';
  el.dataset.cardId = card.id;
  if (card.color) el.dataset.color = card.color;
  el.style.transform = `translate(${card.x}px, ${card.y}px)`;
  el.style.width = `${card.w}px`;
  el.style.height = `${card.h}px`;

  el.innerHTML = `
    <div class="board-card-header">
      <span class="board-card-handle">⠿ Cartão</span>
      <div class="board-card-actions">
        <button class="card-action-btn btn-color" title="Alternar cor" aria-label="Alternar cor">🎨</button>
        <button class="card-action-btn btn-delete" title="Excluir cartão" aria-label="Excluir cartão">✕</button>
      </div>
    </div>
    <div class="board-card-body" contenteditable="true" spellcheck="false">${escHtml(card.text)}</div>
    <div class="board-card-resizer" title="Redimensionar"></div>
    <div class="board-card-connect-handle top" data-handle="top" title="Puxar conexão"></div>
    <div class="board-card-connect-handle right" data-handle="right" title="Puxar conexão"></div>
    <div class="board-card-connect-handle bottom" data-handle="bottom" title="Puxar conexão"></div>
    <div class="board-card-connect-handle left" data-handle="left" title="Puxar conexão"></div>
  `;

  // Evento de Edição de Texto
  const bodyEl = el.querySelector('.board-card-body');
  bodyEl.addEventListener('input', () => {
    card.text = bodyEl.innerText;
    scheduleSave();
  });

  // Alternar Cores
  const btnColor = el.querySelector('.btn-color');
  btnColor.addEventListener('click', e => {
    e.stopPropagation();
    const cores = ['default', 'yellow', 'green', 'blue', 'pink'];
    const idx = cores.indexOf(card.color || 'default');
    const proxima = cores[(idx + 1) % cores.length];
    card.color = proxima;
    el.dataset.color = proxima;
    scheduleSave();
  });

  // Excluir Cartão
  const btnDel = el.querySelector('.btn-delete');
  btnDel.addEventListener('click', e => {
    e.stopPropagation();
    deleteCard(card.id);
  });

  // Arraste de Cartão pelo Cabeçalho
  const headerEl = el.querySelector('.board-card-header');
  headerEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    headerEl.setPointerCapture(e.pointerId);
    draggedCard = card;
    const worldPos = screenToWorld(e.clientX, e.clientY);
    dragCardOffset = { x: worldPos.x - card.x, y: worldPos.y - card.y };
  });

  headerEl.addEventListener('pointermove', e => {
    if (!draggedCard || draggedCard.id !== card.id) return;
    const worldPos = screenToWorld(e.clientX, e.clientY);
    card.x = Math.round(worldPos.x - dragCardOffset.x);
    card.y = Math.round(worldPos.y - dragCardOffset.y);
    el.style.transform = `translate(${card.x}px, ${card.y}px)`;
    renderArrows();
  });

  headerEl.addEventListener('pointerup', e => {
    if (draggedCard && draggedCard.id === card.id) {
      draggedCard = null;
      scheduleSave();
    }
  });

  // Redimensionamento de Cartão
  const resizerEl = el.querySelector('.board-card-resizer');
  resizerEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    resizerEl.setPointerCapture(e.pointerId);
    resizingCard = card;
    resizeStart = { x: e.clientX, y: e.clientY, w: card.w, h: card.h };
  });

  resizerEl.addEventListener('pointermove', e => {
    if (!resizingCard || resizingCard.id !== card.id) return;
    const dw = (e.clientX - resizeStart.x) / currentBoard.viewport.zoom;
    const dh = (e.clientY - resizeStart.y) / currentBoard.viewport.zoom;
    card.w = Math.max(140, Math.round(resizeStart.w + dw));
    card.h = Math.max(90, Math.round(resizeStart.h + dh));
    el.style.width = `${card.w}px`;
    el.style.height = `${card.h}px`;
    renderArrows();
  });

  resizerEl.addEventListener('pointerup', e => {
    if (resizingCard && resizingCard.id === card.id) {
      resizingCard = null;
      scheduleSave();
    }
  });

  // Puxar Conexão / Seta
  el.querySelectorAll('.board-card-connect-handle').forEach(handle => {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      connectingFrom = card;
      const rect = handle.getBoundingClientRect();
      connectingHandlePos = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
      draftArrow.hidden = false;
    });

    handle.addEventListener('pointermove', e => {
      if (!connectingFrom) return;
      const mouseWorld = screenToWorld(e.clientX, e.clientY);
      const startScreen = worldToScreen(connectingHandlePos.x, connectingHandlePos.y);
      draftArrow.setAttribute('x1', String(startScreen.x));
      draftArrow.setAttribute('y1', String(startScreen.y));
      draftArrow.setAttribute('x2', String(e.clientX));
      draftArrow.setAttribute('y2', String(e.clientY));
    });

    handle.addEventListener('pointerup', e => {
      if (!connectingFrom) return;
      draftArrow.hidden = true;

      // Detecta se soltou sobre outro cartão
      const targetCardEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.board-card');
      const targetId = targetCardEl?.dataset.cardId;
      if (targetId && targetId !== connectingFrom.id) {
        addArrow(connectingFrom.id, targetId);
      }
      connectingFrom = null;
    });
  });

  return el;
}

function deleteCard(cardId) {
  currentBoard.cards = currentBoard.cards.filter(c => c.id !== cardId);
  currentBoard.arrows = currentBoard.arrows.filter(a => a.from !== cardId && a.to !== cardId);
  renderCards();
  renderArrows();
  scheduleSave();
}

// ── Gestão de Setas / Conexões SVG ────────────────────────────────────────────
function addArrow(fromId, toId, style = 'solid') {
  // Evita aresta duplicada na mesma direção
  if (currentBoard.arrows.some(a => a.from === fromId && a.to === toId)) return;
  currentBoard.arrows.push({
    id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    from: fromId,
    to: toId,
    style
  });
  renderArrows();
  scheduleSave();
}

function renderArrows() {
  arrowsGroup.innerHTML = '';
  const cardMap = new Map(currentBoard.cards.map(c => [c.id, c]));

  for (const arrow of currentBoard.arrows) {
    const c1 = cardMap.get(arrow.from);
    const c2 = cardMap.get(arrow.to);
    if (!c1 || !c2) continue;

    // Calcula centros dos cartões no espaço de tela
    const s1 = worldToScreen(c1.x + c1.w / 2, c1.y + c1.h / 2);
    const s2 = worldToScreen(c2.x + c2.w / 2, c2.y + c2.h / 2);

    // Bounding boxes na tela
    const r1 = { left: s1.x - (c1.w * currentBoard.viewport.zoom) / 2, right: s1.x + (c1.w * currentBoard.viewport.zoom) / 2, top: s1.y - (c1.h * currentBoard.viewport.zoom) / 2, bottom: s1.y + (c1.h * currentBoard.viewport.zoom) / 2 };
    const r2 = { left: s2.x - (c2.w * currentBoard.viewport.zoom) / 2, right: s2.x + (c2.w * currentBoard.viewport.zoom) / 2, top: s2.y - (c2.h * currentBoard.viewport.zoom) / 2, bottom: s2.y + (c2.h * currentBoard.viewport.zoom) / 2 };

    const p1 = clipLineToRect(s2, s1, r1);
    const p2 = clipLineToRect(s1, s2, r2);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const cx1 = p1.x + dx * 0.5;
    const cy1 = p1.y;
    const cx2 = p2.x - dx * 0.5;
    const cy2 = p2.y;

    path.setAttribute('d', `M ${p1.x} ${p1.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${p2.x} ${p2.y}`);
    path.setAttribute('class', 'board-arrow-path');
    path.setAttribute('marker-end', 'url(#arrowhead)');
    if (arrow.style === 'dashed') path.setAttribute('stroke-dasharray', '5 5');

    path.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm('Deseja excluir esta conexão?')) {
        currentBoard.arrows = currentBoard.arrows.filter(a => a.id !== arrow.id);
        renderArrows();
        scheduleSave();
      }
    });

    arrowsGroup.appendChild(path);
  }
}

// Calcula interseção de reta com a borda de um retângulo
function clipLineToRect(from, to, rect) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return to;

  const t = [];
  if (dx > 0) t.push((rect.right - from.x) / dx);
  if (dx < 0) t.push((rect.left - from.x) / dx);
  if (dy > 0) t.push((rect.bottom - from.y) / dy);
  if (dy < 0) t.push((rect.top - from.y) / dy);

  const valid = t.filter(val => val >= 0 && val <= 1);
  const minT = valid.length ? Math.min(...valid) : 1;

  return {
    x: from.x + dx * minT,
    y: from.y + dy * minT
  };
}

// ── Eventos de Mouse e Teclado ────────────────────────────────────────────────
function setupEventListeners() {
  // Título do Quadro
  titleInput?.addEventListener('input', () => {
    currentBoard.title = titleInput.value.trim() || 'Quadro Sem Título';
    scheduleSave();
  });

  // Ferramentas da Barra
  document.getElementById('tool-select')?.addEventListener('click', () => setTool('select'));
  document.getElementById('tool-card')?.addEventListener('click', () => {
    const center = screenToWorld(container.clientWidth / 2, container.clientHeight / 2);
    addCard(center.x - 110, center.y - 65);
    setTool('select');
  });
  document.getElementById('tool-arrow')?.addEventListener('click', () => setTool('arrow'));

  // Zoom
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoomBy(1.2));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoomBy(0.8));
  document.getElementById('btn-zoom-reset')?.addEventListener('click', resetZoomAndCenter);

  // Voltar / Fechar
  document.getElementById('btn-board-back')?.addEventListener('click', () => {
    if (window.opener || window.history.length <= 1) {
      window.close();
    } else {
      window.history.back();
    }
  });

  // Alternar Tema
  document.getElementById('btn-toggle-theme')?.addEventListener('click', toggleTheme);

  // Exportar JSON
  document.getElementById('btn-export-json')?.addEventListener('click', exportBoardAsJSON);

  // Pan na Área de Trabalho
  container.addEventListener('pointerdown', onContainerPointerDown);
  window.addEventListener('pointermove', onContainerPointerMove);
  window.addEventListener('pointerup', onContainerPointerUp);

  // Zoom com Roda do Mouse
  container.addEventListener('wheel', onContainerWheel, { passive: false });

  // Duplo clique na tela vazia adiciona cartão
  container.addEventListener('dblclick', e => {
    if (e.target !== container && e.target !== svgLayer) return;
    const pos = screenToWorld(e.clientX, e.clientY);
    addCard(pos.x - 110, pos.y - 65);
  });

  // Atalhos de Teclado
  window.addEventListener('keydown', e => {
    if (e.target.matches('input, [contenteditable="true"]')) return;
    if (e.key === 'v' || e.key === 'V') setTool('select');
    if (e.key === 'c' || e.key === 'C') {
      const center = screenToWorld(container.clientWidth / 2, container.clientHeight / 2);
      addCard(center.x - 110, center.y - 65);
    }
    if (e.key === '+' || e.key === '=') zoomBy(1.2);
    if (e.key === '-') zoomBy(0.8);
    if (e.key === '0') resetZoomAndCenter();
  });
}

function setTool(tool) {
  activeTool = tool;
  document.querySelectorAll('.board-tool-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`tool-${tool}`)?.classList.add('active');
}

function onContainerPointerDown(e) {
  // Arraste com botão do meio ou com botão esquerdo fora de cartões
  if (e.button === 1 || (e.button === 0 && (e.target === container || e.target === svgLayer))) {
    isPanning = true;
    startPanX = e.clientX;
    startPanY = e.clientY;
    container.classList.add('is-panning');
    container.setPointerCapture(e.pointerId);
  }
}

function onContainerPointerMove(e) {
  if (!isPanning) return;
  const dx = e.clientX - startPanX;
  const dy = e.clientY - startPanY;
  startPanX = e.clientX;
  startPanY = e.clientY;

  currentBoard.viewport.x += dx;
  currentBoard.viewport.y += dy;
  applyViewport();
}

function onContainerPointerUp(e) {
  if (isPanning) {
    isPanning = false;
    container.classList.remove('is-panning');
    scheduleSave();
  }
}

function onContainerWheel(e) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 0.88;
  zoomBy(factor, e.clientX, e.clientY);
}

function exportBoardAsJSON() {
  const json = JSON.stringify(currentBoard, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const slug = (currentBoard.title || 'quadro').toLowerCase().replace(/[^\w\d-]+/g, '-');
  a.href = url;
  a.download = `${slug}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Inicia ao carregar a página
init();
