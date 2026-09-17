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

export class SyncEngine {
  /**
   * @param {Object} opcoes
   * @param {Object} opcoes.adapter Adaptador que cumpre o contrato de sync-adapter.js
   * @param {Object} opcoes.store   Armazenamento local (notas e estado de sync)
   * @param {string} [opcoes.deviceName='Dispositivo'] Nome para etiquetar cópias de conflito
   */
  constructor({ adapter, store, deviceName = 'Dispositivo' }) {
    this.adapter = adapter;
    this.store = store;
    this.deviceName = deviceName;
  }

  /**
   * Serializa uma nota local para o formato final do arquivo .md (frontmatter + blocos).
   */
  serializarNota(nota) {
    const md = blocksToMarkdown(nota.blocks ?? []);
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
   * Executa uma rodada completa de sincronização bidirecional.
   * @returns {Promise<{ baixadas: number, enviadas: number, conflitos: number, apagadas: number }>}
   */
  async sincronizar() {
    await this.adapter.autenticar();

    const resultado = { baixadas: 0, enviadas: 0, conflitos: 0, apagadas: 0 };
    const cursor = await this.store.obterCursorSync();
    let maiorCursor = cursor;

    // ── PASSO 1 & 2: Baixar o que mudou lá (sempre antes de subir) ─────────────
    const mudancas = await this.adapter.listarMudancas(cursor);

    for (const mudanca of mudancas) {
      const { caminho, rev, apagado } = mudanca;
      // Atualiza cursor de sequência
      if (Number(rev) > Number(maiorCursor || 0)) {
        maiorCursor = rev;
      }

      // Processamos apenas notas na pasta de notas
      if (!caminho.startsWith('notas/') || !caminho.endsWith('.md')) {
        continue;
      }

      const estadoLocal = await this.store.obterEstadoSyncPorCaminho(caminho);

      // Cenário 2.1: Arquivo foi apagado no destino remoto
      if (apagado) {
        if (!estadoLocal) continue;

        const notaLocal = await this.store.obterNotaPorUid(estadoLocal.uid);
        if (!notaLocal) {
          await this.store.excluirEstadoSync(estadoLocal.uid);
          continue;
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

        if (!estadoPorUid || hashLocal === estadoPorUid.hash) {
          // Lado local não foi editado (ou reconciliação inicial sem estado): remoto vence com segurança
          const blocks = parseMarkdownToBlocks(parsed.md);
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
        }
      }
    }

    // ── PASSO 3: Subir o que mudou aqui ─────────────────────────────────────────
    const notasLocais = await this.store.listarNotasLocais();

    for (const nota of notasLocais) {
      const texto = this.serializarNota(nota);
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
          if (Number(res.rev) > Number(maiorCursor || 0)) maiorCursor = res.rev;
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
            if (Number(resAlt.rev) > Number(maiorCursor || 0)) maiorCursor = resAlt.rev;
            resultado.enviadas++;
          }
        }
      } else if (estado.hash !== hashAtual) {
        // Nota editada localmente: tenta atualizar com revBase
        const res = await this.adapter.escrever(estado.caminho, texto, estado.rev);

        if (res && res.rev) {
          await this.store.salvarEstadoSync({
            uid: nota.uid,
            caminho: estado.caminho,
            rev: res.rev,
            hash: hashAtual,
            sincronizadoEm: Date.now(),
          });
          if (Number(res.rev) > Number(maiorCursor || 0)) maiorCursor = res.rev;
          resultado.enviadas++;
        } else if (res && res.conflito) {
          // Colisão na subida: gera arquivo de cópia de conflito no destino
          const caminhoConflito = `notas/${slugTitulo(nota.title)} (conflito ${dataIsoHoje()}, ${this.deviceName}).md`;
          const resConf = await this.adapter.escrever(caminhoConflito, texto, null);
          if (resConf && resConf.rev) {
            if (Number(resConf.rev) > Number(maiorCursor || 0)) maiorCursor = resConf.rev;
            resultado.conflitos++;
          }
        }
      }
    }

    // ── PASSO 4: Exclusões locais para subir ao destino ─────────────────────────
    const todosEstados = await this.store.listarTodosEstadosSync();
    for (const est of todosEstados) {
      const notaExiste = await this.store.obterNotaPorUid(est.uid);
      if (!notaExiste) {
        // Usuário apagou localmente: propaga exclusão
        await this.adapter.apagar(est.caminho);
        await this.store.excluirEstadoSync(est.uid);
        resultado.apagadas++;
      }
    }

    if (maiorCursor !== cursor) {
      await this.store.salvarCursorSync(maiorCursor);
    }

    return resultado;
  }
}
