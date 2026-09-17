# Planejamento — Próximas atualizações do QuickDock

> Descreve abordagem e decisões para cada feature, com base no projeto (extensão Chrome MV3, side panel com nota em textarea + overlay de highlight regex, documentos em IndexedDB via Dexie, modal de preview, tema claro/escuro).

## Status

Itens 1–5 **implementados** (v1.3.0). Item 6 (calculadora avançada) segue pendente de detalhamento.

## Reescrita v1.4.0: editor de blocos

O editor de notas deixou de ser um textarea com camada de decoração por cima e virou um editor de **blocos reais** (`contenteditable`):

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
- **Sem arrastar blocos** para reordenar (a alça "⋮⋮") — não foi pedido.
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

Consequência natural do item 2: cada nota no Dexie ganha um campo `color`, com um seletor de paleta e a cor aplicada como indicador visual na lista/aba da nota. Precisa de um conjunto de cores que funcione nos dois temas (claro/escuro).

## 4. Redimensionar área de notas x área de arquivos ✅

O layout do painel é uma coluna única (`#app { flex-direction: column }` em `sidepanel/style.css`), com `note-section` em cima e `docs-section` embaixo. Dá pra colocar uma barra divisória arrastável (drag handle) entre as duas seções, redistribuindo a altura de cada uma via arrasto vertical, com limites mín/máx, e salvando a proporção escolhida (persistente entre sessões).

## 5. Navegação entre imagens no modal (setas / menu numérico) ✅

**Situação atual**: `openModal(id, name, type)` em `sidepanel/modules/modal.js` abre um arquivo isolado, sem noção de "galeria" — não sabe quem é o próximo/anterior.

**Abordagem**: passar pro modal a lista ordenada dos arquivos visíveis (do grid atual), pra ele saber a posição do item aberto e navegar com setas (⟵/⟶ na toolbar + teclado) e um indicador tipo "3/12" clicável, que abre um mini-menu/thumbstrip pra pular direto pra um arquivo específico.

**Decisão tomada**: navegação limitada a imagens (é o que foi pedido literalmente — "passar de uma imagem para outra"). PDF/txt continuam abrindo normalmente, sem setas.

## 6. Calculadora avançada nas notas

Já existe uma base pronta e **não usada**: `loadMathHistory`/`saveMathHistory` em `sidepanel/modules/storage.js`, e um parser matemático seguro e robusto em `sidepanel/modules/math-parser.js` (usado hoje só pra detectar contas soltas dentro do texto da nota). Isso já é meio caminho andado pra uma calculadora com histórico.

**Definido** — virou a rodada v2.0, no fim deste documento: um bloco de cálculo com variáveis, moeda como unidade e resultado por linha.

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

## Controles de bloco + Markdown/exportação

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

### Adendo: menu da alça "⠿"

Ao clicar na alça (sem arrastar) abre um menu com **Transformar em** (lista de tipos, reaproveitando os mesmos itens do menu "/"), **Duplicar** e **Excluir** — sem os itens de editores colaborativos que não fazem sentido aqui (link pro bloco, comentário, pedir à IA).

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


## v1.9 — Imagens na nota, aninhamento e correções de colagem

### O diagnóstico: uma lacuna explica quase tudo

O modelo de blocos é **plano**: uma linha = um bloco, e um bloco tem um tipo só. Não existe "bloco que contém blocos". Isso é a causa única de coisas que parecem separadas:

- Colar uma citação com título e lista dentro (markdown básico) produz seis blocos soltos, com `####` e `-` virando texto literal.
- Não há lista dentro de lista, nem parágrafo dentro de item.
- Toggle, callout e coluna — os itens que faltam pro padrão de editor de blocos — são todos "bloco com filhos".

Por isso a Etapa 1 abaixo é a alavanca: sem ela, cada um desses vira uma gambiarra isolada.

### Segurança dos dados existentes — regras que valem para todas as etapas

Ninguém pode perder nota por causa desta rodada. São regras, não boas intenções:

1. **Todo campo novo é opcional, com default seguro na leitura.** `depth ?? 0`, `quoted ?? false`. Nunca uma migração que varre e reescreve o banco.
2. **O leitor aceita formato velho e novo; o escritor só emite o novo.** Uma nota antiga só muda de forma quando a pessoa a editar. Quem não abrir a nota, não corre risco nenhum.
3. **Dexie só ganha `version()` que adiciona índice.** Nunca remover store nem campo. O padrão já usado em `noteId` (documentos) e `kind` (modelos) deu certo duas vezes.
4. **O campo `content` continua sendo gravado a cada save.** Ele é markdown completo e é a rede de recuperação se `blocks` ficar inválido por um bug nosso. Hoje já funciona assim; a partir daqui é obrigação, não detalhe.
5. **Backup em lote antes de mexer no modelo.** Um item "Baixar todas as notas (.md)" no menu ⋯, que gera um arquivo por nota. É meia tarde de trabalho e é o seguro de todo o resto. **Entra antes da Etapa 1.**
6. **Fixtures de regressão.** Um arquivo com blocos reais no formato de hoje, e um teste que faz `parse → serialize → parse` e compara. Roda antes e depois de cada etapa. Sem isso, "não quebrou" é chute.

### Etapa 0 — Correções de perda de conteúdo

Pequenas, independentes do resto, e as únicas que hoje **perdem** o que a pessoa colou:

- **Tabela colada como texto markdown vira tabela vazia.** O parser acerta as linhas, mas `pasteMultilineText` monta os blocos sem repassar `rows`. Auditar todas as chamadas de `createBlockEl` — essa assinatura já tem quatro parâmetros e é fácil esquecer o último.
- **Colar imagem com o cursor na nota.** Os dois handlers disparam: o de `note.js` (em `root`) e o de `documents.js` (em `document`). O primeiro não interrompe a propagação. Hoje o efeito é benigno porque a nota não trata imagem, mas vira conflito na Etapa 3 — resolver a precedência agora.

### Etapa 1 — Indentação e aninhamento

**Decisão: profundidade plana, não árvore.** Cada bloco ganha `depth: 0..5`. O pai é implícito — o bloco anterior com `depth` menor.

Por que não árvore de filhos: `serializeBlocks()` continua devolvendo um array simples, e com isso arrastar pra reordenar, seleção múltipla, undo por `innerHTML` e renumeração continuam funcionando sem reescrita. Uma árvore obrigaria a refazer os quatro. O custo é que relações pai/filho são convenção, não estrutura — suficiente pra lista aninhada e citação com conteúdo, que é o grosso do uso.

- **Tab indenta, Shift+Tab desindenta.** Tab já tem dois donos: navegar célula de tabela e confirmar item no menu "/". Precedência: célula > menu > indentar.
- **Teto de 5 níveis.** O painel é estreito; escada infinita vira texto de 3 colunas.
- **Parser**: espaços/tabs à esquerda viram `depth`. Serializador emite dois espaços por nível — que é o que o markdown espera e o que qualquer outro editor vai ler de volta.
- **`renumberLists()`** passa a numerar por nível, reiniciando a cada mudança de profundidade.
- **Migração**: bloco sem `depth` é nível 0. Visualmente nada muda pra quem já tem notas.

### Etapa 2 — Citação com filhos

**Decisão: `quoted` é decoração, não tipo.** Um bloco ganha `quoted: true` de forma ortogonal ao `type`. Assim `> #### Resultado` vira um `heading4` com `quoted`, e é isso que faz o título e a lista funcionarem dentro da citação — o conteúdo depois do `>` é reprocessado como linha normal, em vez de virar texto literal.

- **Compatibilidade**: o tipo `quote` continua sendo lido. Na leitura, normaliza pra `paragraph + quoted`; o escritor emite a forma nova. Nota antiga abre igual.
- **Render**: blocos `quoted` consecutivos ganham uma barra lateral contínua, em vez de uma barra por linha.
- Resolve exatamente o exemplo que motivou esta rodada.

### Etapa 3 — Imagens na nota

**Decisão: guardar Blob, exportar base64.** Base64 dentro do bloco parece simples e é a escolha errada: a nota inteira é regravada a cada autosave (800 ms depois de parar de digitar), então um print de 2 MB embutido significa 2 MB reescritos a cada pausa.

- **Guardar** na tabela `files`, que já existe, com marca de `inline` — imagem da nota não aparece na seção Documentos.
- **Bloco**: `{ type: 'image', fileId, alt }`, `contenteditable="false"`, mesmo padrão da tabela.
- **Render** por `URL.createObjectURL`. **Revogar ao trocar de nota** — senão vaza memória a cada troca de aba.
- **Ações no hover**: trocar, remover, texto alternativo.
- **Clique abre o visualizador** do `modal.js`, que já tem zoom, girar e navegação entre imagens.
- **Colar**: cursor na nota → inline; fora → Documentos. Depende da precedência resolvida na Etapa 0.
- **Arrastar** arquivo de imagem pra dentro do editor → inline.
- **Exportar**: `![alt](data:image/...;base64,...)` na hora de gerar o `.md`. Nota leve no banco e exportação portátil; o custo é exportação lenta em nota cheia de imagem.
- **Importar**: `data:` vira Blob. URL remota é decisão de privacidade — abrir a nota faria a imagem ser baixada do servidor de terceiro, entregando IP e momento da leitura. Recomendação: baixar e embutir na importação, ou avisar explicitamente.
- **Excluir nota**: hoje `detachFilesFromNote` transforma os arquivos em gerais. Imagem inline precisa de regra própria — ela só existe dentro daquela nota, então vai junto.

### Etapa 4 — Inline que ainda falta

`**negrito**`, `*itálico*`, `~~riscado~~` e crase **já convertem ao digitar** (`INLINE_SHORTCUTS`). Falta:

- `[texto](url)` virar link ao digitar. O mecanismo atual assume um grupo de captura por atalho; link precisa de dois.
- `![alt](url)` virar imagem, depois da Etapa 3.

### Ordem

Backup em lote → fixtures de regressão → Etapa 0 → 1 → 2 → 3 → 4.

As duas primeiras não são features, são a condição pra mexer no modelo sem apostar. A Etapa 0 vem antes porque é correção de perda de dado e não depende de nada. A 2 depende da 1, e a 4 depende da 3.

### Fora desta rodada

Toggle, callout, colunas, banco de dados, menções, comentários e blocos sincronizados. Todos ficam substancialmente mais baratos depois da Etapa 1 — vale reavaliar só depois dela.

### O que mudou na execução

Três decisões saíram diferentes do planejado, e por bons motivos:

1. **O backup virou um arquivo só, e restaurável.** O plano pedia um arquivo por nota. Vários downloads de uma vez fazem o navegador pedir permissão, e um punhado de arquivos soltos é pior de guardar. O formato ganhou um marcador por nota (`<!-- quickdock:nota "…" -->`), e a importação reconhece e recria as notas separadas. Restaurar passou a ser um recurso, não um trabalho manual. Fora do QuickDock continua sendo markdown comum.
2. **Endereço remoto de imagem não vira imagem.** O plano deixava em aberto entre baixar-e-embutir ou avisar. Nenhum dos dois: vira link. Assim nada é baixado sem a pessoa pedir, e o endereço não se perde — clicar continua abrindo.
3. **A imagem órfã é recolhida na abertura do painel, não na hora.** Apagar o arquivo junto com o bloco quebraria o Ctrl+Z: o bloco voltaria sem a imagem. Na abertura não existe histórico de desfazer pra atrapalhar.

Também apareceram na conferência dois problemas de perda de conteúdo que não estavam no plano, do mesmo tipo do da tabela colada: **duplicar uma tabela** devolvia uma tabela vazia, e **"Transformar em"** aplicado a uma tabela despejava o HTML dela dentro de um parágrafo. A causa é a mesma — `createBlockEl` tem parâmetros posicionais e é fácil esquecer o último —, então a correção foi eliminar a causa: existe um `createBlockElFrom(bloco)` só, e um teste que falha se alguém voltar a montar bloco na mão.

### Testes

`node test/run.mjs` — 134 verificações. Cobre: blocos no formato v1.8 abrindo e voltando iguais, markdown de fora, indentação vinda de 2/3/4 espaços e tab, citação com filhos, imagens (inclusive a regra de privacidade e a de não embutir base64 no autosave), backup, atalhos ao digitar, e a nota-tutorial inteira.

O que os testes **não** cobrem, e por que: o editor só existe dentro do navegador. `test/indent.mjs` contorna isso recortando as funções de indentação do `note.js` e rodando-as contra blocos de mentira — o que é testado é o código de verdade, mas o recorte é por nome e quebra se alguém renomear as funções (de propósito: quebrar alto é melhor que testar uma cópia velha). Colar, arrastar, o visualizador e o ciclo de vida dos objectURL continuam sem cobertura automatizada.


## v2.0 — Bloco de cálculo

Uma folha de conta dentro da nota: variáveis, fórmulas e o resultado de cada linha aparecendo ao lado enquanto se digita.

```
boleto = R$ 1.000,00            R$ 1.000,00
imposto = 15%                          15 %
calculo = boleto - imposto        R$ 850,00
```

### O que já está pronto

Metade do problema já foi resolvida no `math-parser.js`, e a rodada se apoia nisso em vez de recomeçar:

- **Sem `eval` nem `Function`** — parser recursivo descendente escrito à mão. Não é preferência: MV3 proíbe, e a política de conteúdo da extensão não abre exceção.
- **Percentual contextual** — `1000 - 15%` já subtrai 15% *de* 1000. É exatamente a semântica que o exemplo acima exige.
- **Número pt-BR** — `1.000,00` já entra certo, com a regra do ponto só valer como milhar quando vem seguido de três dígitos.
- **Passo a passo** de cada operação e formatação de saída em pt-BR.

Falta a camada de cima: valor com unidade, variáveis, várias linhas com estado entre elas, e o resultado na tela.

### As decisões, e por quê

**Cada linha é um bloco `calc`; linhas coladas formam uma folha.** É o mesmo padrão do destaque: o modelo continua plano e a "folha" é a sequência contígua. O ganho é grande — Enter, Backspace, setas, arrastar, selecionar, desfazer, indentar e imprimir já funcionam, sem construir um mini-editor dentro de um bloco. A alternativa (um bloco multilinha com `<br>`, como o de código) obrigaria a reimplementar navegação de linha na mão, e ainda deixaria o resultado sem onde morar.

**A folha é o escopo das variáveis.** Uma linha em branco ou um parágrafo comum encerra a folha e começa outra. Sem efeito à distância: nada de um bloco lá em cima quebrar um cálculo muito abaixo.

**O resultado não é conteúdo editável.** Vive num `<span contenteditable="false">` à direita, na mesma estrutura de dois elementos que lista e checklist já usam (marcador + `.block-content`). Isso faz `getContentEl`, a serialização e o salvamento continuarem valendo sem tocar em nada — e impede que o cursor entre no resultado ou que ele seja apagado sem querer.

**O resultado nunca é gravado.** O banco guarda só o texto da linha. Guardar o número criaria a chance de ele discordar da conta, e não haveria como saber qual dos dois está certo.

**Variável guarda tipo, não número.** É a consequência menos óbvia e a que decide se a coisa funciona:

```
imposto = 15%
calculo = boleto - imposto
```

Para isso dar R$ 850,00, `imposto` não pode virar `0,15` na hora em que é definido — ele precisa continuar sendo "quinze por cento" até ser usado, e só então descobrir de quem. Então o avaliador deixa de devolver `number` e passa a devolver `{ n, moeda, pct }`.

Regras de unidade:

| Operação | Resultado |
|---|---|
| moeda + número puro | moeda (o número puro herda) |
| moeda × número | moeda |
| moeda ÷ moeda | número puro (é uma razão) |
| valor + p% | p% *do* valor à esquerda |
| valor × p% | p/100 como fator |

**`let` é opcional.** `let boleto = 1000` e `boleto = 1000` são a mesma coisa. Quem não programa não vai escrever `let`, e recusar seria implicância.

**Linha que não é conta é só texto.** "Cliente ligou 3ª vez" fica lá, sem resultado e sem erro. Erro só aparece quando a linha *é* uma conta e falha — variável que não existe, parêntese aberto. A regra: linha com `=` é uma atribuição e erra alto; linha sem `=` que não avalia é texto e fica quieta. `//` no começo também é comentário.

### Etapa 0 — Valor com unidade

Só o avaliador, sem interface. O `math-parser.js` passa a trabalhar com `{ n, moeda, pct }` em vez de `number`, reconhece `R$` na entrada e devolve o resultado formatado com a unidade.

Vem primeiro de propósito: é a única parte **testável de ponta a ponta fora do navegador**, e é onde moram as decisões difíceis. Entra na suíte junto com o resto.

### Etapa 1 — O bloco e a folha

Tipo `calc` no menu "/" e no "Transformar em". Cada linha calcula sozinha, ainda sem variáveis, e mostra o resultado à direita. Marcação das pontas da folha (primeira e última linha) pra que uma sequência leia como um bloco só — mesma mecânica do `markCalloutEdges`.

`calc` entra no `NO_DETECTION`: a folha inteira é cálculo, então a detecção de CPF/data/conta em texto solto não tem o que fazer ali dentro.

### Etapa 2 — Variáveis

Avaliação sequencial da folha, de cima pra baixo, carregando um mapa de variáveis. Atribuição, reatribuição e referência.

Como a avaliação é em uma passada e de cima pra baixo, **ciclo não existe**: usar antes de definir é erro de "ainda não definido", e não travamento. Recalcula a cada tecla — a folha tem dezenas de linhas, não milhares.

### Etapa 3 — Funções e `acima`

`soma()`, `média()`, `arredondar()`, e uma palavra para "tudo que está acima": empilhar valores e fechar o total sem repetir nome de variável.

**`acima` para na primeira linha sem valor** (texto livre ou linha em branco). É o que torna previsível uma folha com vários blocos de soma.

Palavra reservada não pode virar nome de variável — `soma = 10` dá erro claro, em vez de quebrar a função em silêncio.

### Etapa 4 — Exportar com o resultado

```
boleto = R$ 1.000,00            // R$ 1.000,00
calculo = boleto - imposto      // R$ 850,00
```

Dentro de um bloco cercado com marca `calc`. Quem recebe vê o valor sem ter o QuickDock; fora daqui é um bloco de código comum.

**O resultado só entra na exportação, nunca no `content` interno** — mesma divisão da imagem, que guarda referência e só vira base64 ao sair. Na reimportação o comentário é descartado e tudo é recalculado, então dentro da extensão nunca existe valor desatualizado.

### Riscos conhecidos

**Ponto flutuante em dinheiro.** `0,1 + 0,2` não dá exatamente `0,3`. Hoje o `fmt` limpa isso na exibição com `toPrecision(10)`, e para a escala de um bloco de notas isso resolve. A alternativa correta — guardar centavos como inteiro — muda o avaliador inteiro. **Decisão: fica como está, documentado.** Se aparecer diferença de um centavo somando muitos valores, aí sim vale mudar.

**Coluna estreita.** O painel é estreito e o resultado disputa espaço com a fórmula. O resultado tem largura máxima e o texto encolhe antes dele; se ainda assim não couber, a fórmula quebra em duas linhas e o resultado fica na última.

### Fora desta rodada

Data e prazo (`hoje + 15 dias`), dias úteis e feriados, mais de uma moeda, gráfico, e referência de uma folha em outra. Data é uma segunda linguagem dentro da mesma — vale fazer depois, vendo como a primeira é usada, em vez de adivinhar agora.

## v3.0 — Sincronização na conta do usuário, PWA e compartilhamento

Hoje o QuickDock existe num perfil do Chrome e em mais lugar nenhum. Limpar dados do navegador apaga tudo, e não há como abrir a mesma nota no celular. Esta rodada resolve as duas coisas — sem servidor, sem banco nosso e sem custo que cresça com usuário.

### A escolha central: o dado não é nosso

A pergunta de origem era "qual banco de dados grátis usar". A resposta que ficou é que **não vai ter banco nosso**.

Cada usuário entra com o Google dele, e as notas viram **arquivos numa pasta do Drive dele**, consumindo os 15 GB dele. Isso resolve três problemas de uma vez:

- **Custo.** Não pagamos armazenamento nunca, com 10 ou com 10 mil usuários. A única coisa que escala com gente é cota de API, contada por usuário e folgada para um app de nota.
- **Confiança.** As notas do QuickDock detectam CPF e CNPJ — é o tipo de conteúdo de que ninguém quer ser depositário. Com a pasta na conta do usuário, não somos.
- **Saída.** Se o projeto parar amanhã, ninguém perde nada: os arquivos continuam lá, em markdown legível, abrindo no Obsidian, no VS Code ou no bloco de notas do celular.

O que se recusou, e por quê:

| Opção | Por que não |
|---|---|
| Supabase / Firebase | Resolvem bem, mas nos tornam donos do dado alheio e têm teto no plano grátis |
| Cloudflare D1 + R2 | Melhor economia de todas, mas zero OAuth pronto — autenticação inteira por nossa conta |
| WebRTC / P2P | Não elimina servidor (sinalização e TURN) e exige os dois online ao mesmo tempo. Ver "Compartilhar" |

### Metade disso já está pronta

Vale registrar porque muda a estimativa: o `backup.js` já faz N notas → markdown → N notas de volta, sem DOM e sem banco, com teste. O `FILE_REF_RE` em `blocks.js` já é o ponto de indireção onde `quickdock:file/12` vira caminho. A peça difícil — representar o modelo de blocos como texto honesto — existe e passa nos testes.

A pasta sincronizada é o mesmo formato do backup, com um arquivo por nota em vez de marcadores num arquivo só.

### O formato da pasta

```
QuickDock/
├── notas/
│   ├── atendimento-maria-silva.md
│   └── ideias.md
├── modelos/
│   └── checklist-de-atendimento.md
└── imagens/
    └── a1b2c3d4e5f6.png
```

Cada nota é um `.md` com frontmatter carregando só o que o markdown não sabe dizer — exatamente os campos da tabela `notes` que não são `blocks`:

```markdown
---
quickdock: 1
id: 3f9a7c21-...
titulo: Atendimento — Maria Silva
cor: azul
icone: folder
iconePreenchido: true
tituloOculto: false
ordem: a0V
criadoEm: 2026-03-12T09:14:00Z
---

# Atendimento — Maria Silva

**Nome:** Maria Silva
![print do portal](../imagens/a1b2c3d4e5f6.png)
```

O `content` não vai para o arquivo: ele é derivado dos blocos e seria uma segunda verdade esperando divergir.

### As três decisões estruturais

**Nada de arquivo de índice.** A tentação é um `index.json` com ordem e cor de todas as notas. É a pior forma possível: todo aparelho escreve nele o tempo todo, e reordenar uma nota vira conflito no arquivo que descreve *todas*. Em vez disso cada nota se descreve sozinha, e a ordem vira **índice fracionário** (`a0`, `a0V`, `a1`) — inserir entre duas não toca em nenhuma outra. A pasta *é* o banco.

**O id mora no frontmatter, nunca no nome do arquivo.** Assim o usuário renomeia `ideias.md` para `ideias-2026.md` dentro do Drive e nada quebra — seguimos o id, não o nome. Nome de arquivo vira enfeite legível, que é o papel certo dele.

**O estado de sincronização é local e nunca sobe.** Cada aparelho guarda no Dexie "a nota X eu sincronizei na revisão N, com este hash". É isso que permite distinguir arquivo apagado de arquivo que nunca chegou, sem lápide compartilhada. Some junto com o aparelho, e tudo bem: sem esse estado, a sincronização seguinte trata tudo como novo e reconcilia.

### O laço de sincronização

```
Ao abrir · ao voltar o foco · a cada N minutos:
  1. pergunta o que mudou lá       (Drive: changes.list com pageToken)
  2. baixa o que mudou, compara com o hash da última sincronização
  3. sobe o que mudou aqui         (debounce ~20s — nunca a cada tecla)
  4. colisão → cópia de conflito + aviso na interface
```

Baixar antes de subir, sempre. O `flushSave` que já existe é o gancho natural do passo 3.

Sem servidor não existe push: a latência realista é de até um minuto. Para nota pessoal, está bom. Prometer tempo real aqui seria mentira.

### Conflito: preservar sempre, mesclar depois

Não há árbitro. A regra é a do próprio Dropbox: se os dois lados mudaram desde a última base, **não mescla e não sobrescreve** — grava `ideias (conflito 2026-09-16, Celular).md` e avisa. Chato, raro, e nunca perde nada.

A versão boa vem depois e só é possível por causa dos UUIDs da Etapa 0: com base, local e remoto, e blocos com id estável, dá para fazer **mesclagem de três vias no nível do bloco**. Bloco acrescentado aqui mais bloco editado lá se resolvem sozinhos; só conflita edição no *mesmo* bloco.

Na prática o caso comum nem é edição simultânea — é "editei no note, fechei, abri no celular antes de subir". Raro e recuperável é o alvo certo para a primeira versão.

### Imagens: nome derivado do conteúdo

Hash do blob vira o nome: `imagens/a1b2c3d4e5f6.png`. Três coisas de graça:

- **Dedup** — o mesmo print colado duas vezes é um arquivo só.
- **Imutabilidade** — o arquivo nunca muda, então nunca conflita.
- **Download preguiçoso** — baixa na primeira vez que renderiza, não na sincronização. O celular agradece.

### Compartilhar

Três coisas diferentes costumam receber esse nome, e a resposta muda em cada uma:

**Mandar uma nota para alguém.** Já está pronto: `buildBackup`/`parseBackup` geram e leem `.md`. Falta um botão. Quem recebe abre no que tiver, mesmo sem o QuickDock.

**Nota que dois mexem ao longo do tempo.** O Drive já construiu isso — compartilhamento, permissão, revogação, histórico. A nota é um arquivo. Não escrevemos nada.

Uma quina: o escopo `drive.file` só enxerga arquivo que o nosso app criou. Para a outra pessoa abrir no QuickDock dela, o caminho oficial seria o Google Picker, que carrega script remoto — e **o MV3 proíbe código hospedado fora**. Na extensão isso degrada para "baixa o `.md` e importa". No PWA o Picker funciona.

**Editar junto, ao vivo.** É o único caso em que WebRTC seria a resposta certa, e ele fica fora desta rodada. Registrado porque foi avaliado: P2P não elimina servidor (sinalização precisa existir, e de 10% a 20% das conexões caem em TURN, que é banda paga), e exige os dois online no mesmo instante — formato errado para nota. Se um dia for feito, a sinalização pode passar pela própria pasta compartilhada, e a mesclagem deve ser CRDT (Yjs), não manual.

### O que isso impede para sempre

Sem servidor não existe: busca no que ainda não foi baixado, link público para uma nota, notificação, e colaboração em tempo real. Se algum desses virar requisito, a arquitetura não estica — troca. É escolha, não caminho para tudo.

### Google Cloud Console — o que existe e por quê

Projeto **novo e separado** do Nexus. Projetos são isolados (OAuth client, tela de consentimento, escopos, cotas e **status de verificação** são todos por projeto), então não há conflito — e separar é o certo justamente porque verificação é por projeto: uma revisão do Google no QuickDock não pode ficar amarrada ao Nexus.

Dentro dele:

1. Ativar a **Google Drive API**.
2. **Tela de consentimento**, tipo de usuário External.
3. Adicionar o escopo **`drive.file`** — e conferir no próprio Console o rótulo de sensibilidade. `drive.file` é o escopo que o Google recomenda para ficar fora da categoria **restrita**, e essa diferença decide o projeto: escopo restrito exige avaliação de segurança anual paga, na casa dos milhares de dólares por ano. Para um app grátis, isso encerra o assunto.
4. **Dois OAuth clients no mesmo projeto**: tipo *Chrome Extension* (para `chrome.identity.getAuthToken`) e tipo *Web application* (para o PWA). Clients do mesmo projeto dividem a mesma tela de consentimento e a mesma verificação — o usuário vê o mesmo pedido, venha da extensão ou do site.

No `manifest.json` entram a permissão `identity` e o bloco `oauth2`.

**Usuários ilimitados: sim**, depois de publicar a tela em produção. Enquanto estiver em *Testing*, são 100 usuários no máximo, cada um cadastrado à mão pelo e-mail.

Duas pegadinhas que custam um fim de semana se descobertas tarde:

- **Refresh token morre em 7 dias no modo Testing.** Funciona hoje, deslogado na semana que vem. Não é bug nosso.
- **O ID da extensão muda a cada carregamento descompactado** — ele vem do caminho da pasta, e o OAuth client tipo Chrome Extension é amarrado a um ID fixo. Sem resolver, o login falha sempre. Solução: fixar o campo `key` no `manifest.json`. **É pré-requisito de tudo e não depende de nenhuma outra decisão, então vem primeiro.**

Nota adjacente: o manifesto pede `<all_urls>` com content script em tudo. É legítimo para o que a extensão faz, mas é a combinação que deixa a revisão da Web Store mais lenta. Vale ter a justificativa escrita antes de submeter.

### Hospedagem do PWA

**GitHub Pages**, repositório público (portanto grátis), servindo a partir de `/docs` — não da raiz, senão o site publica os `.zip`, o `PLANEJAMENTO.md` e a pasta `test/` junto.

Encaixa bem por dois motivos do projeto: **não existe build** (ES modules puros, Dexie versionado em `lib/`), então push é deploy; e a arquitetura não tem backend, que é a única coisa que o Pages não faz. A limitação do host e o desenho do produto concordam.

Quinas conhecidas:

- **Sem cabeçalho HTTP.** CSP vai em `<meta>`; cache quem controla é o service worker. Só doeria com `COOP/COEP`, que não é o caso.
- **Subpasta.** Em `arrtu-eedmns.github.io/QuickDock/` o escopo do service worker fica preso a `/QuickDock/`, e `start_url`, `scope`, ícones e registro do SW precisam todos carregar o prefixo. É o erro clássico: o app instala e abre em branco.
- **Sem rewrite.** Link direto dá 404; copiar `index.html` como `404.html` resolve.
- **Nome colidindo.** O `manifest.json` da raiz é o da extensão. O PWA precisa do dele, com outro formato e outro nome (`manifest.webmanifest`), em outra pasta.

**Domínio próprio (~R$50/ano) é o único gasto recomendado.** Não por vaidade: a tela de consentimento **mostra o domínio para o usuário** no momento em que ele decide dar acesso ao Drive dele — é o pior lugar possível para parecer improvisado. Além disso desamarra do GitHub (trocar de host vira mudar DNS, em vez de mexer em redirect URI de app já verificado) e resolve o problema de subpasta de graça.

Enquanto não houver domínio: `github.io` está na Public Suffix List, então `arrtu-eedmns.github.io` conta como site próprio e é verificável no Search Console por arquivo ou meta tag, que o Pages serve normalmente.

**Ganho de brinde:** o mesmo repositório servindo os dois clientes significa que `blocks.js`, `calc.js`, `math-parser.js` e `snapshot.js` são os *mesmos arquivos* na extensão e no PWA, sem cópia e sem divergir. Só o que toca `chrome.storage` e `chrome.identity` precisa de camada de plataforma — o mesmo padrão de adaptador que a sincronização já exige. O trabalho do adaptador paga duas contas.

### Etapa 0 — Identidade estável e round-trip idêntico

Nenhuma rede, nenhum fornecedor, nenhuma conta. É pré-requisito de todos os caminhos, inclusive do de desistir de todos.

**Identidade que viaja: `uid` ao lado do `id`, sem tocar na chave primária.**

O problema é real: hoje tudo é `++id` auto-incremento, e dois aparelhos offline criam a nota 7 cada um. Mas a primeira solução escrita aqui — trocar a chave primária por UUID e reescrever toda referência `fileId` dentro de todo bloco — era mais invasiva do que o problema exige. Fica registrada a correção:

O `id` inteiro continua existindo e passa a ser **explicitamente local**: nunca sai do aparelho. Ao lado dele entra `uid`, que é o que casa nota com arquivo. Os dois aparelhos podem ter `id` diferente para a mesma nota, e não há colisão, porque ninguém compara `id` entre aparelhos.

A referência de imagem também não precisa migrar. No arquivo a imagem é `../imagens/<hash>.png`, com o nome derivado do conteúdo; a tradução entre `fileId` local e hash acontece na camada de sincronização, em tempo de execução. É código, não migração de dado.

Sobra uma migração Dexie v6 pequena e segura: acrescentar `uid` indexado em `notes` e `templates`, preencher os existentes, e trocar `order` inteiro por `ordem` fracionária. Entra junto `updatedAt` confiável.

**Round-trip idêntico.** Hoje o bloco é a verdade e o markdown é exportação: se a exportação perde uma vírgula, dá para dar de ombros. **A partir desta rodada o arquivo vira a verdade**, e toda sincronização é um `blocos → md → blocos`. Qualquer perda deixa de ser chateação e vira corrosão — a nota degrada um pouco a cada ciclo, em todos os aparelhos, em silêncio, e o backup já está corroído também.

Então o `test/fixtures.mjs` passa a **afirmar identidade**, não semelhança: `blocos → md → blocos` tem que devolver exatamente a mesma estrutura, para cada fixture. A bancada já existe; o que muda é a severidade da asserção. O que o markdown não souber dizer ganha válvula explícita (comentário HTML), nunca silêncio.

Esse teste é a única coisa entre nós e estragar a nota das pessoas devagar. Ele vem antes de qualquer linha de OAuth.

### Etapa 1 — Adaptador e pasta local

Interface mínima: `autenticar()`, `listarMudancas(desde)`, `ler(caminho)`, `escrever(caminho, bytes, revBase)`, `apagar(caminho)`.

Primeiro adaptador: **pasta local**, via File System Access API. Sem OAuth, sem nuvem, sem ninguém no meio. O usuário aponta uma pasta — que pode já estar dentro do OneDrive ou do Syncthing — e pronto.

É o truque da rodada: valida a sincronização inteira (conflito, ordem, imagem, apagar) **antes de a autenticação existir para atrapalhar o diagnóstico**. E entrega, de quebra, a versão mais radical de "os dados são seus", que custa quase nada porque o formato já é arquivo.

### Etapa 2 — Google Drive

Segundo adaptador, sobre um mecanismo que já funciona. `changes.list` com `pageToken` para detectar mudança; login por `getAuthToken` na extensão.

### Etapa 3 — PWA

Camada de plataforma para o que hoje chama `chrome.*`, service worker, manifesto web, e o mesmo adaptador do Drive com OAuth de cliente público (PKCE). Publicação no GitHub Pages a partir de `/docs`.

### Etapa 4 — Compartilhar

Botão "Compartilhar" gerando `.md`, e importação de arquivo recebido. O compartilhamento contínuo sai de graça pelo próprio Drive.

### Riscos conhecidos

**Corrosão por round-trip.** O maior de todos, tratado na Etapa 0. Enquanto o teste de identidade não estiver verde, nada de sincronização.

**Token curto no PWA.** Cliente público não guarda segredo. O Google não emite refresh token nesse modo, e a renovação silenciosa depende de cookie de terceiro — funciona no Chrome e falha no Safari/iOS. Impacto: relogar de vez em quando no iPhone. Aceito por ora; se incomodar, o Dropbox emite refresh token para cliente PKCE e o adaptador já estará pronto.

**Google Docs convertendo `.md`.** Se o usuário abrir a nota no Docs por engano, o arquivo muda de tipo. Dá para detectar pela mudança de mimeType e avisar em vez de quebrar.

**Safari despeja IndexedDB** de site pouco usado. PWA instalado na tela inicial se safa; aba comum, não. Vale orientar a instalação.

**Cota de API por usuário.** Folgada para nota, mas subir a cada tecla estoura. Daí o debounce do passo 3 não ser opcional.

### Fora desta rodada

Edição simultânea ao vivo, CRDT, busca no que não foi baixado, link público, notificação, criptografia ponta a ponta. Esta última merece registro: resolveria de vez a questão do CPF, mas fecha a porta de busca no servidor e de recuperar senha — e, com o dado já na conta do próprio usuário, resolve um problema que esta arquitetura em boa parte já não tem.
