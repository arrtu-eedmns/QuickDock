// ── drive-falso.mjs ────────────────────────────────────────────────────────
// Um Google Drive de mentira, com a forma das respostas que a API v3 devolve.
//
// Existe para o GoogleDriveAdapter não ser a única peça da sincronização sem
// teste. Sem ele, só daria para exercitar o adaptador com uma conta de verdade,
// na rede, à mão — ou seja: na prática, nunca.
//
// Não imita o Drive inteiro. Imita o que o adaptador usa: buscar por nome dentro
// de uma pasta, criar pasta, subir e baixar conteúdo, mandar pra lixeira, e o
// changes.list com pageToken. É o suficiente para pegar erro de montagem de
// consulta, de caminho e de conflito — que é onde mora o risco.

export function criarDriveFalso() {
  const arquivos = new Map();   // id -> { id, name, parents, mimeType, conteudo, headRevisionId, trashed }
  let seq = 0;
  let versao = 0;
  const mudancas = [];          // [{ token, fileId, removed }]

  const novoId = () => `f${++seq}`;
  const bump = () => `r${++versao}`;

  function registrarMudanca(fileId, removed = false) {
    mudancas.push({ token: String(mudancas.length + 1), fileId, removed });
  }

  // Interpreta o subconjunto de consulta que o adaptador monta.
  function filtrar(q) {
    const nome = /name='((?:[^'\\]|\\.)*)'/.exec(q);
    const pai = /'([^']+)' in parents/.exec(q);
    const pasta = /mimeType='application\/vnd\.google-apps\.folder'/.test(q);
    const naoLixo = /trashed=false/.test(q);

    return [...arquivos.values()].filter(a => {
      if (nome && a.name !== nome[1].replace(/\\(.)/g, '$1')) return false;
      if (pai && !(a.parents ?? []).includes(pai[1])) return false;
      if (pasta && a.mimeType !== 'application/vnd.google-apps.folder') return false;
      if (naoLixo && a.trashed) return false;
      return true;
    });
  }

  const json = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    blob: async () => obj,
  });

  const texto = (s, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(s),
    text: async () => s,
    blob: async () => s,
  });

  async function corpoParaTexto(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (typeof body.text === 'function') return body.text();   // Blob
    return String(body);
  }

  async function fetchFalso(url, opcoes = {}) {
    const metodo = (opcoes.method || 'GET').toUpperCase();
    const u = new URL(url);
    const caminho = u.pathname;

    if (!/^Bearer .+/.test(opcoes.headers?.Authorization ?? '')) {
      return json({ error: { message: 'sem token' } }, 401);
    }

    // startPageToken
    if (caminho.endsWith('/changes/startPageToken')) {
      return json({ startPageToken: String(mudancas.length + 1) });
    }

    // changes.list
    if (caminho.endsWith('/drive/v3/changes')) {
      const desde = Number(u.searchParams.get('pageToken') || 1);
      const lista = mudancas.filter(m => Number(m.token) >= desde).map(m => {
        const a = arquivos.get(m.fileId);
        return m.removed || !a
          ? { removed: true, fileId: m.fileId }
          : { removed: false, fileId: m.fileId, file: {
              id: a.id, name: a.name, headRevisionId: a.headRevisionId,
              modifiedTime: a.modifiedTime, trashed: !!a.trashed, parents: a.parents } };
      });
      return json({ changes: lista, newStartPageToken: String(mudancas.length + 1) });
    }

    // Download
    if (metodo === 'GET' && u.searchParams.get('alt') === 'media') {
      const id = caminho.split('/').pop();
      const a = arquivos.get(id);
      if (!a) return json({}, 404);
      return texto(a.conteudo ?? '');
    }

    // Busca
    if (metodo === 'GET' && caminho.endsWith('/drive/v3/files')) {
      const achados = filtrar(u.searchParams.get('q') ?? '');
      return json({ files: achados.map(a => ({
        id: a.id, name: a.name, headRevisionId: a.headRevisionId,
        modifiedTime: a.modifiedTime, trashed: !!a.trashed })) });
    }

    // Criar pasta (metadado puro). O `!includes('/upload/')` importa: a rota de
    // upload é /upload/drive/v3/files, que TAMBÉM termina em /drive/v3/files —
    // sem a checagem, esta rota engole o upload multipart.
    if (metodo === 'POST' && caminho.endsWith('/drive/v3/files') && !caminho.includes('/upload/')) {
      const meta = JSON.parse(await corpoParaTexto(opcoes.body));
      const a = { id: novoId(), name: meta.name, parents: meta.parents ?? ['root'],
        mimeType: meta.mimeType, conteudo: '', headRevisionId: bump(),
        modifiedTime: new Date().toISOString(), trashed: false };
      arquivos.set(a.id, a);
      registrarMudanca(a.id);
      return json({ id: a.id, name: a.name, headRevisionId: a.headRevisionId, modifiedTime: a.modifiedTime });
    }

    // Upload multipart (criar com conteúdo)
    if (metodo === 'POST' && caminho.includes('/upload/drive/v3/files')) {
      const bruto = await corpoParaTexto(opcoes.body);
      const meta = JSON.parse(/\{[\s\S]*?\}/.exec(bruto)[0]);
      const partes = bruto.split('\r\n\r\n');
      const conteudo = partes.slice(2).join('\r\n\r\n').replace(/\r\n--[^\r\n]*--\r\n?$/, '');
      const a = { id: novoId(), name: meta.name, parents: meta.parents,
        mimeType: 'text/markdown', conteudo, headRevisionId: bump(),
        modifiedTime: new Date().toISOString(), trashed: false };
      arquivos.set(a.id, a);
      registrarMudanca(a.id);
      return json({ id: a.id, name: a.name, headRevisionId: a.headRevisionId, modifiedTime: a.modifiedTime });
    }

    // Atualizar conteúdo
    if (metodo === 'PATCH' && caminho.includes('/upload/drive/v3/files/')) {
      const id = caminho.split('/').pop();
      const a = arquivos.get(id);
      if (!a) return json({}, 404);
      a.conteudo = await corpoParaTexto(opcoes.body);
      a.headRevisionId = bump();
      a.modifiedTime = new Date().toISOString();
      registrarMudanca(id);
      return json({ id, headRevisionId: a.headRevisionId, modifiedTime: a.modifiedTime });
    }

    // Lixeira
    if (metodo === 'PATCH' && caminho.includes('/drive/v3/files/')) {
      const id = caminho.split('/').pop();
      const a = arquivos.get(id);
      if (!a) return json({}, 404);
      const patch = JSON.parse(await corpoParaTexto(opcoes.body));
      Object.assign(a, patch);
      registrarMudanca(id, !!patch.trashed);
      return json({ id });
    }

    return json({ error: { message: `rota não imitada: ${metodo} ${caminho}` } }, 400);
  }

  return {
    fetchFalso,
    // Para os testes espiarem o estado sem passar pela API.
    arquivos,
    porCaminho(nome) {
      return [...arquivos.values()].find(a => a.name === nome && !a.trashed) ?? null;
    },
    contarPastas() {
      return [...arquivos.values()].filter(a => a.mimeType === 'application/vnd.google-apps.folder').length;
    },
  };
}
