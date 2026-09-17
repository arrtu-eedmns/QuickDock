// ── sync-adapter.js ──────────────────────────────────────────────────────────
// Contrato dos adaptadores de sincronização e implementação em memória.
//
// O QuickDock armazena as notas na conta ou no disco do próprio usuário (Google
// Drive, pasta local ou memória). O motor de sincronização não conhece os
// detalhes de rede nem as APIs de fornecedores: ele interage exclusivamente
// através da interface documentada abaixo.
//
// Contrato que todo adaptador precisa cumprir:
//
//   autenticar()
//     Inicializa acesso ou valida permissões no destino.
//     Devolve Promise<{ ok: boolean, erro?: string }>
//
//   listarMudancas(desde)
//     Lista os arquivos que foram criados, alterados ou apagados desde o cursor `desde`.
//     Devolve Promise<Array<{ caminho: string, rev: string, apagado: boolean }>>
//
//   ler(caminho)
//     Obtém o conteúdo textual e a revisão atual do arquivo indicado.
//     Devolve Promise<{ texto: string, rev: string } | null>
//
//   escrever(caminho, conteudo, revBase)
//     Salva o conteúdo apenas se a revisão atual corresponder à `revBase`.
//     Se a revisão remota tiver avançado no intervalo, NÃO sobrescreve e devolve conflito.
//     Devolve Promise<{ rev: string } | { conflito: true, revAtual: string }>
//
//   apagar(caminho)
//     Remove o arquivo no destino, registrando a exclusão para propagação.
//     Devolve Promise<boolean>

export class MemorySyncAdapter {
  constructor() {
    // Mapa em memória simulando o diretório remoto:
    // Map<caminho, { conteudo: string, rev: string, apagado: boolean, seq: number }>
    this.arquivos = new Map();
    this.seqCounter = 0;
  }

  async autenticar() {
    return { ok: true };
  }

  /**
   * @param {string|number|null} desde Cursor de revisão a partir do qual listar
   * @returns {Promise<Array<{ caminho: string, rev: string, apagado: boolean }>>}
   */
  async listarMudancas(desde = null) {
    const seqMin = desde != null ? Number(desde) : 0;
    const mudancas = [];
    for (const [caminho, arq] of this.arquivos.entries()) {
      if (arq.seq > seqMin) {
        mudancas.push({
          caminho,
          rev: arq.rev,
          apagado: !!arq.apagado,
        });
      }
    }
    // Ordena monotonicamente pelo número de revisão para garantir replay consistente
    mudancas.sort((a, b) => Number(a.rev) - Number(b.rev));
    return mudancas;
  }

  /**
   * @param {string} caminho
   * @returns {Promise<{ texto: string, rev: string } | null>}
   */
  async ler(caminho) {
    const arq = this.arquivos.get(caminho);
    if (!arq || arq.apagado) return null;
    return { texto: arq.conteudo, rev: arq.rev };
  }

  /**
   * @param {string} caminho
   * @param {string} conteudo
   * @param {string|null} revBase Revisão sobre a qual a alteração foi gerada
   * @returns {Promise<{ rev: string } | { conflito: true, revAtual: string }>}
   */
  async escrever(caminho, conteudo, revBase = null) {
    const atual = this.arquivos.get(caminho);

    if (atual && !atual.apagado) {
      // Se o arquivo já existe no destino e a revisão informada não bate, há conflito
      if (revBase === null || revBase !== atual.rev) {
        return { conflito: true, revAtual: atual.rev };
      }
    } else if (atual && atual.apagado) {
      // Se o arquivo foi apagado no destino e revBase não casa com a lápide
      if (revBase !== null && revBase !== atual.rev) {
        return { conflito: true, revAtual: atual.rev };
      }
    }

    this.seqCounter++;
    const novaRev = String(this.seqCounter);
    this.arquivos.set(caminho, {
      conteudo,
      rev: novaRev,
      apagado: false,
      seq: this.seqCounter,
    });

    return { rev: novaRev };
  }

  /**
   * @param {string} caminho
   * @returns {Promise<boolean>}
   */
  async apagar(caminho) {
    const atual = this.arquivos.get(caminho);
    if (!atual || atual.apagado) return false;

    this.seqCounter++;
    this.arquivos.set(caminho, {
      conteudo: '',
      rev: String(this.seqCounter),
      apagado: true,
      seq: this.seqCounter,
    });
    return true;
  }
}
