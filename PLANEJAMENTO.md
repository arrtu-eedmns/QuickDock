# Planejamento — Próximas atualizações do QuickDock

> Descreve abordagem e decisões para cada feature, com base no projeto (extensão Chrome MV3, side panel com nota em textarea + overlay de highlight regex, documentos em IndexedDB via Dexie, modal de preview, tema claro/escuro).

## Status

Itens 1–5 **implementados** (v1.3.0). Item 6 (calculadora avançada) segue pendente de detalhamento.

## Reescrita v1.4.0: editor de blocos (estilo Notion)

O editor de notas deixou de ser um textarea com camada de decoração por cima e virou um editor de **blocos reais** (`contenteditable`), parecido com o Notion:

- Digitar `# `, `## `, `### `, `- `, `1. `, `- [ ] `, `> ` ou `---` no início de um bloco vazio **transforma o bloco na hora** (o marcador digitado desaparece, vira formatação de verdade — título com fonte grande de verdade, não só negrito/cor).
- `**negrito**`, `*itálico*`, `` `código` ``, `~~riscado~~` também convertem sozinhos assim que você fecha a sintaxe, virando `<strong>/<em>/<code>/<s>` reais.
- Checkbox de verdade (`<input type="checkbox">`), clique direto, sem precisar de Ctrl.
- Linha divisória (`---`) agora é um `<hr>` de verdade, de ponta a ponta.
- Menu **"/"**: digite `/` num bloco vazio pra escolher o tipo (Título 1/2/3, lista, lista numerada, checklist, citação, código, divisor) — filtra pelo que você digitar depois da barra, setas navegam, Enter confirma.
- Enter/Backspace foram reimplementados na mão (dividir bloco, mesclar com o anterior, "sair" de uma lista com Enter em item vazio, desfazer formatação com Backspace no início antes de apagar o bloco).
- CPF/CNPJ/data/e-mail/cálculo continuam funcionando (Ctrl+clique) — a detecção agora roda com debounce (para de digitar → meio segundo depois ela varre o bloco) em vez de a cada tecla, porque precisa reconstruir só os nós de texto sem atrapalhar negrito/itálico já aplicados.
- Notas antigas (guardadas como texto markdown) são convertidas pra blocos automaticamente na primeira abertura (`blocks.js`).

**Isso não dava pra fazer em cima do textarea+overlay antigo** — é uma base de editor diferente. Ver a conversa anterior no histórico pra entender por que (resumo: textarea+overlay exige que duas camadas fiquem com largura/altura idênticas caractere por caractere; um editor de blocos de verdade não tem essa restrição, cada bloco é um elemento HTML real).

### Limitações conhecidas / não implementado nessa rodada

- **Sem indentação/lista aninhada** (Tab pra sub-nível) — não foi pedido, ficou fora por controle de escopo.
- **Sem arrastar blocos** para reordenar (o "⋮⋮" do Notion) — não foi pedido.
- Negrito/itálico **dentro** de um título ou citação não renderiza (título e citação reivindicam o bloco inteiro pra estilizar; limitação aceita, é bem incomum precisar disso).
- Bloco de código: sem numeração de linha, sem highlight de sintaxe por linguagem — é só monoespaçado com fundo.
- **Não testei rodando no Chrome de verdade** — o navegador desta sessão não consegue carregar extensões descompactadas (`chrome://extensions` não é acessível aqui). Editor com `contenteditable` é historicamente cheio de detalhe fino (posição de cursor, seleção, etc.) — é bem provável que apareça alguma quina pra ajustar depois de testar de verdade. Ver seção de teste no fim do documento.

## 1. Markdown (negrito, itálico, etc.) ✅

**Situação atual**: a nota é um `<textarea>` puro com uma `<div>` sobreposta (`note-highlight` em `sidepanel/index.html`) que reconhece CPF/CNPJ/datas/matemática via regex e desenha `<mark>` por cima, sincronizando scroll — não é um editor rich-text de verdade.

**Abordagem recomendada**: manter o textarea como fonte da verdade (texto markdown puro salvo) e **estender esse mesmo overlay** para também renderizar `**negrito**`, `*itálico*`, `` `código` ``, `~~riscado~~`, `# título`, listas — do mesmo jeito que hoje já pinta CPF/data. Reaproveita toda a infra existente (autosave, undo/redo nativo do textarea, o mecanismo de `DETECTORS` em `sidepanel/modules/note.js`) sem reescrever o editor para contentEditable (o que quebraria a detecção inteligente atual).

Dá pra adicionar botões na toolbar já existente (`TRANSFORMS` em `note.js`) que envolvem a seleção com `**`/`*` automaticamente.

**Vantagem extra**: como o conteúdo salvo continua sendo markdown puro, fica portátil (copiar/colar, exportar como `.md` no futuro).

## 2. Múltiplas notas (blocos de notas) ✅

**Situação atual**: existe **uma única nota**, salva como string em `chrome.storage.local` (`note_content`).

**Abordagem**: criar uma tabela `notes` no Dexie (mesmo banco que já guarda `files` em `sidepanel/modules/storage.js`) — cada nota com id, título, conteúdo, cor, datas de criação/edição. UI tipo lista/abas para trocar entre notas, criar, renomear, excluir, reordenar — seguindo o mesmo padrão visual do grid de documentos.

**Sobre a preocupação de segurança**: vale um esclarecimento — o projeto já **não** usa `localStorage` cru, usa `chrome.storage.local` (nota) e IndexedDB/Dexie (arquivos). Mas nenhum dos dois é "seguro" no sentido de criptografado: os dados ficam em disco, sem criptografia, presos ao perfil do navegador — se o usuário limpar dados do navegador ou desinstalar a extensão, perde tudo, e qualquer processo com acesso ao perfil consegue ler. Migrar as notas pro Dexie resolve robustez/capacidade, mas não é "seguro" nesse sentido criptográfico.

Sugestão à parte (a decidir depois): um **export/import em JSON** (backup manual) já resolveria o medo de perder nota — criptografia com senha seria um passo além, só se fizer sentido.

## 3. Cores por nota ✅

Consequência natural do item 2: cada nota no Dexie ganha um campo `color`, com um seletor de paleta (tipo Google Keep/Notion) e a cor aplicada como indicador visual na lista/aba da nota. Precisa de um conjunto de cores que funcione nos dois temas (claro/escuro).

## 4. Redimensionar área de notas x área de arquivos ✅

O layout do painel é uma coluna única (`#app { flex-direction: column }` em `sidepanel/style.css`), com `note-section` em cima e `docs-section` embaixo. Dá pra colocar uma barra divisória arrastável (drag handle) entre as duas seções, redistribuindo a altura de cada uma via arrasto vertical, com limites mín/máx, e salvando a proporção escolhida (persistente entre sessões).

## 5. Navegação entre imagens no modal (setas / menu numérico) ✅

**Situação atual**: `openModal(id, name, type)` em `sidepanel/modules/modal.js` abre um arquivo isolado, sem noção de "galeria" — não sabe quem é o próximo/anterior.

**Abordagem**: passar pro modal a lista ordenada dos arquivos visíveis (do grid atual), pra ele saber a posição do item aberto e navegar com setas (⟵/⟶ na toolbar + teclado) e um indicador tipo "3/12" clicável, que abre um mini-menu/thumbstrip pra pular direto pra um arquivo específico.

**Decisão tomada**: navegação limitada a imagens (é o que foi pedido literalmente — "passar de uma imagem para outra"). PDF/txt continuam abrindo normalmente, sem setas.

## 6. Calculadora avançada nas notas

Já existe uma base pronta e **não usada**: `loadMathHistory`/`saveMathHistory` em `sidepanel/modules/storage.js`, e um parser matemático seguro e robusto em `sidepanel/modules/math-parser.js` (usado hoje só pra detectar contas soltas dentro do texto da nota). Isso já é meio caminho andado pra uma calculadora com histórico.

**Pendente**: detalhes de como a calculadora deve funcionar (a definir).

---

## Ordem sugerida de implementação

1. Múltiplas notas no Dexie (base estrutural — tudo mais depende disso)
2. Cores por nota
3. Markdown no overlay
4. Área redimensionável (independente, pode entrar em paralelo)
5. Navegação de imagens no modal (independente)
6. Calculadora avançada (quando detalhada)

---

## Notas de implementação (v1.3.0)

- **Fonte do editor virou monoespaçada** (`--font-mono`, em `sidepanel/style.css`). Motivo técnico: o truque do overlay (textarea invisível + `<div>` colorida por cima) exige que os dois elementos tenham exatamente a mesma largura de caractere. Negrito/itálico em fonte proporcional mudariam a largura dos glifos só na camada visual, desalinhando o cursor real do que é mostrado. Em fonte monoespaçada, negrito/itálico não alteram a largura da célula do caractere — resolve o problema sem reescrever o editor.
- Itálico com `*` só é reconhecido sem espaço colado nos asteriscos (regra do CommonMark) — evita conflito com `*` usado como multiplicação nas contas (ex.: `2 * 3 * 4` continua sendo detectado como cálculo, não como itálico).
- Migração automática: quem já tinha uma nota antiga (v1.2.0, salva em `chrome.storage.local`) recebe essa nota como "Nota 1" na primeira abertura após a atualização — nada se perde.
- "Limpar tudo" agora limpa todas as notas e recria uma única nota vazia.

### Revisão pós-feedback: marcadores escondidos + mais sintaxe

- **Marcadores (`**`, `*`, `` ` ``, `~~`, `#`) agora só aparecem na linha onde está o cursor** — estilo Obsidian/Typora "live preview". Fora dela ficam com `visibility: hidden` (continuam ocupando o mesmo espaço, por isso não desalinham o textarea invisível por baixo — só não removi os caracteres, apenas os torno invisíveis).
- **H1/H2/H3** ganharam botões próprios na barra (antes só existia um botão genérico de título).
- **Listas com marcador (`•`) e numeradas (`1.`)** — novos botões. O marcador (`-`/`*` vira `•`; `1.` fica como digitado) é sempre visível, faz parte da estrutura da lista, não entra na lógica de esconder por cursor. O marcador só reivindica o prefixo da linha, então negrito/itálico dentro do item de lista continuam funcionando.
- Barra de ferramentas dividida em duas: transformações de texto (maiúsculo, minúsculo, etc.) na primeira linha, formatação Markdown na segunda.

### Por que os títulos não ficam com fonte maior

O tamanho da fonte é fixo (não muda por título) de propósito: se um título mudasse de tamanho, uma linha comprida poderia quebrar em duas linhas *só na camada visual* (que é mais larga que a real a 13px), enquanto o textarea invisível por baixo continua contando aquilo como uma linha só — a partir daí a nota inteira abaixo do título fica com a posição do cursor desalinhada do que é mostrado. É um risco silencioso (só aparece com título comprido), por isso os títulos se diferenciam apenas por negrito/cor/sublinhado (que não mudam quebra de linha), não por tamanho.

### Segunda rodada: H4–H6, citação, linha horizontal, checklist

- **H4, H5, H6** — reconhecidos e estilizados (negrito, mais discretos que H1–H3); sem botão próprio na barra (H1–H3 cobrem o uso comum; `####` etc. dá pra digitar direto).
- **Citação (`>`)** — texto em itálico, marcador sempre visível (não soma à lógica de esconder por cursor, funciona como as listas). Negrito/itálico *dentro* de uma citação ou título não renderiza (mesma limitação: eles reivindicam a linha inteira para estilizar o texto todo).
- **Linha horizontal (`---`)** — vira uma linha fina sob o próprio texto digitado. Não estica de borda a borda do painel (isso exigiria um elemento de bloco à parte, incompatível com o modelo atual de span contínuo).
- **Checklist (`- [ ] texto`)** — Ctrl+clique na caixa alterna marcado/desmarcado, editando o texto de verdade (não é só visual). Cor muda mesmo sem segurar Ctrl (cinza/verde), igual ao CPF inválido já fazia.
- Ainda não implementado: links, tabelas, bloco de código multi-linha — não foram pedidos; links e código-bloco são viáveis com mais esforço, tabelas e imagem inline de verdade exigiriam trocar a base do editor (ver explicação acima).

> **Nota (pós v1.4.0)**: a seção "Por que os títulos não ficam com fonte maior" acima descreve a limitação do editor *antigo* (textarea + overlay). Desde a reescrita v1.4.0 pra blocos de verdade (contenteditable), H1–H6 já são tags reais com tamanho de fonte de verdade — essa limitação não existe mais.

## Controles de bloco estilo Notion + Markdown/exportação

### 1. Botão "+" e alça de arrastar (hover no canto esquerdo)
Overlay flutuante único (não embrulha cada bloco) que segue o mouse sobre `#note-editor-blocks`, descobre o bloco sob o cursor via `getBoundingClientRect` e se posiciona à esquerda dele. Clique no "+" insere parágrafo vazio abaixo; Ctrl+clique insere acima.

### 2. Arrastar e soltar com linha indicadora
Implementado na mão com mousedown/mousemove/mouseup (não a API nativa de Drag and Drop — comportamento inconsistente com scroll e imagem de arrasto). Move o(s) elemento(s) de verdade no DOM (`insertBefore`/`after`), não recria — formatação não se perde. Linha indicadora fina mostra onde vai cair. Entra no histórico de undo.

### 3. Seleção múltipla de blocos de tipos diferentes
**Decisão**: Shift+clique nas alças "⠿" — modo de seleção de blocos próprio (independente de seleção de texto), com destaque visual (fundo claro) nos blocos selecionados. Arrastar qualquer um dos selecionados move o grupo inteiro junto, mantendo ordem relativa e formatação de cada um.

### 4. Copiar como Markdown / texto simples
- Novo `blocksToMarkdown(blocks)` em `blocks.js`: reconstrói bloco + formatação inline (`#`, `-`, `**`, `*`, `~~`, `` ` ``) — mais completo que o `blocksToPlainText` atual, que já perde negrito/itálico ao gerar o campo `content`. Aproveitar pra trocar o campo `content` interno (usado como fallback de notas antigas) por essa versão — deixa a migração mais fiel de quebra.
- Novo `blocksToPlainText(blocks)` redesenhado: texto realmente simples, sem nenhum caractere de markdown.
- **Decisão**: Ctrl+C continua copiando texto simples (comportamento já corrigido); "Copiar como Markdown" vira ação separada no menu "⋯" da aba.

### 5. Baixar nota (.txt/.md) e importar (.md/.txt)
Baixar: Blob + download nativo do navegador, sem permissão nova no manifest. Importar: `<input type="file" accept=".md,.txt">`, conteúdo lido e passado pro mesmo `parseMarkdownToBlocks` já usado na migração (um `.txt` sem sintaxe especial só vira parágrafos, então serve pros dois formatos).

### Decisões confirmadas
- Multi-seleção: Shift+clique nas alças de bloco.
- Copiar Markdown / texto / baixar / importar: menu "⋯" por aba de nota (botão de importar ao lado do "+ Nova nota").
- Ctrl+C padrão continua texto simples.
- Arrastar blocos: só dentro da mesma nota (mover entre notas continua sendo copiar/colar).

### Ordem de implementação
1. ✅ Exportar/importar (baixo risco, independente, entrega valor rápido)
2. ✅ Botão "+" / alça / seleção múltipla / menu "Transformar em"
3. ✅ Arrastar (um bloco ou grupo selecionado) com linha indicadora

Os três passos planejados estão implementados.

### Adendo: menu da alça "⠿" (inspirado no menu de bloco do Notion)

Ao clicar na alça (sem arrastar) abre um menu com **Transformar em** (lista de tipos, reaproveitando os mesmos itens do menu "/"), **Duplicar** e **Excluir** — não os itens específicos do Notion que não fazem sentido aqui (link pro bloco, comentário, pedir à IA, habilidades).

- Ctrl+clique na alça seleciona um intervalo de blocos (independente do tipo de cada um), com destaque visual.
- Se o bloco clicado faz parte de uma seleção múltipla ativa, a ação do menu (transformar/duplicar/excluir) vale pra todos ela; senão, só pra esse bloco.
- Backspace/Delete com blocos selecionados também remove todos de uma vez.
- `#note-editor-blocks` ganhou padding-left maior (34px) pra abrir espaço pros controles; o overlay fica fora do editável (irmão dele dentro de `.note-editor`), pra não interferir na lógica que trata `root.children` como só blocos.

### Adendo 2: arrastar pra reordenar + Ctrl+arrastar pra selecionar (de qualquer lugar do bloco)

A alça distingue clique de arrasto pelo deslocamento do mouse (menos de ~4px ainda conta como clique). Arrastar a alça sem Ctrl move o bloco (ou o grupo, se ele fizer parte de uma seleção múltipla ativa) — o elemento é realmente movido no DOM (`before`/`after`), não recriado, então a formatação nunca se perde. Uma linha fina indica onde vai cair, calculada pelo bloco mais próximo verticalmente do cursor.

**Revisão**: o gesto de seleção múltipla trocou de Shift pra **Ctrl** (mais parecido com o "arrastar pra selecionar" do Windows, por pedido) e passou a funcionar **a partir de qualquer ponto do bloco** — não só em cima do ícone da alça, que era limitado demais. Um listener separado em `root` escuta `mousedown` com Ctrl segurado em qualquer lugar dentro de um bloco e só ativa a seleção quando o mouse realmente se move; um Ctrl+clique parado (sem arrastar) continua funcionando normal pro menu de cópia de CPF/data/cálculo, que é outro uso já existente do Ctrl no app.

Proteção: se o botão do mouse for solto fora da janela do painel (fácil de acontecer, já que é estreito) e o evento `mouseup` não chegar, o próximo `mousemove` detecta `e.buttons === 0` e encerra o arrasto sozinho, em vez de deixar preso.

## Redesenho do header das abas de notas

Decisões:
- **Ícones**: fonte completa do Google Fonts (Material Symbols), carregada via `<link>` no `index.html`. Primeira dependência externa da extensão — aceito porque o app só faz sentido com o Chrome aberto e internet disponível (é uma extensão de navegador, não uma ferramenta offline). Renderização via `<span class="material-symbols-outlined">nome_do_icone</span>`, cobre o catálogo inteiro do site — o usuário pode ir em fonts.google.com/icons, pegar qualquer nome e colar.
- Cada nota ganha `icon` (nome do ícone ou nulo) e `tabDisplay` (`'icon' | 'color' | 'text' | 'all'`, padrão `'color'` — não muda o visual de quem já tem notas).
- Excluir sai da aba (não fica mais "à mão"), entra no menu "⋯": Renomear, Ícone, Cor — divisor — Copiar Markdown/texto, Baixar .md/.txt — divisor — Excluir.
- "Ícone" e "Cor" abrem um popover cada um, com um seletor de modo (Ícone/Cor/Texto/Tudo) no topo — dá pra ajustar o modo de exibição sem precisar de um item de menu à parte.
- Botão "☰" no início da barra: lista todas as notas num popover (resolve depender só da rolagem horizontal).
- "Nova nota" e "Importar" viram um botão só, com menuzinho de duas opções.

