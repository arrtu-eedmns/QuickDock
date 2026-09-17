import { blocksToPlainText } from './blocks.js';
import { platformStorage, setPlatformDb } from './platform.js';
// O esquema mora numa função (`definirEsquema`, mais abaixo) pra poder ser
// aplicado a mais de um banco. O de verdade é este; o banco de provas cria um
// descartável com `criarBancoDeProvas()` e exercita a camada de armazenamento
// real — Dexie de verdade, IndexedDB de verdade — sem chegar perto das notas de
// ninguém. Sem isso, o DexieSyncStore seria a única peça sem forma de teste.
export const db = typeof Dexie !== 'undefined' ? definirEsquema(new Dexie('quickdock')) : null;
if (db) setPlatformDb(db);

export function criarBancoDeProvas(nome = 'quickdock-provas') {
  if (typeof Dexie === 'undefined') throw new Error('Dexie não está carregado neste ambiente.');
  return definirEsquema(new Dexie(nome));
}

// ── Ordem fracionária e migração v6 ──────────────────────────────────────────
// O índice fracionário (a0, a0V, a1...) permite inserir e reordenar notas
// calculando uma chave intermediária pura, sem precisar reescrever nem tocar
// nas outras notas. Isso elimina a necessidade de um arquivo de índice centralizado,
// que seria o principal ponto de conflito na sincronização entre aparelhos.
const DIGITOS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = '0';
const MID = 'V';

/**
 * Converte um índice numérico inteiro para string fracionária lexicograficamente ordenada.
 * Exemplo: 0 -> "a0", 1 -> "a1", ..., 61 -> "az", 62 -> "b10".
 */
export function ordemDeIndice(n) {
  const num = typeof n === 'number' && !isNaN(n) ? Math.floor(n) : 0;
  if (num < 0) {
    const neg = -num - 1;
    if (neg < 62) return 'Z' + DIGITOS[61 - neg];
    return 'Y' + String(neg).padStart(4, '0');
  }
  if (num < 62) {
    return 'a' + DIGITOS[num];
  }
  const d1 = Math.floor(num / 62);
  const d0 = num % 62;
  return 'b' + DIGITOS[d1] + DIGITOS[d0];
}

/**
 * Retorna uma string fracionária lexicograficamente estrita entre `a` e `b`.
 * Para quaisquer `a < b`, garante que `a < ordemEntre(a, b) < b`.
 * Suporta inserção no início (a = null), no fim (b = null) ou lista vazia.
 */
/**
 * Chave imediatamente maior que `a`, para inserir no fim da lista.
 *
 * Incrementa o dígito mais à direita que ainda não está no teto e descarta o
 * resto. Isso importa porque criar nota é a operação mais frequente do app e
 * cada uma chama esta função: a versão anterior caía num `a + 'V'` que crescia
 * um caractere por nota — a nota 300 chegava a uma chave de 240 caracteres.
 * Aqui a chave só cresce quando a faixa inteira está no teto.
 */
function proximoDepois(a) {
  // Formas curtas que `ordemDeIndice` produz continuam subindo dentro da
  // própria faixa, que é o que mantém a chave com 2 ou 3 caracteres no uso comum.
  if (a.startsWith('a') && a.length === 2) {
    const idx = DIGITOS.indexOf(a[1]);
    if (idx < 61) return 'a' + DIGITOS[idx + 1];
    return 'b10';
  }
  if (a.startsWith('Z') && a.length === 2) {
    const idx = DIGITOS.indexOf(a[1]);
    if (idx < 61) return 'Z' + DIGITOS[idx + 1];
    return 'a0';
  }
  // O primeiro caractere é a faixa de magnitude e não entra no incremento —
  // por isso o laço para em 1.
  for (let i = a.length - 1; i >= 1; i--) {
    const idx = DIGITOS.indexOf(a[i]);
    if (idx >= 0 && idx < DIGITOS.length - 1) return a.slice(0, i) + DIGITOS[idx + 1];
  }
  return a + MID;
}

export function ordemEntre(a, b) {
  if (!a && !b) return 'a0';
  if (!b) return proximoDepois(a);

  // Inserir no começo é o caso geral com limite inferior vazio: '' é menor que
  // qualquer chave, e o algoritmo de ponto médio abaixo já sabe descer a partir
  // daí. Antes isto era resolvido com casos especiais por prefixo, e era de
  // onde vinha o bug: ao passar da faixa 'Z' para a faixa de estouro 'Y', o
  // caso especial caía num `'Z' + b` que ordenava DEPOIS de `b`, não antes.
  a = a || '';

  if (a >= b) {
    throw new Error(`ordemEntre requer a < b (recebeu a="${a}", b="${b}")`);
  }

  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }

  if (i < a.length && i < b.length) {
    const valA = DIGITOS.indexOf(a[i]);
    const valB = DIGITOS.indexOf(b[i]);
    if (valB - valA > 1) {
      const mid = Math.floor((valA + valB) / 2);
      return a.slice(0, i) + DIGITOS[mid];
    }
    let j = i + 1;
    while (j < a.length && a[j] === DIGITOS[DIGITOS.length - 1]) {
      j++;
    }
    if (j < a.length) {
      const v = DIGITOS.indexOf(a[j]);
      const mid = Math.floor((v + DIGITOS.length) / 2);
      return a.slice(0, j) + DIGITOS[mid];
    }
    return a + MID;
  }

  // a é prefixo de b
  let j = i;
  while (j < b.length && b[j] === ZERO) {
    j++;
  }
  if (j < b.length) {
    const v = DIGITOS.indexOf(b[j]);
    const mid = Math.floor(v / 2);
    if (mid > 0) {
      return a + ZERO.repeat(j - i) + DIGITOS[mid];
    }
    return a + ZERO.repeat(j - i) + ZERO + MID;
  }
  return a + MID;
}

/**
 * Função pura de migração de um registro individual de nota ou template do formato v5 para o v6.
 * Preenche `uid` e `ordem` preservando integralmente todos os campos já existentes.
 */
export function migrarRegistroV5ParaV6(registro, indice = 0) {
  const r = { ...registro };
  if (!r.uid) {
    r.uid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
  if (!r.ordem) {
    r.ordem = ordemDeIndice(r.order ?? indice);
  }
  return r;
}

function definirEsquema(db) {
  db.version(1).stores({
    files: '++id, name, type, createdAt'
  });
  db.version(2).stores({
    files: '++id, name, type, createdAt',
    notes: '++id, order, updatedAt'
  });
  // noteId indexado só pra conseguir varrer os arquivos de uma nota ao excluí-la.
  // Arquivos criados antes desta versão não têm o campo e ficam fora do índice —
  // que é justamente o que queremos: sem noteId = geral.
  db.version(3).stores({
    files: '++id, name, type, noteId, createdAt',
    notes: '++id, order, updatedAt'
  });
  // Modelos de nota: markdown guardado como texto, igual ao que sai na
  // exportação — é o que deixa importar e compartilhar um .md ser a mesma coisa.
  db.version(4).stores({
    files: '++id, name, type, noteId, createdAt',
    notes: '++id, order, updatedAt',
    templates: '++id, order, name'
  });
  // Imagem colada dentro da nota mora na mesma tabela de arquivos: é arquivo de
  // verdade (um Blob), não base64 no meio do texto. A marca `inline` é o que a
  // mantém fora da seção Documentos — ela já está visível dentro da nota.
  //
  // O valor é 1, não `true`: o IndexedDB não aceita booleano como chave e um
  // índice de booleano ficaria silenciosamente vazio. Arquivo salvo antes desta
  // versão não tem o campo e fica fora do índice — ou seja, documento normal,
  // que é exatamente o que ele era.
  db.version(5).stores({
    files: '++id, name, type, noteId, inline, createdAt',
    notes: '++id, order, updatedAt',
    templates: '++id, order, name'
  });
  // v6: identidade que viaja no arquivo (uid) ao lado do id inteiro (local).
  // Nunca tocamos na chave primária `++id`, evitando retrabalho em referências locais.
  // Acrescenta ordem fracionária e migra registros existentes.
  db.version(6).stores({
    files: '++id, name, type, noteId, inline, createdAt',
    notes: '++id, uid, ordem, order, updatedAt',
    templates: '++id, uid, ordem, order, name'
  }).upgrade(async tx => {
    await tx.table('notes').toCollection().modify((note, i) => {
      Object.assign(note, migrarRegistroV5ParaV6(note, note.order ?? i));
    });
    await tx.table('templates').toCollection().modify((tpl, i) => {
      Object.assign(tpl, migrarRegistroV5ParaV6(tpl, tpl.order ?? i));
    });
  });
  // v7: estado de sincronização — local, por aparelho, nunca sobe. É ele que
  // distingue "arquivo apagado lá" de "arquivo que nunca chegou aqui".
  db.version(7).stores({
    files: "++id, name, type, noteId, inline, createdAt",
    notes: "++id, uid, ordem, order, updatedAt",
    templates: "++id, uid, ordem, order, name",
    syncState: "uid, caminho",
    syncMeta: "chave"
  });
  // v8: tabela de preferências locais para uso na web/PWA (fora da extensão)
  db.version(8).stores({
    preferences: "chave"
  });
  setPlatformDb(db);
  return db;
}

// --- NOTAS ---
export async function loadAllNotesMeta() {
  const notes = await (db.notes.schema.indexes.some(idx => idx.name === 'ordem')
    ? db.notes.orderBy('ordem')
    : db.notes.orderBy('order')).toArray();
  return notes.map(({ id, uid, title, content, color, icon, iconFilled, titleHidden, ordem, order, updatedAt }) => ({
    id, uid: uid ?? null, title, content: content ?? '', color, icon: icon ?? null, iconFilled: !!iconFilled, titleHidden: !!titleHidden, ordem: ordem ?? ordemDeIndice(order ?? 0), updatedAt,
  }));
}

export async function getNoteById(id) {
  return db.notes.get(id);
}

export async function createNoteRecord({ title, content = '', blocks = [], color = null, icon = null, iconFilled = false, titleHidden = false, uid = null, ordem = null }) {
  const count = await db.notes.count();
  let novaOrdem = ordem;
  if (!novaOrdem) {
    const lastNote = await db.notes.orderBy('ordem').last().catch(() => null);
    novaOrdem = ordemEntre(lastNote?.ordem ?? null, null);
  }
  const novoUid = uid ?? ((typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
  const now = Date.now();
  return db.notes.add({
    uid: novoUid,
    title,
    content,
    blocks,
    color,
    icon,
    iconFilled,
    titleHidden,
    ordem: novaOrdem,
    order: count,
    createdAt: now,
    updatedAt: now
  });
}

// `blocks` é a fonte de verdade do editor; `content` é uma
// versão em texto simples derivada, guardada só por portabilidade/backup.
export async function updateNoteBlocksById(id, blocks, content) {
  return db.notes.update(id, { blocks, content, updatedAt: Date.now() });
}

export async function updateNoteMetaById(id, patch) {
  return db.notes.update(id, { ...patch, updatedAt: Date.now() });
}

export async function deleteNoteRecordById(id) {
  return db.notes.delete(id);
}

// Renumera a lista inteira. Passou a ser caminho de REPARO, não o caminho
// comum: reescrever todas as notas é exatamente o que a ordem fracionária
// existe pra evitar. Sob sincronização, arrastar uma nota sujaria os N
// arquivos e cada um viraria um conflito em potencial.
// Devolve as ordens atribuídas, na mesma sequência dos ids recebidos.
export async function reorderNoteRecords(orderedIds) {
  const ordens = orderedIds.map((_, i) => ordemDeIndice(i));
  await Promise.all(orderedIds.map((id, i) => db.notes.update(id, { order: i, ordem: ordens[i] })));
  return ordens;
}

// Mover uma nota reescreve só ELA, calculando uma chave entre os dois vizinhos
// novos. `null` em qualquer lado significa ponta da lista.
//
// Não mexe em `updatedAt`: reordenar não é editar, e a lista mostra essa data
// pra pessoa. A sincronização percebe a mudança pelo hash do arquivo.
//
// Devolve a ordem nova, ou `null` quando os vizinhos estão inconsistentes
// (ordens iguais ou invertidas, resquício de banco remendado) — nesse caso quem
// chamou renumera a lista com `reorderNoteRecords`.
export async function moveNoteRecord(id, ordemAnterior, ordemSeguinte) {
  let ordem;
  try {
    ordem = ordemEntre(ordemAnterior ?? null, ordemSeguinte ?? null);
  } catch {
    return null;
  }
  await db.notes.update(id, { ordem });
  return ordem;
}

// Migra a nota única antiga (armazenamento legado) para a primeira nota do Dexie.
// Executa apenas uma vez: se já existir alguma nota no Dexie, não faz nada.
// Se não houver conteúdo legado nenhum (instalação nova de verdade), não cria
// nota nenhuma — quem decide o que mostrar pra um primeiro acesso é o
// initNotesTabs() (nota-tutorial), não esta migração.
export async function migrateLegacyNoteIfNeeded() {
  const count = await db.notes.count();
  if (count > 0) return;

  const legacy = (await platformStorage.get('note_content')) || '';
  if (!legacy) return;

  await createNoteRecord({ title: 'Nota 1', content: legacy });
  await platformStorage.remove('note_content');
}

// --- MODELOS DE NOTA ---
// kind: 'note' cria uma nota inteira, 'block' entra no cursor. Registros
// gravados antes do modelo de bloco existir não têm o campo — o `?? 'note'`
// mantém todos eles como modelo de nota, que é o que eram.
export async function loadAllTemplates() {
  const rows = await (db.templates.schema.indexes.some(idx => idx.name === 'ordem')
    ? db.templates.orderBy('ordem')
    : db.templates.orderBy('order')).toArray();
  return rows.map(({ id, uid, name, content, kind, ordem, order, createdAt }) => ({
    id, uid: uid ?? null, name, content, kind: kind ?? 'note', ordem: ordem ?? ordemDeIndice(order ?? 0), createdAt,
  }));
}

export async function createTemplateRecord({ name, content, kind = 'note', uid = null, ordem = null }) {
  const count = await db.templates.count();
  let novaOrdem = ordem;
  if (!novaOrdem) {
    const lastTpl = await db.templates.orderBy('ordem').last().catch(() => null);
    novaOrdem = ordemEntre(lastTpl?.ordem ?? null, null);
  }
  const novoUid = uid ?? ((typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
  return db.templates.add({
    uid: novoUid,
    name,
    content,
    kind,
    ordem: novaOrdem,
    order: count,
    createdAt: Date.now()
  });
}

export async function updateTemplateById(id, patch) {
  return db.templates.update(id, patch);
}

export async function deleteTemplateById(id) {
  return db.templates.delete(id);
}

// Cada exemplo é semeado uma vez só, com a marca fora da tabela — assim apagar
// o exemplo não o traz de volta na próxima abertura. A chave é por exemplo:
// quem já tem o modelo de nota instalado ainda recebe o de bloco.
export async function wasSeeded(key) {
  return !!(await platformStorage.get(key));
}

export async function markSeeded(key) {
  return platformStorage.set(key, true);
}

// --- NOTA ATIVA ---
export async function loadActiveNoteId() {
  const active_note_id = await platformStorage.get('active_note_id');
  return active_note_id ?? null;
}

export async function saveActiveNoteId(id) {
  return platformStorage.set('active_note_id', id);
}

// --- FILTRO DE DOCUMENTOS ('note' | 'all') ---
export async function loadDocsView() {
  const docs_view = await platformStorage.get('docs_view');
  return docs_view === 'all' ? 'all' : 'note';
}

export async function saveDocsView(view) {
  return platformStorage.set('docs_view', view);
}

// --- LAYOUT (área redimensionável) ---
export async function loadSplitRatio() {
  const split_ratio = await platformStorage.get('split_ratio');
  return split_ratio ?? 0.7;
}

export async function saveSplitRatio(ratio) {
  return platformStorage.set('split_ratio', ratio);
}

// --- TEMA ---
export async function loadTheme() {
  const theme = await platformStorage.get('theme');
  return theme || null;
}

export async function saveTheme(theme) {
  return platformStorage.set('theme', theme);
}

// --- ARQUIVOS ---
// noteId null  → documento geral: aparece em todas as notas.
// noteId <id>  → aparece só naquela nota.
// Quem foi salvo antes deste recurso não tem o campo; o `?? null` na leitura
// os trata como gerais, que é exatamente o comportamento que já tinham.
export async function saveFile(file, noteId = null, { inline = false } = {}) {
  const registro = {
    name: file.name,
    type: file.type,
    blob: file,
    noteId,
    createdAt: Date.now()
  };
  if (inline) registro.inline = 1;
  return db.files.add(registro);
}

export async function loadAllFilesMeta() {
  const files = await db.files.orderBy('createdAt').toArray();
  return files.map(({ id, name, type, noteId, inline, createdAt }) => ({
    id, name, type, noteId: noteId ?? null, inline: inline === 1, createdAt
  }));
}

export async function setFileNoteId(id, noteId) {
  return db.files.update(id, { noteId });
}

// Nota excluída: os documentos dela viram gerais em vez de sumirem junto.
// A imagem colada dentro da nota é o caso oposto — ela só existe dentro
// daquela nota, então não pode virar um documento solto na lista de ninguém.
export async function detachFilesFromNote(noteId) {
  return db.files.where('noteId').equals(noteId)
    .and(f => f.inline !== 1)
    .modify({ noteId: null });
}

// Tira a marca de inline: o arquivo deixa de ser "imagem dentro da nota" e
// passa a ser um documento normal, visível na seção de baixo. Continua
// vinculado à mesma nota, então aparece em "Nesta nota" — que é onde a pessoa
// vai procurar por ele logo depois de tirá-lo do texto.
// O campo é APAGADO, não zerado: o índice `inline` só enxerga quem tem o
// valor 1, e é assim que os arquivos antigos (que nunca tiveram o campo)
// ficam de fora dele. Um `inline: 0` seria um terceiro estado sem sentido.
export async function moveInlineFileToDocuments(id) {
  const mexidos = await db.files.where(':id').equals(id).modify(f => { delete f.inline; });
  return mexidos > 0;
}

// Imagem inline vira lixo quando o bloco dela some da nota (apagaram o bloco,
// limparam a nota, excluíram a nota). Apagar na hora atrapalharia o Ctrl+Z,
// que traria o bloco de volta sem o arquivo — então a faxina roda uma vez na
// abertura do painel, quando não existe histórico de desfazer pra atrapalhar.
//
// Devolve quantos arquivos foram removidos.
export async function gcInlineFiles() {
  const inlines = await db.files.where('inline').equals(1).primaryKeys();
  if (inlines.length === 0) return 0;

  const usados = new Set();
  await db.notes.each(note => {
    for (const b of note.blocks ?? []) {
      if (b.type === 'image' && b.fileId != null) usados.add(b.fileId);
    }
  });

  const lixo = inlines.filter(id => !usados.has(id));
  if (lixo.length) await db.files.bulkDelete(lixo);
  return lixo.length;
}

export async function loadFileBlob(id) {
  const file = await db.files.get(id);
  return file ? file.blob : null;
}

export async function deleteFile(id) {
  return db.files.delete(id);
}

// --- HISTÓRICO DE CÁLCULOS ---
export async function loadMathHistory() {
  const math_history = await platformStorage.get('math_history');
  return math_history ?? [];
}

export async function saveMathHistory(history) {
  return platformStorage.set('math_history', history);
}

// --- PONTE ENTRE O MOTOR DE SINCRONIZAÇÃO E O BANCO ---
// O SyncEngine foi escrito contra um contrato de `store` de 11 métodos, e até
// aqui só existia a implementação de mentira (test/memory-store.mjs). Esta é a
// de verdade.
//
// Recebe o banco no construtor em vez de usar o global: é o que permite o banco
// de provas rodar esta mesma classe contra um banco descartável.
//
// Duas traduções acontecem aqui, e são a razão de a ponte existir em vez de o
// motor falar direto com o Dexie:
//
//   `uid` x `id` — o motor só conhece `uid`, que é a identidade que viaja no
//   arquivo. O `id` inteiro é local e nunca sai daqui, então é esta classe que
//   resolve um pelo outro.
//
//   `content` — o motor manda blocos, que são a verdade do editor. O `content`
//   é a versão em texto simples derivada deles, e quem mantém essa derivação é
//   o armazenamento. Deixá-la a cargo do motor espalharia a regra.
export class DexieSyncStore {
  constructor(banco = db) {
    this.db = banco;
  }

  async listarNotasLocais() {
    return this.db.notes.toArray();
  }

  async obterNotaPorUid(uid) {
    return (await this.db.notes.where('uid').equals(uid).first()) ?? null;
  }

  async salvarNotaLocal(nota) {
    const content = blocksToPlainText(nota.blocks ?? []);
    const existente = await this.obterNotaPorUid(nota.uid);
    if (existente) {
      await this.db.notes.update(existente.id, { ...nota, content });
      return existente.id;
    }
    // `id` vem do auto-incremento; mandar o do outro aparelho colidiria.
    const { id, ...semId } = nota;
    return this.db.notes.add({ ...semId, content });
  }

  async excluirNotaLocal(uid) {
    const nota = await this.obterNotaPorUid(uid);
    if (!nota) return;
    // Os documentos da nota viram gerais em vez de sumirem junto — mesma regra
    // de quando a pessoa exclui a nota pela interface.
    await detachFilesFromNote(nota.id);
    await this.db.notes.delete(nota.id);
  }

  async obterEstadoSync(uid) {
    return (await this.db.syncState.get(uid)) ?? null;
  }

  async obterEstadoSyncPorCaminho(caminho) {
    return (await this.db.syncState.where('caminho').equals(caminho).first()) ?? null;
  }

  async salvarEstadoSync(estado) {
    await this.db.syncState.put({ ...estado });
  }

  async excluirEstadoSync(uid) {
    await this.db.syncState.delete(uid);
  }

  async listarTodosEstadosSync() {
    return this.db.syncState.toArray();
  }

  // O cursor mora em tabela própria, não numa linha reservada do `syncState`:
  // o motor varre `listarTodosEstadosSync()` pra descobrir o que foi apagado lá,
  // e uma linha que não corresponde a nota nenhuma seria lida como exclusão.
  async obterCursorSync() {
    return (await this.db.syncMeta.get('cursor'))?.valor ?? null;
  }

  async salvarCursorSync(valor) {
    await this.db.syncMeta.put({ chave: 'cursor', valor });
  }

  async obterMeta(chave) {
    return (await this.db.syncMeta.get(chave))?.valor ?? null;
  }

  async salvarMeta(chave, valor) {
    await this.db.syncMeta.put({ chave, valor });
  }

  async excluirMeta(chave) {
    await this.db.syncMeta.delete(chave);
  }

  async obterArquivo(id) {
    return (await this.db.files.get(Number(id))) ?? null;
  }

  async obterBlobArquivo(id) {
    const file = await this.db.files.get(Number(id));
    return file ? file.blob : null;
  }

  async salvarArquivo({ name, type, blob, inline = false, noteId = null }) {
    const registro = {
      name,
      type,
      blob,
      noteId,
      createdAt: Date.now(),
    };
    if (inline) registro.inline = 1;
    return this.db.files.add(registro);
  }

  // Imagem sincronizada se chama `<hash>.<ext>`, e o nome vem do conteúdo — então
  // procurar pelo nome é procurar pela imagem, com certeza e não por semelhança.
  // É isso que evita baixar de novo e guardar uma segunda cópia da mesma imagem
  // quando o painel é reaberto: o cache do motor vive só em memória, mas o banco
  // não. A tabela `files` já indexa `name` desde a v3, então não custa nada.
  async obterArquivoPorNome(name) {
    if (!name) return null;
    return (await this.db.files.where('name').equals(name).first()) ?? null;
  }

  async listarModelosLocais() {
    return this.db.templates.toArray();
  }

  async obterModeloPorUid(uid) {
    return (await this.db.templates.where('uid').equals(uid).first()) ?? null;
  }

  async salvarModeloLocal(tpl) {
    const existente = await this.obterModeloPorUid(tpl.uid);
    if (existente) {
      await this.db.templates.update(existente.id, { ...tpl });
      return existente.id;
    }
    const { id, ...semId } = tpl;
    return this.db.templates.add({ ...semId });
  }

  async excluirModeloLocal(uid) {
    const tpl = await this.obterModeloPorUid(uid);
    if (!tpl) return;
    await this.db.templates.delete(tpl.id);
  }
}

// Helpers diretos para acessar metadados de sincronização do banco padrão (db)
export async function getSyncMeta(chave) {
  if (!db) return null;
  return (await db.syncMeta.get(chave))?.valor ?? null;
}

export async function setSyncMeta(chave, valor) {
  if (!db) return;
  await db.syncMeta.put({ chave, valor });
}

export async function deleteSyncMeta(chave) {
  if (!db) return;
  await db.syncMeta.delete(chave);
}
