const db = new Dexie('quickdock');
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

// --- NOTAS ---
export async function loadAllNotesMeta() {
  const notes = await db.notes.orderBy('order').toArray();
  return notes.map(({ id, title, color, icon, iconFilled, titleHidden, updatedAt }) => ({
    id, title, color, icon: icon ?? null, iconFilled: !!iconFilled, titleHidden: !!titleHidden, updatedAt,
  }));
}

export async function getNoteById(id) {
  return db.notes.get(id);
}

export async function createNoteRecord({ title, content = '', blocks = [], color = null, icon = null, iconFilled = false, titleHidden = false }) {
  const count = await db.notes.count();
  const now = Date.now();
  return db.notes.add({ title, content, blocks, color, icon, iconFilled, titleHidden, order: count, createdAt: now, updatedAt: now });
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

export async function reorderNoteRecords(orderedIds) {
  await Promise.all(orderedIds.map((id, i) => db.notes.update(id, { order: i })));
}

// Migra a nota única antiga (chrome.storage.local) para a primeira nota do Dexie.
// Executa apenas uma vez: se já existir alguma nota no Dexie, não faz nada.
// Se não houver conteúdo legado nenhum (instalação nova de verdade), não cria
// nota nenhuma — quem decide o que mostrar pra um primeiro acesso é o
// initNotesTabs() (nota-tutorial), não esta migração.
export async function migrateLegacyNoteIfNeeded() {
  const count = await db.notes.count();
  if (count > 0) return;

  const legacy = await new Promise(resolve => {
    chrome.storage.local.get('note_content', ({ note_content }) => resolve(note_content || ''));
  });
  if (!legacy) return;

  await createNoteRecord({ title: 'Nota 1', content: legacy });
  await new Promise(resolve => chrome.storage.local.remove('note_content', resolve));
}

// --- MODELOS DE NOTA ---
// kind: 'note' cria uma nota inteira, 'block' entra no cursor. Registros
// gravados antes do modelo de bloco existir não têm o campo — o `?? 'note'`
// mantém todos eles como modelo de nota, que é o que eram.
export async function loadAllTemplates() {
  const rows = await db.templates.orderBy('order').toArray();
  return rows.map(({ id, name, content, kind, createdAt }) => ({
    id, name, content, kind: kind ?? 'note', createdAt,
  }));
}

export async function createTemplateRecord({ name, content, kind = 'note' }) {
  const count = await db.templates.count();
  return db.templates.add({ name, content, kind, order: count, createdAt: Date.now() });
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
  return new Promise(resolve => {
    chrome.storage.local.get(key, obj => resolve(!!obj[key]));
  });
}

export async function markSeeded(key) {
  return new Promise(resolve => chrome.storage.local.set({ [key]: true }, resolve));
}

// --- NOTA ATIVA ---
export async function loadActiveNoteId() {
  return new Promise(resolve => {
    chrome.storage.local.get('active_note_id', ({ active_note_id }) => resolve(active_note_id ?? null));
  });
}

export async function saveActiveNoteId(id) {
  return new Promise(resolve => {
    chrome.storage.local.set({ active_note_id: id }, resolve);
  });
}

// --- FILTRO DE DOCUMENTOS ('note' | 'all') ---
export async function loadDocsView() {
  return new Promise(resolve => {
    chrome.storage.local.get('docs_view', ({ docs_view }) => resolve(docs_view === 'all' ? 'all' : 'note'));
  });
}

export async function saveDocsView(view) {
  return new Promise(resolve => {
    chrome.storage.local.set({ docs_view: view }, resolve);
  });
}

// --- LAYOUT (área redimensionável) ---
export async function loadSplitRatio() {
  return new Promise(resolve => {
    chrome.storage.local.get('split_ratio', ({ split_ratio }) => resolve(split_ratio ?? 0.7));
  });
}

export async function saveSplitRatio(ratio) {
  return new Promise(resolve => {
    chrome.storage.local.set({ split_ratio: ratio }, resolve);
  });
}

// --- TEMA ---
export async function loadTheme() {
  return new Promise(resolve => {
    chrome.storage.local.get('theme', ({ theme }) => {
      resolve(theme || null);
    });
  });
}

export async function saveTheme(theme) {
  return new Promise(resolve => {
    chrome.storage.local.set({ theme }, resolve);
  });
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
  return new Promise(resolve => {
    chrome.storage.local.get('math_history', ({ math_history }) => {
      resolve(math_history ?? []);
    });
  });
}

export async function saveMathHistory(history) {
  return new Promise(resolve => {
    chrome.storage.local.set({ math_history: history }, resolve);
  });
}
