// ── board-view.js ──────────────────────────────────────────────────────────
// Motor do Quadro Infinito / Canvas Espacial integrado ao QuickDock.
// Suporta execução direta dentro do painel lateral (View Engine) e
// em aba cheia dedicada (board/index.html).
// Zero frameworks, zero bundlers, 100% nativo.

import { saveBoardRecord, getBoardById, getBoardByUid, loadAllBoards } from './storage.js';
import { escHtml } from './blocks.js';
import { goBack } from './views.js';

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

// Elementos do DOM cacheados
let container = null;
let worldEl = null;
let cardsLayer = null;
let svgLayer = null;
let arrowsGroup = null;
let draftArrow = null;
let titleInput = null;
let saveStatus = null;
let zoomText = null;
let isInitialized = false;

// ── Transformações de Coordenadas Puras ────────────────────────────────────────
export function screenToWorld(screenX, screenY, viewport = currentBoard.viewport) {
  if (!container) return { x: screenX, y: screenY };
  const rect = container.getBoundingClientRect();
  return {
    x: (screenX - rect.left - viewport.x) / viewport.zoom,
    y: (screenY - rect.top - viewport.y) / viewport.zoom
  };
}

export function worldToScreen(worldX, worldY, viewport = currentBoard.viewport) {
  if (!container) return { x: worldX, y: worldY };
  const rect = container.getBoundingClientRect();
  return {
    x: worldX * viewport.zoom + viewport.x + rect.left,
    y: worldY * viewport.zoom + viewport.y + rect.top
  };
}

export function abrirQuadroInfinitoEmAba(boardId = null) {
  const targetId = boardId ?? currentBoard?.id;
  const query = targetId ? `?id=${encodeURIComponent(targetId)}` : '';
  const url = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL(`board/index.html${query}`)
    : `board/index.html${query}`;
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, '_blank');
  }
}

// ── Inicialização ─────────────────────────────────────────────────────────────
export async function initBoardView(scope = document) {
  container = scope.getElementById ? scope.getElementById('board-container') : document.getElementById('board-container');
  if (!container) return;

  worldEl = scope.getElementById ? scope.getElementById('board-world') : document.getElementById('board-world');
  cardsLayer = scope.getElementById ? scope.getElementById('board-cards-layer') : document.getElementById('board-cards-layer');
  svgLayer = scope.getElementById ? scope.getElementById('board-svg') : document.getElementById('board-svg');
  arrowsGroup = scope.getElementById ? scope.getElementById('board-svg-arrows') : document.getElementById('board-svg-arrows');
  draftArrow = scope.getElementById ? scope.getElementById('board-draft-arrow') : document.getElementById('board-draft-arrow');

  titleInput = scope.getElementById ? scope.getElementById('board-title-input') : document.getElementById('board-title-input');
  saveStatus = scope.getElementById ? scope.getElementById('board-save-status') : document.getElementById('board-save-status');
  zoomText = scope.getElementById ? scope.getElementById('zoom-level-text') : document.getElementById('zoom-level-text');

  if (!isInitialized) {
    setupEventListeners(scope);
    isInitialized = true;
  }

  await loadBoardFromUrlOrStorage();
  applyViewport();
  renderCards();
  renderArrows();

  // Ouve evento de transição para esta view
  document.addEventListener('quickdock:view-changed', e => {
    if (e.detail?.view === 'board') {
      loadBoardFromUrlOrStorage().then(() => {
        applyViewport();
        renderCards();
        renderArrows();
      });
    }
  });

  document.addEventListener('quickdock:refresh-board-view', () => {
    loadBoardFromUrlOrStorage().then(() => {
      applyViewport();
      renderCards();
      renderArrows();
    });
  });
}

// ── Carregamento e Salvamento ─────────────────────────────────────────────────
export async function loadBoardFromUrlOrStorage() {
  let idParam = null;
  let uidParam = null;
  if (typeof window !== 'undefined' && window.location && window.location.search) {
    const params = new URLSearchParams(window.location.search);
    idParam = params.get('id');
    uidParam = params.get('uid');
  }

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
      title: board.title || 'Quadro de Ideias',
      viewport: board.viewport || { x: 0, y: 0, zoom: 1 },
      cards: board.cards || [],
      arrows: board.arrows || []
    };
  } else {
    // Cria quadro padrão inicial com 2 cartões demonstrativos conectados
    const cw = container ? container.clientWidth : 400;
    const ch = container ? container.clientHeight : 300;
    const cx = Math.max(150, cw / 2);
    const cy = Math.max(100, ch / 2 - 40);

    currentBoard = {
      id: null,
      uid: `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title: 'Quadro de Ideias',
      viewport: { x: cx - 120, y: cy - 60, zoom: 1 },
      cards: [
        { id: 'c1', x: 0, y: 0, w: 200, h: 110, text: '💡 Ideia Principal\nExplore livremente este espaço.', color: 'yellow' },
        { id: 'c2', x: 260, y: 40, w: 200, h: 110, text: '🎯 Conexão\nPuxe setas pelos pontos azuis.', color: 'blue' }
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
  if (!worldEl || !container) return;
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
  if (!container) return;
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
  if (!container) return;
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

  const cw = container.clientWidth || 400;
  const ch = container.clientHeight || 300;
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
    w: 200,
    h: 120,
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
  if (!cardsLayer) return;
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
  bodyEl?.addEventListener('input', () => {
    card.text = bodyEl.innerText;
    scheduleSave();
  });

  // Alternar Cores
  const btnColor = el.querySelector('.btn-color');
  btnColor?.addEventListener('click', e => {
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
  btnDel?.addEventListener('click', e => {
    e.stopPropagation();
    deleteCard(card.id);
  });

  // Arraste de Cartão pelo Cabeçalho
  const headerEl = el.querySelector('.board-card-header');
  headerEl?.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    headerEl.setPointerCapture(e.pointerId);
    draggedCard = card;
    const worldPos = screenToWorld(e.clientX, e.clientY);
    dragCardOffset = { x: worldPos.x - card.x, y: worldPos.y - card.y };
  });

  headerEl?.addEventListener('pointermove', e => {
    if (!draggedCard || draggedCard.id !== card.id) return;
    const worldPos = screenToWorld(e.clientX, e.clientY);
    card.x = Math.round(worldPos.x - dragCardOffset.x);
    card.y = Math.round(worldPos.y - dragCardOffset.y);
    el.style.transform = `translate(${card.x}px, ${card.y}px)`;
    renderArrows();
  });

  headerEl?.addEventListener('pointerup', e => {
    if (draggedCard && draggedCard.id === card.id) {
      draggedCard = null;
      scheduleSave();
    }
  });

  // Redimensionamento de Cartão
  const resizerEl = el.querySelector('.board-card-resizer');
  resizerEl?.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    resizerEl.setPointerCapture(e.pointerId);
    resizingCard = card;
    resizeStart = { x: e.clientX, y: e.clientY, w: card.w, h: card.h };
  });

  resizerEl?.addEventListener('pointermove', e => {
    if (!resizingCard || resizingCard.id !== card.id) return;
    const dw = (e.clientX - resizeStart.x) / currentBoard.viewport.zoom;
    const dh = (e.clientY - resizeStart.y) / currentBoard.viewport.zoom;
    card.w = Math.max(140, Math.round(resizeStart.w + dw));
    card.h = Math.max(80, Math.round(resizeStart.h + dh));
    el.style.width = `${card.w}px`;
    el.style.height = `${card.h}px`;
    renderArrows();
  });

  resizerEl?.addEventListener('pointerup', e => {
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
      if (draftArrow) draftArrow.hidden = false;
    });

    handle.addEventListener('pointermove', e => {
      if (!connectingFrom || !draftArrow) return;
      const startScreen = worldToScreen(connectingHandlePos.x, connectingHandlePos.y);
      draftArrow.setAttribute('x1', String(startScreen.x));
      draftArrow.setAttribute('y1', String(startScreen.y));
      draftArrow.setAttribute('x2', String(e.clientX));
      draftArrow.setAttribute('y2', String(e.clientY));
    });

    handle.addEventListener('pointerup', e => {
      if (!connectingFrom) return;
      if (draftArrow) draftArrow.hidden = true;

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
  if (!arrowsGroup) return;
  arrowsGroup.innerHTML = '';
  const cardMap = new Map(currentBoard.cards.map(c => [c.id, c]));

  for (const arrow of currentBoard.arrows) {
    const c1 = cardMap.get(arrow.from);
    const c2 = cardMap.get(arrow.to);
    if (!c1 || !c2) continue;

    // Centros dos cartões no espaço de tela
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
function setupEventListeners(scope = document) {
  titleInput?.addEventListener('input', () => {
    currentBoard.title = titleInput.value.trim() || 'Quadro Sem Título';
    scheduleSave();
  });

  const getEl = id => (scope.getElementById ? scope.getElementById(id) : document.getElementById(id));

  // Ferramentas da Barra
  getEl('tool-select')?.addEventListener('click', () => setTool('select'));
  getEl('tool-card')?.addEventListener('click', () => {
    const center = screenToWorld(container.clientWidth / 2, container.clientHeight / 2);
    addCard(center.x - 100, center.y - 60);
    setTool('select');
  });
  getEl('tool-arrow')?.addEventListener('click', () => setTool('arrow'));

  // Zoom
  getEl('btn-board-zoom-in')?.addEventListener('click', () => zoomBy(1.2));
  getEl('btn-board-zoom-out')?.addEventListener('click', () => zoomBy(0.8));
  getEl('btn-board-zoom-reset')?.addEventListener('click', resetZoomAndCenter);
  getEl('btn-zoom-in')?.addEventListener('click', () => zoomBy(1.2));
  getEl('btn-zoom-out')?.addEventListener('click', () => zoomBy(0.8));
  getEl('btn-zoom-reset')?.addEventListener('click', resetZoomAndCenter);

  // Voltar para o Editor (se estiver no painel) ou fechar (se estiver em aba avulsa)
  getEl('btn-board-back')?.addEventListener('click', () => {
    if (document.getElementById('note-editor-blocks')) {
      goBack();
    } else if (window.opener || window.history.length <= 1) {
      window.close();
    } else {
      window.history.back();
    }
  });

  // Abrir em aba inteira
  getEl('btn-board-open-tab')?.addEventListener('click', () => {
    abrirQuadroInfinitoEmAba(currentBoard?.id);
  });

  // Exportar JSON
  getEl('btn-board-export')?.addEventListener('click', exportBoardAsJSON);
  getEl('btn-export-json')?.addEventListener('click', exportBoardAsJSON);

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
    addCard(pos.x - 100, pos.y - 60);
  });

  // Atalhos de Teclado
  window.addEventListener('keydown', e => {
    // Apenas responde a atalhos se a visão do quadro estiver ativa
    const boardSec = document.getElementById('board-view');
    if (boardSec && boardSec.hidden) return;
    if (e.target.matches('input, [contenteditable="true"]')) return;
    if (e.key === 'v' || e.key === 'V') setTool('select');
    if (e.key === 'c' || e.key === 'C') {
      const center = screenToWorld(container.clientWidth / 2, container.clientHeight / 2);
      addCard(center.x - 100, center.y - 60);
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

export function exportBoardAsJSON() {
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
