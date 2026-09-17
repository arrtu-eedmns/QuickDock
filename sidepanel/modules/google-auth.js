// ── google-auth.js ─────────────────────────────────────────────────────────
// De onde sai o access token do Google.
//
// São dois fluxos sem nada em comum, e é por isso que o adaptador do Drive
// recebe `obterToken` de fora em vez de resolver isso sozinho:
//
//   Extensão — chrome.identity.getAuthToken. O Chrome usa a conta em que o
//   navegador já está logado, cuida da tela de permissão e guarda o token. Não
//   há senha, não há redirect, não há código remoto (que o MV3 proibiria).
//
//   PWA — fluxo de navegador, tratado à parte. Ainda não implementado aqui.
//
// Quem chama não precisa saber qual dos dois está em uso.

import { isExtension } from './platform.js';
import { GOOGLE_ESCOPO } from './google-config.js';

/**
 * Token para a extensão.
 *
 * `interactive: false` tenta em silêncio e falha se precisar de interação —
 * é o que se usa nas sincronizações automáticas, para o painel nunca abrir uma
 * janela de permissão sozinho enquanto a pessoa digita.
 *
 * `interactive: true` é só para quando a pessoa clicou em conectar.
 */
export function obterTokenExtensao({ interativo = false } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome?.identity?.getAuthToken) {
      reject(new Error('chrome.identity não está disponível'));
      return;
    }
    chrome.identity.getAuthToken({ interactive: interativo }, token => {
      const erro = chrome.runtime?.lastError;
      if (erro || !token) {
        reject(new Error(erro?.message || 'Não foi possível obter o token do Google'));
        return;
      }
      resolve(token);
    });
  });
}

/**
 * Descarta um token que o Google recusou.
 *
 * O Chrome guarda o token em cache e continua entregando o mesmo mesmo depois
 * de ele expirar ou ser revogado. Sem remover do cache, a sincronização entraria
 * num 401 permanente: pedir de novo devolveria exatamente o token recusado.
 */
export function descartarTokenExtensao(token) {
  return new Promise(resolve => {
    if (typeof chrome === 'undefined' || !chrome?.identity?.removeCachedAuthToken || !token) {
      resolve();
      return;
    }
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

/**
 * Desconectar de verdade: além de tirar do cache, revoga o token no Google.
 * Sem a revogação, o app continuaria autorizado na conta da pessoa e o próximo
 * "conectar" entraria sem perguntar nada — o que não é o que quem clicou em
 * desconectar espera.
 */
export async function revogarTokenExtensao(token) {
  if (!token) return;
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
      { method: 'POST' });
  } catch { /* offline: o descarte do cache abaixo já basta para esta sessão */ }
  await descartarTokenExtensao(token);
}

/**
 * Provedor de token pronto para entregar ao GoogleDriveAdapter.
 *
 * Guarda o último token entregue para conseguir descartá-lo quando o Drive
 * recusar, e tenta uma vez em silêncio antes de pedir interação. Um token
 * recusado sem descarte vira 401 eterno — ver `descartarTokenExtensao`.
 */
export function criarProvedorDeToken({ aoPrecisarDeLogin = null } = {}) {
  let ultimo = null;

  async function obter({ interativo = false } = {}) {
    const token = await obterTokenExtensao({ interativo });
    ultimo = token;
    return token;
  }

  return {
    ehSuportado: () => isExtension,
    tokenAtual: () => ultimo,

    /** Usado pelo adaptador a cada chamada. */
    async obterToken() {
      if (ultimo) return ultimo;
      try {
        return await obter({ interativo: false });
      } catch (e) {
        // Sem sessão silenciosa: quem decide se abre a tela de permissão é o
        // controlador, não uma chamada de rede no meio de uma rodada.
        if (aoPrecisarDeLogin) aoPrecisarDeLogin();
        throw e;
      }
    },

    /** Chamado quando a pessoa clica em conectar. */
    async conectar() {
      return obter({ interativo: true });
    },

    /** Chamado quando o Drive devolve 401/403: o token em cache está velho. */
    async renovar() {
      const velho = ultimo;
      ultimo = null;
      await descartarTokenExtensao(velho);
      return obter({ interativo: false });
    },

    async desconectar() {
      const velho = ultimo;
      ultimo = null;
      await revogarTokenExtensao(velho);
    },
  };
}
