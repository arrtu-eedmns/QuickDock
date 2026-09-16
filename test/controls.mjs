// ── controls.mjs ───────────────────────────────────────────────────────────
// Os controles de bloco (+ e a alça ⠿) que aparecem ao passar o mouse.
//
// Mesma técnica do indent.mjs: recorta as funções do note.js e as roda contra
// retângulos de mentira. O que se testa aqui é geometria pura — qual bloco o
// cursor está apontando e onde os ícones param —, que é exatamente onde os
// erros ficam invisíveis até alguém colocar uma imagem na nota.

import { readFile } from 'node:fs/promises';

const fonte = (await readFile(new URL('../sidepanel/modules/note.js', import.meta.url), 'utf8'))
  .replace(/\r\n?/g, '\n');

function recorta(nome) {
  const inicio = fonte.indexOf(`\nfunction ${nome}(`);
  if (inicio === -1) throw new Error(`função ${nome}() não existe mais em note.js — atualize test/controls.mjs`);
  const fim = fonte.indexOf('\n}\n', inicio);
  return fonte.slice(inicio, fim + 3);
}

// Retângulo no formato que getBoundingClientRect devolve.
const rect = (top, height, left = 34, width = 300) => ({
  top, height, bottom: top + height, left, width, right: left + width,
});

function bloco(r, tipo = 'paragraph') {
  return { dataset: { type: tipo }, _rect: r, getBoundingClientRect: () => r };
}

export function rodarTestesDeControles(ok, igual) {
  let blocos = [];
  let blockControls;
  let viewRect, containerRect;

  // Os três objetos do DOM viram chamadas de função: o teste troca o
  // blockControls a cada cenário, então eles precisam ser lidos na hora, e
  // não capturados uma vez só quando o escopo é montado.
  const codigo = [recorta('blockNearestToY'), recorta('positionBlockControls')]
    .join('\n')
    .replace(/\bblockControls\b/g, 'getControls()')
    .replace(/\broot\b/g, 'getRoot()')
    .replace(/\bnoteEditorEl\b/g, 'getEditor()');

  const api = new Function(
    'getBlocos', 'getControls', 'getRoot', 'getEditor',
    `let hoveredBlock = null;
     const orderedBlocks = () => getBlocos();
     ${codigo}
     return { blockNearestToY, positionBlockControls };`,
  )(
    () => blocos,
    () => blockControls,
    () => ({ getBoundingClientRect: () => viewRect, contains: () => true }),
    () => ({ getBoundingClientRect: () => containerRect }),
  );

  // ── Qual bloco o cursor está apontando ─────────────────────────────────────
  // O caso que motivou a correção: um parágrafo curto, uma imagem alta, outro
  // parágrafo. Antes, a conta era pela distância até o MEIO de cada bloco —
  // e o meio de uma imagem de 190px fica longe do topo dela.
  {
    const p1  = bloco(rect(0, 21));
    const img = bloco(rect(21, 190), 'image');
    const p2  = bloco(rect(211, 21));
    blocos = [p1, img, p2];

    igual('controles · cursor no topo da imagem aponta a imagem',
      api.blockNearestToY(30) === img, true);
    igual('controles · cursor no meio da imagem aponta a imagem',
      api.blockNearestToY(120) === img, true);
    igual('controles · cursor no parágrafo de cima aponta o parágrafo',
      api.blockNearestToY(10) === p1, true);
    igual('controles · cursor no parágrafo de baixo aponta o parágrafo',
      api.blockNearestToY(220) === p2, true);

    // Fora de qualquer bloco: vale a borda mais próxima.
    igual('controles · acima de tudo cai no primeiro bloco',
      api.blockNearestToY(-80) === p1, true);
    igual('controles · abaixo de tudo cai no último bloco',
      api.blockNearestToY(900) === p2, true);

    // Arrastar pra reordenar exclui os blocos arrastados da conta.
    igual('controles · bloco excluído não é escolhido nem sob o cursor',
      api.blockNearestToY(120, [img]) === p1 || api.blockNearestToY(120, [img]) === p2, true);
  }

  // ── Onde os ícones param ───────────────────────────────────────────────────
  const posicionar = b => {
    blockControls = { hidden: true, style: {}, offsetWidth: 31, offsetHeight: 20 };
    api.positionBlockControls(b);
    return blockControls;
  };

  containerRect = rect(0, 400, 0, 380);
  viewRect      = rect(0, 300, 0, 380);

  // Sem indentação: os ícones terminam junto da primeira letra do bloco.
  {
    const c = posicionar(bloco(rect(40, 21, 34)));
    igual('controles · bloco no nível 0 fica na margem de sempre', c.style.left, '4px');
    igual('controles · e alinhado com a primeira linha', c.style.top, '40px');
  }

  // Indentado: os ícones acompanham. Com left fixo, um item aninhado ficava
  // com os ícones lá na margem, longe do bloco a que se referem.
  {
    igual('controles · nível 1 acompanha a indentação',
      posicionar(bloco(rect(40, 21, 52))).style.left, '22px');
    igual('controles · nível 3 acompanha a indentação',
      posicionar(bloco(rect(40, 21, 88))).style.left, '58px');
  }

  // Bloco alto com o topo já rolado pra cima: os ícones param na borda de
  // cima da área visível, em vez de subirem por cima da barra de abas.
  {
    const c = posicionar(bloco(rect(-120, 190, 34), 'image'));
    igual('controles · topo fora da vista fica preso na borda visível', c.style.top, '0px');
    igual('controles · e continuam visíveis', c.hidden, false);
  }

  // Bloco todo fora da vista: escondido, em vez de apontar pra nada.
  {
    igual('controles · bloco acima da vista some',
      posicionar(bloco(rect(-400, 190, 34), 'image')).hidden, true);
    igual('controles · bloco abaixo da vista some',
      posicionar(bloco(rect(700, 190, 34), 'image')).hidden, true);
  }

  // Bloco alto começando perto do fim da área visível: os ícones não podem
  // passar da borda de baixo.
  {
    const c = posicionar(bloco(rect(295, 190, 34), 'image'));
    ok('controles · não passam da borda de baixo',
       Number.parseFloat(c.style.top) <= 300 - 20, `top: ${c.style.top}`);
  }
}
