// ── indent.mjs ─────────────────────────────────────────────────────────────
// Testa a indentação do editor (Tab / Shift+Tab) fora do navegador.
//
// A lógica de profundidade mora em note.js, que não dá pra importar aqui: o
// módulo inteiro toca `document` no topo, monta menus e prende eventos. Então
// o que se faz é recortar do arquivo as funções que interessam e rodá-las
// contra uma lista de blocos de mentira.
//
// É um recorte por nome, e isso é de propósito: se alguém renomear uma dessas
// funções, o teste quebra alto em vez de continuar testando uma cópia velha.

import { readFile } from 'node:fs/promises';
import { MAX_DEPTH, BULLET_GLYPHS } from '../sidepanel/modules/blocks.js';
import { evaluateSheet } from '../sidepanel/modules/calc.js';

const FUNCOES = [
  'blockDepth', 'setBlockDepth', 'normalizeDepths', 'markCalloutEdges',
  'recalcCalcSheets', 'indentBlocks', 'renumberLists',
];

// Normaliza CRLF: o arquivo é editado no Windows e o recorte procura por
// "\n}\n" no início da coluna.
const fonte = (await readFile(new URL('../sidepanel/modules/note.js', import.meta.url), 'utf8'))
  .replace(/\r\n?/g, '\n');

function recorta(nome) {
  const inicio = fonte.indexOf(`\nfunction ${nome}(`);
  if (inicio === -1) throw new Error(`função ${nome}() não existe mais em note.js — atualize test/indent.mjs`);
  const fim = fonte.indexOf('\n}\n', inicio);
  return fonte.slice(inicio, fim + 3);
}

// ── Bloco de mentira: só o que as funções recortadas encostam ────────────────
class FakeBlock {
  constructor(type, depth = 0, lista = null) {
    this.dataset = { type, id: `id${FakeBlock.n++}` };
    if (depth) this.dataset.depth = String(depth);
    this.marker = (type === 'bullet' || type === 'number') ? { textContent: '' } : null;
    this.resultado = type === 'calc' ? { textContent: '' } : null;
    this.conteudo  = { textContent: '' };
    this.lista = lista;
  }
  querySelector(sel) {
    if (sel.includes('calc-result')) return this.resultado;
    return sel.includes('block-marker') ? this.marker : null;
  }
  get _i() { return this.lista.indexOf(this); }
  get previousElementSibling() { return this.lista[this._i - 1] ?? null; }
  get nextElementSibling()     { return this.lista[this._i + 1] ?? null; }
}
FakeBlock.n = 0;

function montar(spec) {
  const lista = [];
  for (const [type, depth] of spec) lista.push(new FakeBlock(type, depth, lista));
  return lista;
}

// `root` e a seleção múltipla são o contexto que as funções recortadas esperam.
let root = { children: [] };
const selectedBlockIds = new Set();
const orderedBlocks = () => [...root.children];
const currentBlock = () => null;

const escopo = FUNCOES.map(recorta).join('\n');
const carregar = new Function(
  'MAX_DEPTH', 'BULLET_GLYPHS', 'getRoot', 'selectedBlockIds', 'orderedBlocks', 'currentBlock',
  'evaluateSheet', 'getContentEl',
  `${escopo.replace(/\broot\.children\b/g, 'getRoot().children')}
   return { ${FUNCOES.join(', ')} };`,
);
const api = carregar(
  MAX_DEPTH, BULLET_GLYPHS, () => root, selectedBlockIds, orderedBlocks, currentBlock,
  evaluateSheet, bloco => bloco.conteudo,
);

// ── Casos ────────────────────────────────────────────────────────────────────
export function rodarTestesDeIndentacao(ok, igual) {
  const niveis = lista => lista.map(b => Number(b.dataset.depth) || 0);

  const cenario = spec => {
    const lista = montar(spec);
    root = { children: lista };
    return lista;
  };

  // Tab indenta no máximo um nível abaixo do bloco anterior.
  {
    const l = cenario([['bullet', 0], ['bullet', 0], ['bullet', 0]]);
    api.indentBlocks([l[1]], 1);
    igual('indent · Tab desce um nível', niveis(l), [0, 1, 0]);

    api.indentBlocks([l[1]], 1);
    igual('indent · Tab de novo não cria degrau faltando', niveis(l), [0, 1, 0]);
  }

  // O primeiro bloco nunca indenta: não há pai possível.
  {
    const l = cenario([['bullet', 0], ['bullet', 0]]);
    ok('indent · primeiro bloco não indenta', api.indentBlocks([l[0]], 1) === false);
    igual('indent · e continua no nível 0', niveis(l), [0, 0]);
  }

  // Um bloco que já está um nível abaixo do anterior não desce mais: descer
  // criaria um degrau faltando na escada.
  {
    const l = cenario([['bullet', 0], ['bullet', 1], ['bullet', 2]]);
    ok('indent · não pula degrau', api.indentBlocks([l[1]], 1) === false);
    igual('indent · escada intacta', niveis(l), [0, 1, 2]);
  }

  // Indentar um pai leva os filhos junto — senão eles ficariam órfãos.
  {
    const l = cenario([['bullet', 0], ['bullet', 0], ['bullet', 1], ['bullet', 2], ['bullet', 0]]);
    api.indentBlocks([l[1]], 1);
    igual('indent · filhos acompanham o pai', niveis(l), [0, 1, 2, 3, 0]);

    api.indentBlocks([l[1]], -1);
    igual('indent · e voltam junto no Shift+Tab', niveis(l), [0, 0, 1, 2, 0]);
  }

  // Shift+Tab no nível 0 não faz nada (quem trata é o Enter/Backspace).
  {
    const l = cenario([['bullet', 0], ['bullet', 0]]);
    ok('indent · Shift+Tab no nível 0 não muda nada', api.indentBlocks([l[1]], -1) === false);
  }

  // Teto de níveis.
  {
    const spec = Array.from({ length: MAX_DEPTH + 3 }, (_, i) => ['bullet', Math.min(i, MAX_DEPTH)]);
    const l = cenario(spec);
    api.indentBlocks([l[l.length - 1]], 1);
    ok('indent · não passa do teto', Math.max(...niveis(l)) === MAX_DEPTH);
  }

  // Escada inválida (bloco arrastado pro topo) é fechada.
  {
    const l = cenario([['bullet', 3], ['bullet', 5], ['bullet', 1]]);
    api.normalizeDepths();
    igual('indent · escada sem pai é fechada', niveis(l), [0, 1, 1]);
  }

  // Seleção múltipla move em bloco, sem duplicar quem já é filho de outro —
  // se o filho fosse movido duas vezes, ele desceria dois níveis de uma vez.
  {
    const l = cenario([['bullet', 0], ['bullet', 0], ['bullet', 1], ['bullet', 0]]);
    api.indentBlocks([l[1], l[2]], 1);
    igual('indent · seleção com pai e filho move uma vez só', niveis(l), [0, 1, 2, 0]);
  }

  // ── Grupo indentado inteiro selecionado ────────────────────────────────────
  // O caso que estava travado: o primeiro bloco do grupo já está na margem e
  // não tem pra onde subir. Ele não pode congelar os outros — cada bloco
  // selecionado responde por si, e o grupo sobe um nível por vez até achatar.
  {
    const l = cenario([['checklist', 0], ['checklist', 1], ['checklist', 2], ['checklist', 2]]);
    const todos = [...l];

    ok('indent · Shift+Tab num grupo indentado faz alguma coisa',
       api.indentBlocks(todos, -1) === true);
    igual('indent · o grupo sobe um nível de cada vez', niveis(l), [0, 0, 1, 1]);

    api.indentBlocks(todos, -1);
    igual('indent · e de novo até achatar', niveis(l), [0, 0, 0, 0]);

    ok('indent · achatado, Shift+Tab para de fazer efeito',
       api.indentBlocks(todos, -1) === false);
  }

  // Descer o grupo inteiro preserva a escada em vez de achatá-la.
  {
    const l = cenario([['bullet', 0], ['bullet', 0], ['bullet', 1], ['bullet', 2]]);
    api.indentBlocks([l[1], l[2], l[3]], 1);
    igual('indent · Tab no grupo inteiro preserva a escada', niveis(l), [0, 1, 2, 3]);
  }

  // Sem um bloco antes pra servir de pai, o grupo não tem como descer.
  {
    const l = cenario([['bullet', 0], ['bullet', 1], ['bullet', 2]]);
    ok('indent · grupo no topo da nota não desce', api.indentBlocks([...l], 1) === false);
    igual('indent · e fica como estava', niveis(l), [0, 1, 2]);
  }

  // Filho não selecionado continua sendo passageiro do pai selecionado.
  {
    const l = cenario([['bullet', 0], ['bullet', 1], ['bullet', 2], ['bullet', 0]]);
    api.indentBlocks([l[1]], -1);
    igual('indent · filho fora da seleção acompanha o pai', niveis(l), [0, 0, 1, 0]);
  }

  // ── Numeração por nível ────────────────────────────────────────────────────
  {
    const l = cenario([
      ['number', 0], ['number', 1], ['number', 1], ['number', 0], ['number', 1],
    ]);
    api.renumberLists();
    igual('numeração · reinicia a cada nível',
      l.map(b => b.marker.textContent), ['1.', '1.', '2.', '2.', '1.']);
  }

  {
    // Um bullet no meio quebra a contagem dali pra dentro, mas não a de fora.
    const l = cenario([['number', 0], ['bullet', 1], ['number', 0]]);
    api.renumberLists();
    igual('numeração · bloco de outro tipo não zera o nível de fora',
      [l[0].marker.textContent, l[2].marker.textContent], ['1.', '2.']);
  }

  {
    const l = cenario([['bullet', 0], ['bullet', 1], ['bullet', 2], ['bullet', 3]]);
    api.renumberLists();
    igual('numeração · marcador de bullet muda por nível',
      l.map(b => b.marker.textContent),
      [0, 1, 2, 3].map(d => BULLET_GLYPHS[d % BULLET_GLYPHS.length]));
  }
}
