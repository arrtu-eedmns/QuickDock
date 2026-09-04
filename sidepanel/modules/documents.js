import { saveFile, loadAllFilesMeta, deleteFile, loadFileBlob } from './storage.js';
import { openModal } from './modal.js';
import { startInject, startInjectMultiple } from './inject.js';
import { initSelection, clearSelection, getSelectedMetas } from './selection.js';

const grid           = document.getElementById('doc-grid');
const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('file-input');
const btnUpload      = document.getElementById('btn-upload');
const groupBar       = document.getElementById('group-bar');
const groupCount     = document.getElementById('group-count');
const btnInjectSel   = document.getElementById('btn-inject-selected');
const btnDeleteSel   = document.getElementById('btn-delete-selected');
const btnClearSel    = document.getElementById('btn-clear-selection');

const ALLOWED_TYPES = ['image/', 'application/pdf', 'text/plain'];

// ── Group bar ────────────────────────────────────────────────────────────────
function updateGroupBar() {
  const metas = getSelectedMetas();
  if (metas.length === 0) {
    groupBar.classList.add('hidden');
    return;
  }
  groupBar.classList.remove('hidden');
  groupCount.textContent = `${metas.length} selecionado${metas.length > 1 ? 's' : ''}`;
}

// ── Ações da group bar ───────────────────────────────────────────────────────
btnClearSel.addEventListener('click', clearSelection);

btnDeleteSel.addEventListener('click', async () => {
  const metas = getSelectedMetas();
  if (!metas.length) return;
  for (const { id } of metas) {
    await deleteFile(id);
    grid.querySelector(`.doc-card[data-id="${id}"]`)?.remove();
  }
  clearSelection();
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
    card.remove();
    // Refresca group bar caso o card deletado estivesse selecionado
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

  return card;
}

async function processFiles(files) {
  for (const file of files) {
    if (!isAllowed(file)) continue;
    const id   = await saveFile(file);
    const card = await buildCard({ id, name: file.name, type: file.type });
    grid.appendChild(card);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────
export async function initDocuments() {
  const metas = await loadAllFilesMeta();
  for (const meta of metas) {
    grid.appendChild(await buildCard(meta));
  }

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

    const id   = await saveFile(file);
    const card = await buildCard({ id, name: file.name, type: file.type });
    grid.appendChild(card);
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

export function clearDocuments() {
  grid.innerHTML = '';
  clearSelection();
}
