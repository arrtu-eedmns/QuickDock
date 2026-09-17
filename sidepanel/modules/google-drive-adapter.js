// ── google-drive-adapter.js ────────────────────────────────────────────────
// Adaptador de sincronização para o Google Drive, cumprindo o mesmo contrato
// de sync-adapter.js que o MemorySyncAdapter e o LocalFolderAdapter.
//
// Duas coisas entram pelo construtor em vez de serem embutidas, e as duas por
// motivo prático:
//
//   `obterToken` — a extensão usa chrome.identity.getAuthToken e o PWA usa
//   PKCE. São fluxos completamente diferentes, e nenhum dos dois pertence aqui.
//   O adaptador só quer um token válido quando pedir.
//
//   `fetchImpl` — trocável para os testes. Sem isso, nada neste arquivo poderia
//   ser exercitado sem rede e sem conta do Google, e seria a única peça da
//   sincronização sem cobertura.
//
// O Drive NÃO tem caminhos. Ele tem arquivos com pastas-mãe, e dois arquivos
// podem ter o mesmo nome na mesma pasta. Todo o trabalho de traduzir
// "notas/x.md" para um fileId mora aqui, e é por isso que este arquivo existe
// em vez de o motor falar direto com a API.

import { PASTA_RAIZ } from './google-config.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const MIME_PASTA = 'application/vnd.google-apps.folder';

// Nome de arquivo dentro de uma consulta do Drive. A API usa aspas simples como
// delimitador, então uma aspa simples no nome encerraria a consulta no meio.
function escaparConsulta(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export class GoogleDriveAdapter {
  /**
   * @param {Object} opcoes
   * @param {() => Promise<string>} opcoes.obterToken Devolve um access token válido.
   * @param {Function} [opcoes.fetchImpl] Substituto de fetch (testes).
   * @param {string} [opcoes.pastaRaiz] Nome da pasta no Drive da pessoa.
   */
  constructor({ obterToken, fetchImpl = null, pastaRaiz = PASTA_RAIZ } = {}) {
    this.obterToken = obterToken;
    this.fetchImpl = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.pastaRaiz = pastaRaiz;

    // Caminho -> fileId. O Drive cobra uma consulta para cada tradução, e sem
    // cache uma rodada com 50 notas viraria 150 chamadas. Invalidado ao apagar.
    this.idsPorCaminho = new Map();
    this.idsDePastas = new Map();
    this.raizId = null;
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────
  async _api(url, { method = 'GET', headers = {}, body = null, cru = false } = {}) {
    const token = await this.obterToken();
    const resp = await this.fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body,
    });

    if (!resp.ok) {
      // 404 é resposta legítima em vários pontos (arquivo que não existe), e
      // quem chamou decide o que fazer. Os outros erros sobem com o corpo junto,
      // porque a mensagem do Drive costuma dizer exatamente o que falta — escopo
      // errado, API desativada, cota estourada.
      if (resp.status === 404) return null;
      let detalhe = '';
      try { detalhe = (await resp.text()).slice(0, 300); } catch { /* sem corpo */ }
      throw new Error(`Drive respondeu ${resp.status}${detalhe ? `: ${detalhe}` : ''}`);
    }
    return cru ? resp : resp.json();
  }

  async _listar(consulta, campos = 'files(id,name,headRevisionId,modifiedTime,trashed)') {
    const url = `${API}/files?q=${encodeURIComponent(consulta)}`
      + `&fields=${encodeURIComponent(campos)}&pageSize=1000&spaces=drive`;
    const r = await this._api(url);
    return r?.files ?? [];
  }

  // ── Pastas ───────────────────────────────────────────────────────────────
  // Acha ou cria. Criar é idempotente na prática porque procuramos antes; e se
  // duas abas criarem ao mesmo tempo, ficamos com a primeira que a consulta
  // devolver — duas pastas de mesmo nome não corrompem nada, só duplicam.
  async _pasta(nome, paiId) {
    const chave = `${paiId ?? 'root'}/${nome}`;
    if (this.idsDePastas.has(chave)) return this.idsDePastas.get(chave);

    const q = `name='${escaparConsulta(nome)}' and mimeType='${MIME_PASTA}'`
      + ` and '${paiId ?? 'root'}' in parents and trashed=false`;
    const achadas = await this._listar(q, 'files(id,name)');

    let id = achadas[0]?.id;
    if (!id) {
      const criada = await this._api(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: nome,
          mimeType: MIME_PASTA,
          parents: [paiId ?? 'root'],
        }),
      });
      id = criada?.id;
    }
    if (id) this.idsDePastas.set(chave, id);
    return id;
  }

  async _raiz() {
    if (!this.raizId) this.raizId = await this._pasta(this.pastaRaiz, null);
    return this.raizId;
  }

  // "notas/x.md" -> { pastaId, nome }. Cria as pastas do caminho se faltarem.
  async _destino(caminho) {
    const partes = String(caminho).split('/').filter(Boolean);
    const nome = partes.pop();
    let paiId = await this._raiz();
    for (const p of partes) paiId = await this._pasta(p, paiId);
    return { pastaId: paiId, nome };
  }

  async _acharArquivo(caminho) {
    if (this.idsPorCaminho.has(caminho)) return this.idsPorCaminho.get(caminho);
    const { pastaId, nome } = await this._destino(caminho);
    const q = `name='${escaparConsulta(nome)}' and '${pastaId}' in parents and trashed=false`;
    const achados = await this._listar(q);
    const arq = achados[0] ?? null;
    if (arq) this.idsPorCaminho.set(caminho, arq);
    return arq;
  }

  // ── Contrato ─────────────────────────────────────────────────────────────
  async autenticar() {
    try {
      await this.obterToken();
      await this._raiz();
      return { ok: true };
    } catch (e) {
      return { ok: false, erro: e?.message ?? String(e) };
    }
  }

  /**
   * Devolve `{ mudancas, cursor }` — o cursor é o pageToken opaco do Drive, e
   * quem sabe interpretá-lo é o próprio Drive. O motor só guarda e devolve.
   *
   * Sem cursor (aparelho novo, ou primeira vez), enumera o que já existe: um
   * changes.list só traz o que mudou DEPOIS do token, então quem chega agora não
   * veria as notas antigas. Junto, pede o startPageToken para as próximas
   * rodadas trazerem só a diferença.
   */
  async listarMudancas(desde = null) {
    if (!desde) {
      const inicio = await this._api(`${API}/changes/startPageToken?fields=startPageToken`);
      const raiz = await this._raiz();
      const mudancas = [];

      for (const sub of ['notas', 'modelos', 'imagens']) {
        const pastaId = await this._pasta(sub, raiz);
        if (!pastaId) continue;
        const arquivos = await this._listar(`'${pastaId}' in parents and trashed=false`);
        for (const a of arquivos) {
          const caminho = `${sub}/${a.name}`;
          this.idsPorCaminho.set(caminho, a);
          mudancas.push({ caminho, rev: a.headRevisionId ?? a.modifiedTime, apagado: false });
        }
      }
      return { mudancas, cursor: inicio?.startPageToken ?? null };
    }

    const r = await this._api(
      `${API}/changes?pageToken=${encodeURIComponent(desde)}`
      + `&fields=${encodeURIComponent('newStartPageToken,nextPageToken,changes(removed,fileId,file(id,name,headRevisionId,modifiedTime,trashed,parents))')}`
      + '&pageSize=1000&spaces=drive'
    );

    const mudancas = [];
    for (const c of r?.changes ?? []) {
      const caminho = this._caminhoConhecidoDe(c.fileId);
      const sumiu = c.removed || c.file?.trashed;

      if (sumiu) {
        // Só sabemos o caminho de quem já passou por aqui. Arquivo apagado que
        // nunca foi visto não interessa: não há estado local apontando pra ele.
        if (caminho) {
          this.idsPorCaminho.delete(caminho);
          mudancas.push({ caminho, rev: `del-${c.fileId}`, apagado: true });
        }
        continue;
      }
      if (!c.file) continue;

      const pastaNome = await this._nomeDaPastaConhecida(c.file.parents?.[0]);
      if (!pastaNome) continue;            // fora das nossas pastas: ignora
      const novo = `${pastaNome}/${c.file.name}`;
      this.idsPorCaminho.set(novo, c.file);
      mudancas.push({
        caminho: novo,
        rev: c.file.headRevisionId ?? c.file.modifiedTime,
        apagado: false,
      });
    }

    return { mudancas, cursor: r?.newStartPageToken ?? r?.nextPageToken ?? desde };
  }

  _caminhoConhecidoDe(fileId) {
    for (const [caminho, arq] of this.idsPorCaminho) {
      if (arq?.id === fileId) return caminho;
    }
    return null;
  }

  async _nomeDaPastaConhecida(pastaId) {
    if (!pastaId) return null;
    for (const [chave, id] of this.idsDePastas) {
      if (id === pastaId) return chave.split('/').pop();
    }
    return null;
  }

  async ler(caminho) {
    const arq = await this._acharArquivo(caminho);
    if (!arq) return null;
    const resp = await this._api(`${API}/files/${arq.id}?alt=media`, { cru: true });
    if (!resp) return null;

    const rev = arq.headRevisionId ?? arq.modifiedTime;
    // Imagem vem como blob; nota vem como texto. Quem chama sabe qual quer, e
    // devolver os dois evita uma segunda viagem.
    if (/^imagens\//.test(caminho)) {
      const blob = await resp.blob();
      return { blob, rev };
    }
    return { texto: await resp.text(), rev };
  }

  /**
   * `revBase` é a revisão que quem escreve acredita estar no destino. Se o que
   * está lá for outra, devolvemos conflito em vez de sobrescrever — é o que
   * impede um aparelho de apagar a edição do outro sem ninguém perceber.
   */
  async escrever(caminho, conteudo, revBase = null) {
    const existente = await this._acharArquivo(caminho);

    if (existente) {
      const atual = existente.headRevisionId ?? existente.modifiedTime;
      if (revBase !== null && revBase !== atual) {
        return { conflito: true, revAtual: atual };
      }
      const r = await this._api(
        `${UPLOAD}/files/${existente.id}?uploadType=media&fields=id,headRevisionId,modifiedTime`,
        { method: 'PATCH', headers: { 'Content-Type': this._tipoDe(caminho) }, body: conteudo }
      );
      const rev = r?.headRevisionId ?? r?.modifiedTime;
      this.idsPorCaminho.set(caminho, { id: existente.id, name: existente.name, headRevisionId: r?.headRevisionId, modifiedTime: r?.modifiedTime });
      return { rev };
    }

    // Arquivo novo. `revBase` não-nulo aqui significa que quem escreve achava
    // que havia algo: alguém apagou no meio do caminho. Criar é o certo — a
    // exclusão remota, se for real, volta na próxima rodada como mudança.
    const { pastaId, nome } = await this._destino(caminho);
    const limite = 'qd-' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name: nome, parents: [pastaId] });
    const corpo =
      `--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`
      + `--${limite}\r\nContent-Type: ${this._tipoDe(caminho)}\r\n\r\n`;

    const partes = [corpo, conteudo, `\r\n--${limite}--\r\n`];
    const r = await this._api(
      `${UPLOAD}/files?uploadType=multipart&fields=id,name,headRevisionId,modifiedTime`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${limite}` },
        body: new Blob(partes),
      }
    );
    if (!r?.id) return { conflito: true, revAtual: null };
    this.idsPorCaminho.set(caminho, r);
    return { rev: r.headRevisionId ?? r.modifiedTime };
  }

  _tipoDe(caminho) {
    if (/\.md$/i.test(caminho)) return 'text/markdown';
    if (/\.png$/i.test(caminho)) return 'image/png';
    if (/\.jpe?g$/i.test(caminho)) return 'image/jpeg';
    if (/\.webp$/i.test(caminho)) return 'image/webp';
    if (/\.gif$/i.test(caminho)) return 'image/gif';
    return 'application/octet-stream';
  }

  /**
   * Manda para a lixeira, não apaga de vez. O Drive guarda por 30 dias, e uma
   * exclusão errada — bug nosso ou clique errado da pessoa — deixa de ser
   * definitiva. Não custa nada e já salvou nota de gente.
   */
  async apagar(caminho) {
    const arq = await this._acharArquivo(caminho);
    if (!arq) return false;
    await this._api(`${API}/files/${arq.id}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
    this.idsPorCaminho.delete(caminho);
    return true;
  }
}
