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
