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
  // Âncora passou a ser aceita — o que vem depois do "#" é um apelido de
  // título, nunca um esquema de endereço.
  '[clique](#javascript:alert(1))',
  '[clique](# javascript:alert(1))',
];

// ── Blocos recentes (v1.9 e v2.0): imagem, cálculo, destaque, setext ─────────
// Fecham o buraco da medição apontado no HANDOFF: até a v1.8 nenhum desses
// tipos existia nas fixtures, e sem testes de round-trip neles qualquer
// corrosão silenciosa passaria despercebida na sincronização.
export const BLOCOS_NOVOS = [
  {
    nome: 'imagem com fileId e texto alternativo',
    blocks: [
      { id: 'img1', type: 'image', fileId: 42, alt: 'Fachada do prédio em reforma' },
    ],
  },
  {
    nome: 'imagem com dataUrl (formato de importação)',
    blocks: [
      { id: 'img2', type: 'image', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', alt: 'print colado de fora' },
    ],
  },
  {
    nome: 'corrida de cálculo com atribuição, referência e texto puro',
    blocks: [
      { id: 'k1', type: 'calc', html: 'boleto = R$ 1.000,00' },
      { id: 'k2', type: 'calc', html: 'imposto = 15%' },
      { id: 'k3', type: 'calc', html: 'calculo = boleto - imposto' },
      { id: 'k4', type: 'calc', html: 'conferido com o financeiro' },
    ],
  },
  {
    nome: 'destaques (callouts) de todos os tipos com corrida',
    blocks: [
      { id: 'c_note1', type: 'paragraph', html: 'Primeiro aviso informativo.', quoted: true, callout: 'note' },
      { id: 'c_note2', type: 'bullet',    html: 'Segundo ponto dentro do mesmo aviso.', quoted: true, callout: 'note' },
      { id: 'c_tip',   type: 'paragraph', html: 'Dica de produtividade.', quoted: true, callout: 'tip' },
      { id: 'c_imp',   type: 'paragraph', html: 'Informação indispensável.', quoted: true, callout: 'important' },
      { id: 'c_warn',  type: 'paragraph', html: 'Cuidado com a data limite.', quoted: true, callout: 'warning' },
      { id: 'c_caut',  type: 'paragraph', html: 'Risco de exclusão de dados.', quoted: true, callout: 'caution' },
    ],
  },
  {
    nome: 'títulos sublinhados (heading1 e heading2 setext)',
    blocks: [
      { id: 'u1', type: 'heading1', html: 'Título 1 Sublinhado', underlined: true },
      { id: 'u2', type: 'heading2', html: 'Título 2 Sublinhado', underlined: true },
    ],
  },
  {
    nome: 'combinação: destaque (callout) com profundidade (depth)',
    blocks: [
      { id: 'cd1', type: 'paragraph', html: 'Item no nível 1 do aviso', depth: 1, quoted: true, callout: 'note' },
      { id: 'cd2', type: 'bullet',    html: 'Subitem aninhado no nível 2', depth: 2, quoted: true, callout: 'note' },
    ],
  },
  {
    nome: 'combinação: imagem dentro de citação',
    blocks: [
      { id: 'iq1', type: 'image', fileId: 88, alt: 'Esquema arquitetural citado', quoted: true },
    ],
  },
  {
    nome: 'combinação: folha de cálculo dentro de citação',
    blocks: [
      { id: 'cq1', type: 'calc', html: 'subtotal = R$ 500,00', quoted: true },
      { id: 'cq2', type: 'calc', html: 'desconto = 10%', quoted: true },
      { id: 'cq3', type: 'calc', html: 'total = subtotal - desconto', quoted: true },
    ],
  },
  {
    nome: 'combinação: tabela dentro de citação',
    blocks: [
      { id: 'tq1', type: 'table', rows: [['Chave', 'Valor'], ['token', '123']], quoted: true },
    ],
  },
  {
    nome: 'combinação: bloco de código dentro de citação',
    blocks: [
      { id: 'codeq1', type: 'code', html: 'const porta = 3000;<br>server.listen(porta);', quoted: true },
    ],
  },
];

