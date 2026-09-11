import {
  loadAllNotesMeta, createNoteRecord, updateNoteMetaById, deleteNoteRecordById,
  reorderNoteRecords, migrateLegacyNoteIfNeeded, loadActiveNoteId, saveActiveNoteId,
  getNoteById,
} from './storage.js';
import { switchToNote, flushSave, getCurrentBlocks } from './note.js';
import { blocksToMarkdown, blocksToPlainText, parseMarkdownToBlocks } from './blocks.js';

const tabsEl        = document.getElementById('notes-tabs');
const btnNew        = document.getElementById('btn-new-note');
const btnNotesList  = document.getElementById('btn-notes-list');
const importInput   = document.getElementById('note-import-input');
const noteEditorEl  = document.querySelector('.note-editor');

const COLORS = ['#9b9b9b', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];

// Ícones comuns (Material Symbols) — qualquer outro nome do catálogo
// (fonts.google.com/icons) também funciona via o campo de texto livre.
const COMMON_ICONS = [
  'note', 'description', 'edit_note', 'checklist', 'star', 'flag',
  'bookmark', 'folder', 'lightbulb', 'push_pin', 'label', 'event',
];

const DISPLAY_MODES = [
  { key: 'icon',  label: 'Ícone' },
  { key: 'color', label: 'Cor'   },
  { key: 'text',  label: 'Texto' },
  { key: 'all',   label: 'Tudo'  },
];

let notesMeta = [];
let activeId  = null;
let dragSrcId = null;

function setAccent(color) {
  noteEditorEl.style.setProperty('--note-accent', color || 'transparent');
}

function positionPopover(el, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const top  = Math.min(rect.bottom + 4, window.innerHeight - el.offsetHeight - 4);
  const left = Math.min(rect.left, window.innerWidth - el.offsetWidth - 4);
  el.style.top  = `${Math.max(4, top)}px`;
  el.style.left = `${Math.max(4, left)}px`;
}

function renderTabs() {
  tabsEl.innerHTML = '';
  for (const meta of notesMeta) tabsEl.appendChild(buildTab(meta));
}

// Indicador visual da aba conforme o modo de exibição da nota (ícone / cor /
// texto / tudo). `interactive` desliga o clique-pra-abrir-o-popover quando
// reaproveitado num contexto só de leitura (ex.: lista do "☰").
function buildTabIndicator(meta, interactive = true) {
  const mode = meta.tabDisplay || 'color';
  if (mode === 'text') return null;

  if ((mode === 'icon' || mode === 'all') && meta.icon) {
    const span = document.createElement('span');
    span.className = 'note-tab-icon material-symbols-outlined';
    span.textContent = meta.icon;
    span.style.color = meta.color || 'var(--text-muted)';
    if (interactive) {
      span.title = 'Ícone da nota';
      span.addEventListener('click', e => { e.stopPropagation(); openIconPicker(meta, span); });
    }
    return span;
  }

  const dot = document.createElement('span');
  dot.className = 'note-tab-dot';
  dot.style.background = meta.color || 'var(--text-muted)';
  if (interactive) {
    dot.title = 'Cor da nota';
    dot.addEventListener('click', e => { e.stopPropagation(); openColorPicker(meta, dot); });
  }
  return dot;
}

function buildTab(meta) {
  const tab = document.createElement('div');
  tab.className = 'note-tab' + (meta.id === activeId ? ' active' : '');
  tab.draggable = true;
  tab.dataset.id = String(meta.id);

  const indicator = buildTabIndicator(meta);

  const title = document.createElement('span');
  title.className   = 'note-tab-title';
  title.textContent = meta.title || 'Sem título';
  title.title       = meta.title || 'Sem título';
  if (meta.tabDisplay === 'all') title.style.color = meta.color || '';
  title.addEventListener('dblclick', e => { e.stopPropagation(); startRename(meta, title); });

  const menuBtn = document.createElement('button');
  menuBtn.className   = 'note-tab-menu';
  menuBtn.textContent = '⋯';
  menuBtn.title       = 'Opções da nota';
  menuBtn.addEventListener('click', e => { e.stopPropagation(); openTabMenu(meta, menuBtn, title); });

  if (indicator) tab.appendChild(indicator);
  tab.append(title, menuBtn);

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

// ── Seletor de modo de exibição (compartilhado pelos popovers de ícone/cor) ──
function buildModeSelector(meta) {
  const row = document.createElement('div');
  row.className = 'tab-mode-row';
  for (const m of DISPLAY_MODES) {
    const btn = document.createElement('button');
    btn.className = 'tab-mode-btn' + ((meta.tabDisplay || 'color') === m.key ? ' active' : '');
    btn.textContent = m.label;
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await updateNoteMetaById(meta.id, { tabDisplay: m.key });
      meta.tabDisplay = m.key;
      row.querySelectorAll('.tab-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTabs();
    });
    row.appendChild(btn);
  }
  return row;
}

// ── Popover de cor ────────────────────────────────────────────────────────────
let colorPopover = null;
function closeColorPicker() { colorPopover?.remove(); colorPopover = null; }

function openColorPicker(meta, anchorEl) {
  closeColorPicker();
  const pop = document.createElement('div');
  pop.className = 'color-popover';

  pop.appendChild(buildModeSelector(meta));

  const grid = document.createElement('div');
  grid.className = 'color-grid';
  for (const c of COLORS) {
    const sw = document.createElement('button');
    sw.className = 'color-swatch' + (meta.color === c ? ' active' : '');
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
    grid.appendChild(sw);
  }
  pop.appendChild(grid);

  if (meta.color) {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'popover-remove-btn';
    removeBtn.textContent = 'Remover cor';
    removeBtn.addEventListener('mousedown', e => e.stopPropagation());
    removeBtn.addEventListener('click', async e => {
      e.stopPropagation();
      await updateNoteMetaById(meta.id, { color: null });
      meta.color = null;
      if (meta.id === activeId) setAccent(null);
      renderTabs();
      closeColorPicker();
    });
    pop.appendChild(removeBtn);
  }

  document.body.appendChild(pop);
  colorPopover = pop;
  positionPopover(pop, anchorEl);
}

document.addEventListener('mousedown', e => {
  if (colorPopover && !colorPopover.contains(e.target)) closeColorPicker();
});

// ── Popover de ícone ──────────────────────────────────────────────────────────
let iconPopover = null;
function closeIconPicker() { iconPopover?.remove(); iconPopover = null; }

function openIconPicker(meta, anchorEl) {
  closeIconPicker();
  const pop = document.createElement('div');
  pop.className = 'icon-popover';

  pop.appendChild(buildModeSelector(meta));

  const grid = document.createElement('div');
  grid.className = 'icon-grid';
  for (const name of COMMON_ICONS) {
    const btn = document.createElement('button');
    btn.className = 'icon-swatch material-symbols-outlined' + (meta.icon === name ? ' active' : '');
    btn.textContent = name;
    btn.title = name;
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await updateNoteMetaById(meta.id, { icon: name });
      meta.icon = name;
      renderTabs();
      closeIconPicker();
    });
    grid.appendChild(btn);
  }
  pop.appendChild(grid);

  const customRow = document.createElement('div');
  customRow.className = 'icon-custom-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'icon-custom-input';
  input.placeholder = 'nome_do_ícone';
  input.value = (meta.icon && !COMMON_ICONS.includes(meta.icon)) ? meta.icon : '';
  input.addEventListener('mousedown', e => e.stopPropagation());
  input.addEventListener('keydown', async e => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    const name = input.value.trim();
    if (!name) return;
    await updateNoteMetaById(meta.id, { icon: name });
    meta.icon = name;
    renderTabs();
    closeIconPicker();
  });
  customRow.appendChild(input);
  pop.appendChild(customRow);

  const hint = document.createElement('a');
  hint.className = 'icon-hint-link';
  hint.href = 'https://fonts.google.com/icons';
  hint.target = '_blank';
  hint.rel = 'noopener noreferrer';
  hint.textContent = 'Ver todos os ícones →';
  hint.addEventListener('mousedown', e => e.stopPropagation());
  pop.appendChild(hint);

  if (meta.icon) {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'popover-remove-btn';
    removeBtn.textContent = 'Remover ícone';
    removeBtn.addEventListener('mousedown', e => e.stopPropagation());
    removeBtn.addEventListener('click', async e => {
      e.stopPropagation();
      await updateNoteMetaById(meta.id, { icon: null });
      meta.icon = null;
      renderTabs();
      closeIconPicker();
    });
    pop.appendChild(removeBtn);
  }

  document.body.appendChild(pop);
  iconPopover = pop;
  positionPopover(pop, anchorEl);
}

document.addEventListener('mousedown', e => {
  if (iconPopover && !iconPopover.contains(e.target)) closeIconPicker();
});

// ── Menu "⋯" (renomear / ícone / cor / copiar / baixar / excluir) ────────────
// Pega os blocos da nota pedida: se for a nota aberta na tela, lê o DOM ao
// vivo (depois de garantir que está salvo); se for outra aba, lê do banco —
// mesma lógica de fallback usada ao trocar de nota.
async function getBlocksForNote(meta) {
  if (meta.id === activeId) {
    await flushSave();
    return getCurrentBlocks();
  }
  const note = await getNoteById(meta.id);
  return (note?.blocks?.length) ? note.blocks : parseMarkdownToBlocks(note?.content ?? '');
}

function safeFilename(title) {
  return (title || 'nota').replace(/[\\/:*?"<>|]/g, '_').trim() || 'nota';
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

let tabMenuEl = null;
function closeTabMenu() { tabMenuEl?.remove(); tabMenuEl = null; }

function openTabMenu(meta, anchorEl, titleEl) {
  closeTabMenu();
  const menu = document.createElement('div');
  menu.className = 'copy-menu tab-menu';

  const addOpt = (label, run) => {
    const btn = document.createElement('button');
    btn.className = 'copy-opt';
    btn.innerHTML = `<span class="copy-opt-value">${label}</span>`;
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', async e => { e.stopPropagation(); closeTabMenu(); await run(); });
    menu.appendChild(btn);
  };
  const addDivider = () => menu.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));

  addOpt('Renomear', () => startRename(meta, titleEl));
  addOpt('Ícone',    () => openIconPicker(meta, anchorEl));
  addOpt('Cor',      () => openColorPicker(meta, anchorEl));

  addDivider();

  addOpt('Copiar como Markdown', async () => {
    const text = blocksToMarkdown(await getBlocksForNote(meta));
    await navigator.clipboard.writeText(text);
  });
  addOpt('Copiar como texto', async () => {
    const text = blocksToPlainText(await getBlocksForNote(meta));
    await navigator.clipboard.writeText(text);
  });
  addOpt('Baixar .md', async () => {
    const text = blocksToMarkdown(await getBlocksForNote(meta));
    downloadText(`${safeFilename(meta.title)}.md`, text);
  });
  addOpt('Baixar .txt', async () => {
    const text = blocksToPlainText(await getBlocksForNote(meta));
    downloadText(`${safeFilename(meta.title)}.txt`, text);
  });

  addDivider();

  addOpt('Excluir', async () => {
    if (notesMeta.length <= 1) { alert('Deve existir ao menos uma nota.'); return; }
    if (!confirm(`Excluir a nota "${meta.title}"?`)) return;
    await deleteNoteRecordById(meta.id);
    notesMeta = notesMeta.filter(n => n.id !== meta.id);
    if (activeId === meta.id) await activateNote(notesMeta[0].id);
    renderTabs();
  });

  document.body.appendChild(menu);
  tabMenuEl = menu;
  positionPopover(menu, anchorEl);
}

document.addEventListener('mousedown', e => {
  if (tabMenuEl && !tabMenuEl.contains(e.target)) closeTabMenu();
});

// ── Lista de notas ("☰") ──────────────────────────────────────────────────────
let notesListPopover = null;
function closeNotesListPopover() { notesListPopover?.remove(); notesListPopover = null; }

function openNotesListPopover() {
  closeNotesListPopover();
  const pop = document.createElement('div');
  pop.className = 'copy-menu notes-list-popover';

  for (const meta of notesMeta) {
    const btn = document.createElement('button');
    btn.className = 'copy-opt notes-list-item' + (meta.id === activeId ? ' current' : '');
    const indicator = buildTabIndicator(meta, false);
    const label = document.createElement('span');
    label.className = 'copy-opt-value';
    label.textContent = meta.title || 'Sem título';
    if (indicator) btn.appendChild(indicator);
    btn.appendChild(label);
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', async () => {
      closeNotesListPopover();
      if (meta.id !== activeId) { await activateNote(meta.id); renderTabs(); }
    });
    pop.appendChild(btn);
  }

  document.body.appendChild(pop);
  notesListPopover = pop;
  positionPopover(pop, btnNotesList);
}

btnNotesList.addEventListener('click', e => { e.stopPropagation(); openNotesListPopover(); });
document.addEventListener('mousedown', e => {
  if (notesListPopover && !notesListPopover.contains(e.target)) closeNotesListPopover();
});

// ── "Nova nota" / "Importar" (botão combinado) ────────────────────────────────
let newMenuPopover = null;
function closeNewMenu() { newMenuPopover?.remove(); newMenuPopover = null; }

async function createBlankNote() {
  await flushSave();
  const title = `Nota ${notesMeta.length + 1}`;
  const id = await createNoteRecord({ title, content: '' });
  notesMeta.push({ id, title, color: null, icon: null, tabDisplay: 'color', updatedAt: Date.now() });
  await activateNote(id);
  renderTabs();
}

function openNewMenu() {
  closeNewMenu();
  const pop = document.createElement('div');
  pop.className = 'copy-menu';

  const blankBtn = document.createElement('button');
  blankBtn.className = 'copy-opt';
  blankBtn.innerHTML = `<span class="copy-opt-value">Nota em branco</span>`;
  blankBtn.addEventListener('mousedown', e => e.stopPropagation());
  blankBtn.addEventListener('click', async () => { closeNewMenu(); await createBlankNote(); });
  pop.appendChild(blankBtn);

  const importBtn = document.createElement('button');
  importBtn.className = 'copy-opt';
  importBtn.innerHTML = `<span class="copy-opt-value">Importar (.md/.txt)</span>`;
  importBtn.addEventListener('mousedown', e => e.stopPropagation());
  importBtn.addEventListener('click', () => { closeNewMenu(); importInput.click(); });
  pop.appendChild(importBtn);

  document.body.appendChild(pop);
  newMenuPopover = pop;
  positionPopover(pop, btnNew);
}

btnNew.addEventListener('click', e => { e.stopPropagation(); openNewMenu(); });
document.addEventListener('mousedown', e => {
  if (newMenuPopover && !newMenuPopover.contains(e.target)) closeNewMenu();
});

importInput.addEventListener('change', async () => {
  const file = importInput.files[0];
  importInput.value = '';
  if (!file) return;

  const text    = await file.text();
  const blocks  = parseMarkdownToBlocks(text);
  const title   = file.name.replace(/\.(md|txt)$/i, '') || 'Nota importada';
  const content = blocksToMarkdown(blocks);

  await flushSave();
  const id = await createNoteRecord({ title, content, blocks });
  notesMeta.push({ id, title, color: null, icon: null, tabDisplay: 'color', updatedAt: Date.now() });
  await activateNote(id);
  renderTabs();
});

// ── Ciclo de vida ──────────────────────────────────────────────────────────────
async function activateNote(id) {
  activeId = id;
  const meta = notesMeta.find(n => n.id === id);
  setAccent(meta?.color);
  await switchToNote(id);
  await saveActiveNoteId(id);
}

export async function initNotesTabs() {
  await migrateLegacyNoteIfNeeded();
  notesMeta = await loadAllNotesMeta();

  if (notesMeta.length === 0) {
    const id = await createNoteRecord({ title: 'Nota 1', content: '' });
    notesMeta = [{ id, title: 'Nota 1', color: null, icon: null, tabDisplay: 'color', updatedAt: Date.now() }];
  }

  const savedActiveId = await loadActiveNoteId();
  const initial = notesMeta.find(n => n.id === savedActiveId) ?? notesMeta[0];
  await activateNote(initial.id);
  renderTabs();
}

// Usado por "limpar tudo": recria uma única nota vazia.
export async function resetNotesTabs() {
  const id = await createNoteRecord({ title: 'Nota 1', content: '' });
  notesMeta = [{ id, title: 'Nota 1', color: null, icon: null, tabDisplay: 'color', updatedAt: Date.now() }];
  activeId  = id;
  setAccent(null);
  await switchToNote(id);
  await saveActiveNoteId(id);
  renderTabs();
}
