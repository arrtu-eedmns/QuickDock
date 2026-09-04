const db = new Dexie('quickdock');
db.version(1).stores({
  files: '++id, name, type, createdAt'
});
db.version(2).stores({
  files: '++id, name, type, createdAt',
  notes: '++id, order, updatedAt'
});

// --- NOTAS ---
export async function loadAllNotesMeta() {
  const notes = await db.notes.orderBy('order').toArray();
  return notes.map(({ id, title, color, updatedAt }) => ({ id, title, color, updatedAt }));
}

export async function getNoteById(id) {
  return db.notes.get(id);
}

export async function createNoteRecord({ title, content = '', color = null }) {
  const count = await db.notes.count();
  const now = Date.now();
  return db.notes.add({ title, content, color, order: count, createdAt: now, updatedAt: now });
}

export async function updateNoteContentById(id, content) {
  return db.notes.update(id, { content, updatedAt: Date.now() });
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
export async function migrateLegacyNoteIfNeeded() {
  const count = await db.notes.count();
  if (count > 0) return;

  const legacy = await new Promise(resolve => {
    chrome.storage.local.get('note_content', ({ note_content }) => resolve(note_content || ''));
  });

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
export async function saveFile(file) {
  return db.files.add({
    name: file.name,
    type: file.type,
    blob: file,
    createdAt: Date.now()
  });
}

export async function loadAllFilesMeta() {
  const files = await db.files.orderBy('createdAt').toArray();
  return files.map(({ id, name, type, createdAt }) => ({ id, name, type, createdAt }));
}

export async function loadFileBlob(id) {
  const file = await db.files.get(id);
  return file ? file.blob : null;
}

export async function deleteFile(id) {
  return db.files.delete(id);
}

export async function clearAll() {
  await db.files.clear();
  await db.notes.clear();
  return new Promise(resolve => {
    chrome.storage.local.remove(['note_content', 'active_note_id'], resolve);
  });
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
