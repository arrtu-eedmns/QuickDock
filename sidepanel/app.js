import { initNotesTabs, createTutorialNote, downloadAllNotes, refreshNotesList, getActiveNoteUid } from './modules/notes-tabs.js';
import { positionPopover } from './modules/popover.js';
import { initDocuments } from './modules/documents.js';
import { loadTheme, saveTheme } from './modules/storage.js';
import { initResizer } from './modules/resizer.js';
import { SyncController, SYNC_STATE } from './modules/sync-controller.js';
import { canSafelyReloadCurrentNote, switchToNote, flushSave, isEditingTemplate, setImageResolver } from './modules/note.js';

const btnAppMenu = document.getElementById('btn-app-menu');
const btnSync    = document.getElementById('btn-sync');
const html       = document.documentElement;

let syncController = null;

function applyTheme(theme) {
  html.setAttribute('data-theme', theme);
}

async function initTheme() {
  let theme = await loadTheme();
  if (!theme) {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme(theme);
}

async function toggleTheme() {
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  await saveTheme(next);
  applyTheme(next);
}

// ── Menu "⋯" ──────────────────────────────────────────────────────────────────
// Tutorial e tema viviam num header próprio, que repetia o ícone e o nome que
// o painel lateral do Chrome já mostra. Limpar/excluir é por nota, no menu da
// própria aba — com várias notas, um botão que apagava tudo de uma vez só
// convidava ao acidente.
let appMenuEl = null;

function closeAppMenu() {
  appMenuEl?.remove();
  appMenuEl = null;
}

function openAppMenu() {
  const menu = document.createElement('div');
  menu.className = 'copy-menu app-menu';

  const addOpt = (label, onClick, className = '') => {
    const opt = document.createElement('button');
    opt.className = `copy-opt ${className}`.trim();
    opt.textContent = label;
    opt.addEventListener('click', async () => {
      closeAppMenu();
      await onClick();
    });
    menu.appendChild(opt);
  };

  const dark = html.getAttribute('data-theme') === 'dark';
  addOpt('📘  Ver tutorial', createTutorialNote);
  addOpt(dark ? '☀️  Tema claro' : '🌙  Tema escuro', toggleTheme);
  addOpt('🔄  Sincronização…', () => syncController?.abrirPopover(btnAppMenu));

  menu.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));

  // Um arquivo com tudo dentro. Existe pra que atualizar a extensão nunca
  // dependa de confiança: dá pra guardar as notas antes e conferir depois.
  addOpt('💾  Baixar todas as notas', downloadAllNotes);

  document.body.appendChild(menu);
  appMenuEl = menu;
  positionPopover(menu, btnAppMenu);
}

btnAppMenu.addEventListener('click', e => {
  e.stopPropagation();
  if (appMenuEl) closeAppMenu();
  else openAppMenu();
});

// O próprio botão fica de fora: mousedown vem antes do click, então fechar
// aqui faria o clique seguinte reabrir o menu que se acabou de fechar.
document.addEventListener('mousedown', e => {
  if (!appMenuEl) return;
  if (appMenuEl.contains(e.target) || btnAppMenu.contains(e.target)) return;
  closeAppMenu();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAppMenu();
});

// O véu costuma durar só alguns milissegundos: sem um piso ele vira um flash de
// um frame, que lê como glitch em vez de carregamento.
const BOOT_MIN_MS = 120;
const bootStartedAt = performance.now();

function revealApp() {
  const remaining = Math.max(0, BOOT_MIN_MS - (performance.now() - bootStartedAt));
  setTimeout(() => document.body.classList.remove('booting'), remaining);
}

async function init() {
  try {
    await initTheme();
    await initNotesTabs();
    await initDocuments();
    await initResizer();

    syncController = new SyncController({
      onNotesChanged: refreshNotesList,
      obterNotaAbertaUid: getActiveNoteUid,
      podeRecarregarNotaAberta: canSafelyReloadCurrentNote,
      recarregarNotaAberta: async id => {
        if (id != null) await switchToNote(id);
      },
      antesDeSincronizar: flushSave,
      emModoModelo: isEditingTemplate,
    });
    await syncController.inicializar();
    setImageResolver((caminho, noteId) => syncController?.resolverImagem(caminho, noteId));

    // Atualiza estado visual do botão de sincronização
    syncController.adicionarListener(resumo => {
      if (!btnSync) return;
      btnSync.classList.toggle('spinning', resumo.state === SYNC_STATE.SYNCING);
      btnSync.classList.toggle('has-error', resumo.state === SYNC_STATE.ERROR);
      btnSync.classList.toggle('needs-reauth', resumo.state === SYNC_STATE.NEEDS_REAUTH);
      btnSync.classList.toggle('has-conflict', (resumo.totalConflitos || 0) > 0);

      if (resumo.state === SYNC_STATE.SYNCING) {
        btnSync.title = 'Sincronizando notas…';
      } else if (resumo.totalConflitos > 0) {
        btnSync.title = `Sincronização: ${resumo.totalConflitos} conflito(s) detectado(s) — clique para detalhes`;
      } else if (resumo.state === SYNC_STATE.ERROR) {
        btnSync.title = `Erro de sincronização: ${resumo.lastSyncError || 'Falha ao sincronizar'}`;
      } else if (resumo.state === SYNC_STATE.NEEDS_REAUTH) {
        btnSync.title = 'Acesso à pasta precisa ser reautorizado';
      } else if (resumo.folderName) {
        btnSync.title = `Sincronização ativa (${resumo.folderName})`;
      } else {
        btnSync.title = 'Sincronização (desconectado)';
      }
    });

    btnSync?.addEventListener('click', e => {
      e.stopPropagation();
      syncController.abrirPopover(btnSync);
    });

    // Tarefa 5: Debounce de ~20s após parar de digitar (nunca a cada tecla)
    document.querySelector('.note-editor')?.addEventListener('input', () => {
      syncController?.notificarAtividadeEditor();
    });
  } finally {
    // no finally: se um init falhar, o painel ainda aparece em vez de travar no véu
    revealApp();
  }
}

init();

// ── Registra este painel no background (necessário para o toggle Ctrl+Q) ───────
const _panelPort = chrome.runtime.connect({ name: 'sidepanel' });
_panelPort.onMessage.addListener(msg => {
  if (msg.type === 'close') window.close();
});
