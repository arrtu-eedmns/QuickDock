import {
  loadAllNotesMeta, createNoteRecord, updateNoteMetaById, deleteNoteRecordById,
  reorderNoteRecords, migrateLegacyNoteIfNeeded, loadActiveNoteId, saveActiveNoteId,
  getNoteById, detachFilesFromNote, updateNoteBlocksById,
} from './storage.js';
import { setDocumentsNote, refreshDocuments } from './documents.js';
import { positionPopover } from './popover.js';
import { initTemplates, getTemplates, openTemplatesManager } from './templates.js';
import { switchToNote, flushSave, getCurrentBlocks, clearCurrentNote } from './note.js';
import { blocksToMarkdown, blocksToPlainText, parseMarkdownToBlocks } from './blocks.js';

const tabsEl        = document.getElementById('notes-tabs');
const btnNew        = document.getElementById('btn-new-note');
const btnNotesList  = document.getElementById('btn-notes-list');
const importInput   = document.getElementById('note-import-input');
const noteEditorEl  = document.querySelector('.note-editor');

// A tira de abas só rola na horizontal, mas a roda do mouse manda scroll
// vertical por padrão (só vira horizontal segurando Shift) — aqui a gente
// já converte deltaY em scrollLeft direto, sem precisar da tecla.
tabsEl.addEventListener('wheel', e => {
  if (e.deltaY === 0) return;
  e.preventDefault();
  tabsEl.scrollLeft += e.deltaY;
}, { passive: false });

// As 7 cores do arco-íris, na ordem — "Nenhuma" fica à parte, sempre primeiro
// na lista do popover.
const COLORS = [
  { name: 'Vermelho', hex: '#ef4444' },
  { name: 'Laranja',  hex: '#f97316' },
  { name: 'Amarelo',  hex: '#eab308' },
  { name: 'Verde',    hex: '#22c55e' },
  { name: 'Azul',     hex: '#3b82f6' },
  { name: 'Anil',     hex: '#6366f1' },
  { name: 'Violeta',  hex: '#a855f7' },
];

// Ícones comuns (Material Symbols) — qualquer outro nome do catálogo
// (fonts.google.com/icons) também funciona via o campo de texto livre.
// Onze: com o "nenhum" na frente fecham duas fileiras de seis na grade.
const COMMON_ICONS = [
  'note', 'edit_note', 'checklist', 'star', 'flag', 'bookmark',
  'folder', 'lightbulb', 'push_pin', 'label', 'event',
];

// ── Nota-tutorial ──────────────────────────────────────────────────────────
// Texto em markdown puro — vira blocos de verdade (títulos, listas, citação,
// checklist, divisores, negrito/itálico/riscado) pelo mesmo parser usado na
// importação de arquivo .md. Sem crase nenhuma aqui de propósito: qualquer
// crase no meio do texto seria interpretada como código em linha pelo
// próprio parser, então os exemplos de sintaxe são descritos por extenso.
const TUTORIAL_MARKDOWN = `# Bem-vindo ao QuickDock 👋

Esta nota foi criada automaticamente pra te mostrar como usar cada parte do QuickDock. Pode editar ou apagar à vontade — sempre que quiser vê-la de novo, abra o menu ⋯ no fim da barra de abas e escolha "Ver tutorial".

## Formatação de texto

- Colocar **duplo asterisco** dos dois lados vira **negrito**
- Colocar *um asterisco* de cada lado vira *itálico*
- Colocar ~~til duplo~~ dos dois lados vira ~~riscado~~
- Colocar o texto entre um par de crases vira código em linha

Tudo junto, numa linha de verdade:

**Protocolo 88123** — reembolso *em análise*, prazo ~~15/09~~ 22/09.

## Links

Selecione um texto e aperte Ctrl+K pra transformar em link. Com o cursor dentro de um link já existente, Ctrl+K reabre o menu pra trocar o endereço ou remover.

Colar uma URL também funciona: sem nada selecionado ela entra como link, e com texto selecionado o endereço envolve a seleção.

Pra abrir um link, segure Ctrl e clique — o mesmo gesto da detecção inteligente. Clique normal só posiciona o cursor, senão não daria pra editar o texto. Experimente neste: [catálogo de ícones do Google](https://fonts.google.com/icons)

Na prática, serve pra deixar o caminho de volta salvo junto do caso: o portal da operadora, o formulário que você sempre preenche, a consulta do protocolo.

## Tipos de bloco

Digite uma barra "/" no começo de uma linha vazia pra abrir o menu e escolher o tipo de bloco. Ou use os atalhos abaixo, digitando o símbolo seguido de espaço no início da linha:

- Cerquilha (#), repetida até seis vezes, + espaço → Título 1 a Título 6
- Hífen ou asterisco + espaço → lista com marcadores
- "1." + espaço → lista numerada
- Hífen, espaço e colchetes "[ ]" → checklist
- Maior-que (>) + espaço → citação
- Três hífens sozinhos na linha → divisor
- Três crases sozinhas na linha → bloco de código

### Exemplos ao vivo

Citação — boa pra guardar a fala de alguém sem misturar com a sua anotação:

> A beneficiária afirma que enviou a documentação em 02/09. Conferir no protocolo antes de responder.

Checklist — clique nas caixas, elas ficam marcadas:

- [x] Solicitar segunda via do boleto
- [ ] Conferir elegibilidade no portal
- [ ] Retornar a ligação

Lista numerada — pro passo a passo de um procedimento:

1. Abrir o protocolo no portal da operadora
2. Anexar o relatório do mês
3. Registrar o número de retorno nesta nota

---

## Tabelas

Digite "/" e escolha Tabela pra inserir uma. A primeira linha é sempre o cabeçalho.

| Beneficiário | CPF | Status |
| --- | --- | --- |
| Ana Souza | 111.444.777-35 | Ativo |
| João Lima | 11.222.333/0001-81 | Pendente |

- Tab pula pra próxima célula e Shift+Tab volta. Tab na última célula cria uma linha nova.
- Com o cursor dentro da tabela aparece uma barra com "+ linha", "+ coluna", "− linha" e "− coluna" — as ações valem pra linha e a coluna onde o cursor está.
- Enter dentro de uma célula quebra linha ali dentro, sem sair da tabela.
- Em painel estreito a tabela rola na horizontal em vez de espremer as colunas.
- A detecção inteligente (CPF, data, cálculo) ainda não roda dentro das células — por isso os números da tabela acima não ficam sublinhados.

### Colar do Excel ou do Google Sheets

Selecione as células lá, copie, e cole aqui: vira uma tabela de verdade, com as colunas separadas. Vale pro Excel, pro Google Sheets e pra qualquer coisa que copie em colunas separadas por tabulação.

Na prática: recorte do relatório só as linhas que interessam ao caso e cole aqui, em vez de deixar a planilha inteira aberta numa aba ao lado.

---

## Controles de cada bloco

Passe o mouse na margem esquerda de qualquer bloco (inclusive este) pra ver dois ícones aparecerem:

- O símbolo "+" adiciona um bloco novo logo abaixo. Segure Ctrl e clique nele pra adicionar acima.
- A alça de arrastar (os pontinhos): clique nela pra abrir o menu do bloco — Transformar em, Duplicar, Excluir. Ou arraste pra reordenar sem perder a formatação.
- Segure Ctrl e arraste a partir de qualquer ponto do texto (não só a alça) pra selecionar vários blocos de uma vez e mover, duplicar ou excluir juntos.
- Ctrl+Z desfaz e Ctrl+Shift+Z refaz — inclusive troca de tipo de bloco.

Experimente agora nesta linha: passe o mouse na margem, clique na alça, escolha "Transformar em" e depois "Citação". Ctrl+Z traz de volta.

## Detecção inteligente (a parte de "cálculo")

Segure Ctrl e clique em cima de qualquer valor sublinhado abaixo pra ver um menu com opções de cópia (ou o cálculo, no último caso):

- CPF: 111.444.777-35
- CNPJ: 11.222.333/0001-81
- CEP: 01310-100
- Telefone: (11) 98765-4321
- E-mail: contato@quickdock.com
- Data: 25/12/2026
- Cálculo: 150 + 25 * 2 - 10%

No cálculo, o menu mostra o passo a passo e o resultado, com um botão pra copiar. CPF e CNPJ também mostram se o número é válido.

Na prática, é o que evita redigitar: cole o CPF do beneficiário na nota, Ctrl+clique e copie já sem pontuação direto pro campo do sistema. O cálculo confere um repasse sem abrir a calculadora, e a data já traz a idade calculada junto, pronta pra copiar.

---

## Várias notas

- As abas da nota ficam no topo desta seção. Clique no ☰ pra ver a lista completa (útil quando há muitas abas abertas).
- O botão ＋ cria uma nota em branco ou importa um arquivo .md ou .txt.
- Dê um duplo clique numa aba pra abrir o menu dela: Renomear, Ícone e cor, Copiar como Markdown, Copiar como texto, Baixar .md, Baixar .txt, Limpar conteúdo e Excluir. Pela lista do ☰ o mesmo menu abre no botão de editar de cada linha.
- "Limpar conteúdo" esvazia só o texto daquela nota — o nome, a cor e os documentos dela continuam onde estão. "Excluir" some com a nota inteira.
- Em "Ícone e cor" dá pra escolher um ícone comum ou digitar o nome de qualquer ícone do catálogo do Google Fonts e clicar no botão ao lado do campo pra aplicar. Também dá pra alternar entre contorno e preenchido e escolher a cor — a última bolinha, com arco-íris, abre o seletor de cor livre.

Uma forma de organizar: uma nota por cliente, por caso ou por dia. Dê nome, cor e ícone a cada aba e ela fica reconhecível de relance mesmo com dez abertas. Se o espaço apertar, marque "Ocultar nome na aba" nas que já têm ícone — a aba encolhe pro ícone colorido e cabe muito mais coisa na barra.

## Modelos de nota

Quando a mesma sequência de conferências se repete todo dia, vale virar modelo. No menu do ＋ aparece a seção "A partir de um modelo": clicar num deles já cria a nota com a estrutura montada, checkbox por checkbox.

Já vem um modelo de exemplo chamado **Atendimento**, com campos de identificação, uma lista de validações e outra de ações. Abra o ＋ e crie uma nota com ele pra ver como fica.

Em "Gerenciar modelos…" você:

- **Salva a nota atual como modelo** — o caminho mais fácil: monte a nota uma vez do jeito que funciona e guarde.
- **Renomeia** ou **exclui** um modelo (passe o mouse na linha pra ver os botões).
- **Baixa como .md** e **importa .md/.txt** — é assim que se compartilha. O modelo é markdown puro, então basta mandar o arquivo pro colega e ele importar.

Na prática: se todo pedido de reembolso passa pelas mesmas seis conferências, faça uma nota com elas, salve como "Reembolso", e no próximo atendimento é um clique em vez de digitar tudo de novo — ou lembrar de cabeça o que faltou conferir.

## Documentos

Na parte de baixo do painel dá pra guardar arquivos e imagens:

- Clique no ＋ da seção Documentos, arraste arquivos pra dentro da área, ou cole uma imagem direto com Ctrl+V.
- Clique em uma imagem pra abrir o visualizador — zoom, girar, navegar entre várias com as setas.
- Selecione vários arquivos pra injetar direto na página que você está usando ou apagar em lote.

### Documento de uma nota ou de todas

Todo arquivo novo entra vinculado à nota aberta. O alfinete no canto do arquivo alterna entre duas situações:

- **Vinculado** (alfinete azul, sempre visível): aparece só nesta nota.
- **Geral** (alfinete some quando o mouse sai): aparece em todas as notas. Bom pra modelo, logo, formulário em branco — coisas que você usa o tempo todo.

No cabeçalho da seção, "Nesta nota" mostra os desta nota mais os gerais, e "Todos" mostra o acervo inteiro, com os de outras notas em tom apagado. Sempre que o filtro esconder alguma coisa, aparece um rodapé dizendo quantos arquivos ficaram de fora, com um clique pra ver todos — nenhum arquivo some sem aviso.

Pra mover vários de uma vez, selecione e use "📌 Vincular" ou "📌 Tornar geral" na barra azul.

Excluir uma nota **não apaga** os arquivos dela: eles viram gerais.

Na prática: abra a nota do caso e arraste pra dentro o PDF da carteirinha e o print do protocolo — eles ficam vinculados àquela nota e somem da vista quando você troca de aba. Já o modelo de e-mail que você usa em todo atendimento vale deixar geral, pra ter à mão em qualquer nota.

---

Pronto — isso cobre praticamente tudo. Bom uso 🚀`;

function buildTutorialNoteFields() {
  const blocks  = parseMarkdownToBlocks(TUTORIAL_MARKDOWN);
  const content = blocksToMarkdown(blocks);
  return { title: 'Tutorial', content, blocks, icon: 'school', color: '#3b82f6' };
}

let notesMeta = [];
let activeId  = null;

// ── Reordenar notas por arraste (abas e lista do "☰") ─────────────────────────
// Mesma lógica de mover-dentro-do-array pros dois lugares; cada um só monta
// o indicador visual (barra vertical nas abas, linha horizontal na lista) do
// seu próprio jeito e chama isto no drop.
let noteDragSrcId = null;
let tabDropIndicatorEl = null;

function cleanupTabDrag() {
  tabDropIndicatorEl?.remove();
  tabDropIndicatorEl = null;
  noteDragSrcId = null;
}

async function reorderNotes(srcId, targetId, before) {
  if (srcId == null || srcId === targetId) return false;
  const from = notesMeta.findIndex(n => n.id === srcId);
  if (from === -1) return false;
  const [moved] = notesMeta.splice(from, 1);
  let to = notesMeta.findIndex(n => n.id === targetId);
  if (to === -1) to = notesMeta.length;
  else if (!before) to += 1;
  notesMeta.splice(to, 0, moved);
  await reorderNoteRecords(notesMeta.map(n => n.id));
  return true;
}

// Sem cor definida: remove a variável (não seta "transparent") pra que os
// elementos temáticos (citação, marcadores, checkbox) caiam de volta no
// var(--accent) padrão em vez de ficarem invisíveis.
function setAccent(color) {
  if (color) noteEditorEl.style.setProperty('--note-accent', color);
  else noteEditorEl.style.removeProperty('--note-accent');
}

function renderTabs() {
  tabsEl.innerHTML = '';
  for (const meta of notesMeta) tabsEl.appendChild(buildTab(meta));
}

// A tira de abas rola só na horizontal — trocar de nota por um caminho que
// não seja clicar na própria aba (menu "☰", carregamento inicial) pode
// deixar a aba ativa fora da área visível.
function scrollTabIntoView(id) {
  const tab = tabsEl.querySelector(`.note-tab[data-id="${id}"]`);
  tab?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

// Indicador visual da aba: ícone se a nota tem um definido, senão a bolinha
// de cor se tem cor, senão nada (só o título aparece). Não existe mais um
// "modo" separado — é só o que estiver de fato preenchido. Não tem clique
// próprio: o duplo clique em qualquer parte da aba (texto, ícone ou cor)
// é tratado no nível da própria aba, em buildTab.
function buildTabIndicator(meta) {
  if (meta.icon) {
    const span = document.createElement('span');
    span.className = 'note-tab-icon material-symbols-rounded' + (meta.iconFilled ? ' icon-filled' : '');
    span.textContent = meta.icon;
    span.style.color = meta.color || 'var(--text-muted)';
    return span;
  }

  if (meta.color) {
    const dot = document.createElement('span');
    dot.className = 'note-tab-dot';
    dot.style.background = meta.color;
    return dot;
  }

  return null;
}

function buildTab(meta) {
  const tab = document.createElement('div');
  tab.className = 'note-tab' + (meta.id === activeId ? ' active' : '');
  tab.draggable = true;
  tab.dataset.id = String(meta.id);
  tab.title = meta.title || 'Sem título';

  const indicator = buildTabIndicator(meta);

  // Só oculta o nome se sobrar ícone ou cor pra identificar a aba — nunca os
  // três (ícone, cor e nome) somem ao mesmo tempo.
  const titleHidden = !!meta.titleHidden && !!(meta.icon || meta.color);

  const title = document.createElement('span');
  title.className   = 'note-tab-title';
  title.textContent = meta.title || 'Sem título';
  title.hidden       = titleHidden;

  if (indicator) tab.appendChild(indicator);
  tab.appendChild(title);

  // Um clique só troca de nota (nunca abre menu, pra não abrir sem querer).
  // O clique duplo — em qualquer parte da aba: texto, ícone ou cor — abre o
  // mesmo menu de sempre (Renomear / Ícone e cor / Copiar / Baixar / Excluir),
  // sem precisar mais do botão "⋯" só pra isso, deixando a aba mais compacta.
  tab.addEventListener('click', async () => {
    if (meta.id === activeId) return;
    await activateNote(meta.id);
    renderTabs();
  });
  tab.addEventListener('dblclick', e => {
    e.preventDefault();
    openTabMenu(meta, tab);
  });

  tab.addEventListener('dragstart', e => {
    noteDragSrcId = meta.id;
    e.dataTransfer.effectAllowed = 'move';
    tabDropIndicatorEl = document.createElement('div');
    tabDropIndicatorEl.className = 'tab-drop-indicator';
  });
  tab.addEventListener('dragover', e => {
    if (noteDragSrcId == null || noteDragSrcId === meta.id || !tabDropIndicatorEl) return;
    e.preventDefault();
    const rect = tab.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    tab[before ? 'before' : 'after'](tabDropIndicatorEl);
  });
  tab.addEventListener('drop', async e => {
    e.preventDefault();
    if (noteDragSrcId == null) return;
    const rect = tab.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    const srcId = noteDragSrcId;
    cleanupTabDrag();
    const moved = await reorderNotes(srcId, meta.id, before);
    if (moved) { renderTabs(); scrollTabIntoView(srcId); }
  });
  tab.addEventListener('dragend', cleanupTabDrag);

  return tab;
}

// ── Conteúdo de ícone + cor (embutido dentro do menu "⋯", ver openTabMenu) ───
// Escolher um ícone ou uma cor não fecha o menu, só re-renderiza este bloco
// no lugar, pra dar pra ajustar os dois sem reabrir nada.
function renderAppearanceContent(pop, meta) {
  pop.innerHTML = '';

  const iconHeader = document.createElement('div');
  iconHeader.className = 'copy-menu-header';
  iconHeader.textContent = 'Ícone';
  pop.appendChild(iconHeader);

  const iconGrid = document.createElement('div');
  iconGrid.className = 'icon-grid';

  const pickIcon = async (name) => {
    await updateNoteMetaById(meta.id, { icon: name });
    meta.icon = name;
    renderTabs();
    renderAppearanceContent(pop, meta);
  };

  const noneIconBtn = document.createElement('button');
  noneIconBtn.className = 'icon-swatch icon-swatch-none' + (!meta.icon ? ' active' : '');
  noneIconBtn.textContent = '—';
  noneIconBtn.title = 'Nenhum ícone';
  noneIconBtn.addEventListener('mousedown', e => e.stopPropagation());
  noneIconBtn.addEventListener('click', e => { e.stopPropagation(); pickIcon(null); });
  iconGrid.appendChild(noneIconBtn);

  const filledClass = meta.iconFilled ? ' icon-filled' : '';
  for (const name of COMMON_ICONS) {
    const btn = document.createElement('button');
    btn.className = 'icon-swatch material-symbols-rounded' + filledClass + (meta.icon === name ? ' active' : '');
    btn.textContent = name;
    btn.title = name;
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', e => { e.stopPropagation(); pickIcon(name); });
    iconGrid.appendChild(btn);
  }
  pop.appendChild(iconGrid);

  // Alterna entre o estilo "contorno" (padrão) e "preenchido" do ícone —
  // usa o eixo FILL da própria fonte variável, não precisa carregar outra.
  const fillRow = document.createElement('label');
  fillRow.className = 'icon-fill-row';
  const fillCheckbox = document.createElement('input');
  fillCheckbox.type = 'checkbox';
  fillCheckbox.checked = !!meta.iconFilled;
  fillCheckbox.addEventListener('mousedown', e => e.stopPropagation());
  fillCheckbox.addEventListener('change', async e => {
    e.stopPropagation();
    await updateNoteMetaById(meta.id, { iconFilled: e.target.checked });
    meta.iconFilled = e.target.checked;
    renderTabs();
    renderAppearanceContent(pop, meta);
  });
  const fillLabel = document.createElement('span');
  fillLabel.textContent = 'Ícone preenchido';
  fillRow.append(fillCheckbox, fillLabel);
  pop.appendChild(fillRow);

  const iconCustomRow = document.createElement('div');
  iconCustomRow.className = 'icon-custom-row';
  const iconInput = document.createElement('input');
  iconInput.type = 'text';
  iconInput.className = 'icon-custom-input';
  iconInput.placeholder = 'nome_do_ícone';
  const initialCustomName = (meta.icon && !COMMON_ICONS.includes(meta.icon)) ? meta.icon : '';
  iconInput.value = initialCustomName;

  // O preview é o próprio botão de aplicar: antes era um <span> e não dava pra
  // confirmar o ícone personalizado a não ser apertando Enter.
  const iconApply = document.createElement('button');
  iconApply.className = 'icon-custom-apply material-symbols-rounded' + filledClass;
  iconApply.title = 'Usar este ícone';

  const syncApply = () => {
    const name = iconInput.value.trim();
    iconApply.textContent = name || 'add';
    iconApply.disabled = !name || name === meta.icon;
    iconApply.classList.toggle('is-empty', !name);
  };
  syncApply();

  const applyCustomIcon = () => {
    const name = iconInput.value.trim();
    if (name) pickIcon(name);
  };

  iconInput.addEventListener('mousedown', e => e.stopPropagation());
  iconInput.addEventListener('input', syncApply);
  iconInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    applyCustomIcon();
  });

  iconApply.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
  iconApply.addEventListener('click', e => { e.stopPropagation(); applyCustomIcon(); });

  iconCustomRow.append(iconInput, iconApply);
  pop.appendChild(iconCustomRow);

  const hint = document.createElement('a');
  hint.className = 'icon-hint-link';
  hint.href = 'https://fonts.google.com/icons';
  hint.target = '_blank';
  hint.rel = 'noopener noreferrer';
  hint.textContent = 'Ver todos os ícones →';
  hint.addEventListener('mousedown', e => e.stopPropagation());
  pop.appendChild(hint);

  pop.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));

  const colorHeader = document.createElement('div');
  colorHeader.className = 'copy-menu-header';
  colorHeader.textContent = 'Cor';
  pop.appendChild(colorHeader);

  const colorGrid = document.createElement('div');
  colorGrid.className = 'color-grid';

  const pickColor = async (hex) => {
    await updateNoteMetaById(meta.id, { color: hex });
    meta.color = hex;
    if (meta.id === activeId) setAccent(hex);
    renderTabs();
    renderAppearanceContent(pop, meta);
  };

  const noneColorBtn = document.createElement('button');
  noneColorBtn.className = 'color-swatch color-swatch-none' + (!meta.color ? ' active' : '');
  noneColorBtn.title = 'Nenhuma cor';
  noneColorBtn.addEventListener('mousedown', e => e.stopPropagation());
  noneColorBtn.addEventListener('click', e => { e.stopPropagation(); pickColor(null); });
  colorGrid.appendChild(noneColorBtn);

  for (const { name, hex } of COLORS) {
    const sw = document.createElement('button');
    sw.className = 'color-swatch' + (meta.color === hex ? ' active' : '');
    sw.style.background = hex;
    sw.title = name;
    sw.addEventListener('mousedown', e => e.stopPropagation());
    sw.addEventListener('click', e => { e.stopPropagation(); pickColor(hex); });
    colorGrid.appendChild(sw);
  }
  // "Outra cor" entra como a última bolinha da própria grade, em vez de uma
  // linha solta embaixo — é o que deixava a seção desalinhada.
  const isCustomColor = !!meta.color && !COLORS.some(c => c.hex === meta.color);
  const customSwatch = document.createElement('label');
  customSwatch.className = 'color-swatch color-swatch-custom' + (isCustomColor ? ' active' : '');
  customSwatch.title = 'Outra cor…';
  if (isCustomColor) customSwatch.style.background = meta.color;

  const colorInput = document.createElement('input');
  colorInput.type  = 'color';
  colorInput.className = 'color-custom-input';
  colorInput.value = (meta.color && /^#[0-9a-f]{6}$/i.test(meta.color)) ? meta.color : '#888888';
  colorInput.addEventListener('mousedown', e => e.stopPropagation());
  colorInput.addEventListener('input',  e => { e.target.closest('.color-swatch').style.background = e.target.value; });
  colorInput.addEventListener('change', e => { e.stopPropagation(); pickColor(e.target.value); });

  customSwatch.appendChild(colorInput);
  colorGrid.appendChild(customSwatch);
  pop.appendChild(colorGrid);

  // Ocultar o nome só faz sentido se sobrar ícone ou cor pra identificar a
  // aba — sem isso a aba ficaria completamente vazia, então a opção nem
  // aparece nesse caso (a nota volta a mostrar o nome automaticamente).
  if (meta.icon || meta.color) {
    pop.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));

    const hideRow = document.createElement('label');
    hideRow.className = 'icon-fill-row';
    const hideCheckbox = document.createElement('input');
    hideCheckbox.type = 'checkbox';
    hideCheckbox.checked = !!meta.titleHidden;
    hideCheckbox.addEventListener('mousedown', e => e.stopPropagation());
    hideCheckbox.addEventListener('change', async e => {
      e.stopPropagation();
      await updateNoteMetaById(meta.id, { titleHidden: e.target.checked });
      meta.titleHidden = e.target.checked;
      renderTabs();
    });
    const hideLabel = document.createElement('span');
    hideLabel.textContent = 'Ocultar nome na aba';
    hideRow.append(hideCheckbox, hideLabel);
    pop.appendChild(hideRow);
  }
}

// ── Menu "⋯" (nome / ícone / cor / copiar / baixar / excluir) ────────────────
// Pega os blocos da nota pedida: se for a nota aberta na tela, lê o DOM ao
// vivo (depois de garantir que está salvo); se for outra aba, lê do banco —
// mesma lógica de fallback usada ao trocar de nota.
async function getBlocksForNote(meta) {
  if (meta.id === activeId) {
    await flushSave();
    return getCurrentBlocks();
  }
  const note = await getNoteById(meta.id);
  return (note?.blocks?.length) ? note.blocks : parseMarkdownToBlocks(note?.content ?? '');
}

function safeFilename(title) {
  return (title || 'nota').replace(/[\\/:*?"<>|]/g, '_').trim() || 'nota';
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

let tabMenuEl = null;
let tabMenuAppearanceOpen = false;

function closeTabMenu() {
  tabMenuEl?.remove();
  tabMenuEl = null;
  tabMenuAppearanceOpen = false;
}

function renderTabMenu(meta, anchorEl) {
  const menu = tabMenuEl ?? document.createElement('div');
  menu.className = 'copy-menu tab-menu';
  menu.innerHTML = '';

  // Nome — o próprio input já dentro do menu, sem botão "Renomear" separado.
  const renameInput = document.createElement('input');
  renameInput.className = 'tab-menu-rename';
  renameInput.value = meta.title;
  renameInput.placeholder = 'Sem título';
  renameInput.addEventListener('mousedown', e => e.stopPropagation());
  renameInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter')  renameInput.blur();
    if (e.key === 'Escape') { renameInput.value = meta.title; renameInput.blur(); }
  });
  renameInput.addEventListener('blur', async () => {
    const val = renameInput.value.trim() || 'Sem título';
    if (val === meta.title) return;
    await updateNoteMetaById(meta.id, { title: val });
    meta.title = val;
    renderTabs();
  });
  menu.appendChild(renameInput);

  menu.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));

  // Ícone e cor — dropdown embutido no mesmo menu, em vez de abrir outro
  // popover por cima. Expande/recolhe sem fechar o menu.
  const appearanceToggle = document.createElement('button');
  appearanceToggle.className = 'copy-opt tab-menu-appearance-toggle';
  appearanceToggle.innerHTML =
    `<span class="copy-opt-value">Ícone e cor</span><span class="copy-opt-hint">${tabMenuAppearanceOpen ? '▲' : '▼'}</span>`;
  appearanceToggle.addEventListener('mousedown', e => e.stopPropagation());
  appearanceToggle.addEventListener('click', e => {
    e.stopPropagation();
    tabMenuAppearanceOpen = !tabMenuAppearanceOpen;
    renderTabMenu(meta, anchorEl);
  });
  menu.appendChild(appearanceToggle);

  if (tabMenuAppearanceOpen) {
    const wrap = document.createElement('div');
    wrap.className = 'tab-menu-appearance';
    renderAppearanceContent(wrap, meta);
    menu.appendChild(wrap);
  }

  menu.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));

  const addOpt = (label, run) => {
    const btn = document.createElement('button');
    btn.className = 'copy-opt';
    btn.innerHTML = `<span class="copy-opt-value">${label}</span>`;
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', async e => { e.stopPropagation(); closeTabMenu(); await run(); });
    menu.appendChild(btn);
  };

  addOpt('Copiar como Markdown', async () => {
    const text = blocksToMarkdown(await getBlocksForNote(meta));
    await navigator.clipboard.writeText(text);
  });
  addOpt('Copiar como texto', async () => {
    const text = blocksToPlainText(await getBlocksForNote(meta));
    await navigator.clipboard.writeText(text);
  });
  addOpt('Baixar .md', async () => {
    const text = blocksToMarkdown(await getBlocksForNote(meta));
    downloadText(`${safeFilename(meta.title)}.md`, text);
  });
  addOpt('Baixar .txt', async () => {
    const text = blocksToPlainText(await getBlocksForNote(meta));
    downloadText(`${safeFilename(meta.title)}.txt`, text);
  });

  menu.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));

  addOpt('Limpar conteúdo', async () => {
    if (!confirm(`Limpar o conteúdo de "${meta.title}"?\n\nO nome, a cor e os documentos da nota não mudam.`)) return;
    if (meta.id === activeId) await clearCurrentNote();
    else await updateNoteBlocksById(meta.id, [], '');
  });

  addOpt('Excluir', async () => {
    if (notesMeta.length <= 1) { alert('Deve existir ao menos uma nota.'); return; }
    if (!confirm(`Excluir a nota "${meta.title}"?`)) return;
    // Os documentos vinculados viram gerais: some a nota, não os arquivos.
    await detachFilesFromNote(meta.id);
    await deleteNoteRecordById(meta.id);
    notesMeta = notesMeta.filter(n => n.id !== meta.id);
    if (activeId === meta.id) await activateNote(notesMeta[0].id);
    await refreshDocuments();
    renderTabs();
  });

  if (!tabMenuEl) {
    document.body.appendChild(menu);
    tabMenuEl = menu;
  }
  positionPopover(menu, anchorEl);
}

function openTabMenu(meta, anchorEl) {
  closeTabMenu();
  renderTabMenu(meta, anchorEl);
  const renameInput = tabMenuEl.querySelector('.tab-menu-rename');
  renameInput?.focus();
  renameInput?.select();
}

document.addEventListener('mousedown', e => {
  if (tabMenuEl && !tabMenuEl.contains(e.target)) closeTabMenu();
});

// ── Lista de notas ("☰") ──────────────────────────────────────────────────────
let notesListPopover = null;
function closeNotesListPopover() { notesListPopover?.remove(); notesListPopover = null; }

// Abre o mesmo menu "⋯" de sempre, mas ancorado na aba de verdade — assim
// não precisa duplicar a lógica de renomear/ícone/cor/excluir pra dentro
// da lista. A aba de qualquer nota sempre existe no DOM (só pode estar fora
// da área visível pela rolagem horizontal).
function openTabMenuForNote(meta) {
  closeNotesListPopover();
  const tabEl = tabsEl.querySelector(`.note-tab[data-id="${meta.id}"]`);
  if (!tabEl) return;
  // Sem "smooth" aqui: o menu abre logo em seguida e precisa da posição
  // final da aba, não de uma posição no meio de uma animação de rolagem.
  tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  openTabMenu(meta, tabEl);
}

let listDropIndicatorEl = null;

function cleanupListDrag() {
  listDropIndicatorEl?.remove();
  listDropIndicatorEl = null;
  noteDragSrcId = null;
}

function renderNotesListRows(pop) {
  pop.querySelectorAll('.notes-list-item').forEach(el => el.remove());

  for (const meta of notesMeta) {
    const row = document.createElement('div');
    row.className = 'copy-opt notes-list-item' + (meta.id === activeId ? ' current' : '');
    row.draggable = true;
    row.dataset.id = String(meta.id);

    const indicator = buildTabIndicator(meta);
    const label = document.createElement('span');
    label.className = 'copy-opt-value';
    label.textContent = meta.title || 'Sem título';
    if (indicator) row.appendChild(indicator);
    row.appendChild(label);

    const editBtn = document.createElement('button');
    editBtn.className   = 'notes-list-edit-btn';
    editBtn.textContent = '⋯';
    editBtn.title       = 'Opções da nota';
    editBtn.addEventListener('mousedown', e => e.stopPropagation());
    editBtn.addEventListener('click', e => { e.stopPropagation(); openTabMenuForNote(meta); });
    row.appendChild(editBtn);

    row.addEventListener('mousedown', e => e.stopPropagation());
    row.addEventListener('click', async () => {
      closeNotesListPopover();
      if (meta.id !== activeId) { await activateNote(meta.id); renderTabs(); }
      scrollTabIntoView(meta.id);
    });

    row.addEventListener('dragstart', e => {
      e.stopPropagation();
      noteDragSrcId = meta.id;
      e.dataTransfer.effectAllowed = 'move';
      listDropIndicatorEl = document.createElement('div');
      listDropIndicatorEl.className = 'notes-list-drop-indicator';
    });
    row.addEventListener('dragover', e => {
      if (noteDragSrcId == null || noteDragSrcId === meta.id || !listDropIndicatorEl) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      row[before ? 'before' : 'after'](listDropIndicatorEl);
    });
    row.addEventListener('drop', async e => {
      e.preventDefault();
      e.stopPropagation();
      if (noteDragSrcId == null) return;
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      const srcId = noteDragSrcId;
      cleanupListDrag();
      const moved = await reorderNotes(srcId, meta.id, before);
      if (moved) { renderNotesListRows(pop); renderTabs(); }
    });
    row.addEventListener('dragend', e => { e.stopPropagation(); cleanupListDrag(); });

    pop.appendChild(row);
  }
}

function openNotesListPopover() {
  closeNotesListPopover();
  const pop = document.createElement('div');
  pop.className = 'copy-menu notes-list-popover';
  renderNotesListRows(pop);
  document.body.appendChild(pop);
  notesListPopover = pop;
  positionPopover(pop, btnNotesList);
}

btnNotesList.addEventListener('click', e => { e.stopPropagation(); openNotesListPopover(); });
document.addEventListener('mousedown', e => {
  if (notesListPopover && !notesListPopover.contains(e.target)) closeNotesListPopover();
});

// ── "Nova nota" / "Importar" (botão combinado) ────────────────────────────────
let newMenuPopover = null;
function closeNewMenu() { newMenuPopover?.remove(); newMenuPopover = null; }

async function createBlankNote() {
  await flushSave();
  const title = `Nota ${notesMeta.length + 1}`;
  const id = await createNoteRecord({ title, content: '' });
  notesMeta.push({ id, title, color: null, icon: null, updatedAt: Date.now() });
  await activateNote(id);
  renderTabs();
}

// Cria uma nova nota com o mesmo conteúdo do tutorial — usado pelo botão 📘
// do cabeçalho, pra quem já tem notas e quer ver o tutorial de novo.
export async function createTutorialNote() {
  await flushSave();
  const fields = buildTutorialNoteFields();
  const id = await createNoteRecord(fields);
  notesMeta.push({ id, title: fields.title, color: fields.color, icon: fields.icon, updatedAt: Date.now() });
  await activateNote(id);
  renderTabs();
  scrollTabIntoView(id);
}

// Nota a partir de um modelo: o markdown do modelo passa pelo mesmo parser da
// importação, então o que estava salvo como texto vira blocos de verdade —
// checklist clicável, títulos, tabela.
async function createNoteFromTemplate(tpl) {
  await flushSave();
  const blocks  = parseMarkdownToBlocks(tpl.content);
  const content = blocksToMarkdown(blocks);
  const id = await createNoteRecord({ title: tpl.name, content, blocks });
  notesMeta.push({ id, title: tpl.name, color: null, icon: null, updatedAt: Date.now() });
  await activateNote(id);
  renderTabs();
  scrollTabIntoView(id);
}

async function currentNoteAsMarkdown() {
  const meta = notesMeta.find(n => n.id === activeId);
  if (!meta) return null;
  return { title: meta.title, markdown: blocksToMarkdown(await getBlocksForNote(meta)) };
}

// textContent, não innerHTML: nome de modelo é texto que o usuário escreveu.
function newMenuOpt(pop, label, run) {
  const btn = document.createElement('button');
  btn.className = 'copy-opt';
  const span = document.createElement('span');
  span.className = 'copy-opt-value';
  span.textContent = label;
  btn.appendChild(span);
  btn.addEventListener('mousedown', e => e.stopPropagation());
  btn.addEventListener('click', async e => { e.stopPropagation(); closeNewMenu(); await run(); });
  pop.appendChild(btn);
}

async function openNewMenu() {
  closeNewMenu();
  const pop = document.createElement('div');
  pop.className = 'copy-menu new-menu';

  newMenuOpt(pop, 'Nota em branco', createBlankNote);
  newMenuOpt(pop, 'Importar (.md/.txt)', () => importInput.click());

  const templates = await getTemplates();
  if (templates.length > 0) {
    pop.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));
    const head = document.createElement('div');
    head.className = 'copy-menu-header';
    head.textContent = 'A partir de um modelo';
    pop.appendChild(head);
    for (const tpl of templates) newMenuOpt(pop, tpl.name, () => createNoteFromTemplate(tpl));
  }

  pop.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));
  newMenuOpt(pop, 'Gerenciar modelos…', () => openTemplatesManager(btnNew, {
    onUse: createNoteFromTemplate,
    getCurrentNote: currentNoteAsMarkdown,
  }));

  document.body.appendChild(pop);
  newMenuPopover = pop;
  positionPopover(pop, btnNew);
}

btnNew.addEventListener('click', e => { e.stopPropagation(); openNewMenu(); });
document.addEventListener('mousedown', e => {
  if (newMenuPopover && !newMenuPopover.contains(e.target)) closeNewMenu();
});

importInput.addEventListener('change', async () => {
  const file = importInput.files[0];
  importInput.value = '';
  if (!file) return;

  const text    = await file.text();
  const blocks  = parseMarkdownToBlocks(text);
  const title   = file.name.replace(/\.(md|txt)$/i, '') || 'Nota importada';
  const content = blocksToMarkdown(blocks);

  await flushSave();
  const id = await createNoteRecord({ title, content, blocks });
  notesMeta.push({ id, title, color: null, icon: null, updatedAt: Date.now() });
  await activateNote(id);
  renderTabs();
});

// ── Ciclo de vida ──────────────────────────────────────────────────────────────
async function activateNote(id) {
  activeId = id;
  const meta = notesMeta.find(n => n.id === id);
  setAccent(meta?.color);
  await switchToNote(id);
  await setDocumentsNote(id);
  await saveActiveNoteId(id);
}

export async function initNotesTabs() {
  await migrateLegacyNoteIfNeeded();
  await initTemplates();
  notesMeta = await loadAllNotesMeta();

  // Primeira vez que a extensão é aberta (nenhuma nota, nem legado migrado):
  // cria a nota-tutorial em vez de uma nota em branco.
  if (notesMeta.length === 0) {
    const fields = buildTutorialNoteFields();
    const id = await createNoteRecord(fields);
    notesMeta = [{ id, title: fields.title, color: fields.color, icon: fields.icon, updatedAt: Date.now() }];
  }

  const savedActiveId = await loadActiveNoteId();
  const initial = notesMeta.find(n => n.id === savedActiveId) ?? notesMeta[0];
  await activateNote(initial.id);
  renderTabs();
  scrollTabIntoView(initial.id);
}
