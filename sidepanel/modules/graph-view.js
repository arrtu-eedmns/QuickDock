// ── graph-view.js ────────────────────────────────────────────────────────
// Visualização espacial de grafo de conexões das notas em Canvas 2D nativo.
// Zero frameworks, zero dependências externas.
// Inclui algoritmo de força com critério de parada (0% CPU ociosa),
// pan, zoom focal, arraste de nós e navegação direta para notas.

import { loadAllNotesMeta, obterTodosLinks } from './storage.js';
import { construirGrafo } from './links.js';
import { switchView, goBack } from './views.js';
import { escHtml } from './blocks.js';

let canvas = null;
let ctx = null;
let container = null;
let statsBadge = null;
let emptyStateEl = null;
let tooltipEl = null;

let nodes = [];
let edges = [];
let nodeMap = new Map();
let neighborMap = new Map();

// Câmera (Pan & Zoom)
let panX = 0;
let panY = 0;
let zoom = 1;

// Estado da Simulação
let animFrameId = null;
let isSimulating = false;
let simulationSteps = 0;
const MAX_STEPS = 250;
const ENERGY_THRESHOLD = 0.04;

// Interação com o Mouse / Toque
let isDragging = false;
let isPanning = false;
let startPointerX = 0;
let startPointerY = 0;
let draggedNode = null;
let hoveredNode = null;
let pointerMoved = false;

export function initGraphView() {
  container = document.getElementById('graph-canvas-container');
  canvas = document.getElementById('graph-canvas');
  if (!canvas || !container) return;

  ctx = canvas.getContext('2d');
  statsBadge = document.getElementById('graph-stats-badge');
  emptyStateEl = document.getElementById('graph-empty-state');
  tooltipEl = document.getElementById('graph-tooltip');

  // Botões do cabeçalho
  document.getElementById('btn-graph-back')?.addEventListener('click', () => goBack());
  document.getElementById('btn-graph-zoom-in')?.addEventListener('click', () => zoomBy(1.25));
  document.getElementById('btn-graph-zoom-out')?.addEventListener('click', () => zoomBy(0.8));
  document.getElementById('btn-graph-zoom-reset')?.addEventListener('click', () => resetCamera(true));

  // Botão de navegação do painel lateral
  document.getElementById('btn-nav-graph')?.addEventListener('click', () => switchView('grafo'));

  // Eventos do Canvas
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // Responsividade
  const resizeObserver = new ResizeObserver(() => {
    resizeCanvas();
    render();
  });
  resizeObserver.observe(container);

  // Ouve mudanças de tela
  document.addEventListener('quickdock:view-changed', e => {
    if (e.detail?.view === 'grafo') {
      carregarERenderizarGrafo();
    } else {
      stopSimulation();
    }
  });

  document.addEventListener('quickdock:refresh-graph-view', () => {
    carregarERenderizarGrafo();
  });
}

function resizeCanvas() {
  if (!canvas || !container) return;
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(100, Math.floor(rect.width));
  const h = Math.max(100, Math.floor(rect.height));

  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
}

export async function carregarERenderizarGrafo() {
  resizeCanvas();
  stopSimulation();

  try {
    const [todasNotas, todosLinks] = await Promise.all([
      loadAllNotesMeta(),
      obterTodosLinks()
    ]);

    const grafo = construirGrafo(todasNotas, todosLinks);
    nodes = grafo.nodes;
    edges = grafo.edges;

    nodeMap = new Map(nodes.map(n => [n.id, n]));
    neighborMap = new Map();
    for (const n of nodes) neighborMap.set(n.id, new Set());
    for (const e of edges) {
      neighborMap.get(e.source)?.add(e.target);
      neighborMap.get(e.target)?.add(e.source);
    }

    if (statsBadge) {
      statsBadge.textContent = `${nodes.length} notas · ${edges.length} ${edges.length === 1 ? 'conexão' : 'conexões'}`;
    }

    if (emptyStateEl) {
      emptyStateEl.hidden = edges.length > 0 || nodes.length > 1;
    }

    posicionarNosInicial();
    resetCamera(false);
    startSimulation();
  } catch (err) {
    console.error('Erro ao carregar grafo de conexões:', err);
  }
}

function posicionarNosInicial() {
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);
  const cx = w / 2;
  const cy = h / 2;
  const count = nodes.length;

  nodes.forEach((node, i) => {
    const angle = i * 2.39996; // Golden ratio angle
    const dist = 30 + Math.sqrt(i + 1) * 35;
    node.x = cx + Math.cos(angle) * dist + (Math.random() - 0.5) * 10;
    node.y = cy + Math.sin(angle) * dist + (Math.random() - 0.5) * 10;
    node.vx = 0;
    node.vy = 0;
    node.fx = 0;
    node.fy = 0;
  });
}

function resetCamera(centralizarApenas = false) {
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);

  if (nodes.length === 0) {
    panX = w / 2;
    panY = h / 2;
    zoom = 1;
    render();
    return;
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const graphW = Math.max(80, maxX - minX + 100);
  const graphH = Math.max(80, maxY - minY + 100);

  if (!centralizarApenas) {
    const scaleX = (w * 0.85) / graphW;
    const scaleY = (h * 0.85) / graphH;
    zoom = Math.max(0.4, Math.min(1.4, Math.min(scaleX, scaleY)));
  }

  panX = w / 2 - cx * zoom;
  panY = h / 2 - cy * zoom;
  render();
}

function zoomBy(factor, centerX = null, centerY = null) {
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);
  const cx = centerX ?? (w / 2);
  const cy = centerY ?? (h / 2);

  const newZoom = Math.max(0.2, Math.min(3.5, zoom * factor));
  panX = cx - (cx - panX) * (newZoom / zoom);
  panY = cy - (cy - panY) * (newZoom / zoom);
  zoom = newZoom;
  render();
}

// ── Motor de Força (Fruchterman-Reingold com Critério de Parada) ──────────────
function startSimulation() {
  if (isSimulating) return;
  isSimulating = true;
  simulationSteps = 0;
  loopSimulation();
}

function stopSimulation() {
  isSimulating = false;
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

function loopSimulation() {
  if (!isSimulating) return;
  simulationSteps++;

  const stepEnergy = stepSimulation();
  render();

  // Critério de parada: energia cinética baixa ou teto de passos atingido
  if ((stepEnergy < ENERGY_THRESHOLD && simulationSteps > 30) || simulationSteps > MAX_STEPS) {
    stopSimulation();
    return;
  }

  animFrameId = requestAnimationFrame(loopSimulation);
}

function stepSimulation() {
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);
  const cx = w / 2;
  const cy = h / 2;

  const nCount = Math.max(1, nodes.length);
  const k = Math.sqrt((w * h) / nCount) * 0.7;
  const k2 = k * k;

  // Reseta forças
  for (const n of nodes) {
    n.fx = 0;
    n.fy = 0;
  }

  // 1. Repulsão entre todos os nós (Coulomb / Fruchterman-Reingold)
  for (let i = 0; i < nCount; i++) {
    const u = nodes[i];
    for (let j = i + 1; j < nCount; j++) {
      const v = nodes[j];
      let dx = u.x - v.x;
      let dy = u.y - v.y;
      let d = Math.hypot(dx, dy);
      if (d < 0.1) {
        dx = (Math.random() - 0.5) * 2;
        dy = (Math.random() - 0.5) * 2;
        d = Math.hypot(dx, dy) || 1;
      }
      if (d < 450) {
        const repulsion = k2 / d;
        const fx = (dx / d) * repulsion;
        const fy = (dy / d) * repulsion;
        u.fx += fx;
        u.fy += fy;
        v.fx -= fx;
        v.fy -= fy;
      }
    }
  }

  // 2. Atração por arestas (Molas / Hooke)
  for (const edge of edges) {
    const u = nodeMap.get(edge.source);
    const v = nodeMap.get(edge.target);
    if (!u || !v) continue;
    const dx = v.x - u.x;
    const dy = v.y - u.y;
    const d = Math.hypot(dx, dy) || 1;
    const attraction = (d * d) / k;
    const fx = (dx / d) * attraction;
    const fy = (dy / d) * attraction;
    u.fx += fx;
    u.fy += fy;
    v.fx -= fx;
    v.fy -= fy;
  }

  // 3. Gravidade central (puxa todos e nós órfãos suavemente para o meio)
  const gravity = 0.035;
  for (const n of nodes) {
    n.fx += (cx - n.x) * gravity;
    n.fy += (cy - n.y) * gravity;
  }

  // 4. Integração de velocidades com amortecimento
  const damping = 0.82;
  const dt = 0.4;
  let totalEnergy = 0;

  for (const n of nodes) {
    if (n.isPinned) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }

    n.vx = (n.vx + n.fx * dt) * damping;
    n.vy = (n.vy + n.fy * dt) * damping;

    // Trava de velocidade máxima para estabilidade numérica
    const speed = Math.hypot(n.vx, n.vy);
    if (speed > 16) {
      n.vx = (n.vx / speed) * 16;
      n.vy = (n.vy / speed) * 16;
    }

    n.x += n.vx;
    n.y += n.vy;

    totalEnergy += n.vx * n.vx + n.vy * n.vy;
  }

  return totalEnergy / nCount;
}

// ── Renderização no Canvas ─────────────────────────────────────────────────────
function render() {
  if (!ctx || !canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Aplica Pan e Zoom
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6';
  const defaultLineColor = isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.12)';
  const dimmedLineColor = isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.03)';
  const activeNeighborSet = hoveredNode ? neighborMap.get(hoveredNode.id) : null;

  // 1. Desenha arestas
  ctx.lineCap = 'round';
  for (const edge of edges) {
    const u = nodeMap.get(edge.source);
    const v = nodeMap.get(edge.target);
    if (!u || !v) continue;

    let strokeColor = defaultLineColor;
    let lineWidth = 1.2;

    if (hoveredNode) {
      const isConnected = (edge.source === hoveredNode.id || edge.target === hoveredNode.id);
      if (isConnected) {
        strokeColor = accentColor;
        lineWidth = 2.4;
      } else {
        strokeColor = dimmedLineColor;
      }
    }

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(u.x, u.y);
    ctx.lineTo(v.x, v.y);
    ctx.stroke();
  }

  // 2. Desenha nós
  for (const node of nodes) {
    const isHovered = hoveredNode === node;
    const isNeighbor = activeNeighborSet && activeNeighborSet.has(node.id);
    const isDimmed = hoveredNode && !isHovered && !isNeighbor;

    const baseRadius = node.radius || 6;
    const r = isHovered ? baseRadius * 1.3 : baseRadius;

    ctx.save();
    if (isDimmed) {
      ctx.globalAlpha = 0.25;
    }

    // Círculo externo do nó
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);

    let nodeColor = node.color || accentColor;
    ctx.fillStyle = nodeColor;
    ctx.fill();

    ctx.strokeStyle = isHovered ? '#ffffff' : (isDark ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.2)');
    ctx.lineWidth = isHovered ? 2.5 : 1.2;
    ctx.stroke();

    // Rótulo da nota
    const shouldShowLabel = isHovered || isNeighbor || zoom >= 0.75 || node.degree > 1;
    if (shouldShowLabel) {
      ctx.font = isHovered ? '600 12px system-ui, sans-serif' : '11px system-ui, sans-serif';
      ctx.fillStyle = isDark ? '#e4e4e7' : '#18181b';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      let text = node.title || 'Sem título';
      if (text.length > 22 && !isHovered) {
        text = text.slice(0, 20) + '…';
      }
      ctx.fillText(text, node.x, node.y + r + 4);
    }

    ctx.restore();
  }

  ctx.restore();
}

// ── Interação com o Mouse e Toque ─────────────────────────────────────────────
function worldCoordinates(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - panX) / zoom,
    y: (clientY - rect.top - panY) / zoom
  };
}

function findNodeAt(worldX, worldY) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const dist = Math.hypot(worldX - node.x, worldY - node.y);
    if (dist <= (node.radius || 6) + 6) {
      return node;
    }
  }
  return null;
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  startPointerX = e.clientX;
  startPointerY = e.clientY;
  pointerMoved = false;

  const world = worldCoordinates(e.clientX, e.clientY);
  const clickedNode = findNodeAt(world.x, world.y);

  if (clickedNode) {
    isDragging = true;
    draggedNode = clickedNode;
    draggedNode.isPinned = true;
    startSimulation();
  } else {
    isPanning = true;
    canvas.style.cursor = 'grabbing';
  }
}

function onPointerMove(e) {
  const dx = e.clientX - startPointerX;
  const dy = e.clientY - startPointerY;
  if (Math.hypot(dx, dy) > 4) {
    pointerMoved = true;
  }

  if (isDragging && draggedNode) {
    const world = worldCoordinates(e.clientX, e.clientY);
    draggedNode.x = world.x;
    draggedNode.y = world.y;
    draggedNode.vx = 0;
    draggedNode.vy = 0;
    startSimulation();
    render();
    return;
  }

  if (isPanning) {
    panX += e.movementX;
    panY += e.movementY;
    render();
    return;
  }

  // Hover detection
  const world = worldCoordinates(e.clientX, e.clientY);
  const targetNode = findNodeAt(world.x, world.y);

  if (targetNode !== hoveredNode) {
    hoveredNode = targetNode;
    canvas.style.cursor = hoveredNode ? 'pointer' : 'grab';
    updateTooltip(e.clientX, e.clientY, hoveredNode);
    render();
  } else if (hoveredNode) {
    updateTooltip(e.clientX, e.clientY, hoveredNode);
  }
}

function onPointerUp(e) {
  if (isDragging && draggedNode) {
    draggedNode.isPinned = false;
    draggedNode = null;
    isDragging = false;
  }

  if (isPanning) {
    isPanning = false;
    canvas.style.cursor = hoveredNode ? 'pointer' : 'grab';
  }

  // Clique em nó sem arrastar abre a nota diretamente
  if (!pointerMoved && hoveredNode) {
    const target = hoveredNode;
    hideTooltip();
    document.dispatchEvent(new CustomEvent('quickdock:activate-note', {
      detail: { id: target.noteId, uid: target.id }
    }));
    switchView('editor');
  }
}

function onWheel(e) {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.14 : 0.88;
  zoomBy(factor, mouseX, mouseY);
}

function updateTooltip(screenX, screenY, node) {
  if (!tooltipEl) return;
  if (!node) {
    tooltipEl.hidden = true;
    return;
  }

  const rect = container.getBoundingClientRect();
  const relX = screenX - rect.left;
  const relY = screenY - rect.top;

  const connCount = neighborMap.get(node.id)?.size || 0;
  const pastaBadge = node.pasta ? `<span class="graph-tooltip-folder">${escHtml(node.pasta)}</span>` : '';

  tooltipEl.innerHTML = `
    <div class="graph-tooltip-title">${escHtml(node.title)}</div>
    ${pastaBadge}
    <div class="graph-tooltip-meta">${connCount} ${connCount === 1 ? 'conexão' : 'conexões'} · clique para abrir</div>
  `;
  tooltipEl.hidden = false;

  const tipW = tooltipEl.offsetWidth || 150;
  const tipH = tooltipEl.offsetHeight || 50;
  let left = relX + 12;
  let top = relY - tipH - 8;
  if (left + tipW > rect.width - 8) left = relX - tipW - 12;
  if (top < 8) top = relY + 16;

  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.hidden = true;
}
