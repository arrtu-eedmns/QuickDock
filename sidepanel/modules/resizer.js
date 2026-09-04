import { loadSplitRatio, saveSplitRatio } from './storage.js';

const app         = document.getElementById('app');
const noteSection = document.querySelector('.note-section');
const handle      = document.getElementById('resize-handle');

const MIN_RATIO = 0.2;
const MAX_RATIO = 0.85;

let dragging = false;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function applyRatio(ratio) {
  noteSection.style.height = `${ratio * 100}%`;
}

handle.addEventListener('mousedown', e => {
  dragging = true;
  handle.classList.add('dragging');
  document.body.style.cursor     = 'row-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', e => {
  if (!dragging) return;
  const rect  = app.getBoundingClientRect();
  const ratio = clamp((e.clientY - rect.top) / rect.height, MIN_RATIO, MAX_RATIO);
  applyRatio(ratio);
});

document.addEventListener('mouseup', async () => {
  if (!dragging) return;
  dragging = false;
  handle.classList.remove('dragging');
  document.body.style.cursor     = '';
  document.body.style.userSelect = '';
  await saveSplitRatio(parseFloat(noteSection.style.height) / 100);
});

export async function initResizer() {
  applyRatio(await loadSplitRatio());
}
