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
    this.cursor = null;
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
}
