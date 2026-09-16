// ── backup.js ──────────────────────────────────────────────────────────────
// Formato do arquivo "todas as notas". Fica separado do resto porque é a peça
// que precisa continuar funcionando justamente quando alguma outra quebrou —
// é ela que devolve as notas. Sem DOM e sem banco, só texto entrando e saindo,
// pra poder ser testada de verdade (test/run.mjs).
//
// O arquivo é markdown comum: abre em qualquer editor. O que o QuickDock
// acrescenta é um marcador por nota, que a importação usa pra desmembrar de
// volta em N notas em vez de uma só, gigante.
//
// O título vai como string JSON com os hifens escapados (-): um "-->"
// dentro do título encerraria o comentário e partiria o arquivo ao meio.

const CABECALHO = [
  'Este arquivo é um backup do QuickDock. Para restaurar, use "Importar" —',
  'as notas voltam separadas, uma por marcador. Fora do QuickDock ele é um',
  'markdown comum e pode ser lido em qualquer editor.',
];

export function backupMarker(title) {
  return `<!-- quickdock:nota ${JSON.stringify(title ?? '').replace(/-/g, '\\u002d')} -->`;
}

/** @param notas [{ title, md }] — markdown já pronto de cada nota. */
export function buildBackup(notas) {
  const partes = [
    `<!-- quickdock:backup v1 · ${notas.length} nota(s) · ${new Date().toISOString()} -->`,
    '',
    ...CABECALHO,
  ];
  for (const { title, md } of notas) {
    partes.push('', backupMarker(title), '', md ?? '');
  }
  return partes.join('\n');
}

/** Devolve [{ title, md }] ou null quando o arquivo não é um backup. */
export function parseBackup(text) {
  const marcas = [...(text ?? '').matchAll(/^<!-- quickdock:nota (".*?") -->$/gm)];
  if (marcas.length === 0) return null;

  return marcas.map((m, i) => {
    const inicio = m.index + m[0].length;
    const fim    = i + 1 < marcas.length ? marcas[i + 1].index : text.length;
    let title;
    try { title = JSON.parse(m[1]); } catch { title = ''; }
    return { title: title || 'Sem título', md: text.slice(inicio, fim).trim() };
  });
}
