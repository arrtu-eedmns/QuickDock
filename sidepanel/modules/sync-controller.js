// ── sync-controller.js ───────────────────────────────────────────────────────
// Controlador de sincronização e interface com o painel do QuickDock.
//
// Faz a ponte entre a UI (botão, popover, estados de conexão), o motor
// SyncEngine, o adaptador de pasta local (LocalFolderAdapter) e o Dexie.
//
// Decisões de projeto (ver PLANEJAMENTO.md e HANDOFF-2.md):
// 1. Sincronização nunca bloqueia a digitação do usuário: roda em segundo plano.
// 2. Sem pasta escolhida, a extensão continua 100% local como antes.
// 3. O FileSystemDirectoryHandle é persistido no IndexedDB (syncMeta), permitindo
//    que a pasta permaneça vinculada entre fechamentos e reaberturas do painel.
// 4. queryPermission é chamado silenciosamente na abertura. Se a permissão não
//    estiver ativa, NÃO pedimos via requestPermission automaticamente, pois o
//    navegador exige gesto do usuário (clique). Exibimos "precisa reautorizar".
// 5. Conexão e desconexão não tocam nos arquivos do disco nem nas notas do Dexie.
// 6. Mutex rígido: duas rodadas nunca se sobrepõem. Falhas não viram laço infinito.

import { SyncEngine } from './sync-engine.js';
import { LocalFolderAdapter } from './local-folder-adapter.js';
import { DexieSyncStore, getSyncMeta, setSyncMeta, deleteSyncMeta, db } from './storage.js';
import { positionPopover } from './popover.js';

export const SYNC_STATE = {
  DISCONNECTED: 'disconnected',
  NEEDS_REAUTH: 'needs-reauth',
  SYNCING: 'syncing',
  IDLE: 'idle',
  ERROR: 'error',
};

function formatarDataRelativa(timestamp) {
  if (!timestamp) return 'Nunca';
  const agora = Date.now();
  const diffSegundos = Math.floor((agora - timestamp) / 1000);

  if (diffSegundos < 10) return 'Agora mesmo';
  if (diffSegundos < 60) return `Há ${diffSegundos}s`;
  const diffMinutos = Math.floor(diffSegundos / 60);
  if (diffMinutos < 60) return `Há ${diffMinutos} min`;
  const data = new Date(timestamp);
  return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function obterNomeAparelhoPadrao() {
  const plataforma = (typeof navigator !== 'undefined' && navigator.userAgentData?.platform)
    ? navigator.userAgentData.platform
    : (typeof navigator !== 'undefined' && /win/i.test(navigator.platform) ? 'Windows' : 'Desktop');
  return `QuickDock (${plataforma})`;
}

export class SyncController {
  constructor({
    onNotesChanged = null,
    store = null,
    adapter = null,
    obterNotaAbertaUid = null,
    podeRecarregarNotaAberta = null,
    recarregarNotaAberta = null,
    antesDeSincronizar = null,
    emModoModelo = null,
  } = {}) {
    this.onNotesChanged = onNotesChanged;
    this.customStore = store;
    this.customAdapter = adapter;
    this.obterNotaAbertaUid = obterNotaAbertaUid;
    this.podeRecarregarNotaAberta = podeRecarregarNotaAberta;
    this.recarregarNotaAberta = recarregarNotaAberta;
    this.antesDeSincronizar = antesDeSincronizar;
    this.emModoModelo = emModoModelo;

    this.state = SYNC_STATE.DISCONNECTED;
    this.folderName = null;
    this.rootHandle = null;
    this.deviceName = obterNomeAparelhoPadrao();
    this.lastSyncAt = null;
    this.lastSyncError = null;
    this.lastStats = null;
    this.conflitosPendentes = [];

    this.engine = null;
    this.isSyncing = false;
    this.syncPending = false;
    this.debounceTimer = null;
    this.statusListeners = new Set();
    this.popoverEl = null;
  }

  // Encapsula leitura e gravação de metadados: se o SyncController recebeu
  // um store customizado (em testes ou no banco de provas), opera sobre ele;
  // em produção, delega para as funções do Dexie em storage.js.
  async _obterMeta(chave) {
    if (this.customStore && typeof this.customStore.obterMeta === 'function') {
      return await this.customStore.obterMeta(chave);
    }
    return await getSyncMeta(chave);
  }

  async _salvarMeta(chave, valor) {
    if (this.customStore && typeof this.customStore.salvarMeta === 'function') {
      return await this.customStore.salvarMeta(chave, valor);
    }
    return await setSyncMeta(chave, valor);
  }

  async _excluirMeta(chave) {
    if (this.customStore && typeof this.customStore.excluirMeta === 'function') {
      return await this.customStore.excluirMeta(chave);
    }
    return await deleteSyncMeta(chave);
  }

  adicionarListener(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  _notificar() {
    for (const fn of this.statusListeners) {
      try { fn(this.obterResumoEstado()); } catch {}
    }
  }

  obterResumoEstado() {
    return {
      state: this.state,
      folderName: this.folderName,
      deviceName: this.deviceName,
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      lastStats: this.lastStats,
      isSyncing: this.isSyncing,
      conflitosPendentes: this.conflitosPendentes,
      totalConflitos: this.conflitosPendentes.length,
    };
  }

  async inicializar() {
    // Carrega dados persistidos do IndexedDB
    try {
      this.folderName = (await this._obterMeta('folderName')) ?? null;
      this.deviceName = (await this._obterMeta('deviceName')) ?? obterNomeAparelhoPadrao();
      this.lastSyncAt = (await this._obterMeta('lastSyncAt')) ?? null;
      this.lastSyncError = (await this._obterMeta('lastSyncError')) ?? null;
      this.lastStats = (await this._obterMeta('lastSyncStats')) ?? null;
      this.conflitosPendentes = (await this._obterMeta('syncPendingConflicts')) || [];

      // Recupera o handle da pasta salva
      const handleSalvo = await this._obterMeta('folderHandle');
      if (handleSalvo && typeof handleSalvo.queryPermission === 'function') {
        this.rootHandle = handleSalvo;
        // Verifica silenciosamente se a permissão continua ativa
        const status = await handleSalvo.queryPermission({ mode: 'readwrite' });
        if (status === 'granted') {
          await this._montarEngine(handleSalvo);
          this.state = SYNC_STATE.IDLE;
        } else {
          // Requer gesto do usuário: não pede agora, sinaliza no estado
          this.state = SYNC_STATE.NEEDS_REAUTH;
        }
      } else if (this.customAdapter) {
        // Modo de testes injetado
        await this._montarEngineComAdapter(this.customAdapter);
        this.state = SYNC_STATE.IDLE;
      } else {
        this.state = SYNC_STATE.DISCONNECTED;
      }
    } catch (err) {
      this.state = SYNC_STATE.ERROR;
      this.lastSyncError = err?.message || String(err);
    }

    this._notificar();

    // Se estiver tudo pronto e autorizado, dispara sincronização inicial ao abrir
    if (this.state === SYNC_STATE.IDLE) {
      this.sincronizarAgora();
    }

    // Registra listener de foco da janela: quando a pessoa volta pro Chrome, sincroniza
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => {
        if (this.state === SYNC_STATE.IDLE && !this.isSyncing) {
          this.sincronizarAgora();
        }
      });
    }
  }

  async _montarEngine(rootHandle) {
    const adapter = new LocalFolderAdapter({ rootHandle });
    await this._montarEngineComAdapter(adapter);
  }

  async _montarEngineComAdapter(adapter) {
    const store = this.customStore || (db ? new DexieSyncStore(db) : null);
    if (!store) return;

    this.engine = new SyncEngine({
      adapter,
      store,
      deviceName: this.deviceName,
      obterNotaAbertaUid: this.obterNotaAbertaUid,
      podeRecarregarNotaAberta: this.podeRecarregarNotaAberta,
      recarregarNotaAberta: async (id, uid) => {
        if (this.recarregarNotaAberta) await this.recarregarNotaAberta(id, uid);
        if (this.onNotesChanged) await this.onNotesChanged();
      },
      antesDeSincronizar: this.antesDeSincronizar,
      emModoModelo: this.emModoModelo,
    });
  }

  // Notifica digitação no editor: agenda sincronização com debounce de 20 segundos
  notificarAtividadeEditor() {
    if (this.state !== SYNC_STATE.IDLE && this.state !== SYNC_STATE.SYNCING) return;
    clearTimeout(this.debounceTimer);
    // 20 segundos de pausa: sincronização que roda a cada tecla trava o editor
    this.debounceTimer = setTimeout(() => {
      this.sincronizarAgora();
    }, 20000);
  }

  async escolherPasta() {
    if (typeof window === 'undefined' || !window.showDirectoryPicker) {
      throw new Error('File System Access API não é suportada neste navegador.');
    }

    // Gesto do usuário direto do clique
    const handle = await window.showDirectoryPicker({
      id: 'quickdock-sync-folder',
      mode: 'readwrite',
    });

    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      const pedido = await handle.requestPermission({ mode: 'readwrite' });
      if (pedido !== 'granted') {
        throw new Error('Permissão de leitura e escrita não foi concedida.');
      }
    }

    this.rootHandle = handle;
    this.folderName = handle.name;

    await this._salvarMeta('folderHandle', handle);
    await this._salvarMeta('folderName', handle.name);

    await this._montarEngine(handle);
    this.state = SYNC_STATE.IDLE;
    this.lastSyncError = null;
    this._notificar();

    // Dispara a primeira sincronização imediatamente após escolher a pasta
    await this.sincronizarAgora();
  }

  async reautorizar() {
    if (!this.rootHandle) return;
    const perm = await this.rootHandle.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      await this._montarEngine(this.rootHandle);
      this.state = SYNC_STATE.IDLE;
      this.lastSyncError = null;
      this._notificar();
      await this.sincronizarAgora();
    } else {
      this.state = SYNC_STATE.NEEDS_REAUTH;
      this._notificar();
    }
  }

  async desconectar() {
    clearTimeout(this.debounceTimer);
    // Desconectar apenas para de sincronizar: NUNCA apaga notas locais nem arquivos da pasta
    await this._excluirMeta('folderHandle');
    await this._excluirMeta('folderName');
    await this._excluirMeta('lastSyncAt');
    await this._excluirMeta('lastSyncError');
    await this._excluirMeta('lastSyncStats');
    await this._excluirMeta('syncPendingConflicts');

    this.rootHandle = null;
    this.folderName = null;
    this.engine = null;
    this.state = SYNC_STATE.DISCONNECTED;
    this.lastSyncError = null;
    this.lastStats = null;
    this.conflitosPendentes = [];
    this._notificar();
  }

  async dispensarConflitos() {
    this.conflitosPendentes = [];
    await this._excluirMeta('syncPendingConflicts');
    this._notificar();
  }

  async resolverImagem(caminhoImagem, notaUid = null) {
    if (!this.engine) return null;
    return this.engine.resolverImagem(caminhoImagem, notaUid);
  }

  async definirNomeAparelho(nome) {
    const limpo = (nome ?? '').trim();
    if (!limpo) return;
    this.deviceName = limpo;
    await this._salvarMeta('deviceName', limpo);
    if (this.engine) this.engine.deviceName = limpo;
    this._notificar();
  }

  async sincronizarAgora() {
    if (!this.engine || this.state === SYNC_STATE.DISCONNECTED || this.state === SYNC_STATE.NEEDS_REAUTH) {
      return;
    }

    // Mutex: se já está rodando, anota pendência para rodar mais uma vez ao terminar,
    // sem nunca disparar duas rodadas concorrentes.
    if (this.isSyncing) {
      this.syncPending = true;
      return;
    }

    this.isSyncing = true;
    const estadoAnterior = this.state;
    this.state = SYNC_STATE.SYNCING;
    this._notificar();

    try {
      const resultado = await this.engine.sincronizar();

      if (resultado.abortadoModelo) {
        this.state = estadoAnterior;
        return;
      }

      this.lastSyncAt = Date.now();
      this.lastSyncError = null;
      this.lastStats = resultado;
      this.state = SYNC_STATE.IDLE;

      if (Array.isArray(resultado.notasConflito) && resultado.notasConflito.length > 0) {
        this.conflitosPendentes.push(...resultado.notasConflito);
        await this._salvarMeta('syncPendingConflicts', this.conflitosPendentes);
      }

      await this._salvarMeta('lastSyncAt', this.lastSyncAt);
      await this._salvarMeta('lastSyncStats', this.lastStats);
      await this._excluirMeta('lastSyncError');

      // Se houve alterações remotas que entraram no banco local, atualiza as abas
      if (resultado.baixadas > 0 || resultado.conflitos > 0 || resultado.apagadas > 0) {
        if (this.onNotesChanged) await this.onNotesChanged();
      }
    } catch (err) {
      // Estado de erro explícito: falha calada faz a pessoa achar que está segura
      this.state = SYNC_STATE.ERROR;
      this.lastSyncError = err?.message || String(err);
      await this._salvarMeta('lastSyncError', this.lastSyncError);
    } finally {
      this.isSyncing = false;
      this._notificar();

      if (this.syncPending) {
        this.syncPending = false;
        // Executa a rodada pendente
        setTimeout(() => this.sincronizarAgora(), 50);
      }
    }
  }

  // ── Renderização do Popover da Seção de Sincronização ─────────────────────────
  abrirPopover(anchorEl) {
    this.fecharPopover();

    const menu = document.createElement('div');
    menu.className = 'copy-menu sync-menu';
    this.popoverEl = menu;

    const renderConteudo = () => {
      menu.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'copy-menu-header';
      header.textContent = 'Sincronização';
      menu.appendChild(header);

      // Caixa de status
      const statusBox = document.createElement('div');
      statusBox.className = 'sync-status-box';

      if (this.state === SYNC_STATE.DISCONNECTED) {
        statusBox.innerHTML = `
          <div class="sync-desc">Sincronize suas notas como arquivos <code>.md</code> em uma pasta local, no OneDrive ou Syncthing.</div>
          <button class="copy-opt sync-action-btn sync-btn-primary" id="sync-btn-escolher">
            📁 Escolher pasta…
          </button>
        `;
      } else if (this.state === SYNC_STATE.NEEDS_REAUTH) {
        statusBox.innerHTML = `
          <div class="sync-folder-label">Pasta: <strong>${this.folderName || 'Selecionada'}</strong></div>
          <div class="sync-badge sync-badge-warn">Acesso precisa ser reautorizado</div>
          <button class="copy-opt sync-action-btn sync-btn-primary" id="sync-btn-reautorizar">
            🔑 Reautorizar acesso
          </button>
        `;
      } else {
        const textoData = formatarDataRelativa(this.lastSyncAt);
        const statusTexto = this.state === SYNC_STATE.SYNCING
          ? 'Sincronizando…'
          : (this.state === SYNC_STATE.ERROR ? 'Erro na última tentativa' : `Última sincronização: ${textoData}`);

        const classeBadge = this.state === SYNC_STATE.ERROR
          ? 'sync-badge-error'
          : (this.state === SYNC_STATE.SYNCING ? 'sync-badge-busy' : 'sync-badge-ok');

        let detalhesErro = '';
        if (this.state === SYNC_STATE.ERROR && this.lastSyncError) {
          detalhesErro = `<div class="sync-error-msg">${this.lastSyncError}</div>`;
        }

        statusBox.innerHTML = `
          <div class="sync-folder-label">Pasta: <strong>${this.folderName || 'Local'}</strong></div>
          <div class="sync-badge ${classeBadge}">${statusTexto}</div>
          ${detalhesErro}
          <div class="sync-actions-row">
            <button class="copy-opt sync-action-btn sync-btn-primary" id="sync-btn-agora" ${this.isSyncing ? 'disabled' : ''}>
              ${this.isSyncing ? '⏳ Sincronizando…' : '🔄 Sincronizar agora'}
            </button>
            <button class="copy-opt sync-action-btn sync-btn-danger" id="sync-btn-desconectar" title="Desconectar sem apagar arquivos">
              Desconectar
            </button>
          </div>
        `;
      }

      menu.appendChild(statusBox);

      // Caixa de aviso de conflitos se houver cópias pendentes de visualização
      if (this.conflitosPendentes && this.conflitosPendentes.length > 0) {
        const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const conflictBox = document.createElement('div');
        conflictBox.className = 'sync-conflict-box';
        const listaHtml = this.conflitosPendentes
          .map(c => `<li><strong>${esc(c.tituloOriginal || 'Nota')}</strong> → <em>${esc(c.tituloConflito || 'Cópia')}</em></li>`)
          .join('');
        conflictBox.innerHTML = `
          <div class="sync-conflict-box-title">⚠ Conflito detectado (${this.conflitosPendentes.length})</div>
          <div class="sync-conflict-box-desc">Edições em aparelhos diferentes geraram cópias de segurança:</div>
          <ul class="sync-conflict-box-list">${listaHtml}</ul>
          <div class="sync-conflict-box-hint">Você pode comparar as notas e apagar a cópia quando desejar.</div>
          <button class="copy-opt sync-action-btn sync-btn-dismiss" id="sync-btn-dispensar-conflitos">
            Dispensar aviso
          </button>
        `;
        menu.appendChild(conflictBox);
      }

      // Eventos dos botões internos
      menu.querySelector('#sync-btn-dispensar-conflitos')?.addEventListener('click', async () => {
        await this.dispensarConflitos();
        renderConteudo();
      });

      menu.querySelector('#sync-btn-escolher')?.addEventListener('click', async () => {
        try {
          await this.escolherPasta();
          renderConteudo();
        } catch (e) {
          alert(`Não foi possível selecionar a pasta: ${e.message}`);
        }
      });

      menu.querySelector('#sync-btn-reautorizar')?.addEventListener('click', async () => {
        await this.reautorizar();
        renderConteudo();
      });

      menu.querySelector('#sync-btn-agora')?.addEventListener('click', async () => {
        await this.sincronizarAgora();
        renderConteudo();
      });

      menu.querySelector('#sync-btn-desconectar')?.addEventListener('click', async () => {
        if (confirm('Desconectar esta pasta de sincronização?\n\nNenhuma nota ou arquivo será apagado.')) {
          await this.desconectar();
          renderConteudo();
        }
      });
    };

    renderConteudo();
    document.body.appendChild(menu);
    positionPopover(menu, anchorEl);

    // Atualiza o popover se o estado mudar enquanto estiver aberto
    const cancelarListener = this.adicionarListener(() => {
      if (document.body.contains(menu)) {
        renderConteudo();
        positionPopover(menu, anchorEl);
      }
    });

    const onMouseDown = e => {
      if (menu.contains(e.target) || anchorEl.contains(e.target)) return;
      this.fecharPopover();
      cancelarListener();
      document.removeEventListener('mousedown', onMouseDown);
    };

    setTimeout(() => document.addEventListener('mousedown', onMouseDown), 0);
  }

  fecharPopover() {
    if (this.popoverEl) {
      this.popoverEl.remove();
      this.popoverEl = null;
    }
  }
}
