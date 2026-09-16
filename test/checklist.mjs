// ── checklist.mjs ──────────────────────────────────────────────────────────
// Propagação entre checklists aninhadas: marcar todos os filhos marca o pai,
// e marcar o pai marca os filhos.
//
// Mesma técnica do indent.mjs e do controls.mjs: recorta as funções do note.js
// e as roda contra blocos de mentira. A regra mais importante testada aqui é a
// última — abrir uma nota não pode mudar o que está escrito nela.

import { readFile } from 'node:fs/promises';
import { MAX_DEPTH } from '../sidepanel/modules/blocks.js';

const fonte = (await readFile(new URL('../sidepanel/modules/note.js', import.meta.url), 'utf8'))
  .replace(/\r\n?/g, '\n');

const FUNCOES = [
  'blockDepth', 'checkboxDe', 'checklistFilhos', 'checklistPai',
  'marcarChecklist', 'propagarParaBaixo', 'propagarParaCima', 'refreshChecklistStates',
];

function recorta(nome) {
  const inicio = fonte.indexOf(`\nfunction ${nome}(`);
  if (inicio === -1) throw new Error(`função ${nome}() não existe mais em note.js — atualize test/checklist.mjs`);
  const fim = fonte.indexOf('\n}\n', inicio);
  return fonte.slice(inicio, fim + 3);
}

class FakeBlock {
  constructor(tipo, depth, checked, lista) {
    this.dataset = { type: tipo };
    if (depth) this.dataset.depth = String(depth);
    if (tipo === 'checklist') {
      this.dataset.checked = checked ? 'true' : 'false';
      this.cb = { checked: !!checked, indeterminate: false };
    }
    this.lista = lista;
  }
  querySelector(sel) { return sel.includes('checkbox') ? (this.cb ?? null) : null; }
  get _i() { return this.lista.indexOf(this); }
  get previousElementSibling() { return this.lista[this._i - 1] ?? null; }
  get nextElementSibling()     { return this.lista[this._i + 1] ?? null; }
}

let root = { children: [] };

const api = new Function(
  'MAX_DEPTH', 'getRoot',
  `${FUNCOES.map(recorta).join('\n').replace(/\broot\.children\b/g, 'getRoot().children')}
   return { ${FUNCOES.join(', ')} };`,
)(MAX_DEPTH, () => root);

export function rodarTestesDeChecklist(ok, igual) {
  // spec: [tipo, nível, marcado]
  const cenario = spec => {
    const lista = [];
    for (const [tipo, depth, checked] of spec) lista.push(new FakeBlock(tipo, depth, checked, lista));
    root = { children: lista };
    return lista;
  };

  const estados = lista => lista.map(b =>
    b.cb ? (b.cb.indeterminate ? '~' : (b.dataset.checked === 'true' ? 'x' : ' ')) : '·');

  const clicar = (block, valor) => {
    block.cb.checked = valor;
    api.marcarChecklist(block, valor);
    api.propagarParaBaixo(block, valor);
    api.propagarParaCima(block);
  };

  // Marcar o último filro que faltava completa o pai.
  {
    const l = cenario([
      ['checklist', 0, false],
      ['checklist', 1, true],
      ['checklist', 1, false],
    ]);
    clicar(l[2], true);
    igual('checklist · completar os filhos marca o pai', estados(l), ['x', 'x', 'x']);
  }

  // Desmarcar um filho tira o pai do completo e deixa meio marcado.
  {
    const l = cenario([
      ['checklist', 0, true],
      ['checklist', 1, true],
      ['checklist', 1, true],
    ]);
    clicar(l[2], false);
    igual('checklist · desmarcar um filho deixa o pai meio marcado', estados(l), ['~', 'x', ' ']);
  }

  // Marcar o pai desce por todos os níveis.
  {
    const l = cenario([
      ['checklist', 0, false],
      ['checklist', 1, false],
      ['checklist', 2, false],
      ['checklist', 2, false],
      ['checklist', 1, false],
    ]);
    clicar(l[0], true);
    igual('checklist · marcar o pai marca tudo que está dentro', estados(l), ['x', 'x', 'x', 'x', 'x']);

    clicar(l[0], false);
    igual('checklist · e desmarcar também', estados(l), [' ', ' ', ' ', ' ', ' ']);
  }

  // Três níveis: completar o mais fundo sobe até o topo.
  {
    const l = cenario([
      ['checklist', 0, false],
      ['checklist', 1, false],
      ['checklist', 2, true],
      ['checklist', 2, false],
    ]);
    clicar(l[3], true);
    igual('checklist · a propagação sobe mais de um nível', estados(l), ['x', 'x', 'x', 'x']);
  }

  // Um filho meio marcado não deixa o avô completo.
  {
    const l = cenario([
      ['checklist', 0, false],
      ['checklist', 1, false],
      ['checklist', 2, false],
      ['checklist', 2, false],
    ]);
    clicar(l[2], true);
    igual('checklist · filho meio marcado não completa o avô', estados(l), ['~', '~', 'x', ' ']);
  }

  // Bloco de outro tipo no meio não quebra a relação pai/filho.
  {
    const l = cenario([
      ['checklist', 0, false],
      ['paragraph', 1, false],
      ['checklist', 1, false],
    ]);
    clicar(l[2], true);
    igual('checklist · parágrafo aninhado no meio é ignorado', estados(l), ['x', '·', 'x']);
  }

  // Item sem filhos nunca fica meio marcado.
  {
    const l = cenario([['checklist', 0, false], ['checklist', 0, false]]);
    clicar(l[0], true);
    igual('checklist · item sem filhos não fica meio marcado', estados(l), ['x', ' ']);
  }

  // Item de outro ramo não é afetado.
  {
    const l = cenario([
      ['checklist', 0, false],
      ['checklist', 1, false],
      ['checklist', 0, false],
      ['checklist', 1, false],
    ]);
    clicar(l[1], true);
    igual('checklist · o ramo vizinho não é tocado', estados(l), ['x', 'x', ' ', ' ']);
  }

  // ── A regra que mais importa ───────────────────────────────────────────────
  // Abrir a nota recalcula só o "meio marcado", que é estado de tela. Nenhum
  // marcado/desmarcado gravado pode mudar por causa de uma abertura.
  {
    const l = cenario([
      ['checklist', 0, false],
      ['checklist', 1, true],
      ['checklist', 1, false],
      ['checklist', 0, false],   // sem filhos
      ['checklist', 0, true],
    ]);
    const gravadoAntes = l.map(b => b.dataset.checked);
    api.refreshChecklistStates();

    igual('checklist · abrir a nota não altera nada do que está gravado',
      l.map(b => b.dataset.checked), gravadoAntes);
    igual('checklist · mas o meio marcado é recalculado na abertura',
      l.map(b => b.cb.indeterminate), [true, false, false, false, false]);
  }
}
