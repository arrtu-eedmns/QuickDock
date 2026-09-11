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

// As 7 cores do arco-íris, na ordem — "Nenhuma" fica à parte, sempre primeiro
// na lista do popover.
const COLORS = [
  { name: 'Vermelho', hex: '#ef4444' },
  { name: 'Laranja',  hex: '#f97316' },
  { name: 'Amarelo',  hex: '#eab308' },
  { name: 'Verde',    hex: '#22c55e' },
  { name: 'Azul',     hex: '#3b82f6' },
  { name: 'Anil',     hex: '#6366f1' },
  { name: 'Violeta',  hex: '#a855f7' },
];

// Ícones comuns (Material Symbols) — qualquer outro nome do catálogo
// (fonts.google.com/icons) também funciona via o campo de texto livre.
const COMMON_ICONS = [
  'note', 'description', 'edit_note', 'checklist', 'star', 'flag',
  'bookmark', 'folder', 'lightbulb', 'push_pin', 'label', 'event',
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

// A tira de abas rola só na horizontal — trocar de nota por um caminho que
// não seja clicar na própria aba (menu "☰", carregamento inicial) pode
// deixar a aba ativa fora da área visível.
function scrollTabIntoView(id) {
  const tab = tabsEl.querySelector(`.note-tab[data-id="${id}"]`);
  tab?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

// Indicador visual da aba: ícone se a nota tem um definido, senão a bolinha
// de cor se tem cor, senão nada (só o título aparece). Não existe mais um
// "modo" separado — é só o que estiver de fato preenchido. `interactive`
// desliga o clique-pra-abrir-o-popover quando reaproveitado num contexto só
// de leitura (ex.: lista do "☰").
function buildTabIndicator(meta, interactive = true) {
  if (meta.icon) {
    const span = document.createElement('span');
    span.className = 'note-tab-icon material-symbols-rounded' + (meta.iconFilled ? ' icon-filled' : '');
    span.textContent = meta.icon;
    span.style.color = meta.color || 'var(--text-muted)';
    if (interactive) {
      span.title = 'Ícone da nota';
      span.addEventListener('click', e => { e.stopPropagation(); openAppearancePicker(meta, span); });
    }
    return span;
  }

  if (meta.color) {
    const dot = document.createElement('span');
    dot.className = 'note-tab-dot';
    dot.style.background = meta.color;
    if (interactive) {
      dot.title = 'Cor da nota';
      dot.addEventListener('click', e => { e.stopPropagation(); openAppearancePicker(meta, dot); });
    }
    return dot;
  }

  return null;
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

// ── Popover de aparência (ícone + cor juntos) ─────────────────────────────────
// Um popover só, com as duas seções — escolher um ícone ou uma cor não fecha
// a tela, só atualiza o que está marcado, pra dar pra ajustar os dois sem
// reabrir o popover a cada escolha.
let appearancePopover = null;
function closeAppearancePicker() { appearancePopover?.remove(); appearancePopover = null; }

function renderAppearanceContent(pop, meta) {
  pop.innerHTML = '';

  const iconHeader = document.createElement('div');
  iconHeader.className = 'copy-menu-header';
  iconHeader.textContent = 'Ícone';
  pop.appendChild(iconHeader);

  const iconGrid = document.createElement('div');
  iconGrid.className = 'icon-grid';

  const pickIcon = async (name) => {
    await updateNoteMetaById(meta.id, { icon: name });
    meta.icon = name;
    renderTabs();
    renderAppearanceContent(pop, meta);
  };

  const noneIconBtn = document.createElement('button');
  noneIconBtn.className = 'icon-swatch icon-swatch-none' + (!meta.icon ? ' active' : '');
  noneIconBtn.textContent = '—';
  noneIconBtn.title = 'Nenhum ícone';
  noneIconBtn.addEventListener('mousedown', e => e.stopPropagation());
  noneIconBtn.addEventListener('click', e => { e.stopPropagation(); pickIcon(null); });
  iconGrid.appendChild(noneIconBtn);

  const filledClass = meta.iconFilled ? ' icon-filled' : '';
  for (const name of COMMON_ICONS) {
    const btn = document.createElement('button');
    btn.className = 'icon-swatch material-symbols-rounded' + filledClass + (meta.icon === name ? ' active' : '');
    btn.textContent = name;
    btn.title = name;
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', e => { e.stopPropagation(); pickIcon(name); });
    iconGrid.appendChild(btn);
  }
  pop.appendChild(iconGrid);

  // Alterna entre o estilo "contorno" (padrão) e "preenchido" do ícone —
  // usa o eixo FILL da própria fonte variável, não precisa carregar outra.
  const fillRow = document.createElement('label');
  fillRow.className = 'icon-fill-row';
  const fillCheckbox = document.createElement('input');
  fillCheckbox.type = 'checkbox';
  fillCheckbox.checked = !!meta.iconFilled;
  fillCheckbox.addEventListener('mousedown', e => e.stopPropagation());
  fillCheckbox.addEventListener('change', async e => {
    e.stopPropagation();
    await updateNoteMetaById(meta.id, { iconFilled: e.target.checked });
    meta.iconFilled = e.target.checked;
    renderTabs();
    renderAppearanceContent(pop, meta);
  });
  const fillLabel = document.createElement('span');
  fillLabel.textContent = 'Ícone preenchido';
  fillRow.append(fillCheckbox, fillLabel);
  pop.appendChild(fillRow);

  const iconCustomRow = document.createElement('div');
  iconCustomRow.className = 'icon-custom-row';
  const iconInput = document.createElement('input');
  iconInput.type = 'text';
  iconInput.className = 'icon-custom-input';
  iconInput.placeholder = 'nome_do_ícone (personalizado)';
  iconInput.value = (meta.icon && !COMMON_ICONS.includes(meta.icon)) ? meta.icon : '';
  iconInput.addEventListener('mousedown', e => e.stopPropagation());
  iconInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    const name = iconInput.value.trim();
    if (name) pickIcon(name);
  });
  iconCustomRow.appendChild(iconInput);
  pop.appendChild(iconCustomRow);

  const hint = document.createElement('a');
  hint.className = 'icon-hint-link';
  hint.href = 'https://fonts.google.com/icons';
  hint.target = '_blank';
  hint.rel = 'noopener noreferrer';
  hint.textContent = 'Ver todos os ícones →';
  hint.addEventListener('mousedown', e => e.stopPropagation());
  pop.appendChild(hint);

  pop.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));

  const colorHeader = document.createElement('div');
  colorHeader.className = 'copy-menu-header';
  colorHeader.textContent = 'Cor';
  pop.appendChild(colorHeader);

  const colorGrid = document.createElement('div');
  colorGrid.className = 'color-grid';

  const pickColor = async (hex) => {
    await updateNoteMetaById(meta.id, { color: hex });
    meta.color = hex;
    if (meta.id === activeId) setAccent(hex);
    renderTabs();
    renderAppearanceContent(pop, meta);
  };

  const noneColorBtn = document.createElement('button');
  noneColorBtn.className = 'color-swatch color-swatch-none' + (!meta.color ? ' active' : '');
  noneColorBtn.title = 'Nenhuma cor';
  noneColorBtn.addEventListener('mousedown', e => e.stopPropagation());
  noneColorBtn.addEventListener('click', e => { e.stopPropagation(); pickColor(null); });
  colorGrid.appendChild(noneColorBtn);

  for (const { name, hex } of COLORS) {
    const sw = document.createElement('button');
    sw.className = 'color-swatch' + (meta.color === hex ? ' active' : '');
    sw.style.background = hex;
    sw.title = name;
    sw.addEventListener('mousedown', e => e.stopPropagation());
    sw.addEventListener('click', e => { e.stopPropagation(); pickColor(hex); });
    colorGrid.appendChild(sw);
  }
  pop.appendChild(colorGrid);

  const colorCustomRow = document.createElement('label');
  colorCustomRow.className = 'color-custom-row';
  const colorInput = document.createElement('input');
  colorInput.type  = 'color';
  colorInput.className = 'color-custom-input';
  colorInput.value = (meta.color && /^#[0-9a-f]{6}$/i.test(meta.color)) ? meta.color : '#888888';
  colorInput.addEventListener('mousedown', e => e.stopPropagation());
  colorInput.addEventListener('change', e => { e.stopPropagation(); pickColor(e.target.value); });
  const colorLabel = document.createElement('span');
  colorLabel.textContent = 'Outra cor…';
  colorCustomRow.append(colorInput, colorLabel);
  pop.appendChild(colorCustomRow);
}

function openAppearancePicker(meta, anchorEl) {
  closeAppearancePicker();
  const pop = document.createElement('div');
  pop.className = 'copy-menu appearance-popover';
  renderAppearanceContent(pop, meta);
  document.body.appendChild(pop);
  appearancePopover = pop;
  positionPopover(pop, anchorEl);
}

document.addEventListener('mousedown', e => {
  if (appearancePopover && !appearancePopover.contains(e.target)) closeAppearancePicker();
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

  addOpt('Renomear',   () => startRename(meta, titleEl));
  addOpt('Ícone e cor', () => openAppearancePicker(meta, anchorEl));

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

// Abre o mesmo menu "⋯" de sempre, mas ancorado na aba de verdade — assim
// não precisa duplicar a lógica de renomear/ícone/cor/excluir pra dentro
// da lista. A aba de qualquer nota sempre existe no DOM (só pode estar fora
// da área visível pela rolagem horizontal).
function openTabMenuForNote(meta) {
  closeNotesListPopover();
  const tabEl    = tabsEl.querySelector(`.note-tab[data-id="${meta.id}"]`);
  const menuBtn  = tabEl?.querySelector('.note-tab-menu');
  const titleEl  = tabEl?.querySelector('.note-tab-title');
  if (!tabEl || !menuBtn || !titleEl) return;
  // Sem "smooth" aqui: o menu abre logo em seguida e precisa da posição
  // final da aba, não de uma posição no meio de uma animação de rolagem.
  tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  openTabMenu(meta, menuBtn, titleEl);
}

function openNotesListPopover() {
  closeNotesListPopover();
  const pop = document.createElement('div');
  pop.className = 'copy-menu notes-list-popover';

  for (const meta of notesMeta) {
    const row = document.createElement('div');
    row.className = 'copy-opt notes-list-item' + (meta.id === activeId ? ' current' : '');

    const indicator = buildTabIndicator(meta, false);
    const label = document.createElement('span');
    label.className = 'copy-opt-value';
    label.textContent = meta.title || 'Sem título';
    if (indicator) row.appendChild(indicator);
    row.appendChild(label);

    const editBtn = document.createElement('button');
    editBtn.className   = 'notes-list-edit-btn';
    editBtn.textContent = '⋯';
    editBtn.title       = 'Opções da nota';
    editBtn.addEventListener('mousedown', e => e.stopPropagation());
    editBtn.addEventListener('click', e => { e.stopPropagation(); openTabMenuForNote(meta); });
    row.appendChild(editBtn);

    row.addEventListener('mousedown', e => e.stopPropagation());
    row.addEventListener('click', async () => {
      closeNotesListPopover();
      if (meta.id !== activeId) { await activateNote(meta.id); renderTabs(); }
      scrollTabIntoView(meta.id);
    });
    pop.appendChild(row);
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
  notesMeta.push({ id, title, color: null, icon: null, updatedAt: Date.now() });
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
  notesMeta.push({ id, title, color: null, icon: null, updatedAt: Date.now() });
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
    notesMeta = [{ id, title: 'Nota 1', color: null, icon: null, updatedAt: Date.now() }];
  }

  const savedActiveId = await loadActiveNoteId();
  const initial = notesMeta.find(n => n.id === savedActiveId) ?? notesMeta[0];
  await activateNote(initial.id);
  renderTabs();
  scrollTabIntoView(initial.id);
}

// Usado por "limpar tudo": recria uma única nota vazia.
export async function resetNotesTabs() {
  const id = await createNoteRecord({ title: 'Nota 1', content: '' });
  notesMeta = [{ id, title: 'Nota 1', color: null, icon: null, updatedAt: Date.now() }];
  activeId  = id;
  setAccent(null);
  await switchToNote(id);
  await saveActiveNoteId(id);
  renderTabs();
}
