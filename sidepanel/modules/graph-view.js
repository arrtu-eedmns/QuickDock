// ── graph-view.js ────────────────────────────────────────────────────────
// Visualização espacial de grafo de conexões das notas em Canvas 2D nativo.
// Zero frameworks, zero dependências externas.
// Inclui algoritmo de força estável com recozimento simulado (simulated annealing),
// amortecimento por temperatura (alpha), molas lineares de Hooke com comprimento de repouso,
// critério de parada (0% CPU ociosa), painel de configurações persistentes,
// pan, zoom focal, arraste de nós e navegação direta para notas.

import { loadAllNotesMeta, obterTodosLinks } from './storage.js';
import { construirGrafo } from './links.js';
import { switchView, goBack } from './views.js';
import { escHtml } from './blocks.js';

const CONFIG_STORAGE_KEY = 'quickdock:graph:config';

export const DEFAULT_GRAPH_CONFIG = Object.freeze({
  showOrphans: true,
  alwaysShowLabels: false,
  selectedFolder: '',
  repulsion: 150,
  linkDistance: 90,
  linkStrength: 0.35,
  gravity: 0.03
});

let config = { ...DEFAULT_GRAPH_CONFIG };

let canvas = null;
let ctx = null;
let container = null;
let statsBadge = null;
let emptyStateEl = null;
let tooltipEl = null;
let settingsPanelEl = null;

let rawGraphNodes = [];
let rawGraphEdges = [];
let nodes = [];
let edges = [];
let nodeMap = new Map();
let neighborMap = new Map();

// Câmera (Pan & Zoom)
let panX = 0;
let panY = 0;
let zoom = 1;

// Estado da Simulação Física
let animFrameId = null;
let isSimulating = false;
let simulationSteps = 0;
let alpha = 1.0;
const MAX_STEPS = 200;
const ENERGY_THRESHOLD = 0.03;

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
  settingsPanelEl = document.getElementById('graph-settings-panel');

  carregarConfig();

  // Botões do cabeçalho
  document.getElementById('btn-graph-back')?.addEventListener('click', () => goBack());
  document.getElementById('btn-graph-zoom-in')?.addEventListener('click', () => zoomBy(1.25));
  document.getElementById('btn-graph-zoom-out')?.addEventListener('click', () => zoomBy(0.8));
  document.getElementById('btn-graph-zoom-reset')?.addEventListener('click', () => resetCamera(true));
  document.getElementById('btn-graph-settings')?.addEventListener('click', toggleSettingsPanel);
  document.getElementById('btn-graph-settings-close')?.addEventListener('click', fecharSettingsPanel);

  // Botão de navegação do painel lateral
  document.getElementById('btn-nav-graph')?.addEventListener('click', () => switchView('grafo'));

  // Configuração dos controles de UI de settings
  initSettingsUI();

  // Eventos do Canvas
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // Fecha o painel de configurações ao clicar fora
  window.addEventListener('pointerdown', e => {
    if (!settingsPanelEl || settingsPanelEl.hidden) return;
    if (settingsPanelEl.contains(e.target) || e.target.closest('#btn-graph-settings')) return;
    fecharSettingsPanel();
  });

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
      fecharSettingsPanel();
    }
  });

  document.addEventListener('quickdock:refresh-graph-view', () => {
    carregarERenderizarGrafo();
  });
}

function carregarConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      config = { ...DEFAULT_GRAPH_CONFIG, ...parsed };
    } else {
      config = { ...DEFAULT_GRAPH_CONFIG };
    }
  } catch {
    config = { ...DEFAULT_GRAPH_CONFIG };
  }
}

function salvarConfig() {
  try {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch (err) {
    console.warn('Falha ao salvar configurações do grafo:', err);
  }
}

function toggleSettingsPanel() {
  if (!settingsPanelEl) return;
  settingsPanelEl.hidden = !settingsPanelEl.hidden;
}

function fecharSettingsPanel() {
  if (settingsPanelEl) {
    settingsPanelEl.hidden = true;
  }
}

function initSettingsUI() {
  const orphansInput = document.getElementById('graph-setting-orphans');
  const labelsInput = document.getElementById('graph-setting-labels');
  const folderSelect = document.getElementById('graph-setting-folder');
  const repInput = document.getElementById('graph-setting-repulsion');
  const linkDistInput = document.getElementById('graph-setting-link-distance');
  const linkStrInput = document.getElementById('graph-setting-link-strength');
  const gravInput = document.getElementById('graph-setting-gravity');

  sincronizarValoresUI();

  orphansInput?.addEventListener('change', e => {
    config.showOrphans = !!e.target.checked;
    salvarConfig();
    aplicarFiltros(true);
    reheatSimulation(0.6);
  });

  labelsInput?.addEventListener('change', e => {
    config.alwaysShowLabels = !!e.target.checked;
    salvarConfig();
    render();
  });

  folderSelect?.addEventListener('change', e => {
    config.selectedFolder = e.target.value;
    salvarConfig();
    aplicarFiltros(false);
    reheatSimulation(0.8);
  });

  repInput?.addEventListener('input', e => {
    const val = Number(e.target.value);
    config.repulsion = val;
    const label = document.getElementById('graph-val-repulsion');
    if (label) label.textContent = String(val);
    salvarConfig();
    reheatSimulation(0.4);
  });

  linkDistInput?.addEventListener('input', e => {
    const val = Number(e.target.value);
    config.linkDistance = val;
    const label = document.getElementById('graph-val-link-distance');
    if (label) label.textContent = String(val);
    salvarConfig();
    reheatSimulation(0.4);
  });

  linkStrInput?.addEventListener('input', e => {
    const val = Number(e.target.value);
    config.linkStrength = val;
    const label = document.getElementById('graph-val-link-strength');
    if (label) label.textContent = val.toFixed(2);
    salvarConfig();
    reheatSimulation(0.4);
  });

  gravInput?.addEventListener('input', e => {
    const val = Number(e.target.value);
    config.gravity = val;
    const label = document.getElementById('graph-val-gravity');
    if (label) label.textContent = val.toFixed(3);
    salvarConfig();
    reheatSimulation(0.4);
  });

  document.getElementById('btn-graph-reheat')?.addEventListener('click', () => {
    posicionarNosInicial(true);
    resetCamera(false);
    startSimulation(1.0);
  });

  document.getElementById('btn-graph-reset-defaults')?.addEventListener('click', () => {
    config = { ...DEFAULT_GRAPH_CONFIG };
    salvarConfig();
    sincronizarValoresUI();
    aplicarFiltros(false);
    startSimulation(1.0);
  });
}

function sincronizarValoresUI() {
  const orphansInput = document.getElementById('graph-setting-orphans');
  const labelsInput = document.getElementById('graph-setting-labels');
  const repInput = document.getElementById('graph-setting-repulsion');
  const linkDistInput = document.getElementById('graph-setting-link-distance');
  const linkStrInput = document.getElementById('graph-setting-link-strength');
  const gravInput = document.getElementById('graph-setting-gravity');

  if (orphansInput) orphansInput.checked = !!config.showOrphans;
  if (labelsInput) labelsInput.checked = !!config.alwaysShowLabels;

  if (repInput) {
    repInput.value = String(config.repulsion);
    const label = document.getElementById('graph-val-repulsion');
    if (label) label.textContent = String(config.repulsion);
  }
  if (linkDistInput) {
    linkDistInput.value = String(config.linkDistance);
    const label = document.getElementById('graph-val-link-distance');
    if (label) label.textContent = String(config.linkDistance);
  }
  if (linkStrInput) {
    linkStrInput.value = String(config.linkStrength);
    const label = document.getElementById('graph-val-link-strength');
    if (label) label.textContent = Number(config.linkStrength).toFixed(2);
  }
  if (gravInput) {
    gravInput.value = String(config.gravity);
    const label = document.getElementById('graph-val-gravity');
    if (label) label.textContent = Number(config.gravity).toFixed(3);
  }
}

function preencherSelectPastas(todasNotas) {
  const folderSelect = document.getElementById('graph-setting-folder');
  if (!folderSelect) return;

  const pastas = new Set();
  for (const n of todasNotas) {
    if (n.pasta && typeof n.pasta === 'string') {
      const p = n.pasta.trim();
      if (p) pastas.add(p);
    }
  }

  const currentVal = config.selectedFolder || '';
  const sorted = Array.from(pastas).sort((a, b) => a.localeCompare(b));
  let html = '<option value="">Todas as pastas</option>';
  for (const pasta of sorted) {
    const sel = pasta === currentVal ? ' selected' : '';
    html += `<option value="${escHtml(pasta)}"${sel}>${escHtml(pasta)}</option>`;
  }
  folderSelect.innerHTML = html;
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

    // Preserva coordenadas existentes de nós que já tinham posição calculada
    const posMap = new Map();
    for (const n of nodes) {
      if (n.x !== undefined && n.y !== undefined && !isNaN(n.x) && !isNaN(n.y)) {
        posMap.set(n.id, { x: n.x, y: n.y });
      }
    }

    const grafo = construirGrafo(todasNotas, todosLinks);
    for (const n of grafo.nodes) {
      const saved = posMap.get(n.id);
      if (saved) {
        n.x = saved.x;
        n.y = saved.y;
      }
    }

    rawGraphNodes = grafo.nodes;
    rawGraphEdges = grafo.edges;

    preencherSelectPastas(todasNotas);
    aplicarFiltros(false);
    startSimulation(1.0);
  } catch (err) {
    console.error('Erro ao carregar grafo de conexões:', err);
  }
}

function aplicarFiltros(manterCamera = true) {
  // 1. Filtrar por pasta
  let filteredNodes = rawGraphNodes;
  if (config.selectedFolder) {
    filteredNodes = filteredNodes.filter(n => (n.pasta || '') === config.selectedFolder);
  }

  const validNodeIds = new Set(filteredNodes.map(n => n.id));
  let filteredEdges = rawGraphEdges.filter(e => validNodeIds.has(e.source) && validNodeIds.has(e.target));

  // 2. Calcular graus no subconjunto filtrado
  const degreeMap = new Map();
  for (const n of filteredNodes) degreeMap.set(n.id, 0);
  for (const e of filteredEdges) {
    degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
  }
  for (const n of filteredNodes) {
    n.degree = degreeMap.get(n.id) || 0;
  }

  // 3. Filtrar notas órfãs (quando desativadas)
  if (!config.showOrphans) {
    filteredNodes = filteredNodes.filter(n => (degreeMap.get(n.id) || 0) > 0);
    const nonOrphanIds = new Set(filteredNodes.map(n => n.id));
    filteredEdges = filteredEdges.filter(e => nonOrphanIds.has(e.source) && nonOrphanIds.has(e.target));
  }

  nodes = filteredNodes;
  edges = filteredEdges;

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
    emptyStateEl.hidden = edges.length > 0 || nodes.length > 0;
  }

  posicionarNosInicial(false);

  if (!manterCamera) {
    resetCamera(false);
  } else {
    render();
  }
}

function posicionarNosInicial(forcarNovoLayout = false) {
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);
  const cx = w / 2;
  const cy = h / 2;

  nodes.forEach((node, i) => {
    if (!forcarNovoLayout && node.x !== undefined && node.y !== undefined && !isNaN(node.x) && !isNaN(node.y)) {
      node.vx = 0;
      node.vy = 0;
      node.fx = 0;
      node.fy = 0;
      return;
    }
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

// ── Motor de Força Estável (Hooke + Coulomb Suavizado + Simulated Annealing) ──
function startSimulation(initialAlpha = 1.0) {
  alpha = Math.max(alpha, initialAlpha);
  if (isSimulating) return;
  isSimulating = true;
  simulationSteps = 0;
  loopSimulation();
}

function reheatSimulation(reheatAlpha = 0.4) {
  alpha = Math.max(alpha, reheatAlpha);
  simulationSteps = Math.min(simulationSteps, 40);
  if (!isSimulating) {
    isSimulating = true;
    loopSimulation();
  }
}

function stopSimulation() {
  isSimulating = false;
  alpha = 0;
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

  // Decaimento térmico suave (Simulated Annealing)
  alpha *= 0.955;

  // Critério de parada: temperatura esgotada, energia residual nula ou passos máximos atingidos
  if (alpha < 0.002 || (stepEnergy < ENERGY_THRESHOLD && simulationSteps > 25) || simulationSteps > MAX_STEPS) {
    stopSimulation();
    return;
  }

  animFrameId = requestAnimationFrame(loopSimulation);
}

function stepSimulation() {
  if (nodes.length === 0) return 0;

  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);
  const cx = w / 2;
  const cy = h / 2;
  const nCount = nodes.length;

  // Reseta forças
  for (const n of nodes) {
    n.fx = 0;
    n.fy = 0;
  }

  // 1. Repulsão suave (Coulomb com amortecimento epsilon para d pequeno)
  const repVal = Number(config.repulsion) || 150;
  const repSq = repVal * repVal;
  const maxRepDist = 450;

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
      if (d < maxRepDist) {
        // Amortecimento no denominador (d + 25) impede que d pequeno gere forças infinitas
        const repulsion = repSq / ((d + 25) * d);
        const fx = (dx / d) * repulsion;
        const fy = (dy / d) * repulsion;
        u.fx += fx;
        u.fy += fy;
        v.fx -= fx;
        v.fy -= fy;
      }
    }
  }

  // 2. Atração por arestas (Molas elásticas lineares de Hooke com comprimento de descanso)
  const idealDist = Number(config.linkDistance) || 90;
  const linkK = Number(config.linkStrength) || 0.35;

  for (const edge of edges) {
    const u = nodeMap.get(edge.source);
    const v = nodeMap.get(edge.target);
    if (!u || !v) continue;
    let dx = v.x - u.x;
    let dy = v.y - u.y;
    let d = Math.hypot(dx, dy);
    if (d < 0.1) {
      dx = (Math.random() - 0.5) * 2;
      dy = (Math.random() - 0.5) * 2;
      d = Math.hypot(dx, dy) || 1;
    }
    // Lei de Hooke estável: atração proporcional ao deslocamento do comprimento de repouso
    const displacement = d - idealDist;
    const attraction = displacement * linkK;
    const fx = (dx / d) * attraction;
    const fy = (dy / d) * attraction;
    u.fx += fx;
    u.fy += fy;
    v.fx -= fx;
    v.fy -= fy;
  }

  // 3. Gravidade central (suave puxão em direção ao centro da viewport)
  const grav = Number(config.gravity) || 0.03;
  for (const n of nodes) {
    n.fx += (cx - n.x) * grav;
    n.fy += (cy - n.y) * grav;
  }

  // 4. Integração de velocidades com amortecimento térmico (alpha)
  const damping = 0.84;
  const dt = 0.35;
  // Trava de velocidade proporcional a alpha: no repouso, maxSpeed -> 0, eliminando tremores
  const maxSpeed = Math.max(0.1, 14 * alpha);
  let totalEnergy = 0;

  for (const n of nodes) {
    if (n.isPinned) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }

    n.vx = (n.vx + n.fx * dt * alpha) * damping;
    n.vy = (n.vy + n.fy * dt * alpha) * damping;

    const speed = Math.hypot(n.vx, n.vy);
    if (speed > maxSpeed && speed > 0) {
      n.vx = (n.vx / speed) * maxSpeed;
      n.vy = (n.vy / speed) * maxSpeed;
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
    const shouldShowLabel = isHovered || isNeighbor || config.alwaysShowLabels || zoom >= 0.75 || node.degree > 1;
    if (shouldShowLabel) {
      ctx.font = isHovered ? '600 12px system-ui, sans-serif' : '11px system-ui, sans-serif';
      ctx.fillStyle = isDark ? '#e4e4e7' : '#18181b';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      let text = node.title || 'Sem título';
      if (text.length > 22 && !isHovered && !config.alwaysShowLabels) {
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
    reheatSimulation(0.35);
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
    reheatSimulation(0.35);
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
