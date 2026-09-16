// ── active-area.js ─────────────────────────────────────────────────────────
// Qual das duas metades do painel a pessoa está usando: a nota ou os
// documentos.
//
// Existe porque o foco do navegador não responde a essa pergunta aqui. A
// seleção por arrasto dos documentos chama preventDefault no mousedown — é o
// que impede o navegador de sair selecionando texto no meio do gesto —, e um
// mousedown cancelado NÃO tira o foco de onde ele estava. Ou seja: clicar na
// área de documentos deixa o editor de notas ainda focado, e o Ctrl+V seguinte
// era entregue à nota, que colava a imagem no meio do texto.
//
// Quem decide, então, é o último clique — que é a intenção declarada, e não um
// resto de estado do navegador.

let area = 'note';   // 'note' | 'docs'

export function setActiveArea(nova) {
  if (nova === 'note' || nova === 'docs') area = nova;
}

export function isNoteActive() { return area === 'note'; }
