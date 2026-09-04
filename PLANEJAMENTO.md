# Planejamento — Próximas atualizações do QuickDock

> Descreve abordagem e decisões para cada feature, com base no projeto (extensão Chrome MV3, side panel com nota em textarea + overlay de highlight regex, documentos em IndexedDB via Dexie, modal de preview, tema claro/escuro).

## Status

Itens 1–5 **implementados** (v1.3.0). Item 6 (calculadora avançada) segue pendente de detalhamento.

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
- Os marcadores de markdown (`**`, `*`, `` ` ``, `~~`, `#`) ficam sempre visíveis no texto (só ficam discretos/apagados), não são escondidos dinamicamente pelo cursor — esconder haveria de rastrear a posição do cursor por linha, complexidade não necessária para o pedido atual.
- Itálico com `*` só é reconhecido sem espaço colado nos asteriscos (regra do CommonMark) — evita conflito com `*` usado como multiplicação nas contas (ex.: `2 * 3 * 4` continua sendo detectado como cálculo, não como itálico).
- Migração automática: quem já tinha uma nota antiga (v1.2.0, salva em `chrome.storage.local`) recebe essa nota como "Nota 1" na primeira abertura após a atualização — nada se perde.
- "Limpar tudo" agora limpa todas as notas e recria uma única nota vazia.
