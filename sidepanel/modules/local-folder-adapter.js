// ── local-folder-adapter.js ──────────────────────────────────────────────────
// Adaptador de sincronização para pasta local (File System Access API).
//
// Permite ao usuário apontar uma pasta no seu computador (que pode estar dentro
// de uma pasta do OneDrive, Dropbox, Syncthing ou em disco local).
//
// Cumpre o mesmo contrato de `sync-adapter.js`, validando o mecanismo de
// sincronização de ponta a ponta sem depender de contas, OAuth ou APIs de nuvem.
//
// NOTA: Este módulo depende de APIs exclusivas de navegador (showDirectoryPicker,
// FileSystemDirectoryHandle, etc.). Não é executável em ambiente Node.js.

export class LocalFolderAdapter {
  /**
   * @param {Object} [opcoes]
   * @param {FileSystemDirectoryHandle} [opcoes.rootHandle=null] Handle da pasta raiz se já persistido
   */
  constructor({ rootHandle = null } = {}) {
    this.root = rootHandle;
    // Cache local de arquivos conhecidos para detecção de exclusões:
    // Map<caminho, { rev: string }>
    this.conhecidos = new Map();
    this.seq = 0;
  }

  /**
   * Solicita ou valida acesso à pasta local escolhida pelo usuário.
   */
  async autenticar() {
    if (typeof window === 'undefined' || !window.showDirectoryPicker) {
      return { ok: false, erro: 'File System Access API não suportada neste ambiente.' };
    }

    try {
      if (!this.root) {
        this.root = await window.showDirectoryPicker({
          id: 'quickdock-sync-folder',
          mode: 'readwrite',
        });
      } else {
        // Valida se a permissão de leitura e escrita ainda está ativa
        const status = await this.root.queryPermission({ mode: 'readwrite' });
        if (status !== 'granted') {
          const pedido = await this.root.requestPermission({ mode: 'readwrite' });
          if (pedido !== 'granted') {
            return { ok: false, erro: 'Permissão de acesso à pasta negada pelo usuário.' };
          }
        }
      }

      // Garante que a estrutura básica de diretórios exista na pasta raiz
      await this.obterOuCriarDiretorio('notas');
      await this.obterOuCriarDiretorio('modelos');
      await this.obterOuCriarDiretorio('imagens');

      return { ok: true };
    } catch (err) {
      return { ok: false, erro: err?.message || 'Falha ao selecionar pasta local.' };
    }
  }

  async obterOuCriarDiretorio(nome) {
    return this.root.getDirectoryHandle(nome, { create: true });
  }

  async resolverHandleArquivo(caminho, criar = false) {
    const partes = caminho.split('/').filter(Boolean);
    let atual = this.root;
    for (let i = 0; i < partes.length - 1; i++) {
      atual = await atual.getDirectoryHandle(partes[i], { create: criar });
    }
    const nomeArquivo = partes[partes.length - 1];
    return atual.getFileHandle(nomeArquivo, { create: criar });
  }

  gerarRev(file) {
    // A revisão é derivada do timestamp de modificação e tamanho do arquivo
    return `${file.lastModified}-${file.size}`;
  }

  /**
   * Varre a pasta de notas identificando arquivos novos, alterados ou removidos.
   */
  async listarMudancas(desde = null) {
    if (!this.root) await this.autenticar();

    const mudancas = [];
    const encontrados = new Set();

    const pastas = ['notas', 'modelos'];
    const varrer = async (dirHandle, prefixo, nivel) => {
      for await (const [nome, handle] of dirHandle.entries()) {
        if (nome.startsWith('.')) continue;
        if (handle.kind === 'file' && nome.endsWith('.md')) {
          const caminho = `${prefixo}/${nome}`;
          encontrados.add(caminho);

          const file = await handle.getFile();
          const rev = this.gerarRev(file);
          const anterior = this.conhecidos.get(caminho);

          if (!anterior || anterior.rev !== rev) {
            mudancas.push({ caminho, rev, apagado: false });
            this.conhecidos.set(caminho, { rev });
          }
        } else if (handle.kind === 'directory' && nivel < 3) {
          await varrer(handle, `${prefixo}/${nome}`, nivel + 1);
        }
      }
    };

    for (const pasta of pastas) {
      try {
        const dir = await this.root.getDirectoryHandle(pasta, { create: false });
        await varrer(dir, pasta, 0);
      } catch {
        // Pasta ainda não existe
      }
    }

    // Detecta arquivos que estavam no cache mas sumiram da pasta (excluídos no disco)
    for (const [caminho] of this.conhecidos.entries()) {
      if (!encontrados.has(caminho)) {
        this.seq++;
        mudancas.push({ caminho, rev: `del-${this.seq}`, apagado: true });
        this.conhecidos.delete(caminho);
      }
    }

    return mudancas;
  }

  async ler(caminho) {
    try {
      const handle = await this.resolverHandleArquivo(caminho, false);
      const file = await handle.getFile();
      const isTexto = caminho.endsWith('.md') || caminho.endsWith('.txt');
      const texto = isTexto ? await file.text() : '';
      const rev = this.gerarRev(file);
      return { texto, blob: file, file, rev };
    } catch {
      return null;
    }
  }

  async escrever(caminho, conteudo, revBase = null) {
    try {
      let handleExistente = null;
      try {
        handleExistente = await this.resolverHandleArquivo(caminho, false);
      } catch {
        // Arquivo não existe ainda
      }

      if (handleExistente) {
        const fileExistente = await handleExistente.getFile();
        const revAtual = this.gerarRev(fileExistente);
        // Se a revisão base fornecida for diferente da encontrada em disco, acusa conflito
        if (revBase === null || revBase !== revAtual) {
          return { conflito: true, revAtual };
        }
      }

      const handle = await this.resolverHandleArquivo(caminho, true);
      const writable = await handle.createWritable();
      await writable.write(conteudo);
      await writable.close();

      const fileAtualizado = await handle.getFile();
      const rev = this.gerarRev(fileAtualizado);
      this.conhecidos.set(caminho, { rev });

      return { rev };
    } catch (err) {
      throw new Error(`Falha ao gravar arquivo local (${caminho}): ${err.message}`);
    }
  }

  async apagar(caminho) {
    try {
      const partes = caminho.split('/').filter(Boolean);
      let atual = this.root;
      for (let i = 0; i < partes.length - 1; i++) {
        atual = await atual.getDirectoryHandle(partes[i], { create: false });
      }
      const nomeArquivo = partes[partes.length - 1];
      await atual.removeEntry(nomeArquivo);
      this.conhecidos.delete(caminho);
      return true;
    } catch {
      return false;
    }
  }
}
