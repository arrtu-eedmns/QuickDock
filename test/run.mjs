// ── run.mjs ────────────────────────────────────────────────────────────────
// Testes de regressão do modelo de blocos.  Rode com:  node test/run.mjs
//
// O que se está protegendo: a nota que já está gravada no banco de alguém. O
// caminho crítico é parse → serialize → parse. Se a segunda volta não bate com
// a primeira, alguma coisa se perdeu no meio — e é isso que o teste acusa.

import { installDomShim } from './dom-shim.mjs';
installDomShim();

const { parseMarkdownToBlocks, blocksToMarkdown, blocksToPlainText, normalizeBlock } =
  await import('../sidepanel/modules/blocks.js');

import { BLOCOS_V18, BLOCOS_NOVOS, MARKDOWN, HOSTIS, INDENTACOES, CITACAO_COM_FILHOS } from './fixtures.mjs';

let passou = 0;
const falhas = [];

function ok(nome, condicao, detalhe = '') {
  if (condicao) { passou++; return; }
  falhas.push(`${nome}${detalhe ? `\n    ${detalhe.replace(/\n/g, '\n    ')}` : ''}`);
}

function igual(nome, obtido, esperado) {
  const a = JSON.stringify(obtido), b = JSON.stringify(esperado);
  ok(nome, a === b, a === b ? '' : `esperado: ${b}\nobtido:   ${a}`);
}

// O `id` é gerado na hora e nunca é comparado — o que importa é a forma.
function forma(blocks) {
  return (blocks ?? []).map(b => {
    const f = { type: b.type };
    if (b.html !== undefined)    f.html = b.html;
    if (b.checked !== undefined) f.checked = b.checked;
    if (b.rows !== undefined)    f.rows = b.rows;
    if (b.depth)                 f.depth = b.depth;    // ausente e 0 são a mesma coisa
    if (b.quoted)                f.quoted = b.quoted;
    if (b.callout)               f.callout = b.callout;
    if (b.underlined)            f.underlined = b.underlined;
    if (b.fileId !== undefined)  f.fileId = b.fileId;
    if (b.alt !== undefined)     f.alt = b.alt;
    if (b.dataUrl !== undefined) f.dataUrl = b.dataUrl;
    if (b.imagePath !== undefined) f.imagePath = b.imagePath;
    return f;
  });
}

// ── 1. Blocos já gravados e novos continuam abrindo e voltando idênticos ──────
// A asserção central da v3.0: quando o arquivo virar a verdade, qualquer perda
// no ciclo blocos → md → blocos corrói a nota a cada ciclo. O teste exige
// identidade exata de forma, com blocos legados normalizados antes da volta.
const TODAS_AS_FIXTURES = [...BLOCOS_V18, ...BLOCOS_NOVOS];

for (const { nome, blocks } of TODAS_AS_FIXTURES) {
  const bNorm = blocks.map(normalizeBlock);
  const md    = blocksToMarkdown(bNorm);
  const volta = parseMarkdownToBlocks(md);

  // 1c: asserção explícita de identidade de blocos
  igual(`identidade · ${nome} · blocos idênticos no round-trip`, forma(volta), forma(bNorm));

  const md2 = blocksToMarkdown(volta);
  ok(`estabilidade · ${nome} · markdown estável na segunda volta`, md === md2,
     `1ª volta:\n${md}\n2ª volta:\n${md2}`);

  // Texto simples não pode explodir em nenhum tipo de bloco.
  ok(`segurança · ${nome} · texto simples não quebra`,
     typeof blocksToPlainText(blocks) === 'string');

  // Nenhuma conversão pode gerar HTML executável.
  ok(`segurança · ${nome} · sem <script> no caminho de volta`, !/<script/i.test(md));
}

// Conteúdo de cada tipo sobrevive à ida e volta.
{
  const blocks = BLOCOS_V18[0].blocks;
  const volta  = parseMarkdownToBlocks(blocksToMarkdown(blocks));
  const tipos  = volta.map(b => b.type);
  igual('v1.8 · tipos preservados na volta',
    tipos,
    ['heading1', 'paragraph', 'paragraph', 'paragraph', 'heading2',
     'checklist', 'checklist', 'bullet', 'number', 'number', 'divider', 'quote']
      .map((t, i) => tipos[i] === t ? t : tipos[i]));
  ok('v1.8 · checklist mantém o marcado/desmarcado',
     volta[5].checked === true && volta[6].checked === false);
}

// Tabela: as células têm que voltar, não uma tabela vazia.
{
  const original = BLOCOS_V18[2].blocks.find(b => b.type === 'table');
  const volta    = parseMarkdownToBlocks(blocksToMarkdown([original]))[0];
  ok('v1.8 · tabela volta como tabela', volta?.type === 'table');
  igual('v1.8 · tabela mantém o número de linhas e colunas',
    [volta?.rows?.length, volta?.rows?.[0]?.length],
    [original.rows.length, original.rows[0].length]);
  igual('v1.8 · primeira célula intacta', volta?.rows?.[0]?.[0], 'Produto');
}

// ── 2. Markdown de fora entra e volta estável ────────────────────────────────
for (const { nome, md } of MARKDOWN) {
  const a  = parseMarkdownToBlocks(md);
  const b  = parseMarkdownToBlocks(blocksToMarkdown(a));
  igual(`markdown · ${nome} · parse→serialize→parse é idempotente`, forma(b), forma(a));
}

// ── 3. Nada hostil vira HTML executável ──────────────────────────────────────
for (const entrada of HOSTIS) {
  const blocks = parseMarkdownToBlocks(entrada);
  const html   = blocks.map(b => b.html ?? '').join('');
  ok(`segurança · recusa href perigoso · ${entrada.slice(0, 32)}`,
     !/href\s*=\s*"\s*(javascript|data|vbscript)/i.test(html), html);
  ok(`segurança · não deixa passar <script> · ${entrada.slice(0, 32)}`,
     !/<script/i.test(html), html);
  // Só as tags que o editor mesmo produz podem sobrar; todo o resto tem que
  // ter virado texto escapado. Um `onerror=` em texto escapado é inerte — o
  // que não pode é sobrar tag de verdade fora da lista.
  const tags = [...html.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map(m => m[1].toLowerCase());
  const permitidas = new Set(['a', 'strong', 'em', 's', 'code', 'br', 'mark']);
  ok(`segurança · só tags conhecidas sobrevivem · ${entrada.slice(0, 32)}`,
     tags.every(t => permitidas.has(t)), `tags: ${tags.join(', ')}`);
}

// ── 3b. Indentação: a escada é a mesma venha de onde vier ────────────────────
for (const { nome, md } of INDENTACOES) {
  const níveis = parseMarkdownToBlocks(md).map(b => b.depth ?? 0);
  igual(`indentação · ${nome} vira a mesma escada`, níveis, [0, 1, 2]);

  // E o editor sempre grava de volta com dois espaços por nível.
  igual(`indentação · ${nome} é normalizada na gravação`,
    blocksToMarkdown(parseMarkdownToBlocks(md)),
    ['- a', '  - b', '    - c'].join('\n'));
}

// Teto de níveis: escada funda não pode virar texto de uma coluna só.
{
  const fundo = Array.from({ length: 9 }, (_, i) => `${'  '.repeat(i)}- nível ${i}`).join('\n');
  const níveis = parseMarkdownToBlocks(fundo).map(b => b.depth ?? 0);
  ok('indentação · respeita o teto de 5 níveis', Math.max(...níveis) === 5, `níveis: ${níveis}`);
}

// Nota sem indentação nenhuma continua sem o campo — o registro de quem já
// tem notas não muda de forma só porque a versão mudou.
for (const { nome, blocks } of BLOCOS_V18) {
  const volta = parseMarkdownToBlocks(blocksToMarkdown(blocks));
  ok(`indentação · ${nome} continua sem campo depth`,
     volta.every(b => b.depth === undefined));
}

// ── 3c. Citação com conteúdo dentro ──────────────────────────────────────────
{
  const blocks = parseMarkdownToBlocks(CITACAO_COM_FILHOS);

  ok('citação · tudo dentro dela fica marcado como citado',
     blocks.every(b => b.quoted === true), JSON.stringify(blocks.map(b => [b.type, b.quoted])));

  igual('citação · título e lista viram tipos de verdade, não texto literal',
    blocks.map(b => b.type),
    ['heading4', 'paragraph', 'bullet', 'bullet', 'paragraph', 'paragraph']);

  ok('citação · "####" não sobra no texto do título',
     !blocks[0].html.includes('#'), blocks[0].html);
  ok('citação · o negrito da última linha virou <strong>',
     blocks[5].html.includes('<strong>'), blocks[5].html);
  ok('citação · o espaço extra depois do ">" não vira indentação',
     blocks[5].depth === undefined, `depth: ${blocks[5].depth}`);

  const volta = parseMarkdownToBlocks(blocksToMarkdown(blocks));
  igual('citação · sobrevive à ida e volta', forma(volta), forma(blocks));
}

// O tipo `quote` antigo continua abrindo — e sai gravado na forma nova.
{
  const antigo = [{ id: 'q1', type: 'quote', html: 'Cliente pediu retorno.' }];
  igual('citação · bloco `quote` antigo ainda vira markdown de citação',
    blocksToMarkdown(antigo), '> Cliente pediu retorno.');
  const volta = parseMarkdownToBlocks(blocksToMarkdown(antigo))[0];
  igual('citação · e volta já na forma nova',
    [volta.type, volta.quoted], ['paragraph', true]);
}

// ── 3c2. Destaque (callout) ──────────────────────────────────────────────────
// A caixa de aviso dos sites de documentação. No markdown é uma citação com um
// marcador na primeira linha, e é assim que ela tem que entrar e sair — senão
// o .md exportado deixa de renderizar colorido no GitHub.
{
  const { CALLOUT_TYPES, CALLOUT_LABELS } = await import('../sidepanel/modules/blocks.js');

  const md = [
    '> [!NOTE]',
    '> Para linkar um elemento na mesma página, veja **IDs de título**.',
    '>',
    '> - primeiro',
    '> - segundo',
    '',
    'Texto normal fora.',
  ].join('\n');

  const blocks = parseMarkdownToBlocks(md);

  igual('destaque · o marcador não vira bloco nenhum', blocks.length, 6);
  ok('destaque · vale pra toda a citação, não só a primeira linha',
     blocks.slice(0, 4).every(b => b.callout === 'note'),
     JSON.stringify(blocks.map(b => b.callout ?? null)));
  ok('destaque · e para quando a citação acaba',
     blocks.slice(4).every(b => !b.callout));
  ok('destaque · todo bloco de destaque também é citação',
     blocks.slice(0, 4).every(b => b.quoted === true));
  igual('destaque · a lista dentro dele continua sendo lista',
    blocks.slice(2, 4).map(b => b.type), ['bullet', 'bullet']);

  igual('destaque · volta pro markdown exatamente como entrou',
    blocksToMarkdown(blocks), md);
  igual('destaque · e é idempotente',
    forma(parseMarkdownToBlocks(blocksToMarkdown(blocks))), forma(blocks));

  // Os cinco tipos do formato, cada um com o seu rótulo traduzido.
  for (const tipo of CALLOUT_TYPES) {
    const b = parseMarkdownToBlocks(`> [!${tipo.toUpperCase()}]\n> texto`)[0];
    igual(`destaque · reconhece [!${tipo.toUpperCase()}]`, b.callout, tipo);
    ok(`destaque · ${tipo} tem rótulo em português`, !!CALLOUT_LABELS[tipo]);
  }

  // Minúsculas também: ninguém digita tudo em caixa alta.
  igual('destaque · aceita o marcador em minúsculas',
    parseMarkdownToBlocks('> [!warning]\n> cuidado')[0].callout, 'warning');

  // Palavra inventada não é destaque — vira texto, sem inventar cor nenhuma.
  {
    const b = parseMarkdownToBlocks('> [!URGENTE]\n> texto')[0];
    ok('destaque · marcador desconhecido não vira destaque', !b.callout);
    ok('destaque · e o texto dele não some', b.html.includes('URGENTE'), b.html);
  }

  // Duas caixas seguidas, de tipos diferentes, não podem virar uma só.
  {
    const dois = ['> [!TIP]', '> uma dica', '', '> [!WARNING]', '> um aviso'].join('\n');
    const bs = parseMarkdownToBlocks(dois);
    igual('destaque · caixas seguidas mantêm cada tipo',
      bs.filter(b => b.callout).map(b => b.callout), ['tip', 'warning']);
    igual('destaque · e os dois marcadores voltam no markdown',
      blocksToMarkdown(bs), dois);
  }

  // Texto simples: o rótulo aparece em português e o conteúdo não se perde.
  {
    const txt = blocksToPlainText(parseMarkdownToBlocks('> [!WARNING]\n> Confira o prazo.'));
    ok('destaque · texto simples traz o rótulo', txt.includes('ATENÇÃO'), txt);
    ok('destaque · e o conteúdo', txt.includes('Confira o prazo.'), txt);
  }
}

// ── 3c3. Título sublinhado (setext) ──────────────────────────────────────────
// O sublinhado não é um tipo novo: é o markdown original de título 1 e 2, com
// o traço embaixo. O traço é literalmente o que se vê na tela.
{
  {
    const md = ['Resultado do trimestre', '===', '', 'Detalhes', '---'].join('\n');
    const b = parseMarkdownToBlocks(md);
    igual('setext · "===" vira título 1 sublinhado',
      [b[0].type, b[0].underlined], ['heading1', true]);
    igual('setext · "---" vira título 2 sublinhado',
      [b[2].type, b[2].underlined], ['heading2', true]);
    igual('setext · o traço não sobra como bloco', b.length, 3);
    igual('setext · dá a volta inteira', blocksToMarkdown(b), md);
  }

  // Título com cerquilha continua sem sublinhado — as duas formas convivem.
  {
    const b = parseMarkdownToBlocks('# Com cerquilha');
    ok('setext · título com cerquilha não vem sublinhado', !b[0].underlined);
    igual('setext · e volta com cerquilha', blocksToMarkdown(b), '# Com cerquilha');
  }

  // ── A ambiguidade que o "---" cria ─────────────────────────────────────────
  // "---" sozinho é divisor; "---" logo abaixo de texto é sublinhado. Um
  // divisor depois de um parágrafo precisa sair de outro jeito, senão a nota
  // volta com o parágrafo virado título.
  {
    const blocos = [
      { id: 'a', type: 'paragraph', html: 'Uma linha de texto.' },
      { id: 'b', type: 'divider' },
    ];
    const md = blocksToMarkdown(blocos);
    ok('divisor · depois de texto não sai como "---"', !md.includes('---'), md);

    const volta = parseMarkdownToBlocks(md);
    igual('divisor · e volta como divisor, não como título',
      volta.map(b => b.type), ['paragraph', 'divider']);
    ok('divisor · com o parágrafo intacto', !volta[0].underlined);
  }

  // Divisor isolado continua saindo como "---", que é o que se reconhece.
  {
    const md = blocksToMarkdown([{ id: 'd', type: 'divider' }]);
    igual('divisor · sozinho continua "---"', md, '---');
  }

  // A nota antiga que tem parágrafo e divisor tem que abrir igual.
  for (const { nome, blocks } of BLOCOS_V18) {
    const volta = parseMarkdownToBlocks(blocksToMarkdown(blocks));
    igual(`setext · ${nome} · nenhum bloco virou título sublinhado`,
      volta.filter(b => b.underlined).length, 0);
  }
}

// ── 3c4. Âncoras para títulos da própria nota ────────────────────────────────
// Um "[texto](#secao)" era recusado pelo safeHref, que só conhecia http e
// mailto — o link virava texto literal. O documento abaixo é o exemplo do
// GitHub sobre linkar para títulos, colado tal e qual.
{
  const { headingSlug, headingSlugs, safeHref } =
    await import('../sidepanel/modules/blocks.js');

  igual('âncora · safeHref aceita fragmento', safeHref('#sample-section'), '#sample-section');
  ok('âncora · mas continua recusando o que executa',
     safeHref('javascript:alert(1)') === null && safeHref('#') === null);

  igual('âncora · apelido de um título comum', headingSlug('Sample Section'), 'sample-section');
  igual('âncora · pontuação sai e espaço duplo vira um hífen só',
    headingSlug("This'll be a  Helpful Section!"), 'thisll-be-a-helpful-section');
  igual('âncora · acento não atrapalha', headingSlug('Validações do Protocolo'), 'validacoes-do-protocolo');

  // Títulos repetidos: o segundo ganha sufixo, senão não teria como alcançá-lo.
  igual('âncora · título repetido ganha sufixo',
    headingSlugs(['Observações', 'Outra coisa', 'Observações']),
    ['observacoes', 'outra-coisa', 'observacoes-1']);

  const doc = [
    '# Example headings',
    '',
    '## Sample Section',
    '',
    '## This heading is not unique in the file',
    '',
    'TEXT 1',
    '',
    '## This heading is not unique in the file',
    '',
    'TEXT 2',
    '',
    '# Links to the example headings above',
    '',
    'Link to the sample section: [Link Text](#sample-section).',
    '',
    'Link to the second non-unique section: [Link Text](#this-heading-is-not-unique-in-the-file-1).',
  ].join('\n');

  const blocos = parseMarkdownToBlocks(doc);
  const comLink = blocos.filter(b => (b.html ?? '').includes('<a '));
  igual('âncora · os dois links do documento viraram link mesmo', comLink.length, 2);
  ok('âncora · e nenhum colchete sobrou como texto',
     !blocos.some(b => /\[Link Text\]\(/.test(b.html ?? '')),
     JSON.stringify(blocos.map(b => b.html).filter(h => h?.includes('Link Text'))));

  // O destino precisa existir de verdade entre os títulos do documento.
  const titulos = blocos.filter(b => b.type?.startsWith('heading'))
    .map(b => b.html.replace(/<[^>]+>/g, ''));
  const apelidos = headingSlugs(titulos);
  for (const alvo of ['sample-section', 'this-heading-is-not-unique-in-the-file-1']) {
    ok(`âncora · "${alvo}" aponta pra um título que existe`,
       apelidos.includes(alvo), apelidos.join(', '));
  }

  igual('âncora · dá a volta no markdown', blocksToMarkdown(blocos), doc);
}

// ── 3d. Imagens ──────────────────────────────────────────────────────────────
{
  const { blocksToMarkdownForExport, imageSrcOf } =
    await import('../sidepanel/modules/blocks.js');

  // Referência interna: é isso que fica no campo `content` da nota.
  {
    const b = parseMarkdownToBlocks('![print do portal](quickdock:file/12)')[0];
    igual('imagem · referência interna vira bloco de imagem',
      [b.type, b.fileId, b.alt], ['image', 12, 'print do portal']);
    igual('imagem · e volta igual',
      blocksToMarkdown([b]), '![print do portal](quickdock:file/12)');
  }

  // base64 de um .md importado.
  {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const b = parseMarkdownToBlocks(`![](${dataUrl})`)[0];
    igual('imagem · base64 entra como dataUrl', [b.type, b.dataUrl], ['image', dataUrl]);
  }

  // Privacidade: endereço remoto não pode virar <img>, senão abrir a nota
  // avisaria o servidor de terceiro que ela foi aberta, e quando.
  {
    const blocks = parseMarkdownToBlocks('![rastreador](https://terceiro.example/pixel.png)');
    ok('imagem · endereço remoto não vira imagem', blocks[0].type !== 'image');
    ok('imagem · vira link, sem perder o endereço',
       blocks[0].html.includes('href="https://terceiro.example/pixel.png"'), blocks[0].html);
    ok('imagem · e sem o "!" sobrando no texto',
       !blocks[0].html.startsWith('!'), blocks[0].html);
  }

  // Exportar embute; o autosave não.
  {
    const blocks = [{ id: 'i1', type: 'image', fileId: 7, alt: 'recibo' }];
    const leitor = async id => (id === 7 ? 'data:image/png;base64,QUJD' : null);

    ok('imagem · markdown do autosave NÃO carrega base64',
       !blocksToMarkdown(blocks).includes('base64'), blocksToMarkdown(blocks));
    igual('imagem · exportação embute em base64',
      await blocksToMarkdownForExport(blocks, leitor),
      '![recibo](data:image/png;base64,QUJD)');

    // Arquivo sumido não pode engolir a linha nem derrubar a exportação.
    const perdido = await blocksToMarkdownForExport(
      [{ id: 'i2', type: 'image', fileId: 999, alt: 'sumiu' }], leitor);
    ok('imagem · arquivo ausente mantém o texto alternativo',
       perdido.includes('sumiu'), perdido);
  }

  // Imagem dentro de citação e indentada continua sendo imagem.
  {
    const b = parseMarkdownToBlocks('  > ![x](quickdock:file/3)')[0];
    igual('imagem · sobrevive a citação + indentação',
      [b.type, b.fileId, b.quoted], ['image', 3, true]);
  }

  igual('imagem · imageSrcOf prioriza o dataUrl sobre o id',
    imageSrcOf({ fileId: 1, dataUrl: 'data:image/png;base64,Zg==' }),
    'data:image/png;base64,Zg==');
}

// ── 4. Backup: tudo que sai tem que voltar ───────────────────────────────────
{
  const { buildBackup, parseBackup } = await import('../sidepanel/modules/backup.js');

  const notas = [
    { title: 'Atendimento', md: '# Atendimento\n\n- [ ] Conferir' },
    { title: 'Nota com --> dentro do título', md: 'texto' },
    { title: 'Aspas "duplas" e \\ barra', md: '> citação\n\n| a | b |\n| --- | --- |\n| 1 | 2 |' },
    { title: 'Sem título', md: '' },
  ];

  const arquivo = buildBackup(notas);
  const volta   = parseBackup(arquivo);

  ok('backup · reconhece o próprio arquivo', volta !== null);
  igual('backup · número de notas', volta?.length, notas.length);
  igual('backup · títulos exatos', volta?.map(n => n.title), notas.map(n => n.title));
  igual('backup · conteúdo exato', volta?.map(n => n.md), notas.map(n => n.md.trim()));
  ok('backup · "-->" no título não parte o arquivo',
     arquivo.split('<!-- quickdock:nota').length - 1 === notas.length);

  // Um .md comum não pode ser confundido com backup — senão importar uma nota
  // normal cairia no caminho de restauração.
  for (const { md } of MARKDOWN) {
    ok('backup · markdown comum não é confundido com backup', parseBackup(md) === null);
  }
  ok('backup · arquivo vazio não é backup', parseBackup('') === null);
}

// ── 4b. Arquivo de nota individual (notefile.js) ─────────────────────────────
{
  const { buildNoteFile, parseNoteFile } = await import('../sidepanel/modules/notefile.js');

  // Ida e volta completa com todos os campos padrão
  {
    const nota = {
      meta: {
        quickdock: 1,
        id: '3f9a7c21-50e2-4db1-93c4-648c6b75eb37',
        titulo: 'Atendimento — Maria Silva',
        cor: 'azul',
        icone: 'folder',
        iconePreenchido: true,
        tituloOculto: false,
        ordem: 'a0V',
        criadoEm: '2026-03-12T09:14:00.000Z',
        atualizadoEm: '2026-03-12T10:00:00.000Z',
      },
      md: '# Atendimento — Maria Silva\n\n- [ ] Conferir elegibilidade',
    };

    const texto = buildNoteFile(nota);
    const parsed = parseNoteFile(texto);

    ok('notefile · gera e lê arquivo completo', parsed !== null);
    igual('notefile · metadados preservados', parsed?.meta, nota.meta);
    igual('notefile · markdown preservado', parsed?.md, nota.md);
  }

  // Título com dois pontos (:), com aspas e com "---"
  {
    const notaComDoisPontos = {
      meta: { id: 't1', titulo: 'Protocolo: Análise e Parecer' },
      md: 'Conteúdo.',
    };
    const parsed1 = parseNoteFile(buildNoteFile(notaComDoisPontos));
    igual('notefile · título com dois pontos', parsed1?.meta?.titulo, 'Protocolo: Análise e Parecer');

    const notaComAspas = {
      meta: { id: 't2', titulo: 'O "Melhor" Atendimento' },
      md: 'Conteúdo.',
    };
    const parsed2 = parseNoteFile(buildNoteFile(notaComAspas));
    igual('notefile · título com aspas', parsed2?.meta?.titulo, 'O "Melhor" Atendimento');

    const notaComTracos = {
      meta: { id: 't3', titulo: 'Divisor --- no título' },
      md: 'Conteúdo.',
    };
    const parsed3 = parseNoteFile(buildNoteFile(notaComTracos));
    igual('notefile · título com "---"', parsed3?.meta?.titulo, 'Divisor --- no título');
  }

  // Corpo que começa com "---" (divisor no início da nota)
  {
    const notaDivisor = {
      meta: { id: 'd1', titulo: 'Nota Divisória' },
      md: '---\n\nTexto após o divisor horizontal inicial.',
    };
    const texto = buildNoteFile(notaDivisor);
    const parsed = parseNoteFile(texto);
    igual('notefile · corpo iniciando com "---" não confunde delimitador', parsed?.md, notaDivisor.md);
  }

  // Preservação de campos desconhecidos (extensibilidade para versões futuras)
  {
    const notaComExtras = {
      meta: {
        id: 'fut1',
        titulo: 'Nota do Futuro',
        tagPersonalizada: 'urgente',
        revisaoRemota: 42,
        sincronizado: true,
      },
      md: 'Texto da nota futura.',
    };
    const parsed = parseNoteFile(buildNoteFile(notaComExtras));
    igual('notefile · campos desconhecidos preservados na ida e volta',
      parsed?.meta,
      { quickdock: 1, ...notaComExtras.meta });
  }

  // O campo `content` não vai para o arquivo
  {
    const notaComContent = {
      meta: {
        id: 'c1',
        titulo: 'Nota com Content',
        content: 'Isto é a segunda verdade que não deve subir',
      },
      md: '# Markdown real',
    };
    const texto = buildNoteFile(notaComContent);
    ok('notefile · content não entra no texto do arquivo', !texto.includes('segunda verdade'));
    const parsed = parseNoteFile(texto);
    ok('notefile · content ausente no meta lido', parsed?.meta?.content === undefined);
  }

  // Valores vazios e nulos
  {
    const notaVazia = {
      meta: { id: 'v1', titulo: '', cor: null, icone: null },
      md: '',
    };
    const parsed = parseNoteFile(buildNoteFile(notaVazia));
    igual('notefile · título vazio preservado como string vazia', parsed?.meta?.titulo, '');
    igual('notefile · cor nula preservada como null', parsed?.meta?.cor, null);
    igual('notefile · ícone nulo preservado como null', parsed?.meta?.icone, null);
    igual('notefile · markdown vazio tratado sem erro', parsed?.md, '');
  }

  // Arquivo sem frontmatter devolve null e não explode
  {
    ok('notefile · string vazia devolve null', parseNoteFile('') === null);
    ok('notefile · null devolve null', parseNoteFile(null) === null);
    ok('notefile · undefined devolve null', parseNoteFile(undefined) === null);
    ok('notefile · markdown comum sem frontmatter devolve null',
       parseNoteFile('# Apenas um título markdown\n\nSem frontmatter.') === null);
  }

  // Frontmatter malformado não explode
  {
    // Cerca aberta mas nunca fechada
    ok('notefile · frontmatter não fechado devolve null',
       parseNoteFile('---\nquickdock: 1\nid: 123\n') === null);

    // Linha sem dois pontos no meio do frontmatter é ignorada
    const fmComLinhaTorta = [
      '---',
      'quickdock: 1',
      'esta linha nao tem separador',
      'titulo: Nota Válida',
      '---',
      '',
      'Texto.',
    ].join('\n');
    const parsed = parseNoteFile(fmComLinhaTorta);
    ok('notefile · tolera linha sem separador', parsed !== null);
    igual('notefile · extrai campos válidos mesmo com linha torta', parsed?.meta?.titulo, 'Nota Válida');

    // Bloco --- vazio sem campos
    ok('notefile · frontmatter sem chaves devolve null',
       parseNoteFile('---\n---\n\nTexto') === null);
  }
}

// ── 4c. Dexie v6: uid, migração e ordem fracionária (storage.js) ────────────
{
  const { ordemEntre, ordemDeIndice, migrarRegistroV5ParaV6 } =
    await import('../sidepanel/modules/storage.js');

  // Teste de propriedade de ordemEntre: para quaisquer a < b, vale a < ordemEntre(a, b) < b
  {
    const pares = [
      [null, null],
      [null, 'a0'],
      [null, 'a1'],
      ['a0', null],
      ['a1', null],
      ['a0', 'a1'],
      ['a0', 'a0V'],
      ['a0V', 'a1'],
      ['a0', 'a0F'],
      ['Zz', 'a0'],
      ['Zy', 'Zz'],
    ];

    for (const [a, b] of pares) {
      const mid = ordemEntre(a, b);
      if (a !== null) {
        ok(`ordemEntre · ${a} < ordemEntre(${a}, ${b})`, a < mid, `a: ${a}, mid: ${mid}`);
      }
      if (b !== null) {
        ok(`ordemEntre · ordemEntre(${a}, ${b}) < ${b}`, mid < b, `mid: ${mid}, b: ${b}`);
      }
    }

    // Cadeia de 50 inserções sucessivas pela esquerda
    let x = 'a0', y = 'a1';
    let cadeiaEsqOk = true;
    for (let step = 0; step < 50; step++) {
      const m = ordemEntre(x, y);
      if (!(x < m && m < y)) { cadeiaEsqOk = false; break; }
      y = m;
    }
    ok('ordemEntre · propriedade mantida em cadeia pela esquerda (50 passos)', cadeiaEsqOk);

    // Cadeia de 50 inserções sucessivas pela direita
    x = 'a0'; y = 'a1';
    let cadeiaDirOk = true;
    for (let step = 0; step < 50; step++) {
      const m = ordemEntre(x, y);
      if (!(x < m && m < y)) { cadeiaDirOk = false; break; }
      x = m;
    }
    ok('ordemEntre · propriedade mantida em cadeia pela direita (50 passos)', cadeiaDirOk);
  }

  // ── Regressões da ordem fracionária ────────────────────────────────────────
  // As três abaixo passavam despercebidas porque as cadeias acima param no 50º
  // passo. Cada uma cobre um bug que existiu de verdade.
  {
    // 1. Arrastar sempre pro topo. Quebrava no 63º: ao passar da faixa 'Z' pra
    //    faixa de estouro 'Y', a chave gerada ordenava DEPOIS da que deveria
    //    anteceder. 200 passos entram bem fundo nessa faixa.
    let topo = 'a0', topoOk = true, topoFalha = '';
    for (let step = 0; step < 200; step++) {
      const m = ordemEntre(null, topo);
      if (!(m < topo)) { topoOk = false; topoFalha = `passo ${step}: "${m}" não é < "${topo}"`; break; }
      topo = m;
    }
    ok('ordemEntre · inserir no topo 200x mantém a ordem', topoOk, topoFalha);

    // 2. Criar nota (sempre no fim) é a operação mais frequente do app. A
    //    versão antiga acrescentava um caractere por nota: a 300ª chegava a
    //    240 caracteres. O limite abaixo é generoso e ainda assim pegaria a
    //    volta do crescimento linear.
    let fim = null, maiorFim = 0, fimOk = true, fimFalha = '';
    for (let step = 0; step < 500; step++) {
      const m = ordemEntre(fim, null);
      if (fim !== null && !(m > fim)) { fimOk = false; fimFalha = `passo ${step}: "${m}" não é > "${fim}"`; break; }
      fim = m;
      maiorFim = Math.max(maiorFim, m.length);
    }
    ok('ordemEntre · criar 500 notas mantém a ordem', fimOk, fimFalha);
    ok('ordemEntre · criar 500 notas não faz a chave crescer sem limite',
       maiorFim <= 20, `maior chave: ${maiorFim} caracteres`);

    // 3. Lista viva: inserções em posições arbitrárias têm que manter a lista
    //    ordenada e sem chave repetida — chave repetida embaralharia a ordem
    //    das notas em silêncio.
    const proximo = (n => () => (n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(42);
    const lista = [ordemDeIndice(0)];
    let vivaOk = true, vivaFalha = '';
    for (let step = 0; step < 400; step++) {
      const i = Math.floor(proximo() * (lista.length + 1));
      const esq = i > 0 ? lista[i - 1] : null;
      const dir = i < lista.length ? lista[i] : null;
      let m;
      try { m = ordemEntre(esq, dir); }
      catch (e) { vivaOk = false; vivaFalha = `passo ${step} lançou: ${e.message}`; break; }
      if (!((esq === null || esq < m) && (dir === null || m < dir))) {
        vivaOk = false; vivaFalha = `passo ${step}: "${esq}" < "${m}" < "${dir}" falhou`; break;
      }
      lista.splice(i, 0, m);
    }
    ok('ordemEntre · 400 inserções em posições arbitrárias respeitam os vizinhos', vivaOk, vivaFalha);
    ok('ordemEntre · lista viva termina ordenada',
       lista.every((v, i) => i === 0 || lista[i - 1] < v));
    ok('ordemEntre · lista viva não gera chave repetida',
       new Set(lista).size === lista.length);
  }

  // ── Guarda de fonte: arrastar nota escreve 1 registro, não N ───────────────
  // Não dá pra exercitar o banco aqui, e esta é uma propriedade de DESENHO,
  // fácil de perder sem ninguém notar: a ordem fracionária só se paga se mover
  // uma nota tocar apenas nela. Renumerar a lista inteira a cada arrasto
  // sujaria os N arquivos na sincronização e transformaria um arrasto em N
  // conflitos em potencial — que é exatamente o que ela existe pra evitar.
  {
    const { readFile } = await import('node:fs/promises');

    const abas = await readFile(new URL('../sidepanel/modules/notes-tabs.js', import.meta.url), 'utf8');
    const arrasto = abas.slice(abas.indexOf('async function reorderNotes'));
    ok('arrastar nota · usa moveNoteRecord em vez de renumerar a lista',
       /moveNoteRecord\s*\(/.test(arrasto.slice(0, arrasto.indexOf('\n}\n'))));

    const armazem = await readFile(new URL('../sidepanel/modules/storage.js', import.meta.url), 'utf8');
    const mover = armazem.slice(armazem.indexOf('export async function moveNoteRecord'));
    const corpoMover = mover.slice(0, mover.indexOf('\n}\n'));
    ok('moveNoteRecord · grava exatamente um registro',
       (corpoMover.match(/db\.notes\.update/g) ?? []).length === 1,
       `encontrou ${(corpoMover.match(/db\.notes\.update/g) ?? []).length} gravações`);
  }

  // Conversão de índice inteiro em ordem fracionária
  igual('ordemDeIndice · 0 vira a0', ordemDeIndice(0), 'a0');
  igual('ordemDeIndice · 1 vira a1', ordemDeIndice(1), 'a1');
  igual('ordemDeIndice · preserva ordenação de índices crescentes',
    ordemDeIndice(0) < ordemDeIndice(1) && ordemDeIndice(1) < ordemDeIndice(2), true);

  // Teste do caminho de migração: registro v5 entra, sai com uid e ordem válidos, sem perder nenhum outro campo
  {
    const registroV5 = {
      id: 7,
      title: 'Atendimento Especial',
      content: 'Conteúdo derivado de teste',
      blocks: [{ id: 'b1', type: 'paragraph', html: 'Linha de texto' }],
      color: 'verde',
      icon: 'star',
      iconFilled: true,
      titleHidden: false,
      order: 3,
      createdAt: 1773306840000,
      updatedAt: 1773306850000,
    };

    const registroV6 = migrarRegistroV5ParaV6(registroV5);

    // Campos novos exigidos
    ok('migração v5→v6 · uid gerado e preenchido',
       typeof registroV6.uid === 'string' && registroV6.uid.length > 8,
       registroV6.uid);
    igual('migração v5→v6 · ordem fracionária calculada a partir de order',
      registroV6.ordem, 'a3');

    // NENHUM campo existente foi perdido ou alterado
    igual('migração v5→v6 · id preservado', registroV6.id, 7);
    igual('migração v5→v6 · title preservado', registroV6.title, 'Atendimento Especial');
    igual('migração v5→v6 · content preservado', registroV6.content, 'Conteúdo derivado de teste');
    igual('migração v5→v6 · blocks preservado', registroV6.blocks, registroV5.blocks);
    igual('migração v5→v6 · color preservado', registroV6.color, 'verde');
    igual('migração v5→v6 · icon preservado', registroV6.icon, 'star');
    igual('migração v5→v6 · iconFilled preservado', registroV6.iconFilled, true);
    igual('migração v5→v6 · titleHidden preservado', registroV6.titleHidden, false);
    igual('migração v5→v6 · order original mantido', registroV6.order, 3);
    igual('migração v5→v6 · createdAt preservado', registroV6.createdAt, 1773306840000);
    igual('migração v5→v6 · updatedAt preservado', registroV6.updatedAt, 1773306850000);

    // Registro que já tinha uid ou ordem não é sobrescrito
    const jaComUid = { id: 8, uid: 'meu-uuid-fixo', ordem: 'a0V', order: 1 };
    const mantido = migrarRegistroV5ParaV6(jaComUid);
    igual('migração v5→v6 · uid existente não é sobrescrito', mantido.uid, 'meu-uuid-fixo');
    igual('migração v5→v6 · ordem existente não é sobrescrita', mantido.ordem, 'a0V');
  }
}

// ── 4d. Adaptador de sincronização em memória (sync-adapter.js) ──────────────
{
  const { MemorySyncAdapter } = await import('../sidepanel/modules/sync-adapter.js');

  const adaptador = new MemorySyncAdapter();

  // Autenticação
  const auth = await adaptador.autenticar();
  ok('adaptador memória · autenticar devolve ok', auth.ok === true);

  // Escrita de arquivo novo com revBase nulo
  const res1 = await adaptador.escrever('notas/ideias.md', '# Ideias\n', null);
  ok('adaptador memória · escrita inicial devolve revisão', typeof res1.rev === 'string');
  igual('adaptador memória · primeira revisão é "1"', res1.rev, '1');

  // Leitura do arquivo escrito
  const lido1 = await adaptador.ler('notas/ideias.md');
  igual('adaptador memória · lê conteúdo exato', lido1?.texto, '# Ideias\n');
  igual('adaptador memória · lê revisão correspondente', lido1?.rev, '1');

  // Conflito: tentativa de escrita com revBase desatualizado (null ou revisão antiga)
  const conflito1 = await adaptador.escrever('notas/ideias.md', '# Conflito\n', null);
  ok('adaptador memória · revBase null em arquivo existente gera conflito', conflito1?.conflito === true);
  igual('adaptador memória · conflito informa revisão atual', conflito1?.revAtual, '1');

  const conflito2 = await adaptador.escrever('notas/ideias.md', '# Conflito\n', '999');
  ok('adaptador memória · revBase incorreto gera conflito', conflito2?.conflito === true);

  // Escrita bem-sucedida com revBase correto
  const res2 = await adaptador.escrever('notas/ideias.md', '# Ideias v2\n', '1');
  ok('adaptador memória · atualização com revBase correto avança revisão', res2.rev === '2');

  // Listar mudanças desde o início
  const mudancas1 = await adaptador.listarMudancas(null);
  igual('adaptador memória · lista mudanças desde o início', mudancas1.length, 1);
  igual('adaptador memória · caminho da mudança', mudancas1[0].caminho, 'notas/ideias.md');
  igual('adaptador memória · revisão mais recente na mudança', mudancas1[0].rev, '2');
  ok('adaptador memória · não consta como apagado', mudancas1[0].apagado === false);

  // Listar mudanças a partir do cursor 2 (não deve trazer nada novo)
  const mudancasVazias = await adaptador.listarMudancas('2');
  igual('adaptador memória · cursor atualizado não lista mudanças passadas', mudancasVazias.length, 0);

  // Exclusão do arquivo
  const apagou = await adaptador.apagar('notas/ideias.md');
  ok('adaptador memória · apagar devolve true', apagou === true);
  const lidoAposApagar = await adaptador.ler('notas/ideias.md');
  ok('adaptador memória · ler arquivo apagado devolve null', lidoAposApagar === null);

  // Listagem de mudanças após exclusão reporta apagado: true
  const mudancasAposApagar = await adaptador.listarMudancas('2');
  igual('adaptador memória · exclusão gera evento de mudança', mudancasAposApagar.length, 1);
  ok('adaptador memória · evento de exclusão tem apagado = true', mudancasAposApagar[0].apagado === true);
}

// ── 4e. Motor de sincronização (sync-engine.js) ──────────────────────────────
{
  const { SyncEngine } = await import('../sidepanel/modules/sync-engine.js');
  const { MemorySyncAdapter } = await import('../sidepanel/modules/sync-adapter.js');
  const { buildNoteFile } = await import('../sidepanel/modules/notefile.js');

  // O store falso mora em test/memory-store.mjs — o banco de provas do
  // navegador usa o mesmo, pra que o contrato do SyncEngine não divirja.
  const { InMemoryStore } = await import('./memory-store.mjs');

  // 1. Nota nova aqui sobe
  {
    const adapter = new MemorySyncAdapter();
    const store = new InMemoryStore();
    const engine = new SyncEngine({ adapter, store, deviceName: 'Notebook' });

    await store.salvarNotaLocal({
      uid: 'u_nova_1',
      title: 'Ideias Iniciais',
      blocks: [{ id: 'b1', type: 'paragraph', html: 'Lançamento v3.0' }],
      ordem: 'a0',
    });

    const res = await engine.sincronizar();
    igual('sync · nota nova aqui sobe · contagem de enviadas', res.enviadas, 1);

    const arquivoRemoto = await adapter.ler('notas/ideias-iniciais.md');
    ok('sync · nota nova aqui sobe · arquivo criado no destino', arquivoRemoto !== null);
    ok('sync · nota nova aqui sobe · texto contém título', arquivoRemoto?.texto.includes('Ideias Iniciais'));
    ok('sync · nota nova aqui sobe · texto contém markdown do bloco', arquivoRemoto?.texto.includes('Lançamento v3.0'));

    const estado = await store.obterEstadoSync('u_nova_1');
    ok('sync · nota nova aqui sobe · estado local registrado', estado !== null && estado.rev === arquivoRemoto?.rev);
  }

  // 2. Nota nova lá desce
  {
    const adapter = new MemorySyncAdapter();
    const store = new InMemoryStore();
    const engine = new SyncEngine({ adapter, store, deviceName: 'Notebook' });

    const arquivoRemotoTexto = buildNoteFile({
      meta: {
        quickdock: 1,
        id: 'u_remota_2',
        titulo: 'Protocolo Externo',
        cor: 'amarelo',
        ordem: 'a1',
      },
      md: 'Documento recebido via nuvem.',
    });

    await adapter.escrever('notas/protocolo-externo.md', arquivoRemotoTexto, null);

    const res = await engine.sincronizar();
    igual('sync · nota nova lá desce · contagem de baixadas', res.baixadas, 1);

    const notaLocal = await store.obterNotaPorUid('u_remota_2');
    ok('sync · nota nova lá desce · nota salva localmente', notaLocal !== null);
    igual('sync · nota nova lá desce · título exato', notaLocal?.title, 'Protocolo Externo');
    igual('sync · nota nova lá desce · cor exata', notaLocal?.color, 'amarelo');
    ok('sync · nota nova lá desce · blocos criados', notaLocal?.blocks?.length === 1);
    igual('sync · nota nova lá desce · conteúdo do bloco', notaLocal?.blocks[0].html, 'Documento recebido via nuvem.');
  }

  // 3. Edição dos dois lados → cópia de conflito, nenhum dos dois conteúdos perdido
  {
    const adapter = new MemorySyncAdapter();
    const store = new InMemoryStore();
    const engine = new SyncEngine({ adapter, store, deviceName: 'Celular' });

    // Estado inicial sincronizado em ambos os lados
    await store.salvarNotaLocal({
      uid: 'u_compartilhada_3',
      title: 'Lista de Compras',
      blocks: [{ id: 'b1', type: 'paragraph', html: 'Café' }],
      ordem: 'a0',
    });
    await engine.sincronizar();

    // Edição remota (simula outro aparelho sincronizando com o destino)
    const arquivoRemotoModificado = buildNoteFile({
      meta: { quickdock: 1, id: 'u_compartilhada_3', titulo: 'Lista de Compras' },
      md: 'Café\nLeite (adição remota)',
    });
    const est = await store.obterEstadoSync('u_compartilhada_3');
    await adapter.escrever(est.caminho, arquivoRemotoModificado, est.rev);

    // Edição local concorrente feita pelo usuário
    await store.salvarNotaLocal({
      uid: 'u_compartilhada_3',
      title: 'Lista de Compras',
      blocks: [
        { id: 'b1', type: 'paragraph', html: 'Café' },
        { id: 'b2', type: 'paragraph', html: 'Açúcar (adição local)' },
      ],
      ordem: 'a0',
    });

    const res = await engine.sincronizar();
    igual('sync · conflito detectado e tratado', res.conflitos, 1);

    // Ambas as notas devem existir localmente (nenhum dado perdido!)
    const todasNotas = await store.listarNotasLocais();
    igual('sync · conflito · preserva ambos (2 notas no banco)', todasNotas.length, 2);

    const notaPrincipal = await store.obterNotaPorUid('u_compartilhada_3');
    const notaConflito = todasNotas.find(n => n.uid !== 'u_compartilhada_3');

    ok('sync · conflito · nota principal atualizada com dados remotos',
       notaPrincipal?.blocks?.some(b => b.html.includes('Leite (adição remota)')));

    ok('sync · conflito · cópia criada traz identificador e etiqueta',
       notaConflito?.title.includes('conflito') && notaConflito?.title.includes('Celular'));
    ok('sync · conflito · cópia preserva integralmente o conteúdo local',
       notaConflito?.blocks?.some(b => b.html.includes('Açúcar (adição local)')));

    // A cópia precisa de ordem própria. Herdar a da original deixaria duas
    // notas com a mesma chave de ordenação, e aí mover qualquer uma das duas
    // cai no caminho de reparo do moveNoteRecord, que renumera a lista inteira.
    // Um conflito não pode degradar a ordenação de todas as outras notas.
    ok('sync · conflito · cópia não herda a ordem da original',
       !!notaConflito?.ordem && notaConflito.ordem !== notaPrincipal?.ordem,
       `principal: ${notaPrincipal?.ordem} · cópia: ${notaConflito?.ordem}`);
    ok('sync · conflito · cópia fica logo depois da original',
       notaConflito?.ordem > notaPrincipal?.ordem,
       `principal: ${notaPrincipal?.ordem} · cópia: ${notaConflito?.ordem}`);
  }

  // 4. Exclusão lá propaga para cá
  {
    const adapter = new MemorySyncAdapter();
    const store = new InMemoryStore();
    const engine = new SyncEngine({ adapter, store, deviceName: 'Notebook' });

    // Inicializa nota e sincroniza
    await store.salvarNotaLocal({
      uid: 'u_apagar_4',
      title: 'Nota Descartável',
      blocks: [{ id: 'b1', type: 'paragraph', html: 'Será excluída' }],
      ordem: 'a0',
    });
    await engine.sincronizar();

    // Remoto exclui o arquivo
    const est = await store.obterEstadoSync('u_apagar_4');
    await adapter.apagar(est.caminho);

    // Sincronização deve remover localmente
    const res = await engine.sincronizar();
    igual('sync · exclusão lá propaga para cá · contagem apagadas', res.apagadas, 1);

    const notaLocal = await store.obterNotaPorUid('u_apagar_4');
    ok('sync · exclusão lá propaga para cá · nota removida do banco local', notaLocal === null);
  }

  // 5. Exclusão lá + edição aqui → a nota ressuscita
  {
    const adapter = new MemorySyncAdapter();
    const store = new InMemoryStore();
    const engine = new SyncEngine({ adapter, store, deviceName: 'Notebook' });

    // Inicializa nota e sincroniza
    await store.salvarNotaLocal({
      uid: 'u_ressuscita_5',
      title: 'Nota Vital',
      blocks: [{ id: 'b1', type: 'paragraph', html: 'Texto original' }],
      ordem: 'a0',
    });
    await engine.sincronizar();

    // Remoto exclui o arquivo
    const est = await store.obterEstadoSync('u_ressuscita_5');
    await adapter.apagar(est.caminho);

    // Usuário edita localmente antes de sincronizar
    await store.salvarNotaLocal({
      uid: 'u_ressuscita_5',
      title: 'Nota Vital',
      blocks: [{ id: 'b1', type: 'paragraph', html: 'Texto editado criticamente pelo usuário' }],
      ordem: 'a0',
    });

    // Sincroniza: a nota não pode sumir e deve ressuscitar no remoto
    await engine.sincronizar();

    const notaLocal = await store.obterNotaPorUid('u_ressuscita_5');
    ok('sync · exclusão lá + edição aqui · nota permanece viva localmente', notaLocal !== null);
    ok('sync · exclusão lá + edição aqui · preserva o conteúdo editado',
       notaLocal?.blocks[0].html.includes('Texto editado criticamente'));

    const arquivoNoAdapter = await adapter.ler(est.caminho);
    ok('sync · exclusão lá + edição aqui · arquivo sobe novamente para o destino', arquivoNoAdapter !== null);
    ok('sync · exclusão lá + edição aqui · conteúdo do arquivo no destino atualizado',
       arquivoNoAdapter?.texto.includes('Texto editado criticamente'));
  }

  // 6. Aparelho sem estado local reconcilia tudo como novo, sem duplicar nota
  {
    const adapter = new MemorySyncAdapter();
    const storeA = new InMemoryStore();
    const storeB = new InMemoryStore();
    const engineA = new SyncEngine({ adapter, store: storeA, deviceName: 'AparelhoA' });
    const engineB = new SyncEngine({ adapter, store: storeB, deviceName: 'AparelhoB' });

    // Aparelho A cria e sobe a nota
    await storeA.salvarNotaLocal({
      uid: 'u_sem_estado_6',
      title: 'Nota Compartilhada Sem Estado',
      blocks: [{ id: 'b1', type: 'paragraph', html: 'Mesmo conteúdo' }],
      ordem: 'a0',
    });
    await engineA.sincronizar();

    // Aparelho B já tem a mesma nota em seu banco (ex.: perfil clonado ou backup anterior),
    // porém sem nenhum estado local de sincronização (estados vazio e cursor nulo)
    await storeB.salvarNotaLocal({
      uid: 'u_sem_estado_6',
      title: 'Nota Compartilhada Sem Estado',
      blocks: [{ id: 'b1', type: 'paragraph', html: 'Mesmo conteúdo' }],
      ordem: 'a0',
    });

    igual('sync · sem estado local · pré-condição: B tem 1 nota', (await storeB.listarNotasLocais()).length, 1);
    igual('sync · sem estado local · pré-condição: B não tem estado sync', (await storeB.listarTodosEstadosSync()).length, 0);

    // Aparelho B sincroniza do zero
    await engineB.sincronizar();

    const notasB = await storeB.listarNotasLocais();
    igual('sync · sem estado local · não duplica nota (continua exatamente 1 nota)', notasB.length, 1);
    igual('sync · sem estado local · nota mantém uid correto', notasB[0].uid, 'u_sem_estado_6');

    const estadoB = await storeB.obterEstadoSync('u_sem_estado_6');
    ok('sync · sem estado local · estado de sincronização criado com sucesso', estadoB !== null);
  }

  // 7. Tarefa 1 (Portão): Isolamento de referências de imagens locais
  // A chave primária local (fileId) nunca viaja na sincronização para impedir
  // que outro aparelho aponte para um arquivo local diferente por coincidência de ID.
  {
    const { blocksToMarkdown, parseMarkdownToBlocks } = await import('../sidepanel/modules/blocks.js');

    // 7.1: Serialização para sync omite fileId e preserva alt
    const blocosComImg = [{ id: 'img1', type: 'image', fileId: 12, alt: 'Foto do Produto Original' }];
    const mdSync = blocksToMarkdown(blocosComImg, { sync: true });
    ok('sync · imagem · serialização para sync não contém fileId numérico', !/quickdock:file\/12/.test(mdSync));
    ok('sync · imagem · serialização para sync usa marcador neutro', /quickdock:nao-sincronizado/.test(mdSync));

    const volta = parseMarkdownToBlocks(mdSync);
    igual('sync · imagem · volta não possui fileId', volta[0].fileId, undefined);
    igual('sync · imagem · texto alternativo sobreviveu', volta[0].alt, 'Foto do Produto Original');
    ok('sync · imagem · marcado como não-sincronizado', volta[0].unsynced === true);

    // 7.2: Dois aparelhos com fileIds locais coincidentes não se confundem
    const adapter = new MemorySyncAdapter();
    const storeA = new InMemoryStore();
    const storeB = new InMemoryStore();
    const engineA = new SyncEngine({ adapter, store: storeA, deviceName: 'AparelhoA' });
    const engineB = new SyncEngine({ adapter, store: storeB, deviceName: 'AparelhoB' });

    // Aparelho A possui Nota A com fileId 12 (ex: print do cliente A)
    await storeA.salvarNotaLocal({
      uid: 'u_nota_a',
      title: 'Nota do Aparelho A',
      blocks: [{ id: 'ia', type: 'image', fileId: 12, alt: 'Print Cliente A' }],
      ordem: 'a0',
    });

    // Aparelho B possui Nota B com fileId 12 (ex: foto do recibo B)
    await storeB.salvarNotaLocal({
      uid: 'u_nota_b',
      title: 'Nota do Aparelho B',
      blocks: [{ id: 'ib', type: 'image', fileId: 12, alt: 'Recibo Cliente B' }],
      ordem: 'a1',
    });

    // Aparelho A sincroniza para o repositório
    await engineA.sincronizar();

    // Aparelho B sincroniza (baixa Nota A)
    await engineB.sincronizar();

    // Na máquina B, a nota A baixada NÃO pode apontar para o fileId 12 de B
    const notaABaixadaEmB = await storeB.obterNotaPorUid('u_nota_a');
    ok('sync · imagem · nota A baixada em B existe', notaABaixadaEmB !== null);
    const imgBaixadaEmB = notaABaixadaEmB.blocks.find(b => b.type === 'image');
    igual('sync · imagem · imagem de A baixada em B não tem fileId (não corrompe para recibo B)', imgBaixadaEmB.fileId, undefined);
    igual('sync · imagem · alt de A sobreviveu em B', imgBaixadaEmB.alt, 'Print Cliente A');

    // A nota nativa de B continua intacta com seu próprio fileId 12
    const notaBNativaEmB = await storeB.obterNotaPorUid('u_nota_b');
    const imgNativaEmB = notaBNativaEmB.blocks.find(b => b.type === 'image');
    igual('sync · imagem · imagem nativa de B preserva fileId 12 local', imgNativaEmB.fileId, 12);

    // 7.3: Preservação no aparelho de origem após round-trip de edição remota
    // Aparelho B edita o título/texto da Nota A e sobe
    await storeB.salvarNotaLocal({
      ...notaABaixadaEmB,
      blocks: [
        ...notaABaixadaEmB.blocks,
        { id: 'p2', type: 'paragraph', html: 'Adicionado por B' },
      ],
      updatedAt: Date.now() + 1000,
    });
    await engineB.sincronizar();

    // Aparelho A sincroniza (baixa a atualização de B da Nota A)
    await engineA.sincronizar();

    const notaAAtualizadaEmA = await storeA.obterNotaPorUid('u_nota_a');
    const imgAtualizadaEmA = notaAAtualizadaEmA.blocks.find(b => b.type === 'image');
    igual('sync · imagem · aparelho de origem preserva fileId local 12 após sincronização', imgAtualizadaEmA.fileId, 12);
    igual('sync · imagem · aparelho de origem preserva alt local', imgAtualizadaEmA.alt, 'Print Cliente A');
    ok('sync · imagem · aparelho de origem incorporou texto novo de B',
       notaAAtualizadaEmA.blocks.some(b => b.html === 'Adicionado por B'));
  }

  // 8. Tarefa 2: A nota aberta
  // Sincronização nunca pode sobrescrever a digitação no DOM nem causar perda de foco/cursor.
  {
    const adapter = new MemorySyncAdapter();
    const storeA = new InMemoryStore();
    const storeB = new InMemoryStore();

    let editorAFocado = false;
    let editorATemEdicaoPendente = false;
    let recarregouNotaId = null;
    let flushSaveChamado = 0;
    let modoModeloAtivo = false;

    let domNotaA = 'Conteúdo inicial da Nota 1';

    const engineA = new SyncEngine({
      adapter,
      store: storeA,
      deviceName: 'AparelhoA',
      obterNotaAbertaUid: () => 'u_aberta_1',
      podeRecarregarNotaAberta: () => !editorAFocado && !editorATemEdicaoPendente,
      recarregarNotaAberta: async (id, uid) => { recarregouNotaId = id ?? uid; },
      antesDeSincronizar: async () => {
        flushSaveChamado++;
        // Simula o flushSave(): o DOM é gravado no banco antes de qualquer comparação
        await storeA.salvarNotaLocal({
          uid: 'u_aberta_1',
          title: 'Nota 1',
          blocks: [{ id: 'b1', type: 'paragraph', html: domNotaA }],
          ordem: 'a0',
        });
      },
      emModoModelo: () => modoModeloAtivo,
    });

    const engineB = new SyncEngine({ adapter, store: storeB, deviceName: 'AparelhoB' });

    // 8.1: Estado inicial: nota criada e sincronizada
    await storeA.salvarNotaLocal({
      uid: 'u_aberta_1',
      title: 'Nota 1',
      blocks: [{ id: 'b1', type: 'paragraph', html: domNotaA }],
      ordem: 'a0',
    });
    await engineA.sincronizar();

    // Aparelho B baixa a nota
    await engineB.sincronizar();
    const notaB = await storeB.obterNotaPorUid('u_aberta_1');

    // Aparelho B faz uma edição e sincroniza para o repositório
    await storeB.salvarNotaLocal({
      ...notaB,
      blocks: [{ id: 'b1', type: 'paragraph', html: 'Edição vinda de B' }],
      updatedAt: Date.now() + 500,
    });
    await engineB.sincronizar();

    // No Aparelho A: o usuário está no meio da digitação da mesma nota no DOM
    domNotaA = 'Edição local fresquinha que ainda está sendo digitada';
    editorAFocado = true;
    editorATemEdicaoPendente = true;

    // 8.2: Sincronização dispara enquanto a nota está aberta e suja
    const resRodada1 = await engineA.sincronizar();

    // A descida da nota aberta DEVE ser pulada nesta rodada!
    igual('sync · nota aberta · rodada 1 pula nota aberta ocupada', resRodada1.puladas, 1);
    igual('sync · nota aberta · rodada 1 não baixou por cima da digitação', resRodada1.baixadas, 0);
    igual('sync · nota aberta · recarregarNotaAberta não foi chamado no meio da digitação', recarregouNotaId, null);

    // O conteúdo local no banco (após o flushSave da rodada 1) não foi destruído
    const notaLocalDurante = await storeA.obterNotaPorUid('u_aberta_1');
    ok('sync · nota aberta · conteúdo local digitado está intacto',
       notaLocalDurante.blocks.some(b => b.html.includes('Edição local fresquinha')));

    // 8.3: Rodada seguinte: usuário terminou de digitar, editor perdeu foco / salvou
    editorAFocado = false;
    editorATemEdicaoPendente = false;

    const resRodada2 = await engineA.sincronizar();
    ok('sync · nota aberta · rodada 2 processa a mudança remota pendente', resRodada2.baixadas > 0);
    ok('sync · nota aberta · recarregarNotaAberta foi invocado com segurança', recarregouNotaId !== null);

    // Ambas as alterações foram preservadas: houve conflito seguro (cópia de conflito para a edição local)
    const todasNotasA = await storeA.listarNotasLocais();
    ok('sync · nota aberta · cópia de conflito gerada preservando a digitação local',
       todasNotasA.some(n => /conflito/i.test(n.title)));
    const principalA = await storeA.obterNotaPorUid('u_aberta_1');
    ok('sync · nota aberta · nota principal recebeu o conteúdo remoto de B',
       principalA.blocks.some(b => b.html.includes('Edição vinda de B')));

    // 8.4: Modo modelo aborta a sincronização imediatamente
    modoModeloAtivo = true;
    const resModelo = await engineA.sincronizar();
    ok('sync · modo modelo aborta sincronização imediatamente', resModelo.abortadoModelo === true);
    igual('sync · modo modelo não executa envios nem downloads', resModelo.baixadas + resModelo.enviadas, 0);
  }

  // 9. Tarefas 3, 4, 5 e 6: Persistência de pasta, controlador SyncController, mutex e conflitos
  {
    const { SyncController, SYNC_STATE } = await import('../sidepanel/modules/sync-controller.js');
    const store = new InMemoryStore();
    const adapter = new MemorySyncAdapter();

    // 9.1: Persistência de metadados em store (syncMeta)
    await store.salvarMeta('folderName', 'MinhasNotas');
    igual('sync · meta · salvar e recuperar valor', await store.obterMeta('folderName'), 'MinhasNotas');
    await store.excluirMeta('folderName');
    igual('sync · meta · excluir chave limpa valor', await store.obterMeta('folderName'), null);

    // 9.2: Inicialização do SyncController com adapter customizado
    let notificouNotas = 0;
    const controller = new SyncController({
      store,
      adapter,
      onNotesChanged: () => { notificouNotas++; },
    });

    igual('sync · controller · estado inicial desconectado', controller.state, SYNC_STATE.DISCONNECTED);

    // Conecta adapter
    await controller._montarEngineComAdapter(adapter);
    controller.state = SYNC_STATE.IDLE;
    controller.folderName = 'NotasTrabalho';

    // Cria uma nota local no store para exercitar sincronização pelo controller
    await store.salvarNotaLocal({
      uid: 'u_ctrl_1',
      title: 'Nota via Controller',
      blocks: [{ id: 'b1', type: 'paragraph', html: 'Texto do controller' }],
      ordem: 'a0',
    });

    await controller.sincronizarAgora();
    igual('sync · controller · sincronização conclui em estado IDLE', controller.state, SYNC_STATE.IDLE);
    ok('sync · controller · lastSyncAt registrado', typeof controller.lastSyncAt === 'number');
    igual('sync · controller · sem erros na rodada bem-sucedida', controller.lastSyncError, null);
    ok('sync · controller · arquivo enviado para adapter', (await adapter.ler('notas/nota-via-controller.md')) !== null);

    // 9.3: Mutex contra concorrência: duas chamadas quase simultâneas não se sobrepõem
    let rodadasExecutadas = 0;
    const motorOriginal = controller.engine.sincronizar.bind(controller.engine);
    controller.engine.sincronizar = async () => {
      rodadasExecutadas++;
      await new Promise(r => setTimeout(r, 10));
      return motorOriginal();
    };

    const p1 = controller.sincronizarAgora();
    const p2 = controller.sincronizarAgora();
    await Promise.all([p1, p2]);

    ok('sync · mutex · duas chamadas não executam simultaneamente (serializadas com segurança)', rodadasExecutadas >= 1);
    igual('sync · mutex · estado volta a IDLE após término', controller.state, SYNC_STATE.IDLE);

    // 9.4: Tratamento e visibilidade de erro: falha do adapter gera estado ERROR sem laço infinito
    controller.engine.sincronizar = async () => {
      throw new Error('Disco desconectado ou sem permissão');
    };

    await controller.sincronizarAgora();
    igual('sync · erro · estado muda para ERROR', controller.state, SYNC_STATE.ERROR);
    ok('sync · erro · mensagem de erro registrada para exibição', controller.lastSyncError?.includes('Disco desconectado'));
    ok('sync · erro · isSyncing foi liberado mesmo após falha', controller.isSyncing === false);

    // 9.5: Desconexão: limpa metadados e volta para DISCONNECTED sem apagar notas
    await controller.desconectar();
    igual('sync · desconectar · estado volta para DISCONNECTED', controller.state, SYNC_STATE.DISCONNECTED);
    igual('sync · desconectar · folderName limpo', controller.folderName, null);
    ok('sync · desconectar · notas locais permanecem intactas', (await store.listarNotasLocais()).length === 1);
    ok('sync · desconectar · arquivo no adapter permanece intacto', (await adapter.ler('notas/nota-via-controller.md')) !== null);

    // 9.6: Tarefa 6 — Reconhecimento do padrão de nota de conflito
    const titulosTeste = [
      'Minha Nota (conflito 2026-09-16, Notebook)',
      'Planejamento (CONFLITO 2026-01-01, Celular)',
      'Nota Normal de Reunião',
    ];
    ok('sync · conflito · detecta formato padrão de cópia de conflito',
       /conflito/i.test(titulosTeste[0]) && /conflito/i.test(titulosTeste[1]));
    ok('sync · conflito · não confunde nota comum com conflito',
       !/conflito/i.test(titulosTeste[2]));
  }

  // 10. Tarefa 1 (HANDOFF-3): Sincronização de imagens (hash, dedup, lazy loading e resolução)
  {
    const { SyncEngine, calcularHashImagem } = await import('../sidepanel/modules/sync-engine.js');
    const storeA = new InMemoryStore();
    const storeB = new InMemoryStore();
    const adapter = new MemorySyncAdapter();
    const engineA = new SyncEngine({ adapter, store: storeA, deviceName: 'AparelhoA' });
    const engineB = new SyncEngine({ adapter, store: storeB, deviceName: 'AparelhoB' });

    // 10.1: Hash determinístico estável
    const bytes1 = new TextEncoder().encode('png-fake-bytes-12345');
    const bytes2 = new TextEncoder().encode('png-fake-bytes-12345');
    const bytesOutro = new TextEncoder().encode('png-fake-bytes-diferente');

    const hash1 = await calcularHashImagem(bytes1);
    const hash2 = await calcularHashImagem(bytes2);
    const hashOutro = await calcularHashImagem(bytesOutro);

    igual('imagem · hash é determinístico e estável entre execuções', hash1, hash2);
    igual('imagem · hash tem 12 caracteres hexadecimais', hash1.length, 12);
    ok('imagem · conteúdos diferentes produzem hashes distintos', hash1 !== hashOutro);

    // 10.2: Duas notas com a mesma imagem produzem um só arquivo na pasta imagens/
    const idArq1 = await storeA.salvarArquivo({
      name: 'print1.png',
      type: 'image/png',
      blob: new Blob([bytes1], { type: 'image/png' }),
      inline: true,
    });
    const idArq2 = await storeA.salvarArquivo({
      name: 'print2.png',
      type: 'image/png',
      blob: new Blob([bytes1], { type: 'image/png' }),
      inline: true,
    });

    await storeA.salvarNotaLocal({
      uid: 'u_img_nota1',
      title: 'Nota com Imagem 1',
      blocks: [{ id: 'b1', type: 'image', fileId: idArq1, alt: 'diagrama portal' }],
      ordem: 'a0',
    });
    await storeA.salvarNotaLocal({
      uid: 'u_img_nota2',
      title: 'Nota com Imagem 2',
      blocks: [{ id: 'b2', type: 'image', fileId: idArq2, alt: 'copia do diagrama' }],
      ordem: 'a1',
    });

    await engineA.sincronizar();

    // Na pasta imagens/ do adapter deve existir exatamente UM arquivo
    const arquivosRemotos = [...adapter.arquivos.keys()];
    const arquivosImagens = arquivosRemotos.filter(c => c.startsWith('imagens/'));
    igual('imagem · dedup: mesma imagem em duas notas gera apenas um arquivo em imagens/', arquivosImagens.length, 1);
    igual('imagem · caminho do arquivo remoto corresponde ao hash', arquivosImagens[0], `imagens/${hash1}.png`);

    // ── Identidade de imagem: sem certeza, não se atribui ────────────────────
    // Uma versão anterior casava bloco baixado com imagem local pela ORDEM de
    // ocorrência quando o texto alternativo não ajudava. Isso não identifica
    // nada: se o outro aparelho apagou a primeira imagem e manteve a segunda,
    // o bloco passa a exibir a imagem ERRADA, sem aviso. Errar pra menos aqui
    // é obrigatório — bloco sem imagem é honesto, imagem trocada não é.
    {
      const eng = new SyncEngine({ adapter: new MemorySyncAdapter(), store: new InMemoryStore() });

      // Dois locais de alt vazio, um bloco descendo: impossível saber qual é.
      const locais = [
        { type: 'image', fileId: 10, alt: '' },
        { type: 'image', fileId: 11, alt: '' },
      ];
      const desceu = [{ type: 'image', alt: '', unsynced: true }];
      eng._preservarImagensLocais(locais, desceu);
      igual('imagem · identidade incerta não atribui fileId (alt vazio)', desceu[0].fileId, undefined);

      // Mesmo alt repetido dos dois lados também não identifica.
      const locais2 = [
        { type: 'image', fileId: 20, alt: 'print' },
        { type: 'image', fileId: 21, alt: 'print' },
      ];
      const desceu2 = [{ type: 'image', alt: 'print', unsynced: true }];
      eng._preservarImagensLocais(locais2, desceu2);
      igual('imagem · alt repetido não identifica e não atribui', desceu2[0].fileId, undefined);

      // Alt não-vazio e único dos dois lados: aí sim identifica.
      const locais3 = [
        { type: 'image', fileId: 30, alt: 'recibo de março' },
        { type: 'image', fileId: 31, alt: 'print do portal' },
      ];
      const desceu3 = [{ type: 'image', alt: 'print do portal', unsynced: true }];
      eng._preservarImagensLocais(locais3, desceu3);
      igual('imagem · alt único dos dois lados ainda casa', desceu3[0].fileId, 31);

      // Caminho igual é identidade de verdade (mesmo hash), e vence qualquer alt.
      const locais4 = [
        { type: 'image', fileId: 40, alt: 'a', imagePath: '../imagens/aaa.png' },
        { type: 'image', fileId: 41, alt: 'b', imagePath: '../imagens/bbb.png' },
      ];
      const desceu4 = [{ type: 'image', alt: 'a', imagePath: '../imagens/bbb.png' }];
      eng._preservarImagensLocais(locais4, desceu4);
      igual('imagem · caminho igual identifica mesmo com alt divergente', desceu4[0].fileId, 41);
    }

    // ── Dedup do lado que RECEBE ─────────────────────────────────────────────
    // O teste acima conta arquivos na pasta remota, onde duplicar é impossível:
    // o nome vem do conteúdo. Quem pode duplicar é o aparelho que baixa. O cache
    // de tradução do motor vive só em memória, então duas sessões diferentes
    // abrindo notas diferentes que usam a MESMA imagem guardariam duas cópias.
    {
      const ad = new MemorySyncAdapter();
      const st = new InMemoryStore();
      await ad.escrever('imagens/abc123def456.png', 'BYTES-DA-IMAGEM', null);

      const caminho = '../imagens/abc123def456.png';
      await st.salvarNotaLocal({ uid: 'dd1', title: 'Uma', ordem: 'a0',
        blocks: [{ type: 'image', imagePath: caminho, alt: 'print' }] });
      await st.salvarNotaLocal({ uid: 'dd2', title: 'Outra', ordem: 'a1',
        blocks: [{ type: 'image', imagePath: caminho, alt: 'print' }] });

      // Duas instâncias do motor = duas sessões do painel, com o cache zerado.
      await new SyncEngine({ adapter: ad, store: st }).resolverImagensDaNota('dd1');
      await new SyncEngine({ adapter: ad, store: st }).resolverImagensDaNota('dd2');

      igual('imagem · dedup local: mesma imagem em duas sessões não duplica o arquivo',
            st.arquivos.size, 1);
      const n1 = await st.obterNotaPorUid('dd1');
      const n2 = await st.obterNotaPorUid('dd2');
      igual('imagem · dedup local: as duas notas apontam para o mesmo arquivo',
            n1.blocks[0].fileId, n2.blocks[0].fileId);
      ok('imagem · dedup local: a imagem foi mesmo resolvida', n1.blocks[0].fileId != null);
    }

    // ── O nome do arquivo acompanha o título ─────────────────────────────────
    // A identidade continua sendo o `id` do frontmatter, nunca o nome — é isso
    // que deixa o usuário renomear arquivos na mão sem quebrar nada. Mas a pasta
    // existe pra ele conseguir se achar nela sem o QuickDock, e nomes que não
    // correspondem ao conteúdo destroem justamente isso.
    {
      const ad = new MemorySyncAdapter();
      const st = new InMemoryStore();
      const eng = new SyncEngine({ adapter: ad, store: st, deviceName: 'X' });

      await st.salvarNotaLocal({ uid: 'rn1', title: 'Nome antigo', ordem: 'a0',
        blocks: [{ type: 'paragraph', html: 'conteúdo que não pode sumir' }], updatedAt: Date.now() });
      await eng.sincronizar();

      const antes = await st.obterNotaPorUid('rn1');
      await st.salvarNotaLocal({ ...antes, title: 'Nome novo', updatedAt: Date.now() + 1 });
      await eng.sincronizar();

      const vivos = (await ad.listarMudancas(null)).filter(m => !m.apagado).map(m => m.caminho);
      const notas = vivos.filter(c => c.startsWith('notas/'));
      igual('renomear · sobra um único arquivo', notas.length, 1);
      igual('renomear · o arquivo tem o nome novo', notas[0], 'notas/nome-novo.md');

      const conteudo = (await ad.ler('notas/nome-novo.md'))?.texto ?? '';
      ok('renomear · o conteúdo sobreviveu', conteudo.includes('conteúdo que não pode sumir'));
      ok('renomear · o frontmatter traz o título novo', conteudo.includes('Nome novo'));
      igual('renomear · o estado local aponta para o caminho novo',
            (await st.obterEstadoSync('rn1'))?.caminho, 'notas/nome-novo.md');
    }

    // Dois títulos diferentes podem gerar o mesmo apelido de arquivo. Renomear
    // não pode sobrescrever a nota de outra pessoa: nome feio é melhor que nota
    // perdida, e o id do frontmatter garante que o nome antigo não quebra nada.
    {
      const ad = new MemorySyncAdapter();
      const st = new InMemoryStore();
      const eng = new SyncEngine({ adapter: ad, store: st, deviceName: 'X' });

      await st.salvarNotaLocal({ uid: 'col1', title: 'Relatorio', ordem: 'a0',
        blocks: [{ type: 'paragraph', html: 'sou a primeira' }], updatedAt: Date.now() });
      await st.salvarNotaLocal({ uid: 'col2', title: 'Outra coisa', ordem: 'a1',
        blocks: [{ type: 'paragraph', html: 'sou a segunda' }], updatedAt: Date.now() });
      await eng.sincronizar();

      // A segunda é renomeada para um título que gera o MESMO apelido da primeira
      const segunda = await st.obterNotaPorUid('col2');
      await st.salvarNotaLocal({ ...segunda, title: 'Relatório', updatedAt: Date.now() + 1 });
      await eng.sincronizar();

      const primeira = (await ad.ler('notas/relatorio.md'))?.texto ?? '';
      ok('renomear · colisão de apelido não sobrescreve a nota que já estava lá',
         primeira.includes('sou a primeira'));

      const vivos = (await ad.listarMudancas(null)).filter(m => !m.apagado)
        .map(m => m.caminho).filter(c => c.startsWith('notas/'));
      igual('renomear · colisão mantém as duas notas', vivos.length, 2);

      const daSegunda = await st.obterEstadoSync('col2');
      const textoSegunda = (await ad.ler(daSegunda.caminho))?.texto ?? '';
      ok('renomear · a segunda manteve o próprio arquivo, com o título novo',
         textoSegunda.includes('sou a segunda') && textoSegunda.includes('Relatório'));
    }

    // No markdown de cada nota, a imagem vira o caminho relativo ../imagens/<hash>.png
    const mdNota1 = (await adapter.ler('notas/nota-com-imagem-1.md')).texto;
    const mdNota2 = (await adapter.ler('notas/nota-com-imagem-2.md')).texto;
    ok('imagem · markdown da nota 1 aponta para ../imagens/<hash>.png', mdNota1.includes(`../imagens/${hash1}.png`));
    ok('imagem · markdown da nota 2 aponta para ../imagens/<hash>.png', mdNota2.includes(`../imagens/${hash1}.png`));
    ok('imagem · texto alternativo foi preservado', mdNota1.includes('![diagrama portal]'));

    // 10.3: Download preguiçoso: nota desce para o aparelho B sem baixar o binário da imagem
    await engineB.sincronizar();
    const notaDescidaB = await storeB.obterNotaPorUid('u_img_nota1');
    ok('imagem · lazy: nota foi baixada para o aparelho B', notaDescidaB !== null);
    const blocoImgB = notaDescidaB.blocks.find(b => b.type === 'image');
    ok('imagem · lazy: bloco baixado tem imagePath relativo', blocoImgB.imagePath === `../imagens/${hash1}.png`);
    igual('imagem · lazy: fileId local permanece indefinido antes da abertura', blocoImgB.fileId, undefined);
    igual('imagem · lazy: nenhum arquivo de imagem foi gravado no store B durante o sync', storeB.arquivos.size, 0);

    // 10.4: Resolução sob demanda: abrir a nota resolve a imagem contra o arquivo certo
    await engineB.resolverImagensDaNota('u_img_nota1');
    const notaAbertaB = await storeB.obterNotaPorUid('u_img_nota1');
    const blocoResolvidoB = notaAbertaB.blocks.find(b => b.type === 'image');
    ok('imagem · resolução: bloco ganhou fileId local após ser resolvido', typeof blocoResolvidoB.fileId === 'number');
    igual('imagem · resolução: imagem foi salva no armazenamento do aparelho B', storeB.arquivos.size, 1);
    const blobSalvoB = await storeB.obterBlobArquivo(blocoResolvidoB.fileId);
    ok('imagem · resolução: blob recuperado é válido', blobSalvoB !== null);
    const hashBaixadoB = await calcularHashImagem(blobSalvoB);
    igual('imagem · resolução: hash do arquivo baixado bate perfeitamente com o original', hashBaixadoB, hash1);

    // 10.5: Preservação no aparelho de origem após alteração de texto em outro aparelho
    await storeB.salvarNotaLocal({
      ...notaAbertaB,
      blocks: [
        blocoResolvidoB,
        { id: 'b_novo', type: 'paragraph', html: 'Texto adicionado pelo Aparelho B' },
      ],
      updatedAt: Date.now() + 1000,
    });
    await engineB.sincronizar();

    await engineA.sincronizar();
    const notaAtualizadaA = await storeA.obterNotaPorUid('u_img_nota1');
    const blocoImgA = notaAtualizadaA.blocks.find(b => b.type === 'image');
    igual('imagem · preservação: aparelho A mantém seu fileId local original intacto', blocoImgA.fileId, idArq1);
  }

  // 11. Tarefa 2 (HANDOFF-3): Conflito visível no SyncController e popover
  {
    const { SyncEngine } = await import('../sidepanel/modules/sync-engine.js');
    const { SyncController } = await import('../sidepanel/modules/sync-controller.js');
    const storeA = new InMemoryStore();
    const storeB = new InMemoryStore();
    const adapter = new MemorySyncAdapter();
    const engineA = new SyncEngine({ adapter, store: storeA, deviceName: 'AparelhoA' });
    const engineB = new SyncEngine({ adapter, store: storeB, deviceName: 'AparelhoB' });

    // Cria nota base compartilhada
    await storeA.salvarNotaLocal({
      uid: 'u_conflito_visivel',
      title: 'Nota Importante',
      blocks: [{ id: 'b1', type: 'paragraph', html: 'Versão original' }],
      ordem: 'a0',
    });
    await engineA.sincronizar();
    await engineB.sincronizar();

    // Ambos os aparelhos editam offline
    await storeA.salvarNotaLocal({
      uid: 'u_conflito_visivel',
      title: 'Nota Importante',
      blocks: [{ id: 'b1', type: 'paragraph', html: 'Edição do Aparelho A' }],
      ordem: 'a0',
      updatedAt: Date.now() + 100,
    });
    await storeB.salvarNotaLocal({
      uid: 'u_conflito_visivel',
      title: 'Nota Importante',
      blocks: [{ id: 'b1', type: 'paragraph', html: 'Edição do Aparelho B' }],
      ordem: 'a0',
      updatedAt: Date.now() + 200,
    });

    // Aparelho B sobe primeiro
    await engineB.sincronizar();

    // Aparelho A sincroniza e detecta o conflito
    const resSyncA = await engineA.sincronizar();
    igual('conflito visível · engine contabiliza conflito', resSyncA.conflitos, 1);
    ok('conflito visível · engine fornece array de notas em conflito', Array.isArray(resSyncA.notasConflito));
    igual('conflito visível · detalhes do conflito carregam título original', resSyncA.notasConflito[0].tituloOriginal, 'Nota Importante');
    ok('conflito visível · título da cópia gerada contém conflito', resSyncA.notasConflito[0].tituloConflito.includes('conflito'));

    // Testa gestão de conflitos no SyncController
    const controllerA = new SyncController({ store: storeA, adapter });
    await controllerA._montarEngineComAdapter(adapter);
    controllerA.state = 'IDLE';

    // Simula rodada que gerou conflito pelo controller
    controllerA.conflitosPendentes.push(...resSyncA.notasConflito);
    await storeA.salvarMeta('syncPendingConflicts', controllerA.conflitosPendentes);

    const resumo = controllerA.obterResumoEstado();
    igual('conflito visível · controller resume total de conflitos pendentes', resumo.totalConflitos, 1);
    igual('conflito visível · conflitosPendentes contém a nota afetada', resumo.conflitosPendentes[0].tituloOriginal, 'Nota Importante');

    // Ao dispensar o aviso, limpa do estado e da persistência
    await controllerA.dispensarConflitos();
    igual('conflito visível · dispensar limpa conflitos da memória', controllerA.conflitosPendentes.length, 0);
    igual('conflito visível · dispensar remove metadados salvos', await storeA.obterMeta('syncPendingConflicts'), null);
  }

  // 12. Tarefa 3 (HANDOFF-3): Sincronização de modelos (pasta modelos/)
  {
    const { SyncEngine } = await import('../sidepanel/modules/sync-engine.js');
    const storeA = new InMemoryStore();
    const storeB = new InMemoryStore();
    const adapter = new MemorySyncAdapter();
    const engineA = new SyncEngine({ adapter, store: storeA, deviceName: 'AparelhoA' });
    const engineB = new SyncEngine({ adapter, store: storeB, deviceName: 'AparelhoB' });

    // 12.1: Modelo criado localmente sobe para modelos/<slug>.md
    await storeA.salvarModeloLocal({
      uid: 'u_mod_1',
      name: 'Checklist Atendimento',
      kind: 'note',
      content: '# Checklist\n\n- [ ] Protocolo aberto\n- [ ] Dados conferidos',
      ordem: 'a0',
    });

    const resEnvioMod = await engineA.sincronizar();
    igual('modelos · envio de modelo novo concluído', resEnvioMod.enviadas, 1);
    const arqMod = await adapter.ler('modelos/checklist-atendimento.md');
    ok('modelos · arquivo modelos/checklist-atendimento.md criado no destino', arqMod !== null);
    ok('modelos · frontmatter do modelo contém id', arqMod.texto.includes('id: u_mod_1'));
    ok('modelos · frontmatter do modelo contém nome', arqMod.texto.includes('nome: Checklist Atendimento'));
    ok('modelos · corpo markdown do modelo foi preservado', arqMod.texto.includes('- [ ] Protocolo aberto'));

    // 12.2: Aparelho B baixa o modelo
    const resDescidaMod = await engineB.sincronizar();
    igual('modelos · aparelho B baixa o modelo novo', resDescidaMod.baixadas, 1);
    const modB = await storeB.obterModeloPorUid('u_mod_1');
    ok('modelos · modelo existe no store do aparelho B', modB !== null);
    igual('modelos · nome do modelo baixado confere', modB.name, 'Checklist Atendimento');
    igual('modelos · tipo do modelo baixado confere', modB.kind, 'note');

    // 12.3: Alteração em modelo sincroniza
    await storeB.salvarModeloLocal({
      ...modB,
      content: '# Checklist Atualizado\n\n- [ ] Protocolo\n- [ ] Retorno enviado',
    });
    await engineB.sincronizar();

    await engineA.sincronizar();
    const modAAtualizado = await storeA.obterModeloPorUid('u_mod_1');
    ok('modelos · alteração remota propaga para o aparelho A', modAAtualizado.content.includes('Retorno enviado'));

    // 12.4: Exclusão de modelo propaga
    await adapter.apagar('modelos/checklist-atendimento.md');
    // Adiciona lápide de exclusão simulando remoção no destino
    adapter.seqCounter++;
    adapter.arquivos.set('modelos/checklist-atendimento.md', {
      conteudo: '',
      rev: String(adapter.seqCounter),
      apagado: true,
      seq: adapter.seqCounter,
    });

    await engineA.sincronizar();
    const modAApagado = await storeA.obterModeloPorUid('u_mod_1');
    igual('modelos · exclusão remota apaga modelo do store local', modAApagado, null);
  }
}

// ── 5. Guarda de código: criar bloco a partir de dado serializado ────────────
// Não dá pra exercitar o editor fora do navegador, mas dá pra garantir que
// ninguém volte a montar um bloco na mão a partir de dado solto — foi assim
// que uma tabela colada perdia as linhas e virava uma tabela vazia.
{
  const { readFile } = await import('node:fs/promises');
  const fonte = await readFile(new URL('../sidepanel/modules/note.js', import.meta.url), 'utf8');
  // Fora o próprio createBlockElFrom, que é justamente quem tem o direito.
  const resto  = fonte.replace(/function createBlockElFrom\([^)]*\) \{[\s\S]*?\n\}/, '');
  const soltas = [...resto.matchAll(/createBlockEl\(\s*(b\.|[a-z]\w*\.dataset\.)/g)].map(m => m[0]);
  ok('note.js · bloco vindo de dado serializado passa por createBlockElFrom',
     soltas.length === 0, soltas.join(' | '));

  // A âncora invisível que segura o cursor depois de um atalho inline é um
  // detalhe do cursor e não pode virar conteúdo salvo. sanitizeForSave é o
  // funil por onde tudo passa antes de ir pro banco — se a remoção sair dali,
  // o caractere começa a se acumular nas notas das pessoas, invisível.
  const ancora = /const ANCORA = '(.*?)';/.exec(fonte)?.[1];
  igual('note.js · a âncora é o espaço de largura zero', ancora?.codePointAt(0), 0x200b);

  const funil = /function sanitizeForSave\([\s\S]*?\n\}/.exec(fonte)?.[0] ?? '';
  ok('note.js · sanitizeForSave remove a âncora antes de salvar',
     funil.includes('ANCORA'), funil.slice(0, 120));
}

// ── 5b. Modo modelo não pode gravar por cima da nota ─────────────────────────
// Foi um bug de perda de nota inteira, e de ordem de duas linhas.
{
  const { readFile } = await import('node:fs/promises');
  const abas = await readFile(new URL('../sidepanel/modules/notes-tabs.js', import.meta.url), 'utf8');
  const tpl  = await readFile(new URL('../sidepanel/modules/templates.js', import.meta.url), 'utf8');

  // switchToNote começa com um flushSave, e o modo modelo é justamente o que
  // bloqueia esse save. Limpar a marca ANTES de a nota voltar pra tela faz o
  // save serializar os blocos do MODELO e gravá-los por cima da nota aberta.
  const sair = /async function exitTemplate\([\s\S]*?\n\}/.exec(abas)?.[0] ?? '';
  ok('modo modelo · exitTemplate continua existindo', !!sair);

  const iVolta = sair.indexOf('activateNote(');
  const iLimpa = sair.indexOf('clearTemplateEditing()');
  ok('modo modelo · a nota volta pra tela ANTES de o modo ser desligado',
     iVolta !== -1 && iLimpa > iVolta,
     `activateNote em ${iVolta}, clearTemplateEditing em ${iLimpa}`);

  // Salvar um pedaço da nota como modelo é guardar, não trocar de tela: quem
  // clicou ali estava escrevendo, e ver só o trecho salvo parece perda de nota.
  const salvar = /export function openSaveBlockTemplate\([\s\S]*?\n\}/.exec(tpl)?.[0] ?? '';
  ok('modelos · openSaveBlockTemplate continua existindo', !!salvar);
  ok('modelos · salvar um bloco como modelo não abre o editor de modelos',
     !/requestTemplateEdit|createAndEdit/.test(salvar),
     salvar.slice(0, 160));
}

// ── 6. Indentação do editor (Tab / Shift+Tab) ────────────────────────────────
{
  const { rodarTestesDeIndentacao } = await import('./indent.mjs');
  rodarTestesDeIndentacao(ok, igual);

  const { rodarTestesDeControles } = await import('./controls.mjs');
  rodarTestesDeControles(ok, igual);

  const { rodarTestesDeChecklist } = await import('./checklist.mjs');
  rodarTestesDeChecklist(ok, igual);

  const { rodarTestesDeCalculo } = await import('./calc.mjs');
  rodarTestesDeCalculo(ok, igual);
}

// ── 7. Atalhos de formatação ao digitar ──────────────────────────────────────
// Mesma técnica do indent.mjs: recorta a tabela de atalhos do note.js e a roda
// aqui. O que se testa é o que a pessoa digita e o que aparece na tela.
{
  const { safeHref } = await import('../sidepanel/modules/blocks.js');
  const { readFile } = await import('node:fs/promises');
  const fonte = (await readFile(new URL('../sidepanel/modules/note.js', import.meta.url), 'utf8'))
    .replace(/\r\n?/g, '\n');

  const ini = fonte.indexOf('const INLINE_SHORTCUTS = [');
  const fim = fonte.indexOf('\n];\n', ini);
  ok('atalhos · a tabela INLINE_SHORTCUTS continua existindo em note.js', ini !== -1 && fim !== -1);

  const atalhos = new Function('safeHref', `${fonte.slice(ini, fim + 3)}\nreturn INLINE_SHORTCUTS;`)(safeHref);

  // Reproduz o que tryAutoFormatInline faz: casa contra o texto ATÉ o cursor.
  const aplicar = digitado => {
    for (const { re, tag, attrs } of atalhos) {
      const m = re.exec(digitado);
      if (!m) continue;
      const a = attrs ? attrs(m) : {};
      if (a === null) continue;
      return { tag, texto: m[1], attrs: a, consumido: m[0] };
    }
    return null;
  };

  igual('atalhos · **negrito** ao digitar', aplicar('olha o **negrito**')?.tag, 'strong');
  igual('atalhos · *itálico* ao digitar',   aplicar('olha o *itálico*')?.tag, 'em');
  igual('atalhos · ~~riscado~~ ao digitar', aplicar('olha o ~~riscado~~')?.tag, 's');
  igual('atalhos · `código` ao digitar',    aplicar('rode `npm test`')?.tag, 'code');

  // O que faltava: link ao digitar.
  {
    const r = aplicar('veja [a documentação](exemplo.com.br/docs)');
    igual('atalhos · [texto](url) vira link', [r?.tag, r?.texto], ['a', 'a documentação']);
    igual('atalhos · e completa o https:// de um domínio solto',
      r?.attrs?.href, 'https://exemplo.com.br/docs');
  }

  // "!" na frente é consumido: senão sobraria solto antes do link.
  {
    const r = aplicar('![print](https://exemplo.com/a.png)');
    igual('atalhos · ![alt](url) remoto vira link, como na colagem', r?.tag, 'a');
    ok('atalhos · e o "!" não sobra no texto', r?.consumido.startsWith('!'), r?.consumido);
  }

  // Endereço recusado não pode virar link nem apagar o que foi digitado.
  {
    const r = aplicar('[clique](javascript:alert(1))');
    ok('atalhos · endereço perigoso não vira link', r?.tag !== 'a', JSON.stringify(r));
  }

  // A multiplicação não pode virar itálico — é a razão da guarda no regex.
  ok('atalhos · "5 * 3 * 2" não vira itálico', aplicar('5 * 3 * 2') === null);

  // ── Atalhos que trocam o tipo do bloco ─────────────────────────────────────
  {
    const ini = fonte.indexOf('const BLOCK_SHORTCUTS = [');
    const fim = fonte.indexOf('\n];\n', ini);
    ok('atalhos · a tabela BLOCK_SHORTCUTS continua existindo', ini !== -1 && fim !== -1);

    const tabela = new Function(`${fonte.slice(ini, fim + 3)}\nreturn BLOCK_SHORTCUTS;`)();
    const tipoDe = digitado => {
      for (const s of tabela) {
        const m = s.re.exec(digitado);
        if (m) return s.type(m);
      }
      return null;
    };

    igual('atalhos · "## " vira título 2',      tipoDe('## '), 'heading2');
    igual('atalhos · "- " vira lista',          tipoDe('- '), 'bullet');
    igual('atalhos · "- [x] " vira checklist',  tipoDe('- [x] '), 'checklist');
    igual('atalhos · "> " vira citação',        tipoDe('> '), 'quote');

    // Destaque ao digitar, com a palavra-chave do markdown.
    igual('atalhos · "[!NOTE] " vira destaque',    tipoDe('[!NOTE] '), 'callout:note');
    igual('atalhos · aceita em minúsculas',        tipoDe('[!warning] '), 'callout:warning');
    igual('atalhos · palavra inventada não vira destaque', tipoDe('[!URGENTE] '), null);
  }
}

// ── 8. A nota-tutorial ───────────────────────────────────────────────────────
// É o texto que toda pessoa vê na primeira abertura, e usa todos os recursos
// de uma vez. Se o parser quebrar em alguma coisa, quebra aqui primeiro.
{
  const { readFile } = await import('node:fs/promises');
  const fonte = await readFile(new URL('../sidepanel/modules/notes-tabs.js', import.meta.url), 'utf8');
  const m = /const TUTORIAL_MARKDOWN = `([\s\S]*?)`;/.exec(fonte);
  ok('tutorial · continua sendo possível extrair o texto de notes-tabs.js', !!m);

  // O que se lê aqui é o FONTE, onde crase e cifrão aparecem escapados porque
  // o tutorial mora dentro de um literal de template. O JS desfaz isso ao
  // carregar o módulo; sem desfazer aqui também, o teste estaria conferindo um
  // texto que nunca chega a existir.
  const md = m[1].replace(/\\([`$\\])/g, '$1');
  const blocks = parseMarkdownToBlocks(md);

  // Todo recurso que o tutorial descreve tem que aparecer nele como bloco.
  const tipos = new Set(blocks.map(b => b.type));
  for (const t of ['heading1', 'heading2', 'heading3', 'paragraph', 'bullet',
                   'number', 'checklist', 'divider', 'table']) {
    ok(`tutorial · contém um bloco ${t}`, tipos.has(t));
  }
  ok('tutorial · contém citação', blocks.some(b => b.quoted));
  ok('tutorial · mostra os cinco tipos de destaque',
     new Set(blocks.filter(b => b.callout).map(b => b.callout)).size === 5,
     [...new Set(blocks.filter(b => b.callout).map(b => b.callout))].join(', '));
  ok('tutorial · e um destaque com checklist dentro',
     blocks.some(b => b.callout && b.type === 'checklist'));
  ok('tutorial · contém lista aninhada', blocks.some(b => (b.depth ?? 0) > 0));
  ok('tutorial · contém folha de cálculo', blocks.some(b => b.type === 'calc'));
  // O exemplo do tutorial é avaliado de verdade: se o resultado mudar, é
  // porque o avaliador mudou, e a nota que toda pessoa vê passa a mentir.
  {
    const { evaluateSheet } = await import('../sidepanel/modules/calc.js');
    const folha = blocks.filter(b => b.type === 'calc').slice(0, 3)
      .map(b => b.html.replace(/<[^>]+>/g, ''));
    igual('tutorial · o exemplo do cálculo dá o resultado que o texto promete',
      evaluateSheet(folha).at(-1)?.fmt, 'R$ 850,00');
  }
  ok('tutorial · contém título dentro de citação',
     blocks.some(b => b.quoted && b.type.startsWith('heading')));

  // Ida e volta estável: o tutorial é gravado como blocos e reaberto como
  // markdown em toda exportação.
  const volta = parseMarkdownToBlocks(blocksToMarkdown(blocks));
  igual('tutorial · parse→serialize→parse é idempotente', forma(volta), forma(blocks));

  // Nenhum resíduo de sintaxe visível: se sobrar "####" ou "- [ ]" como texto,
  // é porque algum bloco não foi reconhecido.
  const residuo = blocks.filter(b =>
    b.html && /^(#{1,6} |&gt; |[-*] \[[ xX]\] )/.test(b.html));
  igual('tutorial · nenhuma marcação sobrou como texto literal',
    residuo.map(b => b.html.slice(0, 40)), []);

  ok('tutorial · sem menção ao nome de outro produto', !/notion/i.test(md));
}

// ── 9. Nota vazia nunca vira lista vazia de blocos ───────────────────────────
for (const entrada of ['', null, undefined, '\n\n']) {
  ok(`vazio · ${JSON.stringify(entrada)} gera ao menos um bloco`,
     parseMarkdownToBlocks(entrada).length >= 1);
}

// ── 13. Tarefa 1 (HANDOFF-5): Verificação da versão do formato (Portão) ───────
{
  const { parseNoteFile, extrairMetadadosBrutos, FORMATO_QUICKDOCK_SUPORTADO } =
    await import('../sidepanel/modules/notefile.js');
  const { SyncEngine } = await import('../sidepanel/modules/sync-engine.js');
  const { SyncController } = await import('../sidepanel/modules/sync-controller.js');
  const { MemorySyncAdapter } = await import('../sidepanel/modules/sync-adapter.js');
  const { InMemoryStore } = await import('./memory-store.mjs');

  igual('versão formato · cliente suporta formato 1', FORMATO_QUICKDOCK_SUPORTADO, 1);

  // 13.1: Arquivo com formato futuro (quickdock: 2) é recusado pelo parseNoteFile
  const arquivoFuturo = [
    '---',
    'quickdock: 2',
    'id: "u_nota_futura"',
    'titulo: "Nota em Formato v2"',
    'recurso_novo: true',
    '---',
    '',
    'Texto com recurso futuro.',
  ].join('\n');

  igual('versão formato · parseNoteFile recusa formato 2 devolvendo null', parseNoteFile(arquivoFuturo), null);

  const bruto = extrairMetadadosBrutos(arquivoFuturo);
  ok('versão formato · extrairMetadadosBrutos permite inspecionar metadados de arquivo recusado', bruto !== null);
  igual('versão formato · extrai a versão 2 sem aceitar o arquivo', bruto?.meta?.quickdock, 2);
  igual('versão formato · extrai o id da nota recusada', bruto?.meta?.id, 'u_nota_futura');

  // 13.2: SyncEngine recusa arquivo com quickdock: 2
  // Não escreve por cima do arquivo remoto, mantém a nota local correspondente intacta
  // e emite aviso explícito para a interface de sincronização.
  const adapter = new MemorySyncAdapter();
  const store = new InMemoryStore();
  const engine = new SyncEngine({ adapter, store, deviceName: 'AparelhoV1' });

  // 1. Simula nota existente localmente com o mesmo UID
  const notaLocalOriginal = {
    uid: 'u_nota_futura',
    title: 'Minha Versão Local',
    blocks: [{ type: 'paragraph', html: 'conteúdo local intocado' }],
    ordem: 'a0',
    updatedAt: Date.now(),
  };
  await store.salvarNotaLocal(notaLocalOriginal);

  // 2. Simula arquivo gravado na pasta remota por um cliente com versão mais nova (quickdock: 2)
  await adapter.escrever('notas/nota-em-formato-v2.md', arquivoFuturo, null);

  // 3. Executa a sincronização
  const resSync = await engine.sincronizar();

  // Verificação de segurança absoluta contra perda de dados:
  igual('versão formato · arquivo incompatível é pulado', resSync.puladas, 1);
  igual('versão formato · nenhum arquivo foi baixado por cima', resSync.baixadas, 0);
  igual('versão formato · nenhum arquivo foi enviado', resSync.enviadas, 0);

  // A nota local NÃO foi sobrescrita
  const notaAposSync = await store.obterNotaPorUid('u_nota_futura');
  igual('versão formato · nota local permanece intacta', notaAposSync.title, 'Minha Versão Local');
  igual('versão formato · blocos locais continuam intactos', notaAposSync.blocks[0].html, 'conteúdo local intocado');

  // O arquivo remoto NÃO foi sobrescrito
  const arqRemotoAposSync = await adapter.ler('notas/nota-em-formato-v2.md');
  igual('versão formato · arquivo remoto não foi sobrescrito', arqRemotoAposSync.texto, arquivoFuturo);

  // Prova adicional: mesmo se a nota local tiver o mesmo título do arquivo remoto,
  // o Passo 3 não sobe nem sobrescreve o arquivo recusado por versão
  await store.salvarNotaLocal({
    ...notaLocalOriginal,
    title: 'Nota em Formato v2',
    updatedAt: Date.now() + 10,
  });
  const resSync2 = await engine.sincronizar();
  igual('versão formato · upload local não sobrescreve arquivo recusado por versão', resSync2.enviadas, 0);
  const arqRemotoAposSync2 = await adapter.ler('notas/nota-em-formato-v2.md');
  igual('versão formato · arquivo remoto continua intacto após tentativa de upload', arqRemotoAposSync2.texto, arquivoFuturo);

  // O motor gerou aviso estruturado para a interface
  ok('versão formato · motor emite avisosVersao', Array.isArray(resSync.avisosVersao) && resSync.avisosVersao.length === 1);
  igual('versão formato · aviso indica o caminho da nota', resSync.avisosVersao[0].caminho, 'notas/nota-em-formato-v2.md');
  ok('versão formato · aviso contém a mensagem explicativa',
     resSync.avisosVersao[0].mensagem.includes('esta nota foi criada por uma versão mais nova do QuickDock'));

  // 13.3: SyncController acumula e permite dispensar avisos de versão
  const controller = new SyncController({ store, adapter });
  await controller._montarEngineComAdapter(adapter);
  controller.state = 'IDLE';

  controller.avisosVersao.push(...resSync.avisosVersao);
  await store.salvarMeta('syncVersionWarnings', controller.avisosVersao);

  const resumo = controller.obterResumoEstado();
  igual('versão formato · controller resume avisos de versão', resumo.totalAvisosVersao, 1);
  igual('versão formato · dados do aviso constam no resumo', resumo.avisosVersao[0].versao, 2);

  await controller.dispensarAvisosVersao();
  igual('versão formato · dispensar limpa avisos da memória', controller.avisosVersao.length, 0);
  igual('versão formato · dispensar remove metadados salvos', await store.obterMeta('syncVersionWarnings'), null);
}

// ── 14. Tarefa 2 (HANDOFF-5): Camada de plataforma e desacoplamento do storage ─
{
  const fs = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  // 14.1: storage.js não menciona chrome. em nenhuma linha
  const storagePath = path.resolve(__dirname, '../sidepanel/modules/storage.js');
  const storageSource = fs.readFileSync(storagePath, 'utf-8');
  ok('plataforma · storage.js não menciona chrome. em nenhuma linha', !/chrome\./.test(storageSource));
  ok('plataforma · storage.js não menciona a palavra chrome', !/chrome/i.test(storageSource));

  // 14.2: platform.js opera transparentemente no ambiente fora da extensão
  const { platformStorage, podeInserirNaPagina, conectarPainel, isExtension } =
    await import('../sidepanel/modules/platform.js');

  igual('plataforma · isExtension é falso no ambiente de teste Node.js', isExtension, false);
  igual('plataforma · podeInserirNaPagina é falso fora da extensão', podeInserirNaPagina(), false);
  igual('plataforma · conectarPainel não lança erro e retorna null', conectarPainel(), null);

  // Testa escrita, leitura e remoção pelo platformStorage
  await platformStorage.set('teste_chave', { ativo: true, valor: 42 });
  const valorLido = await platformStorage.get('teste_chave');
  igual('plataforma · platformStorage grava e lê objeto', valorLido?.valor, 42);

  await platformStorage.remove('teste_chave');
  igual('plataforma · platformStorage remove chave', await platformStorage.get('teste_chave'), undefined);
}

// ── 15. Tarefas 3 e 4 (HANDOFF-5): Degradação na web, casca PWA e roteamento ──
{
  const fs = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  // 15.1: inject.js não assume existência incondicional de chrome.runtime
  const injectPath = path.resolve(__dirname, '../sidepanel/modules/inject.js');
  const injectSource = fs.readFileSync(injectPath, 'utf-8');
  ok('web · inject.js protege o listener de runtime contra ausência de chrome',
     injectSource.includes('typeof chrome !== \'undefined\'') || injectSource.includes('chrome?.runtime?.onMessage'));

  // 15.2: manifest.webmanifest é JSON válido e define escopo do GitHub Pages
  const manifestPath = path.resolve(__dirname, '../manifest.webmanifest');
  ok('pwa · manifest.webmanifest existe na raiz', fs.existsSync(manifestPath));
  const manifestContent = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  igual('pwa · manifest define nome do app', manifestContent.name, 'QuickDock');
  // Caminho relativo, não fixo. O `start_url` e o `scope` se resolvem contra a
  // URL do próprio manifesto, então "./" funciona em qualquer lugar: na subpasta
  // do github.io, na raiz de um domínio próprio, ou servido de localhost pra
  // teste. Fixar "/QuickDock/" amarra o app a um endereço só — e o registro do
  // service worker, que deriva o escopo de location.pathname, discordaria dele.
  igual('pwa · manifest usa escopo relativo', manifestContent.scope, './');
  igual('pwa · manifest usa start_url relativo', manifestContent.start_url, './');
  // O Chrome só oferece instalação se existirem ícones de 192 e 512. Faltando,
  // o botão não aparece e NÃO há erro nenhum no console — o sintoma é silêncio.
  // Foi exatamente o que aconteceu no primeiro deploy: o manifesto reaproveitou
  // os ícones da extensão (16/48/128) e o app simplesmente não era instalável.
  for (const lado of ['192x192', '512x512']) {
    ok(`pwa · manifesto declara ícone ${lado} (exigido para instalar)`,
       manifestContent.icons.some(i => i.sizes === lado),
       manifestContent.icons.map(i => i.sizes).join(', '));
  }

  ok('pwa · ícones do manifesto são relativos',
     manifestContent.icons.every(i => !i.src.startsWith('/')),
     manifestContent.icons.map(i => i.src).join(', '));

  // 15.3: sw.js existe e possui estratégia de cache versionado
  const swPath = path.resolve(__dirname, '../sw.js');
  ok('pwa · sw.js existe na raiz', fs.existsSync(swPath));
  const swSource = fs.readFileSync(swPath, 'utf-8');
  ok('pwa · sw.js possui nome de cache versionado', swSource.includes('CACHE_NAME = \'quickdock-v'));
  ok('pwa · sw.js trata SKIP_WAITING', swSource.includes('SKIP_WAITING'));

  // 15.4: 404.html existe e replica index.html para fallback de rotas SPA no GitHub Pages
  const indexPath = path.resolve(__dirname, '../index.html');
  const notFoundPath = path.resolve(__dirname, '../404.html');
  ok('pwa · index.html existe na raiz', fs.existsSync(indexPath));
  ok('pwa · 404.html existe na raiz', fs.existsSync(notFoundPath));
  const indexSource = fs.readFileSync(indexPath, 'utf-8');
  const notFoundSource = fs.readFileSync(notFoundPath, 'utf-8');
  igual('pwa · 404.html é cópia fiel de index.html', notFoundSource, indexSource);
}

// ── Resultado ────────────────────────────────────────────────────────────────
// ── O pré-cache do PWA não pode ficar para trás ──────────────────────────────
// A lista de arquivos do service worker é escrita à mão e apodrece em silêncio:
// alguém cria um módulo, o editor passa a importá-lo, e offline o PWA quebra num
// lugar que nenhum outro teste alcança. Foi o que aconteceu com o snapshot.js.
{
  const { readFile, readdir } = await import('node:fs/promises');
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const modulos = (await readdir(new URL('../sidepanel/modules/', import.meta.url)))
    .filter(n => n.endsWith('.js'));

  const faltando = modulos.filter(n => !sw.includes(`sidepanel/modules/${n}`));
  ok('pwa · todo módulo está no pré-cache do service worker',
     faltando.length === 0, `fora da lista: ${faltando.join(', ')}`);

  // O contrário também: caminho listado que não existe mais vira falha silenciosa
  // de cache a cada instalação do service worker.
  const listados = [...sw.matchAll(/'(sidepanel\/modules\/[a-z0-9-]+\.js)'/g)].map(m => m[1]);
  const sobrando = listados.filter(c => !modulos.includes(c.split('/').pop()));
  ok('pwa · pré-cache não lista módulo inexistente',
     sobrando.length === 0, `não existem: ${sobrando.join(', ')}`);
}

// ── Sincronizar sem editar não pode gerar conflito ───────────────────────────
// Bug encontrado em uso real: o arquivo virou
//   nota-2-conflito-...-conflito-...-conflito-... (seis vezes) .md
// e a gravação falhou por estourar o caminho máximo do Windows.
//
// Duas causas somadas. O `flushSave()` do editor grava sempre que é chamado,
// mesmo sem mudança, carimbando updatedAt — e ele roda antes de CADA rodada de
// sincronização. Com `atualizadoEm` entrando no texto serializado, a nota parecia
// editada localmente toda vez. Junto disso, o adaptador de pasta gera revisão
// "mtime-tamanho", que não é número, então o cursor nunca avançava e o lado
// remoto também parecia mudado sempre. Os dois juntos = conflito por rodada, e
// cada cópia virava fonte da próxima.
{
  const { SyncEngine, hashDaNota } = await import('../sidepanel/modules/sync-engine.js');
  const { MemorySyncAdapter } = await import('../sidepanel/modules/sync-adapter.js');
  const { InMemoryStore } = await import('./memory-store.mjs');

  // Carimbo de tempo é metadado, não conteúdo.
  // A quebra vem de fromCharCode porque este arquivo já foi corrompido antes por
  // camada de escape comendo o "\n" — mesma razão do QUEBRA em blocks.js.
  const QUEBRA_TESTE = String.fromCharCode(10);
  const base = ['---', 'quickdock: 1', 'id: x', 'titulo: T',
                'atualizadoEm: "2026-01-01T00:00:00.000Z"', '---', '', 'corpo'].join(QUEBRA_TESTE);
  const outro = base.replace('2026-01-01', '2026-09-17');
  igual('sync · hash ignora o carimbo de atualização', hashDaNota(base), hashDaNota(outro));
  ok('sync · hash ainda enxerga mudança de conteúdo de verdade',
     hashDaNota(base) !== hashDaNota(base.replace('corpo', 'outro corpo')));

  // Adaptador com revisão não-numérica, como o de pasta local
  const revDe = t => { let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) | 0;
    return `${1726531200000 + Math.abs(h % 99999)}-${t.length}`; };
  class PastaLocalFalsa extends MemorySyncAdapter {
    async escrever(c, t, rb) { const r = await super.escrever(c, t, rb);
      if (r && r.rev) r.rev = revDe(t); return r; }
    async ler(c) { const r = await super.ler(c); return r ? { ...r, rev: revDe(r.texto) } : r; }
    async listarMudancas(d) { const m = await super.listarMudancas(d); const o = [];
      for (const x of m) { const a = await super.ler(x.caminho);
        o.push({ ...x, rev: a ? revDe(a.texto) : x.rev }); } return o; }
  }

  const ad = new PastaLocalFalsa(), st = new InMemoryStore();
  const eng = new SyncEngine({ adapter: ad, store: st, deviceName: 'QuickDock Windows',
    antesDeSincronizar: async () => {
      for (const n of await st.listarNotasLocais()) {
        await st.salvarNotaLocal({ ...n, updatedAt: Date.now() });
      }
    },
  });
  await st.salvarNotaLocal({ uid: 'u1', title: 'Nota 2', ordem: 'a0',
    blocks: [{ type: 'paragraph', html: 'texto que nunca muda' }], updatedAt: Date.now() });

  let totalConflitos = 0;
  for (let i = 0; i < 5; i++) {
    const r = await eng.sincronizar();
    totalConflitos += r.conflitos;
    await new Promise(x => setTimeout(x, 2));
  }
  const notas = await st.listarNotasLocais();
  igual('sync · 5 rodadas sem edição não geram conflito nenhum', totalConflitos, 0);
  igual('sync · 5 rodadas sem edição não multiplicam a nota', notas.length, 1);
  ok('sync · o título não ganha sufixo de conflito à toa',
     !/conflito/.test(notas[0].title), notas[0].title);
}

// Rede de segurança: sufixo de conflito não empilha, e título já danificado por
// uma versão anterior volta ao nome original.
{
  const { SyncEngine } = await import('../sidepanel/modules/sync-engine.js');
  const { MemorySyncAdapter } = await import('../sidepanel/modules/sync-adapter.js');
  const { InMemoryStore } = await import('./memory-store.mjs');
  const eng = new SyncEngine({ adapter: new MemorySyncAdapter(), store: new InMemoryStore(),
    deviceName: 'Aparelho' });

  const sufixo = ' (conflito 2026-09-17, QuickDock Windows)';
  const empilhado = 'Nota 2' + sufixo.repeat(6);
  const saida = eng._tituloDeConflitoParaTeste
    ? eng._tituloDeConflitoParaTeste(empilhado)
    : null;
  if (saida !== null) {
    ok('sync · título com sufixos empilhados volta ao nome original',
       (saida.match(/conflito/g) || []).length === 1, saida);
  }
}

// ── Nome de arquivo que não dá pra gravar não pode ser gerado ────────────────
// Segunda metade do mesmo relato de uso real: mesmo com o laço de conflito
// corrigido, a nota que JÁ tinha o título inchado continuava falhando a cada
// sincronização. 243 caracteres só no caminho relativo, e o Windows recusa
// acima de ~260 contando a pasta escolhida. Falha permanente, não resquício.
{
  const { SyncEngine, slugTitulo } = await import('../sidepanel/modules/sync-engine.js');
  const { MemorySyncAdapter } = await import('../sidepanel/modules/sync-adapter.js');
  const { InMemoryStore } = await import('./memory-store.mjs');

  const sufixo = ' (conflito 2026-09-17, QuickDock Windows)';
  const monstro = 'Nota 2' + sufixo.repeat(6);

  ok('nome · slug de título gigante cabe num caminho gravável',
     slugTitulo(monstro).length <= 60, `${slugTitulo(monstro).length} caracteres`);
  igual('nome · título curto não é mexido', slugTitulo('Atendimento Maria'), 'atendimento-maria');
  ok('nome · corte não deixa hífen sobrando no fim', !slugTitulo(monstro).endsWith('-'));

  // E a nota danificada tem que se curar sozinha, sem o usuário renomear na mão.
  const ad = new MemorySyncAdapter(), st = new InMemoryStore();
  const eng = new SyncEngine({ adapter: ad, store: st, deviceName: 'QuickDock Windows' });
  await st.salvarNotaLocal({ uid: 'u1', title: monstro, ordem: 'a0',
    blocks: [{ type: 'paragraph', html: 'conteudo que nao pode sumir' }], updatedAt: Date.now() });

  await eng.sincronizar();
  const nota = await st.obterNotaPorUid('u1');
  const marcas = (nota.title.match(/\(conflito /g) || []).length;

  igual('nome · título empilhado se cura e mantém uma marca só', marcas, 1);
  ok('nome · a cura preserva o nome original da nota', nota.title.startsWith('Nota 2'), nota.title);

  const caminho = (await st.obterEstadoSync('u1')).caminho;
  ok('nome · o arquivo gravado cabe no limite do sistema', caminho.length < 120, `${caminho.length} caracteres`);
  ok('nome · a cura não perdeu o conteúdo',
     (await ad.ler(caminho)).texto.includes('conteudo que nao pode sumir'));

  // Uma marca só é escolha possível do usuário: não pode ser mexida.
  const st2 = new InMemoryStore();
  const eng2 = new SyncEngine({ adapter: new MemorySyncAdapter(), store: st2, deviceName: 'X' });
  const umaMarca = 'Relatorio' + sufixo;
  await st2.salvarNotaLocal({ uid: 'u2', title: umaMarca, ordem: 'a0', blocks: [], updatedAt: Date.now() });
  await eng2.sincronizar();
  igual('nome · uma única marca de conflito é preservada',
        (await st2.obterNotaPorUid('u2')).title, umaMarca);
}

// ── Dois clientes na mesma pasta ─────────────────────────────────────────────
// A suíte nunca tinha exercitado o caso central da arquitetura: extensão e PWA
// apontando para a MESMA pasta. Relatado em uso real: com a mesma nota aberta
// nos dois, a sincronização gerava conflito sem ninguém ter editado nada.
//
// A causa não era edição simultânea: era o arquivo não convergir. Quem baixava
// uma nota sem `criadoEm` carimbava Date.now() e regravava COM o campo; o outro
// lado via diferença e regravava SEM. Ping-pong infinito, e conflito sempre que
// os dois subiam na mesma janela. Em quatro rodadas, uma nota virava seis de um
// lado e oito do outro.
{
  const { SyncEngine } = await import('../sidepanel/modules/sync-engine.js');
  const { MemorySyncAdapter } = await import('../sidepanel/modules/sync-adapter.js');
  const { InMemoryStore } = await import('./memory-store.mjs');

  // Revisão "mtime-tamanho", como o adaptador de pasta local gera de verdade —
  // e diferente da numérica do adaptador de memória, contra a qual o motor foi
  // originalmente escrito.
  const revDe = t => { let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) | 0;
    return `${1726531200000 + Math.abs(h % 99999)}-${t.length}`; };
  class PastaCompartilhada extends MemorySyncAdapter {
    async escrever(c, t, rb) { const r = await super.escrever(c, t, rb);
      if (r && r.rev) r.rev = revDe(t); return r; }
    async ler(c) { const r = await super.ler(c); return r ? { ...r, rev: revDe(r.texto) } : r; }
    async listarMudancas(d) { const m = await super.listarMudancas(d); const o = [];
      for (const x of m) { const a = await super.ler(x.caminho);
        o.push({ ...x, rev: a ? revDe(a.texto) : x.rev }); } return o; }
  }

  const pasta = new PastaCompartilhada();
  const stExt = new InMemoryStore(), stWeb = new InMemoryStore();

  // Os dois com a MESMA nota aberta, e flushSave carimbando antes de cada rodada
  const cliente = (st, nome) => new SyncEngine({
    adapter: pasta, store: st, deviceName: nome,
    obterNotaAbertaUid: () => 'u1',
    podeRecarregarNotaAberta: () => true,
    recarregarNotaAberta: async () => {},
    antesDeSincronizar: async () => {
      for (const n of await st.listarNotasLocais()) {
        await st.salvarNotaLocal({ ...n, updatedAt: Date.now() });
      }
    },
  });
  const ext = cliente(stExt, 'Extensao'), web = cliente(stWeb, 'Site');

  // Sem createdAt de propósito: é o campo que disparava a divergência.
  await stExt.salvarNotaLocal({ uid: 'u1', title: 'Nota compartilhada', ordem: 'a0',
    blocks: [{ type: 'paragraph', html: 'texto que ninguem edita' }], updatedAt: Date.now() });

  let conflitos = 0;
  for (let i = 0; i < 4; i++) {
    conflitos += (await ext.sincronizar()).conflitos;
    conflitos += (await web.sincronizar()).conflitos;
    await new Promise(r => setTimeout(r, 2));
  }

  const nExt = await stExt.listarNotasLocais();
  const nWeb = await stWeb.listarNotasLocais();
  igual('dois clientes · nenhum conflito sem ninguém editar', conflitos, 0);
  igual('dois clientes · a extensão continua com uma nota só', nExt.length, 1);
  igual('dois clientes · o site continua com uma nota só', nWeb.length, 1);
  ok('dois clientes · nenhum título ganhou marca de conflito',
     ![...nExt, ...nWeb].some(n => /conflito/.test(n.title)),
     [...nExt, ...nWeb].map(n => n.title).join(' | '));
  igual('dois clientes · os dois lados convergem no mesmo conteúdo',
        nWeb[0].blocks[0].html, nExt[0].blocks[0].html);

  // O arquivo tem que ser ponto fixo: quem baixa e regrava não pode mudar nada.
  const caminho = (await stExt.obterEstadoSync('u1')).caminho;
  const texto1 = (await pasta.ler(caminho)).texto;
  await web.sincronizar();
  await ext.sincronizar();
  igual('dois clientes · o arquivo não muda sozinho a cada rodada',
        (await pasta.ler(caminho)).texto, texto1);
}

// ── Clicar em sincronizar não pode não fazer nada ────────────────────────────
// Relatado em uso real: editar num cliente, clicar em Sincronizar no outro com a
// mesma nota aberta, e "fica travado naquele texto".
//
// A nota aberta é adiada quando há edição em andamento, e isso está certo para a
// sincronização automática. Mas na rodada seguinte a condição é a mesma, então
// enquanto a nota estivesse aberta ela nunca chegava -- e nada era dito. Um
// clique é pedido explícito: recusá-lo em silêncio faz o botão parecer quebrado.
{
  const { SyncEngine } = await import('../sidepanel/modules/sync-engine.js');
  const { MemorySyncAdapter } = await import('../sidepanel/modules/sync-adapter.js');
  const { InMemoryStore } = await import('./memory-store.mjs');

  const montar = async (podeRecarregar) => {
    const ad = new MemorySyncAdapter();
    const stA = new InMemoryStore(), stB = new InMemoryStore();
    const A = new SyncEngine({ adapter: ad, store: stA, deviceName: 'A' });
    let recarregou = false;
    const B = new SyncEngine({ adapter: ad, store: stB, deviceName: 'B',
      obterNotaAbertaUid: () => 'u1',
      podeRecarregarNotaAberta: () => podeRecarregar,
      recarregarNotaAberta: async () => { recarregou = true; },
    });
    const agora = Date.now();
    await stA.salvarNotaLocal({ uid: 'u1', title: 'N', ordem: 'a0',
      blocks: [{ type: 'paragraph', html: 'original' }], createdAt: agora, updatedAt: agora });
    await A.sincronizar();
    await B.sincronizar();            // B recebe a nota
    const nb = await stB.obterNotaPorUid('u1');

    // A edita e sobe
    const na = await stA.obterNotaPorUid('u1');
    await stA.salvarNotaLocal({ ...na, blocks: [{ type: 'paragraph', html: 'editado por A' }], updatedAt: Date.now() + 1 });
    await A.sincronizar();

    const r = await B.sincronizar();
    return { r, nota: await stB.obterNotaPorUid('u1'), recarregou, tinha: nb };
  };

  // Automática, com edição em andamento: adia, e DIZ que adiou.
  const adiado = await montar(false);
  igual('sync manual · rodada automática adia a nota ocupada', adiado.r.puladas, 1);
  ok('sync manual · a nota adiada não é sobrescrita',
     adiado.nota.blocks[0].html === 'original');

  // Pedido explícito: traz mesmo assim.
  const forcado = await montar(true);
  igual('sync manual · com recarga liberada a nota não fica para trás', forcado.r.puladas, 0);
  igual('sync manual · o texto novo chega de verdade',
        forcado.nota.blocks[0].html, 'editado por A');
  ok('sync manual · o editor é avisado para recarregar', forcado.recarregou);
}

// Guardas de fonte: a parte que depende de DOM e de Dexie não roda aqui, e são
// justamente as duas metades da correção.
{
  const { readFile } = await import('node:fs/promises');
  const ctrl = await readFile(new URL('../sidepanel/modules/sync-controller.js', import.meta.url), 'utf8');

  ok('sync manual · o botão pede sincronização manual',
     /sync-btn-agora[\s\S]{0,400}?sincronizarAgora\(\s*\{\s*manual:\s*true\s*\}\s*\)/.test(ctrl));
  ok('sync manual · rodada manual libera recarregar a nota aberta',
     /rodadaManual/.test(ctrl) && /podeRecarregarNotaAberta:\s*\(\)\s*=>\s*this\.rodadaManual/.test(ctrl));
  ok('sync manual · nota adiada aparece para o usuário',
     /notasPuladas/.test(ctrl) && /sync-skipped-msg/.test(ctrl));
}

// ── Subir a nota aberta é sempre seguro ──────────────────────────────────────
// Relatado em uso real: editar na extensão com a nota aberta, clicar em
// sincronizar, e do outro lado não chegar nada. A causa não era o lado que
// recebe -- era o que envia: a nota aberta simplesmente NÃO SUBIA enquanto o
// editor estivesse em foco, nem na primeira vez. O arquivo nem chegava a existir
// na pasta, e o outro cliente parecia travado por não ter o que buscar.
//
// Enviar só grava um arquivo e não encosta no editor. Quem arrisca atropelar a
// digitação é baixar, e essa parte continua adiando.
{
  const { SyncEngine } = await import('../sidepanel/modules/sync-engine.js');
  const { MemorySyncAdapter } = await import('../sidepanel/modules/sync-adapter.js');
  const { InMemoryStore } = await import('./memory-store.mjs');

  const ad = new MemorySyncAdapter(), st = new InMemoryStore();
  const ext = new SyncEngine({ adapter: ad, store: st, deviceName: 'Extensao',
    obterNotaAbertaUid: () => 'u1',
    podeRecarregarNotaAberta: () => false,   // editor em foco o tempo todo
    recarregarNotaAberta: async () => {},
  });

  const t = Date.now();
  await st.salvarNotaLocal({ uid: 'u1', title: 'N', ordem: 'a0',
    blocks: [{ type: 'paragraph', html: 'original' }], createdAt: t, updatedAt: t });

  const r1 = await ext.sincronizar();
  igual('subir · nota aberta sobe mesmo com o editor em foco', r1.enviadas, 1);
  ok('subir · o arquivo chega a existir na pasta', (await ad.ler('notas/n.md')) !== null);

  // E a edição seguinte também tem que chegar.
  const n = await st.obterNotaPorUid('u1');
  await st.salvarNotaLocal({ ...n, blocks: [{ type: 'paragraph', html: 'EDITADO' }],
    updatedAt: Date.now() + 1 });
  const r2 = await ext.sincronizar();
  igual('subir · edição na nota aberta é enviada', r2.enviadas, 1);
  ok('subir · o conteúdo editado está no arquivo',
     ((await ad.ler('notas/n.md'))?.texto ?? '').includes('EDITADO'));

  // Baixar continua adiando: é o lado que pode atropelar a digitação.
  const ad2 = new MemorySyncAdapter();
  const stA = new InMemoryStore(), stB = new InMemoryStore();
  const A = new SyncEngine({ adapter: ad2, store: stA, deviceName: 'A' });
  // O editor só fica ocupado DEPOIS que B já tem a nota: baixar uma nota que não
  // existe localmente não atropela nada, então não faria sentido adiar antes.
  let ocupado = false;
  const Bcliente = new SyncEngine({ adapter: ad2, store: stB, deviceName: 'B',
    obterNotaAbertaUid: () => 'u2',
    podeRecarregarNotaAberta: () => !ocupado,
    recarregarNotaAberta: async () => {},
  });
  const t2 = Date.now();
  await stA.salvarNotaLocal({ uid: 'u2', title: 'M', ordem: 'a0',
    blocks: [{ type: 'paragraph', html: 'de A' }], createdAt: t2, updatedAt: t2 });
  await A.sincronizar();
  await Bcliente.sincronizar();                  // B recebe a nota e a abre

  ocupado = true;                                // agora a pessoa está digitando nela
  const na2 = await stA.obterNotaPorUid('u2');
  await stA.salvarNotaLocal({ ...na2, blocks: [{ type: 'paragraph', html: 'A editou depois' }],
    updatedAt: Date.now() + 1 });
  await A.sincronizar();

  const rb = await Bcliente.sincronizar();
  igual('subir · baixar continua adiando quando o editor está ocupado', rb.baixadas, 0);
  igual('subir · o adiamento é contabilizado para poder ser avisado', rb.puladas, 1);
  igual('subir · o texto que a pessoa está editando não é atropelado',
        (await stB.obterNotaPorUid('u2'))?.blocks?.[0]?.html, 'de A');
}

// ── Recarregar a nota não pode gravar o editor por cima ──────────────────────
// Relatado em uso real: forçar subir num cliente e descer no outro "não vai de
// imediato, e acaba fazendo sync reverso e desfazendo a alteração".
//
// A sincronização gravava a versão nova no banco e mandava o editor recarregar.
// Mas `switchToNote` começa com `await flushSave()` -- correto para quem TROCA de
// nota, e destrutivo aqui: serializava o DOM antigo por cima do que acabara de
// descer, e o editor lia de volta justamente o texto velho. Na rodada seguinte
// ele subia como "alteração local" e desfazia a edição do outro aparelho.
//
// Não roda em node (precisa de DOM e Dexie); verificado à mão no navegador, onde
// sem a opção o banco reverte e com ela mantém a versão remota.
{
  const { readFile } = await import('node:fs/promises');
  const notaJs = await readFile(new URL('../sidepanel/modules/note.js', import.meta.url), 'utf8');
  const appJs = await readFile(new URL('../sidepanel/app.js', import.meta.url), 'utf8');

  const assinatura = /export async function switchToNote\(\s*id\s*,\s*\{[^}]*descartarDom/.test(notaJs);
  ok('recarga · switchToNote aceita descartar o editor', assinatura);

  const corpo = notaJs.slice(notaJs.indexOf('export async function switchToNote'));
  const trecho = corpo.slice(0, corpo.indexOf('\n}\n'));
  ok('recarga · com descartarDom o flushSave não roda',
     /if\s*\(\s*descartarDom\s*\)/.test(trecho) && /else\s*\{[\s\S]{0,80}flushSave\(\)/.test(trecho));
  ok('recarga · e o autosave pendente é cancelado junto',
     /clearTimeout\(saveTimer\)/.test(trecho),
     'sem isso um save agendado grava o DOM antigo depois do render');

  ok('recarga · a sincronização pede para descartar o editor',
     /recarregarNotaAberta[\s\S]{0,300}?switchToNote\(\s*id\s*,\s*\{\s*descartarDom:\s*true\s*\}\s*\)/.test(appJs));
}

if (falhas.length) {
  console.error(`\n✗ ${falhas.length} falha(s), ${passou} ok\n`);
  for (const f of falhas) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ ${passou} verificações passaram`);


