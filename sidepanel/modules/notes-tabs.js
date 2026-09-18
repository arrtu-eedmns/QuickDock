import {
  loadAllNotesMeta, createNoteRecord, updateNoteMetaById, deleteNoteRecordById,
  reorderNoteRecords, moveNoteRecord, migrateLegacyNoteIfNeeded, loadActiveNoteId, saveActiveNoteId,
  getNoteById, detachFilesFromNote, updateNoteBlocksById,
  updateTemplateById, gcInlineFiles,
} from './storage.js';
import { setDocumentsNote, refreshDocuments } from './documents.js';
import { positionPopover } from './popover.js';
import {
  initTemplates, getTemplates, noteTemplates, openTemplatesManager,
  refreshTemplates, closeTemplatesManager,
} from './templates.js';
import {
  switchToNote, flushSave, getCurrentBlocks, clearCurrentNote,
  openTemplateInEditor, currentTemplateMarkdown, clearTemplateEditing,
  blocksToExportMarkdown, absorbDataUrls,
} from './note.js';
import { blocksToMarkdown, blocksToPlainText, parseMarkdownToBlocks } from './blocks.js';
import { buildBackup, parseBackup } from './backup.js';
import { iconSvg, createIcon } from './icons.js';

const tabsEl        = document.getElementById('notes-tabs');
const btnNew        = document.getElementById('btn-new-note');
const btnNotesList  = document.getElementById('btn-notes-list');
const importInput   = document.getElementById('note-import-input');
const noteEditorEl  = document.querySelector('.note-editor');
const noteSection   = document.querySelector('.note-section');

// A tira de abas só rola na horizontal, mas a roda do mouse manda scroll
// vertical por padrão (só vira horizontal segurando Shift) — aqui a gente
// já converte deltaY em scrollLeft direto, sem precisar da tecla.
tabsEl.addEventListener('wheel', e => {
  if (document.documentElement.dataset.platform === 'desktop') return; // Na aside vertical do desktop o scroll já é vertical naturalmente
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

Ctrl+K abre o menu de link, com dois campos: **Texto** (o que aparece na nota) e **Endereço**. Com texto selecionado, ele já vem preenchido e o cursor cai direto no endereço. Sem nada selecionado, dá pra escrever os dois e o link nasce ali.

Com o cursor dentro de um link que já existe, Ctrl+K reabre o menu com os dois campos preenchidos — dá pra trocar só a palavra, só o endereço, ou remover o link.

Colar uma URL também funciona: sem nada selecionado ela entra como link, e com texto selecionado o endereço envolve a seleção.

Pra abrir um link, segure Ctrl e clique — o mesmo gesto da detecção inteligente. Clique normal só posiciona o cursor, senão não daria pra editar o texto. Experimente neste: [catálogo de ícones do Google](https://fonts.google.com/icons)

Na prática, serve pra deixar o caminho de volta salvo junto do caso: o portal da operadora, o formulário que você sempre preenche, a consulta do protocolo.

Digitar também funciona: escreva o texto entre colchetes seguido do endereço entre parênteses e, ao fechar o parêntese, vira link sozinho.

### Pular para um título da própria nota

No lugar do endereço, use cerquilha e o nome do título em minúsculas com hífen no lugar dos espaços. Ctrl+clique rola até lá e o título pisca por um instante, pra você ver onde parou.

Numa nota longa de atendimento, isso vira um índice no topo: um link por seção, e você desce direto pra que interessa.

Acento e pontuação do título não atrapalham — "Validações do Protocolo" é alcançado por "validacoes-do-protocolo". Se houver dois títulos com o mesmo nome, o segundo ganha um "-1" no fim.

## Indentação

Tab indenta o bloco e Shift+Tab desindenta — até cinco níveis, que é o que cabe num painel estreito. Vale pra qualquer bloco, não só lista: parágrafo, título e até tabela.

- Fruta
  - Maçã
    - Fuji
  - Pera
- Legume

Repare em três coisas: o marcador muda a cada nível, a lista numerada recomeça a contagem dentro de cada nível, e indentar um item leva os itens de dentro dele junto.

1. Abrir o protocolo
  1. Anexar o relatório
  2. Conferir o prazo
2. Registrar o retorno

Pra sair de um nível sem usar Shift+Tab: Enter numa linha vazia ou Backspace no começo da linha.

## Tipos de bloco

Digite uma barra "/" no começo de uma linha vazia pra abrir o menu e escolher o tipo de bloco. Ou use os atalhos abaixo, digitando o símbolo seguido de espaço no início da linha:

- Cerquilha (#), repetida até seis vezes, + espaço → Título 1 a Título 6
- Hífen ou asterisco + espaço → lista com marcadores
- "1." + espaço → lista numerada
- Colchetes "[]" (sem hífen na frente) + espaço → checklist
- Maior-que (>) + espaço → citação
- Colchete, exclamação, o tipo e colchete + espaço → destaque colorido
- Três hífens sozinhos na linha → divisor
- Três crases sozinhas na linha → bloco de código

O menu do "/" mostra os tipos numa grade de ícones, separados por grupo — Texto, Listas, Destaques, Blocos e os seus modelos. É onde estão as coisas que não têm atalho de teclado, como Tabela, Imagem e Cálculo. Setas pra andar (esquerda e direita de um em um, cima e baixo de linha em linha), Enter pra confirmar. Digitar depois da barra filtra.

### Título sublinhado

Título 1 e Título 2 podem ganhar um traço embaixo. Abra o menu da alça com o cursor no título e escolha "Sublinhar título".

Isso não é um tipo de bloco novo, é uma marca — e no arquivo vira a forma original do markdown de escrever título, com o traço na linha de baixo. Ou seja: dá a volta inteira e abre certo em qualquer editor.

### Exemplos ao vivo

Citação — boa pra guardar a fala de alguém sem misturar com a sua anotação:

> A beneficiária afirma que enviou a documentação em 02/09. Conferir no protocolo antes de responder.

A citação não é um tipo de bloco e sim uma marca: qualquer bloco pode ser citado e continua sendo o que era. Por isso título, lista e checklist funcionam dentro dela:

> #### Retorno da operadora
>
> - Protocolo aceito
> - Prazo de 5 dias úteis
>
> - [ ] Conferir no dia 22

Pra tirar a citação: Backspace no começo da linha, ou o botão de aspas na barra que aparece ao selecionar texto.

### Destaques

Aquela caixa colorida de aviso que todo manual tem. São cinco tipos, cada um com sua cor:

> [!NOTE]
> Um recado que a pessoa precisa ler, sem urgência nenhuma.

> [!TIP]
> Um atalho que economiza tempo.

> [!IMPORTANT]
> Algo que muda o resultado se for ignorado.

> [!WARNING]
> Um cuidado a tomar antes de seguir.

> [!CAUTION]
> Um risco de verdade — dá pra perder trabalho aqui.

Pra criar: digite "/" e procure por Destaque, ou escreva o marcador direto no início da linha — colchete, exclamação, o nome do tipo em inglês, colchete e espaço. O rótulo colorido aparece sozinho; ele não é texto da nota, então não dá pra apagar sem querer.

O destaque é uma citação com um marcador — por isso tudo que funciona dentro de uma citação funciona dentro dele, e a caixa cresce conforme você aperta Enter:

> [!WARNING]
> **Antes de enviar o protocolo**
>
> - [ ] CPF confere com o do titular
> - [ ] Documentação dentro da validade

Isso é markdown de verdade, o mesmo que o GitHub usa. Baixe a nota como .md, abra lá, e a caixa aparece colorida do mesmo jeito.

Checklist — clique nas caixas, elas ficam marcadas:

- [x] Solicitar segunda via do boleto
- [ ] Conferir elegibilidade no portal
- [ ] Retornar a ligação

Checklist aninhada conversa entre si: marcar um item marca tudo que está dentro dele, e completar os itens de dentro completa o de fora. Enquanto só uma parte está feita, o item de fora mostra um tracinho em vez do visto. Experimente marcar os dois itens de dentro:

- [ ] Documentação do beneficiário
  - [ ] Documento com foto
  - [ ] Comprovante de residência
- [ ] Enviar para análise

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

## Cálculo

Digite "/" e escolha Cálculo pra abrir uma folha de conta. Cada linha calcula sozinha e mostra o resultado ao lado, enquanto você digita.

\`\`\`calc
boleto = R$ 1.000,00
imposto = 15%
calculo = boleto - imposto
\`\`\`

Passe o mouse no resultado à direita e clique: ele vai pra área de transferência. Serve pra jogar o valor direto num formulário ou numa conversa sem ter que selecionar o número na mão. Linha de texto e linha com erro não ficam clicáveis, porque não têm o que copiar.

Repare no que acontece ali: **porcentagem é sempre relativa ao valor da esquerda**. "boleto menos imposto" tira 15% de mil e dá R$ 850,00 — não subtrai quinze centavos.

O "R$" é pra valer: ele acompanha a conta e volta formatado no fim. Some com número puro, multiplique, divida — o resultado continua em reais. Só dividir dinheiro por dinheiro vira número, porque aí é uma razão.

- Escrever "let" na frente é opcional: "boleto = 1000" funciona igual
- Uma linha que não é conta fica lá como texto, sem resultado e sem reclamação. Serve pra anotar no meio da folha
- Começar com duas barras também é comentário
- Enter numa linha vazia sai da folha, como numa lista

### Somar uma coluna

A palavra "acima" vale por tudo que está logo em cima, até a primeira linha sem valor:

\`\`\`calc
R$ 480,00
R$ 120,50
R$ 89,90
total = acima
\`\`\`

Também existem soma, média e arredondar. Os argumentos vão separados por ponto e vírgula, porque a vírgula aqui é decimal: soma(10; 20; 30).

### O resultado não fica guardado

O que a nota grava é só a conta — o valor é recalculado toda vez que a folha aparece. Guardar o número criaria a chance de ele discordar da conta, e não haveria como saber qual dos dois está certo.

Na hora de baixar a nota ou copiar como texto, aí sim o resultado vai junto, ao lado de cada linha. Quem recebe vê os valores sem precisar do QuickDock.

---

## Imagens

Três jeitos de colocar uma imagem dentro da nota:

- Cole com Ctrl+V depois de clicar na nota — um print recém-tirado entra direto. O que decide o destino é onde você clicou por último: clicou na nota, a imagem entra no texto; clicou na seção Documentos, ela vai pra lá.
- Arraste o arquivo de imagem pra dentro do editor
- Digite "/" e escolha Imagem

Passe o mouse na imagem pra ver a barra de botões:

- **Mover p/ Documentos** — tira a imagem do meio do texto e guarda na seção de baixo, vinculada a esta nota. Serve pra quando o arquivo importa mas não precisa ocupar espaço na leitura.
- **Trocar** — troca por outro arquivo, mantendo o lugar dela na nota.
- **Texto** — a descrição da imagem. Serve pra quem usa leitor de tela e é o que aparece caso o arquivo se perca.
- **Remover** — tira a imagem da nota.

Clique na imagem pra abrir o visualizador, com zoom, girar e setas pra passar pelas outras imagens da nota.

A imagem é guardada como arquivo de verdade, não embutida no texto da nota. Isso é o que mantém a nota leve por mais prints que ela tenha. Quando você baixa a nota como .md, aí sim ela vai embutida — o arquivo abre em qualquer editor, com as imagens dentro.

Imagem colada na nota não aparece na seção Documentos: ela já está visível aqui. E imagem com endereço da internet não é exibida de propósito — abrir a nota avisaria o site de onde ela veio que você abriu, e quando. Nesses casos o endereço vira um link, e você decide se quer abrir.

---

## Controles de cada bloco

Passe o mouse na margem esquerda de qualquer bloco (inclusive este) pra ver dois ícones aparecerem:

- O símbolo "+" adiciona um bloco novo logo abaixo. Segure Ctrl e clique nele pra adicionar acima.
- A alça de arrastar (os pontinhos): clique nela pra abrir o menu do bloco, ou arraste pra reordenar sem perder a formatação.
- No topo do menu fica uma fileira de ícones com o que mais se usa: copiar como texto, copiar imagem, duplicar e excluir. Ela não sai do lugar enquanto você rola o resto do menu.
- Pra mexer em vários blocos de uma vez: selecione por cima deles arrastando o texto normalmente, sem tecla nenhuma. Os blocos inteiros ficam marcados, e a partir daí a alça de qualquer um deles move o grupo todo — e o menu da alça passa a valer pros três ("Transformar em (3 blocos)").
- Ctrl e arrastar também seleciona, a partir de qualquer ponto do bloco. Serve pros casos em que não há texto pra arrastar por cima, como um bloco de imagem sozinho.

### Mandar um pedaço da nota como imagem

No menu da alça tem "Copiar imagem" e "Baixar imagem (.png)". Vale pro bloco sozinho ou pro grupo selecionado, e serve pra mandar um trecho num aplicativo de conversa sem ter que explicar o que é markdown.

A imagem sai exatamente como está na tela — com as cores da nota, os destaques e as checklists —, mas sem nada que seja controle: sem o realce de seleção, sem os ícones da margem e sem a barra de botões da tabela. E com a mesma margem do editor em volta, pra que o texto não fique colado na borda.
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
- O botão ＋ abre um menu: nota em branco, importar um .md ou .txt, criar a partir de um modelo, e gerenciar os modelos.
- Dê um duplo clique numa aba pra abrir o menu dela: Renomear, Ícone e cor, Copiar como Markdown, Copiar como texto, Baixar .md, Baixar .txt, Limpar conteúdo e Excluir. Pela lista do ☰ o mesmo menu abre no botão de editar de cada linha.
- "Limpar conteúdo" esvazia só o texto daquela nota — o nome, a cor e os documentos dela continuam onde estão. "Excluir" some com a nota inteira.
- Em "Ícone e cor" dá pra escolher um ícone comum ou digitar o nome de qualquer ícone do catálogo do Google Fonts e clicar no botão ao lado do campo pra aplicar. Também dá pra alternar entre contorno e preenchido e escolher a cor — a última bolinha, com arco-íris, abre o seletor de cor livre.

Uma forma de organizar: uma nota por cliente, por caso ou por dia. Dê nome, cor e ícone a cada aba e ela fica reconhecível de relance mesmo com dez abertas. Se o espaço apertar, marque "Ocultar nome na aba" nas que já têm ícone — a aba encolhe pro ícone colorido e cabe muito mais coisa na barra.

### Backup de tudo

No menu ⋯ tem "Baixar todas as notas": gera um arquivo só, com todas as notas dentro e as imagens embutidas. Fora daqui ele é um markdown comum, que abre em qualquer editor.

Pra restaurar, use Importar e escolha esse arquivo — o QuickDock reconhece que é um backup e recria as notas separadas, uma a uma, com os nomes originais. Restaurar sempre adiciona notas novas: nada do que já existe é alterado, então importar um backup antigo por engano não apaga o trabalho de hoje.

## Modelos

Quando a mesma sequência de conferências se repete todo dia, vale virar modelo. Existem dois tipos, e a diferença é só o tamanho do que eles trazem.

### Modelo de nota — cria a nota inteira

No menu do ＋ aparece a seção "A partir de um modelo": clicar num deles já cria a nota com a estrutura montada, checkbox por checkbox.

Já vem um de exemplo chamado **Atendimento**, com campos de identificação, uma lista de validações e outra de ações. Abra o ＋ e crie uma nota com ele pra ver como fica.

### Modelo de bloco — entra no meio da nota

Esse não cria nota nenhuma: insere um pedaço onde o cursor está. Duas formas de chamar:

- Digite "/" numa linha vazia e comece a escrever o nome do modelo — ele aparece na lista junto com os tipos de bloco, marcado como "modelo".
- Ou abra o menu da alça do bloco: os modelos ficam na seção "Inserir modelo", logo abaixo de "Transformar em".

Numa linha vazia o modelo ocupa o lugar dela; com texto na linha, ele entra logo abaixo.

Vem um de exemplo chamado **Conferência** — um subtítulo, três checkboxes e o campo de quem conferiu.

Pra criar o seu: selecione os blocos que quer guardar (basta arrastar por cima deles), abra o menu da alça e escolha "Salvar como modelo de bloco". Aparece um campo com um nome sugerido a partir da primeira linha — confirme e pronto. Você continua na nota, no mesmo lugar: salvar um modelo não mexe no que está escrito.

### Criar e editar um modelo

Você não escreve modelo em lugar nenhum diferente: **o modelo abre no editor normal**, este mesmo. Checkbox clicável, menu "/", tabela, negrito — tudo igual a editar uma nota, porque é o mesmo editor.

O que muda é uma barra azul que aparece no topo, com a etiqueta **MODELO**. Nela ficam o nome, o tipo e os botões Salvar e Cancelar.

Três formas de chegar lá, todas no menu do ＋ → "Gerenciar modelos…":

- No ✎ de um modelo que já existe (passe o mouse na linha pra ver os botões).
- Em "Criar modelo do zero", pra começar em branco.
- Em "Salvar a nota atual como modelo", que leva o conteúdo da nota aberta pro modelo novo.

O **tipo** na barra converte um modelo de nota em modelo de bloco e vice-versa — serve quando a importação entrou no tipo errado.

Duas coisas pra não tomar susto: enquanto um modelo está aberto **não existe salvamento automático**, ele só grava no botão Salvar. E **trocar de aba sai sem salvar**, como se você tivesse clicado em Cancelar.

### Compartilhar

O modelo é markdown puro, o mesmo formato da exportação. Então compartilhar é só isso:

- **↓** baixa o modelo como .md — mande o arquivo pro colega.
- Quem recebe usa **"Importar como modelo de nota"** ou **"...de bloco"**. São dois botões porque o .md sozinho não diz qual dos dois ele é.
- **✕** exclui.

Na prática: se todo pedido de reembolso passa pelas mesmas seis conferências, faça uma nota com elas e salve como modelo de nota "Reembolso". Já um trecho que você cola no meio de qualquer atendimento — o bloco de conferência, o de encerramento — vale guardar como modelo de bloco, pra chamar com "/" sem sair da nota.

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

## Sincronização

Suas notas não precisam ficar presas neste computador. O botão 🔄 na barra de abas (ou no menu ⋯) permite salvar suas notas como arquivos normais de texto numa pasta à sua escolha.

- **A pasta é sua:** você escolhe onde ela fica no computador. Pode ser uma pasta do OneDrive, Dropbox, Google Drive ou Syncthing — você continua sendo o dono dos seus dados, sem servidor nem banco nosso no caminho.
- **Formato aberto:** cada nota vira um arquivo de texto (.md) na pasta \`notas/\`, seus modelos vão para \`modelos/\` e as imagens para \`imagens/\`. Dá pra abrir suas notas no Obsidian, VS Code ou no bloco de notas do celular.
- **Edição em dois aparelhos:** se você editar a mesma nota em dois computadores diferentes ao mesmo tempo, nada é apagado nem sobrescrito. O QuickDock mantém as duas edições e cria uma cópia com a data e o nome do aparelho — é a chamada "cópia de conflito". Um aviso discreto no botão te avisa para você comparar as duas versões com calma e apagar a cópia quando quiser.

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

  // Só a nota arrastada é regravada — os vizinhos dizem onde ela cai. É o
  // ganho concreto da ordem fracionária: arrastar toca 1 registro, não N.
  const anterior = notesMeta[to - 1]?.ordem ?? null;
  const seguinte = notesMeta[to + 1]?.ordem ?? null;
  const novaOrdem = await moveNoteRecord(moved.id, anterior, seguinte);

  if (novaOrdem) {
    moved.ordem = novaOrdem;
  } else {
    // Vizinhança inconsistente: renumera a lista uma vez e segue. Caro, mas é
    // reparo — e deixa o banco são pro próximo arrasto ser barato de novo.
    const ordens = await reorderNoteRecords(notesMeta.map(n => n.id));
    notesMeta.forEach((n, i) => { n.ordem = ordens[i]; });
  }
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
    const ico = createIcon(meta.icon, 'note-tab-icon' + (meta.iconFilled ? ' icon-filled' : ''));
    ico.style.color = meta.color || 'var(--text-muted)';
    return ico;
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
  const isConflict = /conflito/i.test(meta.title ?? '');
  const tab = document.createElement('div');
  tab.className = 'note-tab' + (meta.id === activeId ? ' active' : '') + (isConflict ? ' is-conflict' : '');
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
    const isVertical = document.documentElement.dataset.platform === 'desktop';
    const before = isVertical ? (e.clientY < rect.top + rect.height / 2) : (e.clientX < rect.left + rect.width / 2);
    tab[before ? 'before' : 'after'](tabDropIndicatorEl);
  });
  tab.addEventListener('drop', async e => {
    e.preventDefault();
    if (noteDragSrcId == null) return;
    const rect = tab.getBoundingClientRect();
    const isVertical = document.documentElement.dataset.platform === 'desktop';
    const before = isVertical ? (e.clientY < rect.top + rect.height / 2) : (e.clientX < rect.left + rect.width / 2);
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
    btn.className = 'icon-swatch' + filledClass + (meta.icon === name ? ' active' : '');
    btn.innerHTML = iconSvg(name);
    btn.title = name;
    btn.setAttribute('aria-label', name);
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
  iconApply.className = 'icon-custom-apply' + filledClass;
  iconApply.title = 'Usar este ícone';
  iconApply.setAttribute('aria-label', 'Usar este ícone');

  const syncApply = () => {
    const name = iconInput.value.trim();
    iconApply.innerHTML = '';
    iconApply.appendChild(createIcon(name || 'add'));
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

// Cria uma nota a partir de markdown de fora (.md importado, backup).
// A nota nasce vazia de propósito: a imagem em base64 precisa de um noteId pra
// virar arquivo, e só depois disso é que os blocos são gravados — senão o
// registro da nota carregaria os megabytes e seria regravado inteiro a cada
// autosave.
async function createNoteFromMarkdown(title, md) {
  const brutos = parseMarkdownToBlocks(md);
  const id     = await createNoteRecord({ title, content: '', blocks: [] });
  const blocks = await absorbDataUrls(brutos, id);
  await updateNoteBlocksById(id, blocks, blocksToMarkdown(blocks));
  notesMeta.push({ id, title, color: null, icon: null, updatedAt: Date.now() });
  return id;
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

// ── Backup de todas as notas ──────────────────────────────────────────────────
// Um arquivo só, e não um por nota: um download não pede permissão de "vários
// downloads" ao navegador, e um arquivo único é mais fácil de guardar e de
// conferir. O formato e a leitura de volta estão em backup.js.
export async function downloadAllNotes() {
  await flushSave();

  const notas = [];
  for (const meta of notesMeta) {
    notas.push({ title: meta.title, md: await blocksToExportMarkdown(await getBlocksForNote(meta)) });
  }

  const carimbo = new Date().toISOString().slice(0, 10);
  downloadText(`quickdock-backup-${carimbo}.md`, buildBackup(notas));
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
    const text = await blocksToExportMarkdown(await getBlocksForNote(meta));
    await navigator.clipboard.writeText(text);
  });
  addOpt('Copiar como texto', async () => {
    const text = blocksToPlainText(await getBlocksForNote(meta));
    await navigator.clipboard.writeText(text);
  });
  addOpt('Baixar .md', async () => {
    const text = await blocksToExportMarkdown(await getBlocksForNote(meta));
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
    // Imagem inline só existe dentro daquela nota: sem a nota, é lixo.
    await gcInlineFiles();
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

function renderNotesListRows(container, filterQuery = '', countEl = null, clearBtn = null) {
  container.querySelectorAll('.notes-list-item, .notes-list-empty').forEach(el => el.remove());

  const q = filterQuery.trim().toLowerCase();
  const filtered = q
    ? notesMeta.filter(m => {
        const titleMatch = (m.title || '').toLowerCase().includes(q);
        const contentMatch = (m.content || '').toLowerCase().includes(q);
        return titleMatch || contentMatch;
      })
    : notesMeta;

  if (countEl && clearBtn) {
    if (q) {
      const visible = filtered.length;
      const total = notesMeta.length;
      const hidden = total - visible;
      countEl.textContent = `Mostrando ${visible} de ${total} notas (${hidden} oculta${hidden === 1 ? '' : 's'})`;
      countEl.hidden = false;
      clearBtn.hidden = false;
    } else {
      countEl.hidden = true;
      clearBtn.hidden = true;
    }
  }

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'copy-opt notes-list-empty';
    empty.style.color = 'var(--text-muted)';
    empty.style.justifyContent = 'center';
    empty.textContent = 'Nenhuma nota encontrada';
    container.appendChild(empty);
    return;
  }

  for (const meta of filtered) {
    const isConflict = /conflito/i.test(meta.title ?? '');
    const row = document.createElement('div');
    row.className = 'copy-opt notes-list-item' + (meta.id === activeId ? ' current' : '') + (isConflict ? ' is-conflict' : '');
    row.draggable = !q;
    row.dataset.id = String(meta.id);

    const indicator = buildTabIndicator(meta);
    const label = document.createElement('span');
    label.className = 'copy-opt-value';
    label.textContent = meta.title || 'Sem título';
    if (indicator) row.appendChild(indicator);
    row.appendChild(label);

    const editBtn = document.createElement('button');
    editBtn.className   = 'notes-list-edit-btn';
    editBtn.innerHTML   = iconSvg('more_horiz');
    editBtn.title       = 'Opções da nota';
    editBtn.setAttribute('aria-label', 'Opções da nota');
    editBtn.addEventListener('mousedown', e => e.stopPropagation());
    editBtn.addEventListener('click', e => { e.stopPropagation(); openTabMenuForNote(meta); });
    row.appendChild(editBtn);

    row.addEventListener('mousedown', e => e.stopPropagation());
    row.addEventListener('click', async () => {
      closeNotesListPopover();
      if (meta.id !== activeId) { await activateNote(meta.id); renderTabs(); }
      scrollTabIntoView(meta.id);
    });

    if (!q) {
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
        if (moved) { renderNotesListRows(container, filterQuery, countEl, clearBtn); renderTabs(); }
      });
      row.addEventListener('dragend', e => { e.stopPropagation(); cleanupListDrag(); });
    }

    container.appendChild(row);
  }
}

function openNotesListPopover() {
  closeNotesListPopover();
  const pop = document.createElement('div');
  pop.className = 'copy-menu notes-list-popover';

  const searchBar = document.createElement('div');
  searchBar.className = 'notes-search-bar';

  const searchIcon = document.createElement('span');
  searchIcon.className = 'search-icon';
  searchIcon.innerHTML = iconSvg('search');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'notes-search-input';
  input.placeholder = 'Buscar por título ou conteúdo...';
  input.setAttribute('aria-label', 'Buscar por título ou conteúdo');

  const clearBtn = document.createElement('button');
  clearBtn.className = 'notes-search-clear icon-btn';
  clearBtn.innerHTML = iconSvg('close');
  clearBtn.title = 'Limpar busca';
  clearBtn.setAttribute('aria-label', 'Limpar busca');
  clearBtn.hidden = true;

  searchBar.append(searchIcon, input, clearBtn);
  pop.appendChild(searchBar);

  const countEl = document.createElement('div');
  countEl.className = 'notes-search-count';
  countEl.hidden = true;
  pop.appendChild(countEl);

  const scrollArea = document.createElement('div');
  scrollArea.className = 'notes-list-scroll';
  pop.appendChild(scrollArea);

  const doUpdate = () => renderNotesListRows(scrollArea, input.value, countEl, clearBtn);

  input.addEventListener('input', doUpdate);
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (input.value) {
        e.stopPropagation();
        input.value = '';
        doUpdate();
      } else {
        closeNotesListPopover();
      }
    }
  });

  clearBtn.addEventListener('click', e => {
    e.stopPropagation();
    input.value = '';
    doUpdate();
    input.focus();
  });

  renderNotesListRows(scrollArea, '', countEl, clearBtn);
  document.body.appendChild(pop);
  notesListPopover = pop;
  positionPopover(pop, btnNotesList);
  setTimeout(() => input.focus(), 50);
}

btnNotesList.addEventListener('click', e => { e.stopPropagation(); openNotesListPopover(); });
document.addEventListener('mousedown', e => {
  if (notesListPopover && !notesListPopover.contains(e.target)) closeNotesListPopover();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && notesListPopover) closeNotesListPopover();
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
  // Passa pelo mesmo caminho da importação: um modelo compartilhado por outra
  // pessoa pode trazer imagem em base64, que tem que virar arquivo.
  const id = await createNoteFromMarkdown(tpl.name, tpl.content);
  await activateNote(id);
  renderTabs();
  scrollTabIntoView(id);
}

// ── Modo modelo ───────────────────────────────────────────────────────────────
// O editor de blocos é um só, ligado a #note-editor-blocks. Em vez de construir
// um segundo editor, ele empresta: carrega o modelo, mostra esta barra e o que
// for digitado volta pro modelo em vez de pra uma nota.
const templateBar    = document.getElementById('template-bar');
const templateName   = document.getElementById('template-bar-name');
const templateKind   = document.getElementById('template-bar-kind');
const templateCancel = document.getElementById('template-bar-cancel');
const templateSave   = document.getElementById('template-bar-save');

let editingTpl  = null;   // {id, name, kind} do modelo aberto
let returnNoteId = null;  // nota pra onde voltar ao sair

export async function editTemplate(tpl) {
  closeTemplatesManager();
  returnNoteId = activeId;
  editingTpl = { id: tpl.id, name: tpl.name, kind: tpl.kind };

  await openTemplateInEditor(tpl);

  templateName.value = tpl.name;
  templateKind.value = tpl.kind;
  templateBar.hidden = false;
  noteSection.classList.add('template-mode');
}

async function exitTemplate(salvar) {
  if (!editingTpl) return;

  if (salvar) {
    const nome = templateName.value.trim() || editingTpl.name;
    await updateTemplateById(editingTpl.id, {
      name: nome,
      kind: templateKind.value,
      content: currentTemplateMarkdown(),
    });
    await refreshTemplates();
  }

  editingTpl = null;
  templateBar.hidden = true;
  noteSection.classList.remove('template-mode');

  const voltarPara = notesMeta.some(n => n.id === returnNoteId) ? returnNoteId : notesMeta[0]?.id;

  // O modo modelo só é desligado DEPOIS de a nota voltar pra tela.
  //
  // Desligar antes era perda de nota: switchToNote começa com um flushSave, e
  // esse save é justamente o que o modo modelo existe pra bloquear. Com a
  // marca já limpa, ele serializava o que estava na tela — os blocos do
  // MODELO — e gravava por cima da nota que estava aberta. Valia pra toda
  // saída, inclusive pelo "Cancelar".
  if (voltarPara != null) await activateNote(voltarPara);
  clearTemplateEditing();
  renderTabs();
}

// Evento em vez de import: templates.js e note.js precisam pedir "abre este
// modelo no editor", e os dois seriam import circular com este módulo.
document.addEventListener('quickdock:edit-template', e => { editTemplate(e.detail); });

templateSave.addEventListener('click', () => exitTemplate(true));
templateCancel.addEventListener('click', () => exitTemplate(false));
templateName.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); exitTemplate(true); }
});

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

  await getTemplates();               // atualiza o cache antes de listar
  const templates = noteTemplates();  // o menu do ＋ cria notas, não insere blocos
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

  const text = await file.text();
  await flushSave();

  // Arquivo de backup: vem com várias notas dentro, cada uma com o seu título.
  // Restaurar cria notas novas — nunca sobrescreve as que já existem, senão
  // um backup antigo apagaria o trabalho de quem o importou por engano.
  const backup = parseBackup(text);
  if (backup) {
    if (!confirm(`Este arquivo é um backup com ${backup.length} nota(s).\n\nElas serão adicionadas como notas novas — nada do que já existe é alterado.`)) return;
    let ultimoId = null;
    for (const { title, md } of backup) ultimoId = await createNoteFromMarkdown(title, md);
    if (ultimoId != null) await activateNote(ultimoId);
    renderTabs();
    return;
  }

  const title = file.name.replace(/\.(md|txt)$/i, '') || 'Nota importada';
  const id = await createNoteFromMarkdown(title, text);
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
  // Faxina de imagem órfã. Roda na abertura de propósito: é o único momento em
  // que não existe histórico de desfazer que pudesse trazer de volta um bloco
  // cujo arquivo acabou de ser apagado.
  await gcInlineFiles();
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

export async function refreshNotesList() {
  notesMeta = await loadAllNotesMeta();
  renderTabs();
  const current = notesMeta.find(n => n.id === activeId);
  if (!current && notesMeta.length > 0) {
    await activateNote(notesMeta[0].id);
    renderTabs();
    scrollTabIntoView(notesMeta[0].id);
  }
}

export function getActiveNoteUid() {
  return notesMeta.find(n => n.id === activeId)?.uid ?? null;
}
