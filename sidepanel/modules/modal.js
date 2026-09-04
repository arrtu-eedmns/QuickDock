import { loadFileBlob } from './storage.js';

// ── Elementos do modal ────────────────────────────────────────────────────────
const modal      = document.getElementById('modal');
const titleEl    = document.getElementById('modal-title');
const body       = document.getElementById('modal-body');
const btnClose   = document.getElementById('modal-close');
const toolbar    = document.getElementById('img-toolbar');
const btnRotL    = document.getElementById('btn-rot-left');
const btnRotR    = document.getElementById('btn-rot-right');
const btnZoomIn  = document.getElementById('btn-zoom-in');
const btnZoomOut = document.getElementById('btn-zoom-out');
const btnFit     = document.getElementById('btn-zoom-fit');
const zoomLabel  = document.getElementById('zoom-label');

// ── Elementos da navegação de galeria ─────────────────────────────────────────
const galleryNav     = document.getElementById('gallery-nav');
const btnGalleryPrev = document.getElementById('gallery-prev');
const btnGalleryNext = document.getElementById('gallery-next');
const galleryCounter = document.getElementById('gallery-counter');

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Estado do visualizador de imagens ─────────────────────────────────────────
let viewerImg  = null;
let viewerWrap = null;
let scale      = 1;
let fitScale   = 1;
let rotation   = 0;   // graus: 0 | 90 | 180 | 270
let tx         = 0;   // pan X
let ty         = 0;   // pan Y
let isPanning  = false;
let panStartX  = 0;
let panStartY  = 0;

const MIN_SCALE  = 0.02;
const MAX_SCALE  = 20;
const ZOOM_STEP  = 1.18;

// ── Estado da galeria (navegação entre imagens) ───────────────────────────────
let galleryList  = [];  // [{ id, name, type }] — apenas quando o arquivo aberto é imagem
let galleryIndex = -1;
let galleryMenuEl = null;

function updateGalleryNav() {
  const has = galleryIndex !== -1 && galleryList.length > 1;
  galleryNav.classList.toggle('hidden', !has);
  if (has) galleryCounter.textContent = `${galleryIndex + 1} / ${galleryList.length}`;
}

function closeGalleryMenu() { galleryMenuEl?.remove(); galleryMenuEl = null; }

function openGalleryMenu(anchorRect) {
  closeGalleryMenu();
  const menu = document.createElement('div');
  menu.className = 'copy-menu gallery-menu';

  galleryList.forEach((item, i) => {
    const btn = document.createElement('button');
    btn.className = 'copy-opt gallery-menu-item' + (i === galleryIndex ? ' current' : '');
    btn.innerHTML =
      `<span class="copy-opt-hint">${i + 1}</span>` +
      `<span class="copy-opt-value">${escHtml(item.name)}</span>`;
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', () => {
      closeGalleryMenu();
      openModal(item.id, item.name, item.type, galleryList);
    });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  galleryMenuEl = menu;

  const mh = menu.offsetHeight, mw = menu.offsetWidth, gap = 6;
  const top = anchorRect.bottom + gap + mh > window.innerHeight
    ? anchorRect.top - mh - gap
    : anchorRect.bottom + gap;
  menu.style.top  = `${Math.max(4, top)}px`;
  menu.style.left = `${Math.max(4, Math.min(anchorRect.left, window.innerWidth - mw - 4))}px`;
}

async function navigateGallery(delta) {
  if (galleryIndex === -1) return;
  const nextIndex = (galleryIndex + delta + galleryList.length) % galleryList.length;
  const next = galleryList[nextIndex];
  await openModal(next.id, next.name, next.type, galleryList);
}

btnGalleryPrev.addEventListener('click', () => navigateGallery(-1));
btnGalleryNext.addEventListener('click', () => navigateGallery(1));

galleryCounter.addEventListener('click', e => {
  e.stopPropagation();
  openGalleryMenu(galleryCounter.getBoundingClientRect());
});

document.addEventListener('mousedown', e => {
  if (galleryMenuEl && !galleryMenuEl.contains(e.target) && e.target !== galleryCounter) closeGalleryMenu();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function applyTransform(animate = true) {
  if (!viewerImg) return;
  // Transição suave em zoom/rotação; sem transição durante pan (melhor resposta)
  viewerImg.classList.toggle('no-transition', !animate);
  viewerImg.style.transform =
    `translate(${tx}px, ${ty}px) rotate(${rotation}deg) scale(${scale})`;
  zoomLabel.textContent = Math.round(scale * 100) + '%';
}

function computeFitScale() {
  if (!viewerImg || !viewerWrap) return 1;
  const cw = viewerWrap.clientWidth;
  const ch = viewerWrap.clientHeight;
  const iw = viewerImg.naturalWidth;
  const ih = viewerImg.naturalHeight;
  if (!iw || !ih || !cw || !ch) return 1;

  // Se a imagem estiver girada 90°/270°, as dimensões lógicas invertem
  const rotated = rotation % 180 !== 0;
  const effectiveW = rotated ? ih : iw;
  const effectiveH = rotated ? iw : ih;

  return Math.min(cw / effectiveW, ch / effectiveH);
}

function fitView(animate = true) {
  fitScale = computeFitScale();
  scale    = fitScale;
  tx       = 0;
  ty       = 0;
  applyTransform(animate);
}

function zoomBy(factor, cx = 0, cy = 0) {
  const next  = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
  const ratio = next / scale;
  // Ajusta translação para manter o ponto (cx,cy) fixo na tela
  tx    = cx - (cx - tx) * ratio;
  ty    = cy - (cy - ty) * ratio;
  scale = next;
  applyTransform();
}

function rotateTo(delta) {
  rotation = (rotation + delta + 360) % 360;
  // Recalcula fit para a nova orientação; mantém o zoom relativo ao fit anterior
  const oldFit = fitScale;
  fitScale = computeFitScale();
  scale    = scale * (fitScale / oldFit); // proporcional ao novo fit
  tx       = 0;
  ty       = 0;
  applyTransform();
}

// ── Eventos do toolbar ────────────────────────────────────────────────────────
btnRotL.addEventListener('click',   () => rotateTo(-90));
btnRotR.addEventListener('click',   () => rotateTo(90));
btnZoomIn.addEventListener('click', () => zoomBy(ZOOM_STEP));
btnZoomOut.addEventListener('click',() => zoomBy(1 / ZOOM_STEP));
btnFit.addEventListener('click',    () => fitView());

// ── Ctrl + Scroll ─────────────────────────────────────────────────────────────
function onWheel(e) {
  if (!e.ctrlKey) return;
  e.preventDefault(); // impede o zoom nativo do Chrome no painel

  const rect   = viewerWrap.getBoundingClientRect();
  const cx     = e.clientX - rect.left  - rect.width  / 2;
  const cy     = e.clientY - rect.top   - rect.height / 2;
  const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
  zoomBy(factor, cx, cy);
}

// ── Pan (arrastar a imagem) ───────────────────────────────────────────────────
function onPanStart(e) {
  if (e.button !== 0) return;
  isPanning = true;
  panStartX = e.clientX - tx;
  panStartY = e.clientY - ty;
  viewerWrap.classList.add('panning');
  document.body.style.userSelect = 'none'; // impede seleção de texto fora do viewer
}

function onPanMove(e) {
  if (!isPanning) return;
  tx = e.clientX - panStartX;
  ty = e.clientY - panStartY;
  applyTransform(false); // sem transição durante o drag
}

function onPanEnd() {
  if (!isPanning) return;
  isPanning = false;
  viewerWrap?.classList.remove('panning');
  document.body.style.userSelect = ''; // restaura seleção normal
}

// ── Atalhos de teclado (só quando o modal está aberto e é imagem) ─────────────
function onKeyDown(e) {
  if (modal.classList.contains('hidden') || !viewerImg) return;

  switch (e.key) {
    case '+': case '=': e.preventDefault(); zoomBy(ZOOM_STEP);       break;
    case '-':           e.preventDefault(); zoomBy(1 / ZOOM_STEP);   break;
    case '0':           e.preventDefault(); fitView();                break;
    case '[': case ',': rotateTo(-90); break;
    case ']': case '.': rotateTo(90);  break;
    case 'ArrowLeft':   if (galleryIndex !== -1) { e.preventDefault(); navigateGallery(-1); } break;
    case 'ArrowRight':  if (galleryIndex !== -1) { e.preventDefault(); navigateGallery(1);  } break;
    case 'Escape':      closeModal();  break;
  }
}

// ── Setup / teardown do visualizador de imagens ───────────────────────────────
function setupImageViewer(url) {
  toolbar.classList.remove('hidden');

  body.style.cssText = 'overflow:hidden; padding:0; background:#111;';

  viewerWrap = document.createElement('div');
  viewerWrap.className = 'img-viewer';

  viewerImg = document.createElement('img');
  viewerImg.draggable = false;
  viewerImg.alt       = '';
  viewerImg.src       = url;

  viewerWrap.appendChild(viewerImg);
  body.appendChild(viewerWrap);

  viewerImg.addEventListener('load', () => {
    // Primeira exibição: ajusta ao tamanho do container sem animação
    fitView(false);
  });

  // Registra listeners do viewer
  viewerWrap.addEventListener('wheel',     onWheel,    { passive: false });
  viewerWrap.addEventListener('mousedown', onPanStart);
  viewerWrap.addEventListener('dragstart', e => e.preventDefault()); // elimina ghost do browser
  document.addEventListener('mousemove',  onPanMove);
  document.addEventListener('mouseup',    onPanEnd);
  document.addEventListener('keydown',    onKeyDown);
}

function teardownImageViewer() {
  toolbar.classList.add('hidden');
  body.style.cssText = '';

  viewerWrap?.removeEventListener('wheel',     onWheel);
  viewerWrap?.removeEventListener('mousedown', onPanStart);
  document.removeEventListener('mousemove',  onPanMove);
  document.removeEventListener('mouseup',    onPanEnd);
  document.removeEventListener('keydown',    onKeyDown);

  viewerImg  = null;
  viewerWrap = null;
  scale = fitScale = 1;
  rotation = tx = ty = 0;
  isPanning = false;
}

// ── Modal ─────────────────────────────────────────────────────────────────────
let currentURL = null;

function revokeURL() {
  if (currentURL) { URL.revokeObjectURL(currentURL); currentURL = null; }
}

export function closeModal() {
  teardownImageViewer();
  closeGalleryMenu();
  modal.classList.add('hidden');
  body.innerHTML = '';
  revokeURL();
  galleryList  = [];
  galleryIndex = -1;
}

btnClose.addEventListener('click', closeModal);

// Fechar com Esc — também capturado em onKeyDown para imagens,
// mas este listener cobre PDF e TXT
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !modal.classList.contains('hidden') && !viewerImg) {
    closeModal();
  }
});

export async function openModal(id, name, type, gallery = null) {
  const blob = await loadFileBlob(id);
  if (!blob) return;

  teardownImageViewer();
  closeGalleryMenu();
  revokeURL();

  if (gallery && gallery.length > 1) {
    galleryList  = gallery;
    galleryIndex = gallery.findIndex(g => g.id === id);
  } else {
    galleryList  = [];
    galleryIndex = -1;
  }
  updateGalleryNav();

  const url  = URL.createObjectURL(blob);
  currentURL = url;

  titleEl.textContent = name;
  body.innerHTML      = '';

  if (type.startsWith('image/')) {
    setupImageViewer(url);

  } else if (type === 'application/pdf') {
    body.style.display = 'flex';
    const obj = document.createElement('object');
    obj.data          = url;
    obj.type          = 'application/pdf';
    obj.style.cssText = 'width:100%;flex:1;border:none;';
    body.appendChild(obj);

  } else if (type === 'text/plain') {
    const pre = document.createElement('pre');
    pre.textContent = await blob.text();
    body.appendChild(pre);
  }

  modal.classList.remove('hidden');
}
