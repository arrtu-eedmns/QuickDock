// ── memory-store.mjs ───────────────────────────────────────────────────────
// Armazenamento local de mentira, cumprindo o contrato que o SyncEngine espera
// do `store`. Existe pra que o motor de sincronização possa ser exercitado sem
// IndexedDB — nos testes (test/run.mjs) e no banco de provas do navegador
// (test/banco-de-provas.html).
//
// Fica num módulo só justamente porque os dois usam: se o contrato mudar, os
// dois quebram juntos e na mesma hora, em vez de divergirem em silêncio.

export class InMemoryStore {
  constructor() {
    this.notas = new Map();
    this.estados = new Map();
    this.arquivos = new Map();
    this.modelos = new Map();
    this.arquivoSeq = 0;
    this.cursor = null;
  }

  async salvarArquivo({ name, type, blob, inline = false, noteId = null }) {
    this.arquivoSeq++;
    const id = this.arquivoSeq;
    this.arquivos.set(id, { id, name, type, blob, inline: inline ? 1 : undefined, noteId, createdAt: Date.now() });
    return id;
  }

  async obterArquivo(id) {
    return this.arquivos.get(Number(id)) ?? null;
  }

  async obterBlobArquivo(id) {
    const arq = this.arquivos.get(Number(id));
    return arq ? arq.blob : null;
  }

  async listarModelosLocais() {
    return [...this.modelos.values()];
  }

  async obterModeloPorUid(uid) {
    return this.modelos.get(uid) ?? null;
  }

  async salvarModeloLocal(tpl) {
    this.modelos.set(tpl.uid, { ...tpl });
    return tpl.uid;
  }

  async excluirModeloLocal(uid) {
    this.modelos.delete(uid);
  }
  async listarNotasLocais() {
    return [...this.notas.values()];
  }
  async obterNotaPorUid(uid) {
    return this.notas.get(uid) ?? null;
  }
  async salvarNotaLocal(nota) {
    this.notas.set(nota.uid, { ...nota });
    return nota.uid;
  }
  async excluirNotaLocal(uid) {
    this.notas.delete(uid);
  }
  async obterEstadoSync(uid) {
    return this.estados.get(uid) ?? null;
  }
  async obterEstadoSyncPorCaminho(caminho) {
    for (const est of this.estados.values()) {
      if (est.caminho === caminho) return est;
    }
    return null;
  }
  async salvarEstadoSync(estado) {
    this.estados.set(estado.uid, { ...estado });
  }
  async excluirEstadoSync(uid) {
    this.estados.delete(uid);
  }
  async listarTodosEstadosSync() {
    return [...this.estados.values()];
  }
  async obterCursorSync() {
    return this.cursor;
  }
  async salvarCursorSync(c) {
    this.cursor = c;
  }
  async obterMeta(chave) {
    return this.meta?.get(chave) ?? null;
  }
  async salvarMeta(chave, valor) {
    if (!this.meta) this.meta = new Map();
    this.meta.set(chave, valor);
  }
  async excluirMeta(chave) {
    this.meta?.delete(chave);
  }
}
