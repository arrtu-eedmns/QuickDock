// ── templates-gallery.js ───────────────────────────────────────────────────
// Gerenciador e renderizador da Galeria de Modelos em cards visuais.
// Suporta filtragem por abas, busca em tempo real, visualização de previews,
// criação de novo modelo, importação, exportação (.md), edição, duplicação e exclusão.

import {
  createTemplateRecord, deleteTemplateById, updateTemplateById,
} from './storage.js';
import {
  refreshTemplates, getTemplates, requestTemplateEdit,
} from './templates.js';
import { positionPopover } from './popover.js';
import { switchView, goBack } from './views.js';

let currentFilter = 'all'; // 'all' | 'note' | 'block'
let currentSearch = '';
let isInitialized = false;

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

function safeFilename(name) {
  return (name || 'modelo').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'modelo';
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function renderPreview(markdown) {
  const lines = (markdown || '').split('\n').slice(0, 8);
  if (lines.length === 0 || lines.every(l => !l.trim())) {
    return '<div class="preview-line preview-muted">Modelo em branco</div>';
  }
  return lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '<div class="preview-line preview-empty"></div>';
    if (trimmed.startsWith('### ')) {
      return `<div class="preview-line preview-h3">${escapeHtml(trimmed.slice(4))}</div>`;
    }
    if (trimmed.startsWith('## ')) {
      return `<div class="preview-line preview-h2">${escapeHtml(trimmed.slice(3))}</div>`;
    }
    if (trimmed.startsWith('# ')) {
      return `<div class="preview-line preview-h1">${escapeHtml(trimmed.slice(2))}</div>`;
    }
    if (trimmed.startsWith('- [ ] ') || trimmed.startsWith('- [x] ')) {
      const checked = trimmed.startsWith('- [x] ');
      return `<div class="preview-line preview-check"><span class="check-box ${checked ? 'checked' : ''}"></span><span>${escapeHtml(trimmed.slice(6))}</span></div>`;
    }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      return `<div class="preview-line preview-bullet">• <span>${escapeHtml(trimmed.slice(2))}</span></div>`;
    }
    if (trimmed.startsWith('> ')) {
      return `<div class="preview-line preview-quote">${escapeHtml(trimmed.slice(2))}</div>`;
    }
    return `<div class="preview-line preview-text">${escapeHtml(trimmed)}</div>`;
  }).join('');
}

let newMenuPopover = null;
function closeNewMenu() {
  newMenuPopover?.remove();
  newMenuPopover = null;
}

function openNewTemplateMenu(anchorBtn) {
  closeNewMenu();
  const menu = document.createElement('div');
  menu.className = 'copy-menu';

  const addOpt = (label, iconName, onClick) => {
    const btn = document.createElement('button');
    btn.className = 'copy-opt';
    btn.innerHTML = `
      <span class="qd-icon material-symbols-rounded" style="margin-right:8px">${iconName}</span>
      <span class="copy-opt-value">${escapeHtml(label)}</span>
    `;
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      closeNewMenu();
      await onClick();
    });
    menu.appendChild(btn);
  };

  addOpt('Modelo de Nota em branco', 'description', async () => {
    const id = await createTemplateRecord({ name: 'Novo modelo de nota', content: '# Título do modelo\n\nEscreva aqui o conteúdo padrão...', kind: 'note' });
    await refreshTemplates();
    requestTemplateEdit({ id, name: 'Novo modelo de nota', content: '# Título do modelo\n\nEscreva aqui o conteúdo padrão...', kind: 'note' });
    switchView('editor');
  });

  addOpt('Modelo de Bloco em branco', 'widgets', async () => {
    const id = await createTemplateRecord({ name: 'Novo modelo de bloco', content: '## Seção rápida\n- [ ] Item 1\n- [ ] Item 2', kind: 'block' });
    await refreshTemplates();
    requestTemplateEdit({ id, name: 'Novo modelo de bloco', content: '## Seção rápida\n- [ ] Item 1\n- [ ] Item 2', kind: 'block' });
    switchView('editor');
  });

  document.body.appendChild(menu);
  newMenuPopover = menu;
  positionPopover(menu, anchorBtn);
}

document.addEventListener('mousedown', e => {
  if (newMenuPopover && !newMenuPopover.contains(e.target)) closeNewMenu();
});

export async function renderTemplatesGallery(filter = currentFilter, search = currentSearch) {
  currentFilter = filter;
  currentSearch = search;

  const grid = document.getElementById('gallery-grid');
  const emptyEl = document.getElementById('gallery-empty');
  const countAll = document.getElementById('count-tab-all');
  const countNote = document.getElementById('count-tab-note');
  const countBlock = document.getElementById('count-tab-block');
  const galleryCount = document.getElementById('gallery-count');
  const navBadge = document.getElementById('nav-templates-count');

  if (!grid) return;

  const allTemplates = await getTemplates();

  const totalAll = allTemplates.length;
  const totalNotes = allTemplates.filter(t => t.kind === 'note').length;
  const totalBlocks = allTemplates.filter(t => t.kind === 'block').length;

  if (countAll) countAll.textContent = totalAll;
  if (countNote) countNote.textContent = totalNotes;
  if (countBlock) countBlock.textContent = totalBlocks;
  if (navBadge) navBadge.textContent = totalAll;

  // Filtragem
  let list = allTemplates;
  if (filter === 'note') list = list.filter(t => t.kind === 'note');
  if (filter === 'block') list = list.filter(t => t.kind === 'block');

  const s = search.trim().toLowerCase();
  if (s) {
    list = list.filter(t =>
      (t.name || '').toLowerCase().includes(s) ||
      (t.content || '').toLowerCase().includes(s)
    );
  }

  if (galleryCount) {
    galleryCount.textContent = list.length === 1 ? '1 modelo' : `${list.length} modelos`;
  }

  grid.innerHTML = '';

  if (list.length === 0) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }

  if (emptyEl) emptyEl.classList.add('hidden');

  for (const tpl of list) {
    const card = document.createElement('article');
    card.className = `template-card kind-${tpl.kind}`;
    card.dataset.id = tpl.id;
    card.dataset.kind = tpl.kind;

    const isBlock = tpl.kind === 'block';

    card.innerHTML = `
      <div class="template-card-header">
        <div class="template-card-badge ${isBlock ? 'badge-block' : 'badge-note'}">
          <span class="qd-icon material-symbols-rounded" aria-hidden="true">${isBlock ? 'widgets' : 'description'}</span>
          <span>${isBlock ? 'Bloco' : 'Nota'}</span>
        </div>
        <div class="template-card-actions-top">
          <button class="icon-btn template-card-btn-edit" title="Editar modelo" aria-label="Editar modelo">
            <span class="qd-icon material-symbols-rounded" aria-hidden="true">edit</span>
          </button>
        </div>
      </div>

      <div class="template-card-body">
        <h3 class="template-card-title" title="${escapeHtml(tpl.name)}">${escapeHtml(tpl.name)}</h3>
        <div class="template-card-preview">
          ${renderPreview(tpl.content)}
          <div class="template-card-preview-fade"></div>
        </div>
      </div>

      <div class="template-card-footer">
        <button class="template-card-use-btn" title="${isBlock ? 'Inserir este bloco na nota aberta' : 'Criar nova nota a partir deste modelo'}">
          <span class="qd-icon material-symbols-rounded" aria-hidden="true">${isBlock ? 'add_box' : 'note_add'}</span>
          <span>${isBlock ? 'Inserir Bloco' : 'Usar Modelo'}</span>
        </button>

        <div class="template-card-bottom-actions">
          <button class="icon-btn template-card-btn-copy" title="Duplicar modelo" aria-label="Duplicar">
            <span class="qd-icon material-symbols-rounded" aria-hidden="true">content_copy</span>
          </button>
          <button class="icon-btn template-card-btn-dl" title="Baixar arquivo .md" aria-label="Baixar markdown">
            <span class="qd-icon material-symbols-rounded" aria-hidden="true">download</span>
          </button>
          <button class="icon-btn template-card-btn-del danger" title="Excluir modelo" aria-label="Excluir">
            <span class="qd-icon material-symbols-rounded" aria-hidden="true">delete</span>
          </button>
        </div>
      </div>
    `;

    // Ação: Usar modelo
    const useBtn = card.querySelector('.template-card-use-btn');
    useBtn.addEventListener('click', async e => {
      e.stopPropagation();
      if (tpl.kind === 'note') {
        document.dispatchEvent(new CustomEvent('quickdock:use-template-note', { detail: { template: tpl } }));
      } else {
        document.dispatchEvent(new CustomEvent('quickdock:insert-template-blocks', { detail: { content: tpl.content } }));
      }
      switchView('editor');
    });

    // Ação: Editar modelo
    const editBtn = card.querySelector('.template-card-btn-edit');
    editBtn.addEventListener('click', e => {
      e.stopPropagation();
      requestTemplateEdit(tpl);
      switchView('editor');
    });

    // Ação: Duplicar
    const copyBtn = card.querySelector('.template-card-btn-copy');
    copyBtn.addEventListener('click', async e => {
      e.stopPropagation();
      await createTemplateRecord({
        name: `${tpl.name} (cópia)`,
        content: tpl.content,
        kind: tpl.kind,
      });
      await refreshTemplates();
      await renderTemplatesGallery();
    });

    // Ação: Baixar .md
    const dlBtn = card.querySelector('.template-card-btn-dl');
    dlBtn.addEventListener('click', e => {
      e.stopPropagation();
      downloadText(`${safeFilename(tpl.name)}.md`, tpl.content);
    });

    // Ação: Excluir
    const delBtn = card.querySelector('.template-card-btn-del');
    delBtn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Excluir o modelo "${tpl.name}" permanentemente?`)) return;
      await deleteTemplateById(tpl.id);
      await refreshTemplates();
      await renderTemplatesGallery();
    });

    grid.appendChild(card);
  }
}

export function initTemplatesGallery() {
  if (isInitialized) return;
  isInitialized = true;

  const btnBack = document.getElementById('btn-gallery-back');
  const searchInput = document.getElementById('gallery-search-input');
  const searchClear = document.getElementById('gallery-search-clear');
  const btnNew = document.getElementById('btn-gallery-new');
  const btnImport = document.getElementById('btn-gallery-import');
  const importInput = document.getElementById('gallery-import-input');
  const emptyCreateBtn = document.getElementById('gallery-empty-create-btn');

  if (btnBack) btnBack.addEventListener('click', goBack);

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const val = searchInput.value;
      if (searchClear) searchClear.hidden = !val;
      renderTemplatesGallery(currentFilter, val);
    });
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (searchInput.value) {
          e.stopPropagation();
          searchInput.value = '';
          if (searchClear) searchClear.hidden = true;
          renderTemplatesGallery(currentFilter, '');
        }
      }
    });
  }

  if (searchClear) {
    searchClear.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      searchClear.hidden = true;
      renderTemplatesGallery(currentFilter, '');
      searchInput?.focus();
    });
  }

  // Abas de filtro
  const tabs = document.querySelectorAll('.gallery-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const filter = tab.dataset.filter || 'all';
      renderTemplatesGallery(filter, currentSearch);
    });
  });

  if (btnNew) {
    btnNew.addEventListener('click', e => {
      e.stopPropagation();
      openNewTemplateMenu(btnNew);
    });
  }

  if (emptyCreateBtn && btnNew) {
    emptyCreateBtn.addEventListener('click', e => {
      e.stopPropagation();
      openNewTemplateMenu(emptyCreateBtn);
    });
  }

  if (btnImport && importInput) {
    btnImport.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
      const file = importInput.files[0];
      importInput.value = '';
      if (!file) return;
      const content = await file.text();
      const name = file.name.replace(/\.(md|txt)$/i, '') || 'Modelo importado';
      await createTemplateRecord({ name, content, kind: 'note' });
      await refreshTemplates();
      await renderTemplatesGallery();
    });
  }

  // Escuta evento para atualizar a galeria sempre que ativada
  document.addEventListener('quickdock:refresh-templates-gallery', () => {
    renderTemplatesGallery();
  });

  // Render inicial
  renderTemplatesGallery();
}
