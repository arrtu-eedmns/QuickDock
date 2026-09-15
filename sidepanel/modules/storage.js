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
export async function saveFile(file, noteId = null) {
  return db.files.add({
    name: file.name,
    type: file.type,
    blob: file,
    noteId,
    createdAt: Date.now()
  });
}

export async function loadAllFilesMeta() {
  const files = await db.files.orderBy('createdAt').toArray();
  return files.map(({ id, name, type, noteId, createdAt }) => ({
    id, name, type, noteId: noteId ?? null, createdAt
  }));
}

export async function setFileNoteId(id, noteId) {
  return db.files.update(id, { noteId });
}

// Nota excluída: os documentos dela viram gerais em vez de sumirem junto.
export async function detachFilesFromNote(noteId) {
  return db.files.where('noteId').equals(noteId).modify({ noteId: null });
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
