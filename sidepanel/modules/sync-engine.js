// ── sync-engine.js ───────────────────────────────────────────────────────────
// Motor de sincronização de notas do QuickDock.
//
// Projetado para operar sem DOM e sem acoplamento direto a fornecedores de nuvem:
// recebe um adaptador de sincronização (MemorySyncAdapter, LocalFolderAdapter, etc.)
// e um repositório de dados local (Dexie em produção ou InMemoryStore em testes).
//
// Ordem das operações (ver PLANEJAMENTO.md v3.0 e HANDOFF.md):
//   1. Pergunta o que mudou lá (adapter.listarMudancas)
//   2. Baixa o que mudou lá e reconcilia (baixar antes de subir, sempre)
//   3. Sobe o que mudou aqui
//   4. Conflito → preserva ambos criando cópia de conflito identificada
//
// O estado local de sincronização ({ uid, caminho, rev, hash, sincronizadoEm })
// reside exclusivamente no aparelho e nunca sobe. É ele que diferencia uma
// nota apagada remotamente de uma nota que ainda não chegou.

import { buildNoteFile, parseNoteFile } from './notefile.js';
import { parseMarkdownToBlocks, blocksToMarkdown } from './blocks.js';
// Só a função pura de ordenação — o motor não fala com o banco.
import { ordemEntre } from './storage.js';

/**
 * Hash determinístico síncrono de 64 bits para detectar alterações de texto
 * em qualquer ambiente (Node.js ou navegador MV3) sem overhead assíncrono.
 */
export function hashConteudo(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c64e6d;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function slugTitulo(titulo) {
  const s = (titulo ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/\p{Mn}/gu, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'sem-titulo';
}

function dataIsoHoje() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Calcula o hash SHA-256 dos bytes da imagem e extrai os primeiros 12 dígitos
 * hexadecimais (ex: a1b2c3d4e5f6), garantindo nome único, imutável e idêntico
 * em qualquer aparelho ou plataforma.
 */
export async function calcularHashImagem(bytesOuBlob) {
  let buffer;
  if (bytesOuBlob instanceof ArrayBuffer) {
    buffer = bytesOuBlob;
  } else if (ArrayBuffer.isView(bytesOuBlob)) {
    buffer = bytesOuBlob.buffer.slice(bytesOuBlob.byteOffset, bytesOuBlob.byteOffset + bytesOuBlob.byteLength);
  } else if (bytesOuBlob && typeof bytesOuBlob.arrayBuffer === 'function') {
    buffer = await bytesOuBlob.arrayBuffer();
  } else if (typeof bytesOuBlob === 'string') {
    buffer = new TextEncoder().encode(bytesOuBlob);
  } else {
    throw new Error('Tipo de dado não suportado para cálculo de hash de imagem');
  }
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hashHex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.slice(0, 12);
}

export function extensaoDeMimeOuNome(mime, nome = '') {
  if (nome && /\.[a-z0-9]+$/i.test(nome)) {
    return nome.split('.').pop().toLowerCase();
  }
  if (!mime) return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/svg+xml') return 'svg';
  return 'png';
}

export class SyncEngine {
  /**
   * @param {Object} opcoes
   * @param {Object} opcoes.adapter Adaptador que cumpre o contrato de sync-adapter.js
   * @param {Object} opcoes.store   Armazenamento local (notas e estado de sync)
   * @param {string} [opcoes.deviceName='Dispositivo'] Nome para etiquetar cópias de conflito
   */
  constructor({
    adapter,
    store,
    deviceName = 'Dispositivo',
    obterNotaAbertaUid = null,
    podeRecarregarNotaAberta = null,
    recarregarNotaAberta = null,
    antesDeSincronizar = null,
    emModoModelo = null,
  }) {
    this.adapter = adapter;
    this.store = store;
    this.deviceName = deviceName;
    this.obterNotaAbertaUid = obterNotaAbertaUid;
    this.podeRecarregarNotaAberta = podeRecarregarNotaAberta;
    this.recarregarNotaAberta = recarregarNotaAberta;
    this.antesDeSincronizar = antesDeSincronizar;
    this.emModoModelo = emModoModelo;
    this.cacheImagensLocais = new Map();
  }

  /**
   * Serializa uma nota local para o formato final do arquivo .md (frontmatter + blocos).
   */
  serializarNota(nota, mapaImagens = null) {
    const md = blocksToMarkdown(nota.blocks ?? [], { sync: true, mapaImagens });
    const meta = {
      quickdock: 1,
      id: nota.uid,
      titulo: nota.title,
      cor: nota.color ?? null,
      icone: nota.icon ?? null,
      iconePreenchido: !!nota.iconFilled,
      tituloOculto: !!nota.titleHidden,
      ordem: nota.ordem ?? 'a0',
      criadoEm: nota.createdAt ? (typeof nota.createdAt === 'number' ? new Date(nota.createdAt).toISOString() : nota.createdAt) : undefined,
      atualizadoEm: nota.updatedAt ? (typeof nota.updatedAt === 'number' ? new Date(nota.updatedAt).toISOString() : nota.updatedAt) : undefined,
    };
    return buildNoteFile({ meta, md });
  }

  /**
   * Serializa um modelo local para o formato final do arquivo .md (frontmatter + conteúdo).
   */
  serializarModelo(modelo) {
    const meta = {
      quickdock: 1,
      id: modelo.uid,
      nome: modelo.name,
      tipo: modelo.kind || 'note',
      ordem: modelo.ordem ?? 'a0',
      criadoEm: modelo.createdAt ? (typeof modelo.createdAt === 'number' ? new Date(modelo.createdAt).toISOString() : modelo.createdAt) : undefined,
      atualizadoEm: modelo.updatedAt ? (typeof modelo.updatedAt === 'number' ? new Date(modelo.updatedAt).toISOString() : modelo.updatedAt) : undefined,
    };
    return buildNoteFile({ meta, md: modelo.content || '' });
  }

  /**
   * Executa uma rodada completa de sincronização bidirecional.
   * @returns {Promise<{ baixadas: number, enviadas: number, conflitos: number, apagadas: number, puladas: number, notasConflito: Array, abortadoModelo?: boolean }>}
   */
  async sincronizar() {
    // Regra 3 (Tarefa 2): Nunca sincronize enquanto isEditingTemplate() for verdadeiro.
    // O editor está exibindo um modelo, não uma nota; sincronizar gravaria por cima.
    if (this.emModoModelo && this.emModoModelo()) {
      return { baixadas: 0, enviadas: 0, conflitos: 0, apagadas: 0, puladas: 0, notasConflito: [], abortadoModelo: true };
    }

    // Regra 1 (Tarefa 2): Antes de cada rodada, chame flushSave() para que o banco
    // reflita fielmente o que estiver no DOM.
    if (this.antesDeSincronizar) {
      await this.antesDeSincronizar();
    }

    await this.adapter.autenticar();

    const resultado = { baixadas: 0, enviadas: 0, conflitos: 0, apagadas: 0, puladas: 0, notasConflito: [] };
    const cursor = await this.store.obterCursorSync();
    let maiorCursor = cursor;
    let tevePulo = false;
    const uidsPulados = new Set();

    // ── PASSO 1 & 2: Baixar o que mudou lá (sempre antes de subir) ─────────────
    const mudancas = await this.adapter.listarMudancas(cursor);

    for (const mudanca of mudancas) {
      const { caminho, rev, apagado } = mudanca;

      const ehNota = caminho.startsWith('notas/') && caminho.endsWith('.md');
      const ehModelo = caminho.startsWith('modelos/') && caminho.endsWith('.md');

      if (!ehNota && !ehModelo) {
        if (!tevePulo && Number(rev) > Number(maiorCursor || 0)) maiorCursor = rev;
        continue;
      }

      const estadoLocal = await this.store.obterEstadoSyncPorCaminho(caminho);

      // Tratamento específico de modelos na pasta modelos/
      if (ehModelo) {
        if (apagado) {
          if (!estadoLocal) continue;
          const modLocal = await this.store.obterModeloPorUid(estadoLocal.uid);
          if (!modLocal) {
            await this.store.excluirEstadoSync(estadoLocal.uid);
            continue;
          }
          const textoLocalMod = this.serializarModelo(modLocal);
          if (hashConteudo(textoLocalMod) === estadoLocal.hash) {
            await this.store.excluirModeloLocal(modLocal.uid);
            await this.store.excluirEstadoSync(modLocal.uid);
            resultado.apagadas++;
          } else {
            await this.store.salvarEstadoSync({ ...estadoLocal, rev: null, hash: null });
          }
          if (!tevePulo && Number(rev) > Number(maiorCursor || 0)) maiorCursor = rev;
          continue;
        }

        const arqMod = await this.adapter.ler(caminho);
        if (!arqMod) continue;
        const revRemotaMod = arqMod.rev;
        const parsedMod = parseNoteFile(arqMod.texto);
        if (!parsedMod || !parsedMod.meta || !parsedMod.meta.id) continue;

        const uidMod = parsedMod.meta.id;
        const hashRemotoMod = hashConteudo(arqMod.texto);
        const modLocal = await this.store.obterModeloPorUid(uidMod);
        const estadoModPorUid = await this.store.obterEstadoSync(uidMod);

        if (!modLocal) {
          await this.store.salvarModeloLocal({
            uid: uidMod,
            name: parsedMod.meta.nome || parsedMod.meta.titulo || 'Sem título',
            kind: parsedMod.meta.tipo || parsedMod.meta.kind || 'note',
            content: parsedMod.md || '',
            ordem: parsedMod.meta.ordem ?? 'a0',
            createdAt: parsedMod.meta.criadoEm ? new Date(parsedMod.meta.criadoEm).getTime() : Date.now(),
            updatedAt: parsedMod.meta.atualizadoEm ? new Date(parsedMod.meta.atualizadoEm).getTime() : Date.now(),
          });
          await this.store.salvarEstadoSync({
            uid: uidMod,
            caminho,
            rev: revRemotaMod,
            hash: hashRemotoMod,
            sincronizadoEm: Date.now(),
          });
          resultado.baixadas++;
        } else {
          const textoModLocal = this.serializarModelo(modLocal);
          const hashModLocal = hashConteudo(textoModLocal);

          if (estadoModPorUid && estadoModPorUid.hash === hashRemotoMod && estadoModPorUid.rev === revRemotaMod) {
            if (!tevePulo && Number(rev) > Number(maiorCursor || 0)) maiorCursor = rev;
            continue;
          }

          if (!estadoModPorUid || hashModLocal === estadoModPorUid.hash) {
            await this.store.salvarModeloLocal({
              ...modLocal,
              name: parsedMod.meta.nome || parsedMod.meta.titulo || modLocal.name,
              kind: parsedMod.meta.tipo || parsedMod.meta.kind || modLocal.kind,
              content: parsedMod.md || '',
              ordem: parsedMod.meta.ordem || modLocal.ordem,
              updatedAt: parsedMod.meta.atualizadoEm ? new Date(parsedMod.meta.atualizadoEm).getTime() : Date.now(),
            });
            await this.store.salvarEstadoSync({
              uid: uidMod,
              caminho,
              rev: revRemotaMod,
              hash: hashRemotoMod,
              sincronizadoEm: Date.now(),
            });
            resultado.baixadas++;
          } else {
            const uidConflitoMod = (typeof crypto !== 'undefined' && crypto.randomUUID)
              ? crypto.randomUUID()
              : `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
            const nomeConflitoMod = `${modLocal.name} (conflito ${dataIsoHoje()}, ${this.deviceName})`;
            await this.store.salvarModeloLocal({
              ...modLocal,
              uid: uidConflitoMod,
              name: nomeConflitoMod,
              ordem: ordemEntre(modLocal.ordem ?? 'a0', null),
            });
            await this.store.salvarModeloLocal({
              ...modLocal,
              name: parsedMod.meta.nome || parsedMod.meta.titulo || modLocal.name,
              kind: parsedMod.meta.tipo || parsedMod.meta.kind || modLocal.kind,
              content: parsedMod.md || '',
              ordem: parsedMod.meta.ordem || modLocal.ordem,
              updatedAt: parsedMod.meta.atualizadoEm ? new Date(parsedMod.meta.atualizadoEm).getTime() : Date.now(),
            });
            await this.store.salvarEstadoSync({
              uid: uidMod,
              caminho,
              rev: revRemotaMod,
              hash: hashRemotoMod,
              sincronizadoEm: Date.now(),
            });
            resultado.conflitos++;
            resultado.baixadas++;
          }
        }
        if (!tevePulo && Number(rev) > Number(maiorCursor || 0)) maiorCursor = rev;
        continue;
      }

      // Cenário 2.1: Arquivo foi apagado no destino remoto
      if (apagado) {
        if (!estadoLocal) continue;

        const notaLocal = await this.store.obterNotaPorUid(estadoLocal.uid);
        if (!notaLocal) {
          await this.store.excluirEstadoSync(estadoLocal.uid);
          continue;
        }

        const uidAberta = this.obterNotaAbertaUid ? this.obterNotaAbertaUid() : null;
        const ehNotaAberta = uidAberta != null && uidAberta === estadoLocal.uid;
        if (ehNotaAberta) {
          const podeRecarregar = this.podeRecarregarNotaAberta ? this.podeRecarregarNotaAberta() : true;
          if (!podeRecarregar) {
            tevePulo = true;
            uidsPulados.add(estadoLocal.uid);
            resultado.puladas++;
            continue;
          }
        }

        // Verifica se o usuário editou localmente após o último sync
        const textoLocalAtual = this.serializarNota(notaLocal);
        const hashAtual = hashConteudo(textoLocalAtual);

        if (hashAtual === estadoLocal.hash) {
          // Nota não foi tocada localmente: exclusão remota propaga para cá
          await this.store.excluirNotaLocal(notaLocal.uid);
          await this.store.excluirEstadoSync(notaLocal.uid);
          resultado.apagadas++;
        } else {
          // Nota foi editada aqui enquanto era apagada lá:
          // Regra do QuickDock: a nota RESSUSCITA (edição do usuário nunca se perde).
          // Remove o vínculo com a revisão antiga para subir como novo arquivo no Passo 3.
          await this.store.salvarEstadoSync({
            ...estadoLocal,
            rev: null,
            hash: null,
          });
        }
        continue;
      }

      // Cenário 2.2: Arquivo criado ou atualizado no destino remoto
      const arquivoRemoto = await this.adapter.ler(caminho);
      if (!arquivoRemoto) continue;

      const { texto: textoRemoto, rev: revRemota } = arquivoRemoto;
      const parsed = parseNoteFile(textoRemoto);
      if (!parsed || !parsed.meta || !parsed.meta.id) continue;

      const uid = parsed.meta.id;
      const hashRemoto = hashConteudo(textoRemoto);
      const notaLocal = await this.store.obterNotaPorUid(uid);
      const estadoPorUid = await this.store.obterEstadoSync(uid);

      if (!notaLocal) {
        // Nota não existe localmente: baixa como nota nova
        const blocks = parseMarkdownToBlocks(parsed.md);
        await this.store.salvarNotaLocal({
          uid,
          title: parsed.meta.titulo || 'Sem título',
          blocks,
          color: parsed.meta.cor ?? null,
          icon: parsed.meta.icone ?? null,
          iconFilled: !!parsed.meta.iconePreenchido,
          titleHidden: !!parsed.meta.tituloOculto,
          ordem: parsed.meta.ordem ?? 'a0',
          createdAt: parsed.meta.criadoEm ? new Date(parsed.meta.criadoEm).getTime() : Date.now(),
          updatedAt: parsed.meta.atualizadoEm ? new Date(parsed.meta.atualizadoEm).getTime() : Date.now(),
        });
        await this.store.salvarEstadoSync({
          uid,
          caminho,
          rev: revRemota,
          hash: hashRemoto,
          sincronizadoEm: Date.now(),
        });
        resultado.baixadas++;
      } else {
        // Nota existe localmente: verifica se houve alteração de ambos os lados
        const textoLocal = this.serializarNota(notaLocal);
        const hashLocal = hashConteudo(textoLocal);

        if (estadoPorUid && estadoPorUid.hash === hashRemoto && estadoPorUid.rev === revRemota) {
          // Conteúdo remoto é idêntico ao já sincronizado: nada a fazer no download
          continue;
        }

        // Regra 2 (Tarefa 2): Se a alteração remota for modificar a nota aberta,
        // só aplique se o editor não estiver com foco nem com edição pendente.
        // Caso contrário, pule a nota nesta rodada: ela sincroniza na próxima.
        const uidAberta = this.obterNotaAbertaUid ? this.obterNotaAbertaUid() : null;
        const ehNotaAberta = uidAberta != null && uidAberta === uid;
        if (ehNotaAberta) {
          const podeRecarregar = this.podeRecarregarNotaAberta ? this.podeRecarregarNotaAberta() : true;
          if (!podeRecarregar) {
            tevePulo = true;
            uidsPulados.add(uid);
            resultado.puladas++;
            continue;
          }
        }

        if (!estadoPorUid || hashLocal === estadoPorUid.hash) {
          // Lado local não foi editado (ou reconciliação inicial sem estado): remoto vence com segurança
          const blocks = parseMarkdownToBlocks(parsed.md);
          this._preservarImagensLocais(notaLocal.blocks, blocks);
          await this.store.salvarNotaLocal({
            ...notaLocal,
            uid,
            title: parsed.meta.titulo || notaLocal.title,
            blocks,
            color: parsed.meta.cor !== undefined ? parsed.meta.cor : notaLocal.color,
            icon: parsed.meta.icone !== undefined ? parsed.meta.icone : notaLocal.icon,
            iconFilled: parsed.meta.iconePreenchido !== undefined ? parsed.meta.iconePreenchido : notaLocal.iconFilled,
            titleHidden: parsed.meta.tituloOculto !== undefined ? parsed.meta.tituloOculto : notaLocal.titleHidden,
            ordem: parsed.meta.ordem || notaLocal.ordem,
            updatedAt: parsed.meta.atualizadoEm ? new Date(parsed.meta.atualizadoEm).getTime() : Date.now(),
          });
          await this.store.salvarEstadoSync({
            uid,
            caminho,
            rev: revRemota,
            hash: hashRemoto,
            sincronizadoEm: Date.now(),
          });
          resultado.baixadas++;

          if (ehNotaAberta && this.recarregarNotaAberta) {
            await this.recarregarNotaAberta(notaLocal.id ?? null, uid);
          }
        } else {
          // Conflito: ambos os lados mudaram em relação à base compartilhada!
          // Política: preserva os dois conteúdos. O remoto atualiza a nota local,
          // e o conteúdo local divergente é salvo como cópia de conflito com novo uid.
          const uidConflito = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

          const tituloConflito = `${notaLocal.title} (conflito ${dataIsoHoje()}, ${this.deviceName})`;
          const caminhoConflito = `notas/${slugTitulo(notaLocal.title)} (conflito ${dataIsoHoje()}, ${this.deviceName}).md`;

          // 1. Salva a cópia de conflito com os dados locais.
          //
          // A cópia precisa de ordem PRÓPRIA, logo depois da original. Herdar a
          // mesma deixaria duas notas com a mesma chave de ordenação — e aí
          // mover qualquer uma das duas cai no caminho de reparo do
          // `moveNoteRecord`, que renumera a lista inteira. Um conflito não
          // pode degradar a ordenação de todas as outras notas.
          const notaConflito = {
            ...notaLocal,
            uid: uidConflito,
            title: tituloConflito,
            ordem: ordemEntre(notaLocal.ordem ?? 'a0', null),
          };
          delete notaConflito.id;
          await this.store.salvarNotaLocal(notaConflito);

          // 2. Atualiza a nota principal com o conteúdo que veio do remoto
          const blocks = parseMarkdownToBlocks(parsed.md);
          this._preservarImagensLocais(notaLocal.blocks, blocks);
          await this.store.salvarNotaLocal({
            ...notaLocal,
            uid,
            title: parsed.meta.titulo || notaLocal.title,
            blocks,
            color: parsed.meta.cor !== undefined ? parsed.meta.cor : notaLocal.color,
            icon: parsed.meta.icone !== undefined ? parsed.meta.icone : notaLocal.icon,
            iconFilled: parsed.meta.iconePreenchido !== undefined ? parsed.meta.iconePreenchido : notaLocal.iconFilled,
            titleHidden: parsed.meta.tituloOculto !== undefined ? parsed.meta.tituloOculto : notaLocal.titleHidden,
            ordem: parsed.meta.ordem || notaLocal.ordem,
            updatedAt: parsed.meta.atualizadoEm ? new Date(parsed.meta.atualizadoEm).getTime() : Date.now(),
          });

          await this.store.salvarEstadoSync({
            uid,
            caminho,
            rev: revRemota,
            hash: hashRemoto,
            sincronizadoEm: Date.now(),
          });

          resultado.conflitos++;
          resultado.baixadas++;
          resultado.notasConflito.push({
            tituloOriginal: notaLocal.title,
            tituloConflito,
            uidOriginal: uid,
            uidConflito,
            caminhoOriginal: caminho,
            caminhoConflito,
            criadoEm: Date.now(),
          });

          if (ehNotaAberta && this.recarregarNotaAberta) {
            await this.recarregarNotaAberta(notaLocal.id ?? null, uid);
          }
        }
      }

      if (!tevePulo && Number(rev) > Number(maiorCursor || 0)) {
        maiorCursor = rev;
      }
    }

    // ── PASSO 3: Subir o que mudou aqui ─────────────────────────────────────────
    const notasLocais = await this.store.listarNotasLocais();
    const uidAbertaParaUpload = this.obterNotaAbertaUid ? this.obterNotaAbertaUid() : null;
    const podeRecarregarUpload = this.podeRecarregarNotaAberta ? this.podeRecarregarNotaAberta() : true;

    for (const nota of notasLocais) {
      // Se a nota teve seu download adiado nesta rodada (por estar aberta/ocupada),
      // ou se ainda está aberta com digitação pendente no editor, NÃO sobe nesta rodada.
      // Ela subirá na próxima rodada após flushSave e reconciliação segura.
      if (uidsPulados.has(nota.uid)) continue;
      if (nota.uid === uidAbertaParaUpload && !podeRecarregarUpload) continue;

      // Traduz imagens locais para caminhos imutáveis ../imagens/<hash>.<ext>
      const mapaImagens = new Map();
      if (Array.isArray(nota.blocks)) {
        for (const b of nota.blocks) {
          if (b.type === 'image' && b.fileId != null) {
            try {
              const blob = this.store.obterBlobArquivo
                ? await this.store.obterBlobArquivo(b.fileId)
                : (this.store.obterArquivo ? (await this.store.obterArquivo(b.fileId))?.blob : null);
              if (blob) {
                const hash = await calcularHashImagem(blob);
                const ext = extensaoDeMimeOuNome(blob.type, blob.name);
                const caminhoRemoto = `imagens/${hash}.${ext}`;
                const caminhoRelativo = `../imagens/${hash}.${ext}`;
                mapaImagens.set(b.fileId, caminhoRelativo);

                // Grava na pasta imagens/ se ainda não existir no destino (deduplicação por conteúdo)
                const existe = await this.adapter.ler(caminhoRemoto);
                if (!existe) {
                  await this.adapter.escrever(caminhoRemoto, blob, null);
                }
              }
            } catch {
              // Se falhar o upload da imagem, a nota sobe normalmente e a imagem é marcada como não-sincronizada
            }
          }
        }
      }

      const texto = this.serializarNota(nota, mapaImagens);
      const hashAtual = hashConteudo(texto);
      const estado = await this.store.obterEstadoSync(nota.uid);

      if (!estado) {
        // Nota criada localmente: sobe arquivo novo
        const caminho = `notas/${slugTitulo(nota.title)}.md`;
        const res = await this.adapter.escrever(caminho, texto, null);

        if (res && res.rev) {
          await this.store.salvarEstadoSync({
            uid: nota.uid,
            caminho,
            rev: res.rev,
            hash: hashAtual,
            sincronizadoEm: Date.now(),
          });
          if (!tevePulo && Number(res.rev) > Number(maiorCursor || 0)) maiorCursor = res.rev;
          resultado.enviadas++;
        } else if (res && res.conflito) {
          // Arquivo já existia no remoto com outro conteúdo: gera caminho único
          const caminhoAlt = `notas/${slugTitulo(nota.title)}-${nota.uid.slice(0, 8)}.md`;
          const resAlt = await this.adapter.escrever(caminhoAlt, texto, null);
          if (resAlt && resAlt.rev) {
            await this.store.salvarEstadoSync({
              uid: nota.uid,
              caminho: caminhoAlt,
              rev: resAlt.rev,
              hash: hashAtual,
              sincronizadoEm: Date.now(),
            });
            if (!tevePulo && Number(resAlt.rev) > Number(maiorCursor || 0)) maiorCursor = resAlt.rev;
            resultado.enviadas++;
          }
        }
      } else if (estado.hash !== hashAtual) {
        // Renomear a nota renomeia o arquivo. A identidade continua sendo o `id`
        // do frontmatter — nada depende do nome, e um arquivo renomeado à mão
        // pelo usuário continua funcionando. Mas o motivo de as notas morarem
        // numa pasta legível é a pessoa poder abri-la e se achar sem o
        // QuickDock; uma pasta onde os nomes não correspondem ao conteúdo perde
        // exatamente isso.
        const caminhoUsado = await this._renomearSePreciso(nota, estado);

        // Nota editada localmente: tenta atualizar com revBase
        const revBase = caminhoUsado === estado.caminho ? estado.rev : null;
        const res = await this.adapter.escrever(caminhoUsado, texto, revBase);

        if (res && res.rev) {
          // O antigo só sai depois que o novo já está gravado. Na ordem inversa,
          // uma falha no meio deixaria a nota sem arquivo nenhum.
          if (caminhoUsado !== estado.caminho) {
            try { await this.adapter.apagar(estado.caminho); } catch { /* sobra é melhor que perda */ }
          }
          await this.store.salvarEstadoSync({
            uid: nota.uid,
            caminho: caminhoUsado,
            rev: res.rev,
            hash: hashAtual,
            sincronizadoEm: Date.now(),
          });
          if (!tevePulo && Number(res.rev) > Number(maiorCursor || 0)) maiorCursor = res.rev;
          resultado.enviadas++;
        } else if (res && res.conflito) {
          // Colisão na subida: gera arquivo de cópia de conflito no destino
          const tituloConflito = `${nota.title} (conflito ${dataIsoHoje()}, ${this.deviceName})`;
          const caminhoConflito = `notas/${slugTitulo(nota.title)} (conflito ${dataIsoHoje()}, ${this.deviceName}).md`;
          const resConf = await this.adapter.escrever(caminhoConflito, texto, null);
          if (resConf && resConf.rev) {
            if (!tevePulo && Number(resConf.rev) > Number(maiorCursor || 0)) maiorCursor = resConf.rev;
            resultado.conflitos++;
            resultado.notasConflito.push({
              tituloOriginal: nota.title,
              tituloConflito,
              uidOriginal: nota.uid,
              uidConflito: null,
              caminhoOriginal: estado.caminho,
              caminhoConflito,
              criadoEm: Date.now(),
            });
          }
        }
      }
    }

    // ── PASSO 3.1: Subir modelos locais ─────────────────────────────────────────
    if (this.store.listarModelosLocais) {
      const modelosLocais = await this.store.listarModelosLocais();
      for (const mod of modelosLocais) {
        const textoMod = this.serializarModelo(mod);
        const hashAtualMod = hashConteudo(textoMod);
        const estadoMod = await this.store.obterEstadoSync(mod.uid);

        if (!estadoMod) {
          const caminhoMod = `modelos/${slugTitulo(mod.name)}.md`;
          const res = await this.adapter.escrever(caminhoMod, textoMod, null);
          if (res && res.rev) {
            await this.store.salvarEstadoSync({
              uid: mod.uid,
              caminho: caminhoMod,
              rev: res.rev,
              hash: hashAtualMod,
              sincronizadoEm: Date.now(),
            });
            if (!tevePulo && Number(res.rev) > Number(maiorCursor || 0)) maiorCursor = res.rev;
            resultado.enviadas++;
          }
        } else if (estadoMod.hash !== hashAtualMod) {
          const res = await this.adapter.escrever(estadoMod.caminho, textoMod, estadoMod.rev);
          if (res && res.rev) {
            await this.store.salvarEstadoSync({
              uid: mod.uid,
              caminho: estadoMod.caminho,
              rev: res.rev,
              hash: hashAtualMod,
              sincronizadoEm: Date.now(),
            });
            if (!tevePulo && Number(res.rev) > Number(maiorCursor || 0)) maiorCursor = res.rev;
            resultado.enviadas++;
          }
        }
      }
    }

    // ── PASSO 4: Exclusões locais para subir ao destino ─────────────────────────
    const todosEstados = await this.store.listarTodosEstadosSync();
    for (const est of todosEstados) {
      if (est.caminho.startsWith('modelos/')) {
        const modExiste = this.store.obterModeloPorUid ? await this.store.obterModeloPorUid(est.uid) : null;
        if (!modExiste) {
          await this.adapter.apagar(est.caminho);
          await this.store.excluirEstadoSync(est.uid);
          resultado.apagadas++;
        }
      } else if (est.caminho.startsWith('notas/')) {
        const notaExiste = await this.store.obterNotaPorUid(est.uid);
        if (!notaExiste) {
          // Usuário apagou localmente: propaga exclusão
          await this.adapter.apagar(est.caminho);
          await this.store.excluirEstadoSync(est.uid);
          resultado.apagadas++;
        }
      }
    }

    if (maiorCursor !== cursor) {
      await this.store.salvarCursorSync(maiorCursor);
    }

    return resultado;
  }

  /**
   * Resolve uma imagem remota sob demanda (download preguiçoso).
   * Lê o arquivo de imagens/<hash>.<ext> no adaptador e grava no store local (files),
   * devolvendo o novo fileId local criado.
   */
  async resolverImagem(caminhoImagem, notaUid = null) {
    if (!caminhoImagem || typeof caminhoImagem !== 'string') return null;
    const caminhoRemoto = caminhoImagem.replace(/^\.\.\//, '');
    if (!caminhoRemoto.startsWith('imagens/')) return null;

    const nomeArquivo = caminhoRemoto.split('/').pop();

    if (this.cacheImagensLocais.has(caminhoRemoto)) {
      const idExistente = this.cacheImagensLocais.get(caminhoRemoto);
      if (notaUid) await this._associarImagemLocalANota(notaUid, caminhoImagem, idExistente);
      return { fileId: idExistente };
    }

    // O cache acima vive só em memória e zera quando o painel fecha. O banco não:
    // como o nome do arquivo É o hash do conteúdo, procurar por ele encontra a
    // mesma imagem com certeza. Sem esta busca, reabrir o painel e abrir uma
    // segunda nota que usa a mesma imagem baixaria tudo de novo e guardaria uma
    // cópia a mais — desperdício do disco de quem usa, com prints de megabytes.
    if (this.store.obterArquivoPorNome) {
      const jaTem = await this.store.obterArquivoPorNome(nomeArquivo);
      if (jaTem && jaTem.id != null) {
        this.cacheImagensLocais.set(caminhoRemoto, jaTem.id);
        if (notaUid) await this._associarImagemLocalANota(notaUid, caminhoImagem, jaTem.id);
        return { fileId: jaTem.id };
      }
    }

    const arq = await this.adapter.ler(caminhoRemoto);
    if (!arq) return null;

    const ext = nomeArquivo.split('.').pop().toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
               : (ext === 'webp' ? 'image/webp' : (ext === 'gif' ? 'image/gif' : 'image/png'));
    const blob = arq.blob || arq.conteudo || arq.texto;

    let fileId = null;
    if (this.store.salvarArquivo) {
      fileId = await this.store.salvarArquivo({
        name: nomeArquivo,
        type: mime,
        blob,
        inline: true,
      });
    }

    if (fileId != null) {
      this.cacheImagensLocais.set(caminhoRemoto, fileId);
      if (notaUid) {
        await this._associarImagemLocalANota(notaUid, caminhoImagem, fileId);
      }
    }

    return { fileId, blob };
  }

  /**
   * Decide em qual caminho a nota deve ser gravada quando o título mudou.
   *
   * Não renomeia se o destino já existir: dois títulos diferentes podem gerar o
   * mesmo apelido de arquivo, e sobrescrever seria apagar a nota de outra
   * pessoa. Nome feio é melhor que nota perdida — e o `id` do frontmatter
   * continua sendo a identidade, então ficar com o nome antigo não quebra nada.
   */
  async _renomearSePreciso(nota, estado) {
    const desejado = `notas/${slugTitulo(nota.title)}.md`;
    if (desejado === estado.caminho) return estado.caminho;

    try {
      const ocupado = await this.adapter.ler(desejado);
      if (ocupado) return estado.caminho;
    } catch {
      return estado.caminho;   // na dúvida, não mexe no nome
    }
    return desejado;
  }

  async _associarImagemLocalANota(notaUid, caminhoImagem, fileId) {
    const nota = await this.store.obterNotaPorUid(notaUid);
    if (!nota || !Array.isArray(nota.blocks)) return;
    let mudou = false;
    for (const b of nota.blocks) {
      if (b.type === 'image' && (b.imagePath === caminhoImagem || b.src === caminhoImagem)) {
        b.fileId = fileId;
        mudou = true;
      }
    }
    if (mudou) {
      await this.store.salvarNotaLocal(nota);
    }
  }

  async resolverImagensDaNota(notaOuUid) {
    const nota = typeof notaOuUid === 'string'
      ? await this.store.obterNotaPorUid(notaOuUid)
      : notaOuUid;
    if (!nota || !Array.isArray(nota.blocks)) return;

    let mudou = false;
    for (const b of nota.blocks) {
      if (b.type === 'image' && b.fileId == null && b.imagePath) {
        const res = await this.resolverImagem(b.imagePath, nota.uid);
        if (res && res.fileId != null) {
          b.fileId = res.fileId;
          mudou = true;
        }
      }
    }
    if (mudou) {
      await this.store.salvarNotaLocal(nota);
    }
  }

  /**
   * Quando blocos de imagem descem sem `fileId`, tenta reencontrar o arquivo
   * local correspondente — mas só quando dá pra ter CERTEZA de qual é.
   *
   * Uma versão anterior casava pela ordem de ocorrência quando o texto
   * alternativo não ajudava. Casar por posição não é identificar, é chutar: se
   * o outro aparelho apagou a primeira imagem e manteve a segunda, o bloco
   * passa a exibir a imagem errada, com toda a confiança e sem aviso nenhum.
   * É o mesmo estrago que a troca de `quickdock:file/<id>` por hash existiu
   * pra impedir, voltando por uma heurística.
   *
   * A regra agora é errar pra menos: sem certeza, o bloco fica sem `fileId` e
   * aparece como imagem indisponível. Indisponível é honesto; errada não é.
   */
  _preservarImagensLocais(blocosLocais, novosBlocos) {
    if (!Array.isArray(blocosLocais) || !Array.isArray(novosBlocos)) return;
    const imagensLocais = blocosLocais.filter(b => b.type === 'image' && b.fileId != null);
    if (!imagensLocais.length) return;

    const candidatos = novosBlocos.filter(b => b.type === 'image' && b.fileId == null);
    if (!candidatos.length) return;

    const usados = new Set();

    // 1. Identidade de verdade: mesmo caminho = mesmo hash = mesma imagem.
    for (const nb of candidatos) {
      if (!nb.imagePath) continue;
      const igual = imagensLocais.find(ib => ib.imagePath === nb.imagePath && !usados.has(ib.fileId));
      if (igual) {
        nb.fileId = igual.fileId;
        usados.add(igual.fileId);
      }
    }

    // 2. Texto alternativo, e só quando ele identifica sozinho: não-vazio e
    //    único dos DOIS lados. Dois blocos com o mesmo alt não identificam nada,
    //    e alt vazio identifica menos ainda.
    const contar = (lista, pegar) => {
      const n = new Map();
      for (const b of lista) {
        const k = pegar(b);
        if (k) n.set(k, (n.get(k) ?? 0) + 1);
      }
      return n;
    };
    const alt = b => (b.alt ?? '').trim();
    const quantosLocais = contar(imagensLocais, alt);
    const quantosNovos  = contar(candidatos, alt);

    for (const nb of candidatos) {
      if (nb.fileId != null) continue;
      const a = alt(nb);
      if (!a || quantosLocais.get(a) !== 1 || quantosNovos.get(a) !== 1) continue;
      const unico = imagensLocais.find(ib => alt(ib) === a && !usados.has(ib.fileId));
      if (unico) {
        nb.fileId = unico.fileId;
        usados.add(unico.fileId);
      }
    }

    // O que sobrou fica sem fileId de propósito.
  }
}
