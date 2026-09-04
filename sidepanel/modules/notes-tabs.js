import {
  loadAllNotesMeta, createNoteRecord, updateNoteMetaById, deleteNoteRecordById,
  reorderNoteRecords, migrateLegacyNoteIfNeeded, loadActiveNoteId, saveActiveNoteId,
} from './storage.js';
import { switchToNote, flushSave } from './note.js';

const tabsEl      = document.getElementById('notes-tabs');
const btnNew      = document.getElementById('btn-new-note');
const noteEditorEl = document.querySelector('.note-editor');

const COLORS = ['#9b9b9b', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];

let notesMeta = [];
let activeId  = null;
let dragSrcId = null;

function setAccent(color) {
  noteEditorEl.style.setProperty('--note-accent', color || 'transparent');
}

function renderTabs() {
  tabsEl.innerHTML = '';
  for (const meta of notesMeta) tabsEl.appendChild(buildTab(meta));
}

function buildTab(meta) {
  const tab = document.createElement('div');
  tab.className = 'note-tab' + (meta.id === activeId ? ' active' : '');
  tab.draggable = true;
  tab.dataset.id = String(meta.id);

  const dot = document.createElement('span');
  dot.className = 'note-tab-dot';
  dot.style.background = meta.color || 'var(--text-muted)';
  dot.title = 'Cor da nota';
  dot.addEventListener('click', e => { e.stopPropagation(); openColorPicker(meta, dot); });

  const title = document.createElement('span');
  title.className   = 'note-tab-title';
  title.textContent = meta.title || 'Sem título';
  title.title        = meta.title || 'Sem título';
  title.addEventListener('dblclick', e => { e.stopPropagation(); startRename(meta, title); });

  const close = document.createElement('button');
  close.className   = 'note-tab-close';
  close.textContent = '✕';
  close.title       = 'Excluir nota';
  close.addEventListener('click', async e => {
    e.stopPropagation();
    if (notesMeta.length <= 1) { alert('Deve existir ao menos uma nota.'); return; }
    if (!confirm(`Excluir a nota "${meta.title}"?`)) return;
    await deleteNoteRecordById(meta.id);
    notesMeta = notesMeta.filter(n => n.id !== meta.id);
    if (activeId === meta.id) {
      await activateNote(notesMeta[0].id);
    }
    renderTabs();
  });

  tab.append(dot, title, close);

  tab.addEventListener('click', async () => {
    if (meta.id === activeId) return;
    await activateNote(meta.id);
    renderTabs();
  });

  tab.addEventListener('dragstart', e => {
    dragSrcId = meta.id;
    e.dataTransfer.effectAllowed = 'move';
  });
  tab.addEventListener('dragover', e => e.preventDefault());
  tab.addEventListener('drop', async e => {
    e.preventDefault();
    if (dragSrcId == null || dragSrcId === meta.id) return;
    const from = notesMeta.findIndex(n => n.id === dragSrcId);
    const to   = notesMeta.findIndex(n => n.id === meta.id);
    if (from === -1 || to === -1) return;
    const [moved] = notesMeta.splice(from, 1);
    notesMeta.splice(to, 0, moved);
    dragSrcId = null;
    await reorderNoteRecords(notesMeta.map(n => n.id));
    renderTabs();
  });

  return tab;
}

function startRename(meta, titleEl) {
  const input = document.createElement('input');
  input.className = 'note-tab-rename';
  input.value = meta.title;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const val = input.value.trim() || 'Sem título';
    await updateNoteMetaById(meta.id, { title: val });
    meta.title = val;
    renderTabs();
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  input.blur();
    if (e.key === 'Escape') { done = true; renderTabs(); }
  });
  input.addEventListener('blur', commit);
}

let colorPopover = null;
function closeColorPicker() { colorPopover?.remove(); colorPopover = null; }

function openColorPicker(meta, anchorEl) {
  closeColorPicker();
  const pop = document.createElement('div');
  pop.className = 'color-popover';
  for (const c of COLORS) {
    const sw = document.createElement('button');
    sw.className = 'color-swatch';
    sw.style.background = c;
    sw.addEventListener('mousedown', e => e.stopPropagation());
    sw.addEventListener('click', async e => {
      e.stopPropagation();
      await updateNoteMetaById(meta.id, { color: c });
      meta.color = c;
      if (meta.id === activeId) setAccent(c);
      renderTabs();
      closeColorPicker();
    });
    pop.appendChild(sw);
  }
  document.body.appendChild(pop);
  colorPopover = pop;

  const rect = anchorEl.getBoundingClientRect();
  const top  = Math.min(rect.bottom + 4, window.innerHeight - pop.offsetHeight - 4);
  const left = Math.min(rect.left, window.innerWidth - pop.offsetWidth - 4);
  pop.style.top  = `${Math.max(4, top)}px`;
  pop.style.left = `${Math.max(4, left)}px`;
}

document.addEventListener('mousedown', e => {
  if (colorPopover && !colorPopover.contains(e.target)) closeColorPicker();
});

async function activateNote(id) {
  activeId = id;
  const meta = notesMeta.find(n => n.id === id);
  setAccent(meta?.color);
  await switchToNote(id);
  await saveActiveNoteId(id);
}

btnNew.addEventListener('click', async () => {
  await flushSave();
  const title = `Nota ${notesMeta.length + 1}`;
  const id = await createNoteRecord({ title, content: '' });
  notesMeta.push({ id, title, color: null, updatedAt: Date.now() });
  await activateNote(id);
  renderTabs();
});

export async function initNotesTabs() {
  await migrateLegacyNoteIfNeeded();
  notesMeta = await loadAllNotesMeta();

  if (notesMeta.length === 0) {
    const id = await createNoteRecord({ title: 'Nota 1', content: '' });
    notesMeta = [{ id, title: 'Nota 1', color: null, updatedAt: Date.now() }];
  }

  const savedActiveId = await loadActiveNoteId();
  const initial = notesMeta.find(n => n.id === savedActiveId) ?? notesMeta[0];
  await activateNote(initial.id);
  renderTabs();
}

// Usado por "limpar tudo": recria uma única nota vazia.
export async function resetNotesTabs() {
  const id = await createNoteRecord({ title: 'Nota 1', content: '' });
  notesMeta = [{ id, title: 'Nota 1', color: null, updatedAt: Date.now() }];
  activeId  = id;
  setAccent(null);
  await switchToNote(id);
  await saveActiveNoteId(id);
  renderTabs();
}
