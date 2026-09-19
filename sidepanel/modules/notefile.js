// ── notefile.js ────────────────────────────────────────────────────────────
// Formato de um arquivo de nota individual (.md com frontmatter).
//
// Fica desacoplado de DOM e de Dexie de propósito: só texto entra e sai,
// permitindo testes unitários rigorosos fora do navegador (test/run.mjs).
//
// Decisão de projeto (ver PLANEJAMENTO.md v3.0):
// - O campo `content` da nota NÃO vai para o arquivo: ele é derivado dos blocos
//   e seria uma segunda verdade propensa a divergir.
// - Campos desconhecidos no frontmatter DEVEM ser preservados na ida e volta:
//   uma versão mais recente pode gravar metadados que esta versão não conhece,
//   e descartá-los destruiria dados de quem compartilha a pasta entre aparelhos.
// - Não usamos biblioteca de YAML externa (MV3 sem bundler e sem dependências npm).
//   Um subconjunto plano "chave: valor" escrito à mão atende com precisão e segurança.

function toIsoString(val) {
  if (!val) return undefined;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (val instanceof Date) return val.toISOString();
  return undefined;
}

function formatValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  const s = String(v);
  if (s === '') return '""';
  // Aspas e escape JSON são aplicados quando o texto contém dois pontos, aspas,
  // quebras de linha ou caracteres delimitadores, para que o parser manual não
  // confunda títulos como "Reunião: Metas" com uma nova chave YAML.
  if (/[:"\n\r#\[\]{}]|^---|^null$|^true$|^false$|^-?\d+(\.\d+)?$/.test(s) || s.trim() !== s) {
    return JSON.stringify(s);
  }
  return s;
}

function parseValue(raw) {
  const v = (raw ?? '').trim();
  if (v === '' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  // Número inteiro ou decimal puro
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  // String entre aspas duplas (gerada por JSON.stringify)
  if (v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  // String entre aspas simples
  if (v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Constrói o conteúdo de um arquivo .md a partir dos metadados e do markdown.
 * @param {Object} params
 * @param {Object} params.meta Metadados da nota (identificadores, opções visuais, datas e extras)
 * @param {string} params.md   Corpo da nota em markdown
 * @returns {string}
 */
export function buildNoteFile({ meta = {}, md = '' }) {
  // Monta dicionário normalizado, aceitando tanto as chaves em português
  // quanto as chaves internas do Dexie (title, color, icon, etc.).
  const f = {};

  f.quickdock = meta.quickdock ?? 1;
  const id = meta.id ?? meta.uid;
  if (id !== undefined && id !== null) f.id = id;

  const titulo = meta.titulo !== undefined ? meta.titulo : meta.title;
  if (titulo !== undefined && titulo !== null) f.titulo = titulo;

  const cor = meta.cor !== undefined ? meta.cor : meta.color;
  if (cor !== undefined) f.cor = cor;

  const icone = meta.icone !== undefined ? meta.icone : meta.icon;
  if (icone !== undefined) f.icone = icone;

  const iconePreenchido = meta.iconePreenchido !== undefined ? meta.iconePreenchido : meta.iconFilled;
  if (iconePreenchido !== undefined) f.iconePreenchido = !!iconePreenchido;

  const tituloOculto = meta.tituloOculto !== undefined ? meta.tituloOculto : meta.titleHidden;
  if (tituloOculto !== undefined) f.tituloOculto = !!tituloOculto;

  const ordem = meta.ordem !== undefined ? meta.ordem : meta.order;
  if (ordem !== undefined && ordem !== null) f.ordem = String(ordem);

  const pasta = meta.pasta;
  if (pasta !== undefined && pasta !== null && pasta !== '') f.pasta = pasta;

  const criadoEm = meta.criadoEm ?? toIsoString(meta.createdAt);
  if (criadoEm) f.criadoEm = criadoEm;

  const atualizadoEm = meta.atualizadoEm ?? toIsoString(meta.updatedAt);
  if (atualizadoEm) f.atualizadoEm = atualizadoEm;

  // Preservação de campos desconhecidos: qualquer chave extra em meta
  // que não seja interna (como `content` ou `blocks`) é mantida no arquivo.
  const tratadas = new Set([
    'quickdock', 'id', 'uid', 'titulo', 'title', 'cor', 'color',
    'icone', 'icon', 'iconePreenchido', 'iconFilled', 'tituloOculto',
    'titleHidden', 'ordem', 'order', 'pasta', 'criadoEm', 'createdAt',
    'atualizadoEm', 'updatedAt', 'content', 'blocks',
  ]);

  for (const [k, v] of Object.entries(meta)) {
    if (!tratadas.has(k) && v !== undefined) {
      f[k] = v;
    }
  }

  const linhasFm = ['---'];
  for (const [k, v] of Object.entries(f)) {
    linhasFm.push(`${k}: ${formatValue(v)}`);
  }
  linhasFm.push('---');

  const corpo = (md ?? '').trim();
  return corpo ? `${linhasFm.join('\n')}\n\n${corpo}\n` : `${linhasFm.join('\n')}\n`;
}

// Versão do formato suportada por este cliente do QuickDock.
// Se uma versão futura gravar `quickdock: 2` ou superior, clientes nesta versão
// devem recusar o arquivo em vez de fazer "melhor esforço" e regravá-lo
// mutilado, perdendo campos ou estruturas que ainda não conhecem.
export const FORMATO_QUICKDOCK_SUPORTADO = 1;

/**
 * Extrai o frontmatter bruto e o markdown sem validar a versão do formato.
 * Permite que o motor de sincronização inspecione os metadados de um arquivo
 * recusado por versão (ex.: para identificar o título ou o ID sem aceitá-lo).
 * @param {string} texto
 * @returns {{ meta: Object, md: string } | null}
 */
export function extrairMetadadosBrutos(texto) {
  if (typeof texto !== 'string') return null;

  // Um arquivo de nota precisa começar com o marcador de abertura "---"
  const matchAbertura = /^---\r?\n/.exec(texto);
  if (!matchAbertura) return null;

  const inicioFm = matchAbertura[0].length;
  // A cerca de fechamento precisa estar em linha isolada
  const matchFechamento = /\r?\n---\s*(?:\r?\n|$)/.exec(texto.slice(inicioFm));
  if (!matchFechamento) return null;

  const rawFm = texto.slice(inicioFm, inicioFm + matchFechamento.index);
  const inicioMd = inicioFm + matchFechamento.index + matchFechamento[0].length;
  const md = texto.slice(inicioMd).trim();

  const meta = {};
  const linhas = rawFm.replace(/\r\n?/g, '\n').split('\n');

  for (const linha of linhas) {
    const limpa = linha.trim();
    if (!limpa || limpa.startsWith('#')) continue;
    const idx = linha.indexOf(':');
    // Linha malformada sem ":" é ignorada sem interromper o resto do arquivo
    if (idx === -1) continue;
    const chave = linha.slice(0, idx).trim();
    const rawVal = linha.slice(idx + 1).trim();
    if (!chave) continue;
    meta[chave] = parseValue(rawVal);
  }

  // Se não foi encontrada nenhuma chave no frontmatter, o bloco estava vazio/inválido
  if (Object.keys(meta).length === 0) return null;

  return { meta, md };
}

/**
 * Lê um arquivo de nota, extraindo metadados do frontmatter e corpo markdown.
 * Devolve null se o arquivo não tiver frontmatter válido no padrão QuickDock
 * OU se tiver uma versão de formato que este cliente não saiba ler.
 * @param {string} texto
 * @returns {{ meta: Object, md: string } | null}
 */
export function parseNoteFile(texto) {
  const bruto = extrairMetadadosBrutos(texto);
  if (!bruto) return null;

  // Recusa explícita de versões incompatíveis/mais novas:
  // Um cliente antigo lendo formato novo nunca deve tentar ler "como der",
  // pois uma regravação subsequente destruiria dados gravados pelo cliente novo.
  if (bruto.meta.quickdock !== FORMATO_QUICKDOCK_SUPORTADO) {
    return null;
  }

  return bruto;
}

