import { initNotesTabs, resetNotesTabs, createTutorialNote } from './modules/notes-tabs.js';
import { initDocuments, clearDocuments } from './modules/documents.js';
import { closeModal } from './modules/modal.js';
import { loadTheme, saveTheme, clearAll } from './modules/storage.js';
import { initResizer } from './modules/resizer.js';

const btnTheme    = document.getElementById('btn-theme');
const btnClear    = document.getElementById('btn-clear');
const btnTutorial = document.getElementById('btn-tutorial');
const html        = document.documentElement;

function applyTheme(theme) {
  html.setAttribute('data-theme', theme);
  btnTheme.textContent = theme === 'dark' ? '☀️' : '🌙';
}

async function initTheme() {
  let theme = await loadTheme();
  if (!theme) {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme(theme);
}

btnTheme.addEventListener('click', async () => {
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  await saveTheme(next);
  applyTheme(next);
});

btnTutorial.addEventListener('click', async () => {
  await createTutorialNote();
});

btnClear.addEventListener('click', async () => {
  if (!confirm('Limpar todas as notas e documentos?')) return;
  closeModal();
  await clearAll();
  await resetNotesTabs();
  clearDocuments();
});

async function init() {
  await initTheme();
  await initNotesTabs();
  await initDocuments();
  await initResizer();
}

init();

// ── Registra este painel no background (necessário para o toggle Ctrl+Q) ───────
const _panelPort = chrome.runtime.connect({ name: 'sidepanel' });
_panelPort.onMessage.addListener(msg => {
  if (msg.type === 'close') window.close();
});
