// ── run.mjs ────────────────────────────────────────────────────────────────
// Testes de regressão do modelo de blocos.  Rode com:  node test/run.mjs
//
// O que se está protegendo: a nota que já está gravada no banco de alguém. O
// caminho crítico é parse → serialize → parse. Se a segunda volta não bate com
// a primeira, alguma coisa se perdeu no meio — e é isso que o teste acusa.

import { installDomShim } from './dom-shim.mjs';
installDomShim();

const { parseMarkdownToBlocks, blocksToMarkdown, blocksToPlainText } =
  await import('../sidepanel/modules/blocks.js');

import { BLOCOS_V18, MARKDOWN, HOSTIS, INDENTACOES, CITACAO_COM_FILHOS } from './fixtures.mjs';

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
    return f;
  });
}

// ── 1. Blocos já gravados continuam abrindo e voltando iguais ────────────────
for (const { nome, blocks } of BLOCOS_V18) {
  const md  = blocksToMarkdown(blocks);
  const md2 = blocksToMarkdown(parseMarkdownToBlocks(md));
  ok(`v1.8 · ${nome} · markdown estável na segunda volta`, md === md2,
     `1ª volta:\n${md}\n2ª volta:\n${md2}`);

  // Texto simples não pode explodir em nenhum tipo de bloco.
  ok(`v1.8 · ${nome} · texto simples não quebra`,
     typeof blocksToPlainText(blocks) === 'string');

  // Nenhuma conversão pode gerar HTML executável.
  ok(`v1.8 · ${nome} · sem <script> no caminho de volta`, !/<script/i.test(md));
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

  const md = m[1];
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

// ── Resultado ────────────────────────────────────────────────────────────────
if (falhas.length) {
  console.error(`\n✗ ${falhas.length} falha(s), ${passou} ok\n`);
  for (const f of falhas) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ ${passou} verificações passaram`);
