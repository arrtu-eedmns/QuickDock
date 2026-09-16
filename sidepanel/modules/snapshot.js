// ── snapshot.js ────────────────────────────────────────────────────────────
// Transforma blocos da nota numa imagem PNG, pra copiar ou baixar e mandar
// pra alguém.
//
// Como funciona: os blocos são clonados, embrulhados num <foreignObject> de
// SVG junto com o CSS do painel, e desenhados num <canvas>. É o jeito de
// "fotografar" HTML sem trazer biblioteca de fora.
//
// A regra que rege tudo aqui: **nada pode depender de algo externo**. Nenhum
// endereço de rede, nenhum blob:. Se sobrar uma referência externa, o
// navegador marca o canvas como contaminado e simplesmente se recusa a
// devolver a imagem — sem erro nenhum que explique o motivo.

import { loadFileBlob } from './storage.js';

const ESCALA = 2;     // imagem em 2x: continua nítida quando a pessoa amplia
const MARGEM = 22;    // respiro em volta do texto, pra não colar na borda

// As variáveis de tema moram no :root do painel. Dentro do foreignObject não
// existe :root, então elas vão copiadas como estilo inline no embrulho.
const VARIAVEIS = [
  '--bg', '--bg-secondary', '--bg-hover', '--border', '--text', '--text-muted',
  '--accent', '--radius', '--radius-sm', '--font', '--font-mono', '--note-accent',
];

// Ajustes que só valem dentro da imagem.
const CSS_DA_IMAGEM = `
  .snapshot-wrap > style { display: none; }
  /* Sem rolagem e sem altura elástica: a imagem tem que mostrar tudo. */
  .snapshot-blocks { overflow: visible; height: auto; flex: none; padding: 0; }
  /* A caixa de seleção vira símbolo desenhado (ver trocarCheckboxes). */
  .snapshot-check { color: var(--note-accent, var(--accent)); font-size: 14px; line-height: 1.2; }
`;

let cssCache = null;

// Junta o CSS do painel inteiro. A folha do Google Fonts é de outro domínio e
// lançar exceção ao ler as regras dela é o esperado — os ícones daquela fonte
// não aparecem dentro de um bloco, então não fazem falta aqui.
function cssDoPainel() {
  if (cssCache !== null) return cssCache;
  let css = '';
  for (const folha of document.styleSheets) {
    try {
      for (const regra of folha.cssRules) css += `${regra.cssText}\n`;
    } catch {
      /* folha de outro domínio — segue o baile */
    }
  }
  cssCache = css + CSS_DA_IMAGEM;
  return cssCache;
}

function blobParaDataUrl(blob) {
  return new Promise(resolve => {
    const leitor = new FileReader();
    leitor.onload  = () => resolve(leitor.result);
    leitor.onerror = () => resolve(null);
    leitor.readAsDataURL(blob);
  });
}

// As imagens da nota são exibidas por blob:, que não sobrevive dentro do SVG.
// Cada uma vira base64 antes de entrar.
async function embutirImagens(clone) {
  for (const img of clone.querySelectorAll('img')) {
    const fileId = Number(img.closest('.block-image')?.dataset.fileId);
    const blob = Number.isFinite(fileId) ? await loadFileBlob(fileId) : null;
    const dataUrl = blob ? await blobParaDataUrl(blob) : null;
    if (dataUrl) img.setAttribute('src', dataUrl);
    else img.remove();       // sem o arquivo, melhor o espaço vazio que o ícone de quebrado
  }
}

// Controle de formulário não renderiza dentro de um SVG usado como imagem, e
// uma checklist sem as caixinhas não é uma checklist. Vira símbolo.
function trocarCheckboxes(clone) {
  for (const marcador of clone.querySelectorAll('.cb-wrap')) {
    const marcado = marcador.closest('.block')?.dataset.checked === 'true';
    const span = document.createElement('span');
    span.className = 'block-marker snapshot-check';
    span.textContent = marcado ? '☑' : '☐';
    marcador.replaceWith(span);
  }
}

// Tira da imagem tudo que é controle da interface e não conteúdo da nota.
function limparControles(clone) {
  clone.querySelectorAll('.table-tools, .image-tools, .block-controls').forEach(el => el.remove());
  clone.querySelectorAll('.block-selected, .block-dragging').forEach(el => {
    el.classList.remove('block-selected', 'block-dragging');
  });
  clone.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
}

/**
 * Monta o PNG dos blocos dados. Devolve null se não houver o que desenhar.
 * @param blocos elementos .block, na ordem em que aparecem na nota
 */
export async function blocksToPngBlob(blocos) {
  if (!blocos?.length) return null;

  const editor = blocos[0].parentElement;
  const estiloEditor = getComputedStyle(editor);
  const estiloRaiz   = getComputedStyle(document.documentElement);

  // A largura é a da área de texto do editor: assim as quebras de linha da
  // imagem são exatamente as que a pessoa está vendo na tela.
  const largura = Math.max(
    220,
    Math.round(editor.clientWidth
      - parseFloat(estiloEditor.paddingLeft)
      - parseFloat(estiloEditor.paddingRight)),
  );

  const corDeFundo = estiloEditor.backgroundColor === 'rgba(0, 0, 0, 0)'
    ? (estiloRaiz.getPropertyValue('--bg').trim() || '#ffffff')
    : estiloEditor.backgroundColor;

  // ── Monta a página da imagem ───────────────────────────────────────────────
  const embrulho = document.createElement('div');
  embrulho.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  embrulho.className = 'snapshot-wrap';

  const variaveis = VARIAVEIS
    .map(v => `${v}:${(estiloEditor.getPropertyValue(v) || estiloRaiz.getPropertyValue(v)).trim()}`)
    .filter(par => !par.endsWith(':'))
    .join(';');

  embrulho.style.cssText = [
    `width:${largura + MARGEM * 2}px`,
    `padding:${MARGEM}px`,
    `background:${corDeFundo}`,
    'box-sizing:border-box',
    variaveis,
  ].join(';');

  const estilo = document.createElement('style');
  estilo.textContent = cssDoPainel();
  embrulho.appendChild(estilo);

  const caixa = document.createElement('div');
  caixa.className = 'note-editor-blocks snapshot-blocks';
  caixa.style.cssText = `width:${largura}px`;
  for (const b of blocos) caixa.appendChild(b.cloneNode(true));
  embrulho.appendChild(caixa);

  limparControles(embrulho);
  trocarCheckboxes(embrulho);
  await embutirImagens(embrulho);

  // ── Mede fora da vista ─────────────────────────────────────────────────────
  embrulho.style.position = 'fixed';
  embrulho.style.left = '-10000px';
  embrulho.style.top = '0';
  document.body.appendChild(embrulho);
  const altura = Math.ceil(embrulho.getBoundingClientRect().height);
  const larguraTotal = Math.ceil(embrulho.getBoundingClientRect().width);
  embrulho.remove();
  embrulho.style.position = '';
  embrulho.style.left = '';
  embrulho.style.top = '';

  if (!altura || !larguraTotal) return null;

  // ── Desenha ────────────────────────────────────────────────────────────────
  // O XMLSerializer é quem escapa "&" e "<" do CSS e do texto — por isso o
  // conteúdo é montado como DOM em vez de string concatenada.
  const markup = new XMLSerializer().serializeToString(embrulho);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${larguraTotal}" height="${altura}">`
            + `<foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject>`
            + '</svg>';

  const img = new Image();
  img.width  = larguraTotal;
  img.height = altura;
  await new Promise((resolve, reject) => {
    img.onload  = resolve;
    img.onerror = () => reject(new Error('não foi possível desenhar a imagem'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });

  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(larguraTotal * ESCALA);
  canvas.height = Math.round(altura * ESCALA);
  const ctx = canvas.getContext('2d');
  ctx.scale(ESCALA, ESCALA);
  // Pinta o fundo mesmo assim: se o embrulho ficar transparente por algum
  // motivo, um PNG sem fundo vira um borrão em qualquer conversa de fundo claro.
  ctx.fillStyle = corDeFundo;
  ctx.fillRect(0, 0, larguraTotal, altura);
  ctx.drawImage(img, 0, 0);

  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

export async function copyBlocksAsImage(blocos) {
  const blob = await blocksToPngBlob(blocos);
  if (!blob) return false;
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  return true;
}

export async function downloadBlocksAsImage(blocos, nome = 'nota') {
  const blob = await blocksToPngBlob(blocos);
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(nome || 'nota').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 40)}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}
