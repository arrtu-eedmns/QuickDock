import { loadSplitRatio, saveSplitRatio } from './storage.js';

const app         = typeof document !== 'undefined' ? document.getElementById('app') : null;
const noteSection = typeof document !== 'undefined' ? document.querySelector('.note-section') : null;
const handle      = typeof document !== 'undefined' ? document.getElementById('resize-handle') : null;

let dragging = false;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function getDimensions() {
  const rect = app ? app.getBoundingClientRect() : { height: 600, top: 0 };
  const docsHeader = typeof document !== 'undefined' ? document.getElementById('docs-header') : null;
  const minDocsHeight = (docsHeader && docsHeader.offsetHeight > 0) ? docsHeader.offsetHeight : 40;
  const tabbar = typeof document !== 'undefined' ? document.querySelector('.notes-tabbar') : null;
  const tabbarHeight = (tabbar && tabbar.offsetHeight > 0) ? tabbar.offsetHeight : 48;
  const handleHeight = (handle && handle.offsetHeight > 0) ? handle.offsetHeight : 7;
  const appHeight = rect.height || 600;
  const maxNoteHeight = Math.max(80, appHeight - minDocsHeight - handleHeight - tabbarHeight);
  
  return {
    appHeight,
    appTop: rect.top,
    minDocsHeight,
    tabbarHeight,
    handleHeight,
    maxNoteHeight,
  };
}

export function updateMinimizedState(isMin) {
  if (typeof document === 'undefined') return;
  const docsSection = document.querySelector('.docs-section');
  const btnDocsToggle = document.getElementById('btn-docs-toggle');
  if (docsSection) {
    docsSection.classList.toggle('is-minimized', isMin);
  }
  if (btnDocsToggle) {
    btnDocsToggle.title = isMin ? 'Expandir documentos (50%)' : 'Recolher documentos';
    btnDocsToggle.setAttribute('aria-label', isMin ? 'Expandir documentos' : 'Recolher documentos');
  }
}

function applyRatio(ratio) {
  if (!noteSection) return;
  noteSection.style.height = `${ratio * 100}%`;
}

export function expandDocsToHalf() {
  if (!noteSection) return;
  const dims = getDimensions();
  const docsSection = document.querySelector('.docs-section');
  
  // 1. Remove estado minimizado antes para que o conteúdo esteja no fluxo para ser revelado
  updateMinimizedState(false);
  
  // 2. Ativa transição suave no container e trava overflow temporariamente contra saltos de scrollbar
  noteSection.classList.add('is-animating');
  if (docsSection) docsSection.classList.add('is-animating');
  
  // 3. Documentos passa a ocupar metade da altura da extensão (50% de #app):
  // noteSection = 50% - tabbarHeight - handleHeight
  const targetHeight = `calc(50% - ${dims.tabbarHeight + dims.handleHeight}px)`;
  noteSection.style.height = targetHeight;
  
  const onEnd = async () => {
    noteSection.removeEventListener('transitionend', onEnd);
    noteSection.classList.remove('is-animating');
    if (docsSection) docsSection.classList.remove('is-animating');
    if (dims.appHeight > 0) {
      await saveSplitRatio(noteSection.offsetHeight / dims.appHeight);
    }
  };
  noteSection.addEventListener('transitionend', onEnd, { once: true });
  setTimeout(onEnd, 350);
}

export function minimizeDocs() {
  if (!noteSection) return;
  const dims = getDimensions();
  const docsSection = document.querySelector('.docs-section');
  
  // 1. Ativa transição suave e trava overflow-y durante o encolhimento
  noteSection.classList.add('is-animating');
  if (docsSection) docsSection.classList.add('is-animating');
  
  // 2. noteSection ocupa todo o espaço restante, deixando apenas a altura do header Documentos
  const totalOverhead = dims.tabbarHeight + dims.handleHeight + dims.minDocsHeight;
  const targetHeight = `calc(100% - ${totalOverhead}px)`;
  noteSection.style.height = targetHeight;
  
  const onEnd = async () => {
    noteSection.removeEventListener('transitionend', onEnd);
    noteSection.classList.remove('is-animating');
    if (docsSection) docsSection.classList.remove('is-animating');
    updateMinimizedState(true);
    if (dims.appHeight > 0) {
      await saveSplitRatio(noteSection.offsetHeight / dims.appHeight);
    }
  };
  noteSection.addEventListener('transitionend', onEnd, { once: true });
  setTimeout(onEnd, 350);
}

export function toggleDocsExtension() {
  const docsSection = typeof document !== 'undefined' ? document.querySelector('.docs-section') : null;
  const isMin = docsSection?.classList.contains('is-minimized');
  if (isMin) {
    expandDocsToHalf();
  } else {
    minimizeDocs();
  }
}

if (handle) {
  handle.addEventListener('mousedown', e => {
    dragging = true;
    handle.classList.add('dragging');
    if (noteSection) noteSection.classList.remove('is-animating');
    const docsSection = document.querySelector('.docs-section');
    if (docsSection) docsSection.classList.remove('is-animating');
    document.body.style.cursor     = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  handle.addEventListener('dblclick', () => {
    toggleDocsExtension();
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('mousemove', e => {
    if (!dragging || !app || !noteSection) return;
    const dims = getDimensions();
    if (dims.appHeight <= 0) return;
    
    const minRatio = 0.15;
    const maxRatio = dims.maxNoteHeight / dims.appHeight;
    
    const currentRatio = (e.clientY - dims.appTop) / dims.appHeight;
    const ratio = clamp(currentRatio, minRatio, maxRatio);
    
    const isAtMin = ratio >= maxRatio - 0.005;
    updateMinimizedState(isAtMin);
    
    if (isAtMin) {
      const totalOverhead = dims.tabbarHeight + dims.handleHeight + dims.minDocsHeight;
      noteSection.style.height = `calc(100% - ${totalOverhead}px)`;
    } else {
      noteSection.style.height = `${ratio * 100}%`;
    }
  });

  document.addEventListener('mouseup', async () => {
    if (!dragging) return;
    dragging = false;
    if (handle) handle.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    const dims = getDimensions();
    if (dims.appHeight > 0 && noteSection) {
      await saveSplitRatio(noteSection.offsetHeight / dims.appHeight);
    }
  });
}

export async function initResizer() {
  if (!noteSection) return;
  const saved = await loadSplitRatio();
  const dims = getDimensions();
  const maxRatio = dims.maxNoteHeight / (dims.appHeight || 600);
  
  if (saved && saved >= maxRatio - 0.01) {
    updateMinimizedState(true);
    const totalOverhead = dims.tabbarHeight + dims.handleHeight + dims.minDocsHeight;
    noteSection.style.height = `calc(100% - ${totalOverhead}px)`;
  } else {
    updateMinimizedState(false);
    applyRatio(saved || 0.7);
  }
}
