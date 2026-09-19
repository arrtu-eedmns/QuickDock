// ── links.js ─────────────────────────────────────────────────────────────
// Módulo puro para manipulação, extração e resolução de links entre notas,
// cálculo de backlinks reversos e geração de topologia de grafo.
// Desacoplado de DOM e de Dexie para permitir testes automatizados instantâneos.

const RE_WIKILINK = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;
const RE_CANONICAL = /\[([^\]]+)\]\(nota:([^\)]+)\)/g;
const RE_HTML_LINK = /<a\s+[^>]*href="nota:([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
const RE_DATA_TITLE = /data-note-title="([^"]+)"/gi;

/**
 * Extrai todas as referências a notas de uma string de texto/markdown/HTML.
 * Retorna lista de objetos: { alvo, alias, isUid }.
 */
export function extrairLinksDeTexto(texto) {
  if (!texto || typeof texto !== 'string') return [];
  const encontrados = [];
  const jaVistos = new Set();

  function registrar(alvo, alias, isUid) {
    const alvoLimpo = (alvo || '').trim();
    if (!alvoLimpo) return;
    const chave = `${isUid ? 'u:' : 't:'}${alvoLimpo.toLowerCase()}`;
    if (jaVistos.has(chave)) return;
    jaVistos.add(chave);
    encontrados.push({
      alvo: alvoLimpo,
      alias: alias ? alias.trim() : null,
      isUid: !!isUid
    });
  }

  // 1. Wikilinks no formato [[Título]] ou [[Título|Alias]]
  let m;
  const reWiki = new RegExp(RE_WIKILINK.source, 'g');
  while ((m = reWiki.exec(texto)) !== null) {
    const alvo = m[1];
    const alias = m[2] || null;
    const isUid = alvo.startsWith('u_');
    registrar(alvo, alias, isUid);
  }

  // 2. Links canônicos markdown [Texto](nota:uid_ou_titulo)
  const reCanon = new RegExp(RE_CANONICAL.source, 'g');
  while ((m = reCanon.exec(texto)) !== null) {
    const alias = m[1];
    const alvo = decodeURIComponent(m[2]);
    const isUid = alvo.startsWith('u_');
    registrar(alvo, alias, isUid);
  }

  // 3. Links HTML <a href="nota:..."> ou com data-note-title="..."
  const reHtml = new RegExp(RE_HTML_LINK.source, 'gi');
  while ((m = reHtml.exec(texto)) !== null) {
    const alvo = decodeURIComponent(m[1]);
    const alias = m[2]?.replace(/<[^>]+>/g, '') || null;
    const isUid = alvo.startsWith('u_');
    registrar(alvo, alias, isUid);
  }

  const reData = new RegExp(RE_DATA_TITLE.source, 'gi');
  while ((m = reData.exec(texto)) !== null) {
    const titulo = m[1];
    registrar(titulo, null, false);
  }

  return encontrados;
}

/**
 * Varre todos os blocos de uma nota e extrai links internos.
 */
export function extrairLinksDeBlocos(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  const referencias = [];
  const jaVistos = new Set();

  for (const block of blocks) {
    if (!block) continue;
    const textos = [block.html, block.content];
    if (Array.isArray(block.rows)) {
      for (const row of block.rows) {
        if (Array.isArray(row)) {
          textos.push(...row);
        }
      }
    }

    for (const txt of textos) {
      if (!txt) continue;
      const links = extrairLinksDeTexto(txt);
      for (const link of links) {
        const chave = `${link.isUid ? 'u:' : 't:'}${link.alvo.toLowerCase()}`;
        if (!jaVistos.has(chave)) {
          jaVistos.add(chave);
          referencias.push(link);
        }
      }
    }
  }

  return referencias;
}

/**
 * Resolve referências contra a lista de notas existentes, preenchendo
 * uidDestino (se encontrado) e tituloAlvo.
 * Retorna registros prontos para a tabela Dexie `links`.
 */
export function resolverLinks(referencias, uidOrigem, todasNotas = []) {
  if (!referencias || !uidOrigem) return [];
  const mapaPorUid = new Map();
  const mapaPorTitulo = new Map();

  for (const nota of todasNotas) {
    if (nota.uid) mapaPorUid.set(nota.uid, nota);
    if (nota.title) mapaPorTitulo.set(nota.title.trim().toLowerCase(), nota);
  }

  const resultados = [];
  const vistos = new Set();

  for (const ref of referencias) {
    let uidDestino = null;
    let tituloAlvo = ref.alvo;

    if (ref.isUid || mapaPorUid.has(ref.alvo)) {
      const notaAlvo = mapaPorUid.get(ref.alvo);
      uidDestino = ref.alvo;
      tituloAlvo = notaAlvo?.title || ref.alias || ref.alvo;
    } else {
      const notaAlvo = mapaPorTitulo.get(ref.alvo.toLowerCase());
      if (notaAlvo) {
        uidDestino = notaAlvo.uid || null;
        tituloAlvo = notaAlvo.title || ref.alvo;
      } else {
        uidDestino = null;
        tituloAlvo = ref.alvo;
      }
    }

    // Ignora auto-ligação redundante para evitar laços triviais
    if (uidDestino && uidDestino === uidOrigem) continue;

    const chave = `${uidDestino || ''}|${tituloAlvo.toLowerCase()}`;
    if (!vistos.has(chave)) {
      vistos.add(chave);
      resultados.push({
        uidOrigem,
        uidDestino,
        tituloAlvo
      });
    }
  }

  return resultados;
}

/**
 * Calcula quais notas mencionam uma determinada nota alvo (backlinks).
 * @param {Object} targetNote - { uid, title }
 * @param {Array} todasNotas - Lista de metadados de todas as notas
 * @param {Array} todosLinks - Registros da tabela `links` ({ uidOrigem, uidDestino, tituloAlvo })
 */
export function calcularBacklinks(targetNote, todasNotas = [], todosLinks = []) {
  if (!targetNote) return [];
  const targetUid = targetNote.uid;
  const targetTitle = targetNote.title ? targetNote.title.trim().toLowerCase() : '';

  const uidsOrigemEncontrados = new Set();

  for (const l of todosLinks) {
    if (!l || !l.uidOrigem) continue;
    if (targetUid && l.uidOrigem === targetUid) continue; // ignora auto-menção

    let casa = false;
    if (targetUid && l.uidDestino === targetUid) {
      casa = true;
    } else if (targetTitle && (!l.uidDestino || !targetUid) && (l.tituloAlvo || '').trim().toLowerCase() === targetTitle) {
      casa = true;
    } else if (targetTitle && (l.tituloAlvo || '').trim().toLowerCase() === targetTitle) {
      casa = true;
    }

    if (casa) {
      uidsOrigemEncontrados.add(l.uidOrigem);
    }
  }

  const mapaNotas = new Map(todasNotas.map(n => [n.uid, n]));
  const backlinks = [];

  for (const uidOrigem of uidsOrigemEncontrados) {
    const nota = mapaNotas.get(uidOrigem);
    if (nota) {
      backlinks.push({
        id: nota.id,
        uid: nota.uid,
        title: nota.title || 'Sem título',
        pasta: nota.pasta || '',
        color: nota.color || null,
        icon: nota.icon || null
      });
    }
  }

  return backlinks.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

/**
 * Gera os nós e as arestas para o grafo de conexões.
 * @param {Array} todasNotas - Lista de notas completas ou metadados
 * @param {Array} todosLinks - Registros da tabela `links`
 * @returns { nodes: Array, edges: Array }
 */
export function construirGrafo(todasNotas = [], todosLinks = []) {
  const mapaPorUid = new Map();
  const mapaPorTitulo = new Map();

  const nodes = todasNotas.map(n => {
    const node = {
      id: n.uid || String(n.id),
      noteId: n.id,
      title: n.title || 'Sem título',
      pasta: n.pasta || '',
      color: n.color || null,
      icon: n.icon || null,
      degree: 0,
      radius: 6
    };
    if (n.uid) mapaPorUid.set(n.uid, node);
    if (n.title) mapaPorTitulo.set(n.title.trim().toLowerCase(), node);
    return node;
  });

  const validIds = new Set(nodes.map(n => n.id));
  const edges = [];
  const seenEdges = new Set();

  for (const link of todosLinks) {
    if (!link || !link.uidOrigem) continue;
    const src = link.uidOrigem;
    let dst = link.uidDestino;

    if (!dst && link.tituloAlvo) {
      const match = mapaPorTitulo.get(link.tituloAlvo.trim().toLowerCase());
      if (match) dst = match.id;
    }

    if (src && dst && src !== dst && validIds.has(src) && validIds.has(dst)) {
      const [u1, u2] = [src, dst].sort();
      const edgeKey = `${u1}--${u2}`;
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({
          source: src,
          target: dst
        });

        const nodeSrc = mapaPorUid.get(src);
        const nodeDst = mapaPorUid.get(dst);
        if (nodeSrc) nodeSrc.degree++;
        if (nodeDst) nodeDst.degree++;
      }
    }
  }

  for (const node of nodes) {
    node.radius = Math.min(18, 6 + Math.sqrt(node.degree) * 3);
  }

  return { nodes, edges };
}
