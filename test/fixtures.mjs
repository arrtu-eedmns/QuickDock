// ── fixtures.mjs ───────────────────────────────────────────────────────────
// Notas reais no formato que já está gravado no banco das pessoas (v1.8).
//
// A razão de existir: toda mudança no modelo de blocos passa por aqui antes de
// ir pro editor. Se um bloco entra e sai diferente, o teste acusa — em vez de
// alguém descobrir com a nota aberta.
//
// Regra ao mexer: só se ACRESCENTA fixture. Apagar uma é apagar a prova de que
// aquele formato ainda abre.

// Blocos exatamente como `serializeBlocks()` os grava hoje: sem `depth`, sem
// `quoted`, com `quote` ainda sendo um tipo.
export const BLOCOS_V18 = [
  {
    nome: 'nota de atendimento (o modelo semeado)',
    blocks: [
      { id: 'b1',  type: 'heading1',  html: 'Atendimento — Maria Silva' },
      { id: 'b2',  type: 'paragraph', html: '<strong>Nome:</strong> Maria Silva' },
      { id: 'b3',  type: 'paragraph', html: '<strong>CPF:</strong> 529.982.247-25' },
      { id: 'b4',  type: 'paragraph', html: '' },
      { id: 'b5',  type: 'heading2',  html: 'Validações' },
      { id: 'b6',  type: 'checklist', html: 'Conferir elegibilidade no portal', checked: true },
      { id: 'b7',  type: 'checklist', html: 'Documentação completa e legível', checked: false },
      { id: 'b8',  type: 'bullet',    html: 'Protocolo aberto em 12/03/2025' },
      { id: 'b9',  type: 'number',    html: 'Primeiro contato' },
      { id: 'b10', type: 'number',    html: 'Retorno em 5 dias' },
      { id: 'b11', type: 'divider' },
      { id: 'b12', type: 'quote',     html: 'Cliente pediu retorno por e-mail.' },
    ],
  },
  {
    nome: 'formatação inline de todos os tipos',
    blocks: [
      { id: 'c1', type: 'paragraph', html: 'Texto com <strong>negrito</strong>, <em>itálico</em>, <s>riscado</s> e <code>código</code>.' },
      { id: 'c2', type: 'paragraph', html: 'Link para <a href="https://exemplo.com/a?b=1&amp;c=2">a documentação</a>.' },
      { id: 'c3', type: 'code',      html: 'const a = 1;<br>const b = 2;' },
      { id: 'c4', type: 'paragraph', html: 'E-mail: contato@exemplo.com.br' },
    ],
  },
  {
    nome: 'tabela',
    blocks: [
      { id: 'd1', type: 'heading3', html: 'Comparativo' },
      { id: 'd2', type: 'table', rows: [
        ['Produto', 'Preço', 'Estoque'],
        ['Cadeira', 'R$ 249,90', '12'],
        ['Mesa <strong>grande</strong>', 'R$ 1.180,00', '3'],
      ] },
      { id: 'd3', type: 'paragraph', html: 'Valores de março.' },
    ],
  },
  {
    nome: 'caracteres que precisam de escape',
    blocks: [
      { id: 'e1', type: 'paragraph', html: 'Comparação: 5 &lt; 10 &amp;&amp; 10 &gt; 5' },
      { id: 'e2', type: 'paragraph', html: 'Aspas &quot;duplas&quot; e cifrão $ 100' },
      { id: 'e3', type: 'table', rows: [['Coluna | com barra', 'ok'], ['a', 'b']] },
    ],
  },
  {
    nome: 'nota vazia',
    blocks: [
      { id: 'f1', type: 'paragraph', html: '' },
    ],
  },
];

// Markdown que chega de fora: importação de .md, colagem, modelo compartilhado.
export const MARKDOWN = [
  {
    nome: 'markdown básico completo',
    md: [
      '# Título',
      '',
      'Parágrafo com **negrito** e *itálico*.',
      '',
      '## Subtítulo',
      '',
      '- item um',
      '- item dois',
      '',
      '1. primeiro',
      '2. segundo',
      '',
      '- [ ] tarefa aberta',
      '- [x] tarefa feita',
      '',
      '> uma citação',
      '',
      '---',
      '',
      'Fim.',
    ].join('\n'),
  },
  {
    nome: 'tabela GFM',
    md: [
      '| Produto | Preço |',
      '| --- | --- |',
      '| Cadeira | R$ 249,90 |',
      '| Mesa | R$ 1.180,00 |',
    ].join('\n'),
  },
  {
    nome: 'link e código inline',
    md: 'Veja [a documentação](https://exemplo.com/docs) e rode `npm test`.',
  },
  {
    nome: 'lista aninhada com 2 espaços',
    md: [
      '- fruta',
      '  - maçã',
      '    - fuji',
      '  - pera',
      '- legume',
    ].join('\n'),
  },
  {
    nome: 'numerada aninhada com linha em branco no meio',
    md: [
      '1. abrir o protocolo',
      '  1. anexar o relatório',
      '',
      '  2. conferir o prazo',
      '2. registrar o retorno',
    ].join('\n'),
  },
];

// Mesma escada escrita de jeitos diferentes — todas têm que virar a mesma
// sequência de níveis, senão o arquivo de cada editor produziria um resultado
// diferente pro mesmo conteúdo.
export const INDENTACOES = [
  { nome: '2 espaços', md: ['- a', '  - b', '    - c'].join('\n') },
  { nome: '4 espaços', md: ['- a', '    - b', '        - c'].join('\n') },
  { nome: 'tab',       md: ['- a', '\t- b', '\t\t- c'].join('\n') },
  { nome: '3 espaços', md: ['- a', '   - b', '      - c'].join('\n') },
];

// A citação que não funcionava: título e lista DENTRO dela. É o caso que
// motivou tratar citação como decoração em vez de tipo de bloco.
export const CITACAO_COM_FILHOS = [
  '> #### Os resultados do trimestre ficaram ótimos!',
  '>',
  '> - A receita saiu da curva.',
  '> - O lucro foi o maior de todos.',
  '>',
  '>  *Tudo* está indo conforme o **plano**.',
].join('\n');

// Entradas hostis: nenhuma pode virar HTML executável nem derrubar o parser.
export const HOSTIS = [
  '[clique](javascript:alert(1))',
  '[clique](JaVaScRiPt:alert(1))',
  '[clique](data:text/html,<script>alert(1)</script>)',
  '<img src=x onerror="alert(1)">',
  '<script>alert(1)</script>',
  '[ok](https://exemplo.com) e [ruim](vbscript:msgbox(1))',
];
