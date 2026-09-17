// ── google-auth-web.js ─────────────────────────────────────────────────────
// Token do Google no PWA. A extensão usa chrome.identity (google-auth.js);
// aqui não existe nada disso, e o fluxo é outro.
//
// Usa o Google Identity Services (GIS), que é o caminho que o Google documenta
// para aplicativo de navegador. A alternativa seria trocar código por token no
// endpoint do OAuth, mas isso exige client_secret — e um PWA é servido em texto
// aberto, então não tem onde guardar segredo nenhum.
//
// O que isso custa, dito na cara:
//
//   O token vale cerca de uma hora e NÃO há refresh token. A renovação é feita
//   em silêncio enquanto a sessão do Google no navegador estiver viva. No Chrome
//   isso funciona bem. No Safari do iPhone, a proteção contra rastreamento pode
//   derrubar a renovação silenciosa, e aí a pessoa precisa tocar em conectar de
//   novo. Não há como contornar do lado do aplicativo.

import { GOOGLE_CLIENT_ID_WEB, GOOGLE_ESCOPO } from './google-config.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

let carregando = null;

/**
 * Carrega o script do Google sob demanda, nunca na abertura.
 *
 * Duas razões: quem não usa sincronização não deveria baixar nada do Google
 * (nem aparecer nos registros dele), e o script é remoto — se a rede estiver
 * fora, o aplicativo inteiro não pode deixar de abrir por causa disso.
 */
function carregarGIS() {
  if (typeof window === 'undefined') return Promise.reject(new Error('sem navegador'));
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (carregando) return carregando;

  carregando = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      carregando = null;
      reject(new Error('Não foi possível carregar o login do Google. Verifique a conexão.'));
    };
    document.head.appendChild(s);
  }).then(() => {
    if (!window.google?.accounts?.oauth2) {
      carregando = null;
      throw new Error('O login do Google carregou de forma incompleta.');
    }
  });

  return carregando;
}

/**
 * Provedor de token para o PWA, com a mesma forma do provedor da extensão —
 * é o que permite ao controlador e ao adaptador do Drive não saberem em qual
 * dos dois estão rodando.
 */
export function criarProvedorDeTokenWeb() {
  let token = null;
  let expiraEm = 0;          // timestamp em ms
  let cliente = null;

  // Uma margem antes do vencimento real. Sem ela, uma rodada que começa com o
  // token quase vencido termina com 401 no meio — e o meio de uma rodada é o
  // pior lugar para descobrir isso.
  const MARGEM_MS = 90 * 1000;

  const valido = () => !!token && Date.now() < expiraEm - MARGEM_MS;

  async function pedir({ interativo }) {
    await carregarGIS();

    if (!cliente) {
      cliente = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID_WEB,
        scope: GOOGLE_ESCOPO,
        callback: () => {},        // trocado a cada pedido, abaixo
      });
    }

    return new Promise((resolve, reject) => {
      cliente.callback = resposta => {
        if (resposta?.error) {
          reject(new Error(resposta.error_description || resposta.error));
          return;
        }
        token = resposta.access_token;
        expiraEm = Date.now() + (Number(resposta.expires_in || 3600) * 1000);
        resolve(token);
      };

      try {
        // `prompt: ''` tenta sem mostrar nada, aproveitando a sessão do Google
        // que já existe no navegador. É o que se usa nas rodadas automáticas.
        cliente.requestAccessToken({ prompt: interativo ? 'consent' : '' });
      } catch (e) {
        reject(e);
      }
    });
  }

  return {
    ehSuportado: () => typeof window !== 'undefined',
    tokenAtual: () => token,

    async obterToken() {
      if (valido()) return token;
      return pedir({ interativo: false });
    },

    /** Só a partir de clique: o Google bloqueia a janela se não houver gesto. */
    async conectar() {
      return pedir({ interativo: true });
    },

    async renovar() {
      token = null;
      expiraEm = 0;
      return pedir({ interativo: false });
    },

    /**
     * Revoga de verdade, não só esquece. Sem isso o aplicativo continuaria
     * autorizado na conta da pessoa e o próximo "conectar" entraria sem
     * perguntar nada — não é o que quem desconecta espera.
     */
    async desconectar() {
      const velho = token;
      token = null;
      expiraEm = 0;
      if (!velho) return;
      try {
        window.google?.accounts?.oauth2?.revoke?.(velho, () => {});
      } catch { /* sem rede: o token local já saiu, e ele vence sozinho */ }
    },
  };
}
