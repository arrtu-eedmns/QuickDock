// ── platform.js ────────────────────────────────────────────────────────────
// Camada de plataforma do QuickDock.
//
// Unifica o acesso a recursos do ambiente em duas implementações atrás da mesma
// interface:
//   1. Extensão do Chrome (Manifest V3): usa `chrome.storage.local`, consulta `chrome.tabs`
//      para injeção e se conecta ao runtime para o atalho de fechar painel.
//   2. Web / PWA: sem `chrome.*`, usa tabela `preferences` do Dexie (com fallback para
//      `localStorage`), não possui capacidade de injeção em abas do navegador e
//      opera sem o canal de runtime.
//
// Decisão de projeto (ver HANDOFF-5.md Tarefa 2):
// - A extensão NÃO muda de comportamento em absolutamente nada.
// - Nenhum módulo de persistência (storage.js) fala com `chrome.*` diretamente.

let _db = null;
const _memStorage = new Map();

export function setPlatformDb(db) {
  _db = db;
}

// Detecta se estamos rodando dentro do contexto de extensão com permissão de storage
export const isExtension = typeof chrome !== 'undefined' && !!chrome?.storage?.local;

/**
 * Armazenamento assíncrono de chave-valor para preferências (tema, layout, notas ativas, histórico).
 */
export const platformStorage = {
  async get(key) {
    if (isExtension) {
      return new Promise(resolve => {
        chrome.storage.local.get(key, obj => resolve(obj?.[key]));
      });
    }

    // Ambiente Web / PWA: prioriza a tabela do Dexie se disponível
    if (_db && _db.preferences) {
      try {
        const row = await _db.preferences.get(key);
        return row ? row.valor : undefined;
      } catch {
        // Se o banco estiver fechado ou migrando, recorre ao localStorage
      }
    }

    if (typeof localStorage !== 'undefined') {
      try {
        const item = localStorage.getItem(`qd_${key}`);
        return item !== null ? JSON.parse(item) : undefined;
      } catch {
        return undefined;
      }
    }

    // Fallback de memória para testes e ambientes sem DOM
    return _memStorage.get(key);
  },

  async set(key, value) {
    if (isExtension) {
      return new Promise(resolve => {
        chrome.storage.local.set({ [key]: value }, resolve);
      });
    }

    // Ambiente Web / PWA: persiste no Dexie e no localStorage para garantia de leitura
    if (_db && _db.preferences) {
      try {
        await _db.preferences.put({ chave: key, valor: value });
      } catch {}
    }

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`qd_${key}`, JSON.stringify(value));
      } catch {}
    }

    _memStorage.set(key, value);
  },

  async remove(key) {
    if (isExtension) {
      return new Promise(resolve => {
        chrome.storage.local.remove(key, resolve);
      });
    }

    if (_db && _db.preferences) {
      try {
        await _db.preferences.delete(key);
      } catch {}
    }

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(`qd_${key}`);
      } catch {}
    }

    _memStorage.delete(key);
  },
};

/**
 * Consulta de capacidade: indica se o ambiente suporta enviar arquivos para
 * elementos de páginas ativas (requer chrome.tabs e content scripts da extensão).
 * Em um PWA / Web, esta capacidade não existe e os botões não devem nem ser criados.
 */
export function podeInserirNaPagina() {
  return isExtension && typeof chrome !== 'undefined' && !!chrome?.tabs && !!chrome?.runtime?.sendMessage;
}

/**
 * Registra o painel no background da extensão para receber comandos do atalho (Ctrl+Q).
 * Na Web / PWA, não há background e a função é uma operação nula segura.
 */
export function conectarPainel() {
  if (isExtension && typeof chrome !== 'undefined' && chrome?.runtime?.connect) {
    try {
      const port = chrome.runtime.connect({ name: 'sidepanel' });
      port.onMessage.addListener(msg => {
        if (msg?.type === 'close') window.close();
      });
      return port;
    } catch {
      return null;
    }
  }
  return null;
}
