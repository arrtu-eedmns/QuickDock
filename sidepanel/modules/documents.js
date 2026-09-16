import {
  saveFile, loadAllFilesMeta, deleteFile, loadFileBlob, setFileNoteId,
  loadDocsView, saveDocsView,
} from './storage.js';
import { openModal } from './modal.js';
import { startInject, startInjectMultiple } from './inject.js';
import { initSelection, clearSelection, getSelectedMetas } from './selection.js';
import { setActiveArea } from './active-area.js';

const grid           = document.getElementById('doc-grid');
const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('file-input');
const btnUpload      = document.getElementById('btn-upload');
const groupBar       = document.getElementById('group-bar');
const groupCount     = document.getElementById('group-count');
const btnInjectSel   = document.getElementById('btn-inject-selected');
const btnDeleteSel   = document.getElementById('btn-delete-selected');
const btnClearSel    = document.getElementById('btn-clear-selection');
const btnScopeSel    = document.getElementById('btn-scope-selected');
const btnViewNote    = document.getElementById('btn-view-note');
const btnViewAll     = document.getElementById('btn-view-all');
const hiddenHint     = document.getElementById('docs-hidden-hint');
const docsSection    = document.querySelector('.docs-section');

const ALLOWED_TYPES = ['image/', 'application/pdf', 'text/plain'];

// ── Escopo dos documentos ────────────────────────────────────────────────────
// Um documento é geral (noteId null, aparece em qualquer nota) ou vinculado a
// uma nota. Duas visões: "Nesta nota" (os desta nota + os gerais) e "Todos".
// Guardamos os metas em memória para trocar de nota sem reler o banco.
let currentNoteId = null;
let allMetas      = [];
let viewMode      = 'note';
let ready         = false;

// Imagem colada dentro da nota fica fora da lista de Documentos: ela já está
// visível dentro da nota, e repeti-la aqui faria a seção encher de recorte a
// cada print colado. Filtrar já na carga mantém o resto do módulo sem precisar
// saber que existe imagem inline — inclusive a contagem do rodapé, que conta
// documento escondido e não deve contar o que nem é documento.
async function carregarMetas() {
  return (await loadAllFilesMeta()).filter(m => !m.inline);
}

function isVisible(meta) {
  if (viewMode === 'all') return true;
  return meta.noteId === null || meta.noteId === currentNoteId;
}

function scopeOf(noteId) {
  if (noteId === null) return 'geral';
  return noteId === currentNoteId ? 'nota' : 'outra';
}

async function renderGrid() {
  clearSelection();
  grid.innerHTML = '';
  for (const meta of allMetas.filter(isVisible)) {
    grid.appendChild(await buildCard(meta));
  }
  paintView();
}

// O ponto da visão "Nesta nota" é filtrar, mas filtrar em silêncio é como se
// perde arquivo. Sempre que algo fica de fora, o rodapé diz quantos são e leva
// pra visão completa num clique.
function paintView() {
  btnViewNote.classList.toggle('is-on', viewMode === 'note');
  btnViewAll.classList.toggle('is-on', viewMode === 'all');

  const hidden = allMetas.length - allMetas.filter(isVisible).length;
  hiddenHint.hidden = hidden === 0;
  if (hidden > 0) {
    hiddenHint.textContent = hidden === 1
      ? '+ 1 documento em outra nota — ver todos'
      : `+ ${hidden} documentos em outras notas — ver todos`;
  }
}

async function setView(view) {
  if (view === viewMode) return;
  viewMode = view;
  await saveDocsView(view);
  await renderGrid();
}

btnViewNote.addEventListener('click', () => setView('note'));
btnViewAll.addEventListener('click',  () => setView('all'));
hiddenHint.addEventListener('click',  () => setView('all'));

// ── Group bar ────────────────────────────────────────────────────────────────
// Se algum selecionado ainda não é desta nota, a ação é trazer todos pra cá;
// se todos já são, a ação vira soltá-los como gerais.
function selectionWouldPin() {
  return getSelectedMetas().some(({ id }) => {
    const meta = allMetas.find(m => m.id === id);
    return meta && meta.noteId !== currentNoteId;
  });
}

function updateGroupBar() {
  const metas = getSelectedMetas();
  if (metas.length === 0) {
    groupBar.classList.add('hidden');
    return;
  }
  groupBar.classList.remove('hidden');
  groupCount.textContent = `${metas.length} selecionado${metas.length > 1 ? 's' : ''}`;

  const pin = selectionWouldPin();
  btnScopeSel.hidden      = currentNoteId === null;
  btnScopeSel.textContent = pin ? '📌 Vincular' : '📌 Tornar geral';
  btnScopeSel.title       = pin
    ? 'Mostrar estes documentos só na nota aberta'
    : 'Mostrar estes documentos em todas as notas';
}

// ── Ações da group bar ───────────────────────────────────────────────────────
btnClearSel.addEventListener('click', clearSelection);

btnDeleteSel.addEventListener('click', async () => {
  const metas = getSelectedMetas();
  if (!metas.length) return;
  for (const { id } of metas) {
    await deleteFile(id);
    forgetMeta(id);
  }
  clearSelection();
});

btnScopeSel.addEventListener('click', async () => {
  const metas = getSelectedMetas();
  if (!metas.length || currentNoteId === null) return;
  const target = selectionWouldPin() ? currentNoteId : null;
  for (const { id } of metas) await applyScope(id, target);
  updateGroupBar();
});

btnInjectSel.addEventListener('click', async () => {
  const metas = getSelectedMetas();
  if (!metas.length) return;
  await startInjectMultiple(metas);
});

// ── Helpers de renderização ──────────────────────────────────────────────────
function isAllowed(file) {
  return ALLOWED_TYPES.some(t => file.type.startsWith(t));
}

function forgetMeta(id) {
  allMetas = allMetas.filter(m => m.id !== id);
  grid.querySelector(`.doc-card[data-id="${id}"]`)?.remove();
  paintView();
}

// O destino é sempre a nota aberta ou "geral" — nunca outra nota —, então o
// card nunca some da vista ao mudar de escopo: basta repintar o marcador.
async function applyScope(id, noteId) {
  await setFileNoteId(id, noteId);
  const meta = allMetas.find(m => m.id === id);
  if (meta) meta.noteId = noteId;
  const card = grid.querySelector(`.doc-card[data-id="${id}"]`);
  if (card) paintScope(card, noteId);
  paintView();
}

const SCOPE_TITLE = {
  nota:  'Só nesta nota — clique para mostrar em todas',
  geral: 'Em todas as notas — clique para vincular só a esta',
  outra: 'De outra nota — clique para trazer para esta',
};

function paintScope(card, noteId) {
  const scope = scopeOf(noteId);
  card.classList.toggle('scoped',  scope === 'nota');
  card.classList.toggle('foreign', scope === 'outra');
  const btn = card.querySelector('.doc-scope');
  if (!btn) return;
  btn.classList.toggle('icon-filled', scope === 'nota');
  btn.title = SCOPE_TITLE[scope];
}

// Lista ordenada (na ordem exibida no grid) das imagens atuais, para navegação no modal.
function getImageGalleryMetas() {
  return [...grid.querySelectorAll('.doc-card')]
    .filter(c => c.dataset.filetype.startsWith('image/'))
    .map(c => ({ id: Number(c.dataset.id), name: c.dataset.name, type: c.dataset.filetype }));
}

async function buildThumbEl(type, blob) {
  if (type.startsWith('image/') && blob) {
    const url = URL.createObjectURL(blob);
    const img = document.createElement('img');
    img.className = 'doc-thumbnail';
    img.src = url;
    img.onload = () => URL.revokeObjectURL(url);
    return img;
  }
  const icon = document.createElement('div');
  icon.className = 'doc-icon';
  icon.textContent = type === 'application/pdf' ? '📄' : '📝';
  return icon;
}

async function buildCard(meta) {
  const { id, name, type } = meta;

  const card = document.createElement('div');
  card.className        = 'doc-card';
  card.dataset.id       = String(id);
  card.dataset.name     = name;
  card.dataset.filetype = type;

  const blob  = type.startsWith('image/') ? await loadFileBlob(id) : null;
  const thumb = await buildThumbEl(type, blob);

  const nameEl = document.createElement('span');
  nameEl.className   = 'doc-name';
  nameEl.textContent = name;

  const delBtn = document.createElement('button');
  delBtn.className   = 'doc-delete';
  delBtn.title       = 'Remover';
  delBtn.textContent = '✕';
  delBtn.addEventListener('click', async e => {
    e.stopPropagation();
    await deleteFile(id);
    forgetMeta(id);
    // Refresca group bar caso o card deletado estivesse selecionado
    updateGroupBar();
  });

  const scopeBtn = document.createElement('button');
  scopeBtn.className = 'doc-scope material-symbols-rounded';
  scopeBtn.textContent = 'push_pin';
  scopeBtn.hidden = currentNoteId === null;
  scopeBtn.addEventListener('click', async e => {
    e.stopPropagation();
    const current = allMetas.find(m => m.id === id)?.noteId ?? null;
    // já é desta nota → solta como geral; qualquer outro caso → traz pra cá
    await applyScope(id, scopeOf(current) === 'nota' ? null : currentNoteId);
    updateGroupBar();
  });

  const injectBtn = document.createElement('button');
  injectBtn.className   = 'doc-inject';
  injectBtn.title       = 'Enviar para campo da página';
  injectBtn.textContent = '→';
  injectBtn.addEventListener('click', async e => {
    e.stopPropagation();
    await startInject(id, name, type);
  });

  // Clique simples abre o preview (sem modificadores)

  card.appendChild(thumb);
  card.appendChild(nameEl);
  card.appendChild(delBtn);
  card.appendChild(injectBtn);
  card.appendChild(scopeBtn);
  paintScope(card, meta.noteId ?? null);

  return card;
}

// Documento novo cai na nota aberta: quem está importando quer o arquivo ali,
// não espalhado por todas. Soltar como geral depois é um clique no alfinete.
async function addFile(file) {
  const noteId = currentNoteId;
  const id     = await saveFile(file, noteId);
  const meta   = { id, name: file.name, type: file.type, noteId, createdAt: Date.now() };
  allMetas.push(meta);
  grid.appendChild(await buildCard(meta));
  paintView();
}

async function processFiles(files) {
  for (const file of files) {
    if (!isAllowed(file)) continue;
    await addFile(file);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────
export async function initDocuments() {
  // initNotesTabs() já rodou e definiu a nota aberta via setDocumentsNote().
  viewMode = await loadDocsView();
  allMetas = await carregarMetas();
  ready = true;
  await renderGrid();

  // Clique simples em card abre modal (sem modificadores)
  // Ctrl/Shift são tratados por selection.js via mousedown
  grid.addEventListener('click', e => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.target.closest('.doc-delete, .doc-inject')) return;
    const card = e.target.closest('.doc-card');
    if (!card) return;
    grid.querySelectorAll('.doc-card.last-opened').forEach(c => c.classList.remove('last-opened'));
    card.classList.add('last-opened');

    const type    = card.dataset.filetype;
    const gallery = type.startsWith('image/') ? getImageGalleryMetas() : null;
    openModal(Number(card.dataset.id), card.dataset.name, type, gallery);
  });

  // Seleção centralizada no módulo selection.js
  initSelection(grid, dropZone, updateGroupBar);

  btnUpload.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    processFiles([...fileInput.files]);
    fileInput.value = '';
  });

  // Clicar em qualquer canto desta seção passa a vez pros documentos: é o que
  // manda a próxima imagem colada vir pra cá em vez de entrar na nota. Em
  // captura, pra valer mesmo quando o alvo interrompe a propagação.
  docsSection?.addEventListener('mousedown', () => setActiveArea('docs'), true);

  // Ctrl+V — cola imagem da área de transferência
  document.addEventListener('paste', async e => {
    const imageItem = [...(e.clipboardData?.items ?? [])]
      .find(item => item.type.startsWith('image/'));
    if (!imageItem) return;

    e.preventDefault();

    const blob = imageItem.getAsFile();
    if (!blob) return;

    const extMap = { jpeg: 'jpg' };
    const rawExt = blob.type.split('/')[1] || 'png';
    const ext    = extMap[rawExt] || rawExt;
    const ts     = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const file   = new File([blob], `colado_${ts}.${ext}`, { type: blob.type });

    await addFile(file);
  });

  // Drop externo de arquivos no painel
  dropZone.addEventListener('dragover', e => {
    // Ignora se for rubber band ativo (não há files no dataTransfer)
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dropZone.classList.add('dragging');
  });
  dropZone.addEventListener('dragleave', e => {
    if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('dragging');
  });
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragging');
    if (e.dataTransfer?.files.length) {
      processFiles([...e.dataTransfer.files]);
    }
  });
}

// Troca de nota: só repinta o grid, sem reler o banco.
export async function setDocumentsNote(noteId) {
  currentNoteId = noteId;
  if (ready) await renderGrid();
}

// Usado quando algo mexeu nos arquivos por fora (ex.: excluir uma nota solta
// os documentos dela como gerais).
export async function refreshDocuments() {
  if (!ready) return;
  allMetas = await carregarMetas();
  await renderGrid();
}

