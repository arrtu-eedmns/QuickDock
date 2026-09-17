# HANDOFF 6 — Interface: toque, tamanhos, ícones e busca

Continuação de `HANDOFF.md` a `HANDOFF-5.md`. **Leia o `HANDOFF.md` §1, §2 e §3
primeiro** — regras, projeto e armadilhas. Nada dali se repete aqui.

Esta rodada é de **interface**, e é a primeira que mexe de verdade no que a
pessoa vê. As anteriores foram de dados e sincronização.

---

## 1. Onde estamos

O QuickDock roda hoje em três lugares:

| Contexto | Largura | Entrada |
|---|---|---|
| Painel da extensão | ~320–500px | mouse |
| PWA no computador | larga | mouse |
| PWA no celular | ~360–430px | **dedo** |

O terceiro é novo — a sincronização pelo Drive acabou de chegar ao celular — e a
interface nunca foi feita para ele. O levantamento:

```
eventos de toque no projeto ............  0
media queries de largura ...............  0   (só tema e movimento reduzido)
interações presas a Ctrl ...............  9   em 4 módulos
emojis usados como ícone ............... 55
```

Não é ajuste: é a primeira vez que a interface vai ser pensada para mais de um
tamanho e mais de um tipo de entrada.

---

## 2. A decisão que organiza tudo o resto

**Largura e tipo de entrada são eixos independentes, e confundi-los estraga a
extensão.**

O painel da extensão é estreito *e* de mouse. O PWA no computador é largo *e* de
mouse. O celular é estreito *e* de dedo. Se "estreito" virar sinônimo de "toque",
o painel da extensão — que é o que se usa todo dia — ganha alvos gigantes e um
botão flutuante que não serve para nada ali.

Use os dois separadamente:

- **Largura** decide o layout: `@media (max-width: …)`
- **Entrada** decide o tamanho dos alvos e quais gestos existem:
  `@media (pointer: coarse)` e `matchMedia('(pointer: coarse)')` no JS

Não invente um terceiro caminho, e não detecte "celular" por user agent.

---

## 3. Regras desta rodada

Além das do `HANDOFF.md` §1:

- **A extensão é o que ele usa todo dia.** Qualquer regressão ali é a pior coisa
  que esta rodada pode produzir. Ao terminar, confira o painel estreito com
  mouse e diga no relatório que conferiu.
- **Nada de código remoto.** O MV3 proíbe, e vale para fonte de ícone também:
  não carregue nada de `fonts.googleapis.com`. Ver Tarefa 4.
- **Não mexa na lógica de sincronização.** Ela acabou de estabilizar depois de
  quatro bugs seguidos em uso real. Esta rodada é de interface.
- `node test/run.mjs` precisa continuar acima de **681**.

---

## Tarefa 1 — O modo toque, e o botão que o liga  ⟵ o coração da rodada

Nove interações hoje exigem segurar Ctrl, e **em telefone não existe Ctrl**.
Elas são:

| Onde | O que o Ctrl faz |
|---|---|
| `note.js` | Ctrl+clique num bloco começa seleção múltipla |
| `note.js` | Ctrl+arrastar seleciona vários blocos |
| `note.js` | Ctrl+clique num `<mark>` aciona o detector (CPF, data, cálculo) |
| `note.js` | Ctrl+Z / Ctrl+Y / Ctrl+K |
| `selection.js` | Ctrl no laço de seleção |
| `documents.js` | Ctrl+clique seleciona vários documentos |
| `modal.js` | Ctrl no visualizador de imagem |

**O que construir:** um botão flutuante, visível só em `pointer: coarse`, que
liga e desliga um **modo de seleção**. Com o modo ligado, tocar num bloco faz o
que o Ctrl+clique faz hoje; tocar num `<mark>` aciona o detector.

Regras que importam mais que o visual:

- O modo precisa ser **óbvio quando está ligado**. Um botão que muda de estado
  sem deixar claro qual é o estado transforma cada toque numa aposta.
- Sair do modo tem que ser fácil e previsível: o próprio botão, e a tecla Esc
  quando houver teclado.
- **O atalho de teclado continua funcionando onde há teclado.** Isto se
  acrescenta, não substitui: quem usa a extensão com mouse não pode perder o
  Ctrl+clique.
- Ctrl+Z, Ctrl+Y e Ctrl+K são atalhos de teclado, não gestos — não precisam de
  equivalente no modo de seleção. Desfazer no celular, se for oferecido, é botão
  próprio, não esse modo.

**Pronto quando:** num navegador com toque emulado, dá para selecionar vários
blocos, arrastar para reordenar e acionar um detector sem teclado nenhum. E com
mouse, nada mudou.

---

## Tarefa 2 — Três tamanhos, um layout

Hoje o CSS tem **zero** media query de largura. O layout é uma coluna só, pensada
para o painel estreito, e no PWA de computador ele fica esticado e vazio.

- **Estreito (extensão e celular)**: como é hoje, com os ajustes de alvo que a
  Tarefa 1 trouxer.
- **Largo (PWA de computador)**: aproveitar o espaço. Não é obrigatório inventar
  um layout de duas colunas; é obrigatório o texto não virar uma linha de 200
  caracteres. Largura máxima de leitura confortável já resolve a maior parte.
- **Alvos de toque** com no mínimo 44px em `pointer: coarse` — inclusive as
  alças de arrastar bloco, que hoje são minúsculas de propósito porque aparecem
  no hover, e hover não existe no dedo.

Aliás, **todo comportamento de hover precisa de um caminho alternativo no
toque**: os controles de bloco (+ e alça) aparecem no `mouseover` hoje. No
celular eles simplesmente nunca aparecem.

---

## Tarefa 3 — Funcionar de verdade no celular

A referência que ele deu é o Notion. O que isso quer dizer na prática, e o que
está quebrado hoje:

- **Teclado virtual cobre o cursor.** Ao digitar no fim de uma nota longa, o
  teclado sobe e esconde a linha. Precisa rolar para manter o cursor visível.
- **Barra de formatação alcançável.** No celular, seleção + barra flutuante é o
  padrão; menu escondido atrás de hover não existe.
- **Menu "/" utilizável com o dedo** — hoje ele é navegado por setas.
- **Rolagem que não briga com arrastar bloco.** É o gesto mais fácil de errar:
  arrastar para rolar não pode começar a mover um bloco. Toque longo é o jeito
  usual de distinguir.
- **Nada de `:hover` como única forma de descobrir uma função.**

---

## Tarefa 4 — Ícones no lugar dos emojis

São 55 emojis usados como ícone. Eles mudam de desenho conforme o sistema, ficam
desalinhados e não herdam cor.

Troque por **Material Symbols** (os ícones do Google), com uma restrição
importante:

**Não carregue a fonte de `fonts.googleapis.com`.** O MV3 proíbe recurso remoto,
e no PWA isso quebraria o funcionamento offline que o service worker garante
hoje. Duas saídas aceitáveis:

- **SVG embutido** (preferido): baixe só os ícones usados e inclua como SVG.
  Sem fonte, sem piscada de carregamento, herda `currentColor`, funciona
  offline, e some do caminho do MV3.
- Ou a fonte **hospedada junto do projeto**, com subconjunto só dos ícones
  usados — como o Dexie já é versionado em `lib/`.

Não deixe emoji e ícone convivendo: meia troca fica pior que nenhuma.

---

## Tarefa 5 — Buscar nota

Não existe busca. Com dezenas de notas, a barra de abas deixa de servir.

- Campo de busca que filtra por **título e conteúdo**. O campo `content` de cada
  nota já é o texto simples derivado dos blocos — está pronto para isso, não
  precisa varrer bloco.
- **O filtro precisa dizer quanto escondeu.** Se a busca deixa 3 de 40 notas
  visíveis, isso tem que estar escrito na tela. Filtro que esconde em silêncio
  faz a pessoa achar que perdeu nota — e essa regra já vale no resto do projeto.
- Limpar a busca com um toque, e com Esc onde houver teclado.

---

## Tarefa 6 — Documentos mais discreto, sem perder acesso

A seção de documentos ocupa metade da tela hoje. No celular quase não se usa; no
PWA de computador também não; **na extensão sim** — é lá que se arrasta arquivo
para a página.

- Torne a seção **recolhível**, com o estado lembrado.
- Padrão **recolhido** no PWA (celular e computador), **aberto** na extensão.
- **Não remova o acesso.** Recolhido significa uma linha com o nome e a
  contagem, que abre ao toque. Nunca escondido atrás de um menu de três níveis.
- O divisor arrastável que já existe continua valendo quando a seção estiver
  aberta.

---

## Fora desta rodada

Mudar a lógica de sincronização, o modelo de blocos, o parser ou o formato de
arquivo. Se algo de interface parecer exigir mexer neles, **pare e relate** em
vez de mexer.

Pendente com o dono do projeto, como sempre: **qualquer operação de git**.

---

## Como verificar

```bash
node test/run.mjs
```

Acima de 681, tudo verde. A suíte cobre o núcleo sem DOM — quase nada desta
rodada é alcançado por ela, e é por isso que o relatório importa mais que o
normal.

Para o navegador: sirva a pasta em localhost e use a emulação de dispositivo do
Chrome, alternando entre ponteiro fino e grosso. `test/banco-de-provas.html`
continua servindo para o motor.

No relatório final, separe:

1. O que ganhou teste automatizado.
2. O que foi verificado à mão no navegador, e em quais tamanhos.
3. **Se o painel estreito com mouse continua igual** — esta é a pergunta que
   mais importa, porque é o que ele usa todo dia.
4. O que não foi verificado de jeito nenhum.

A extensão não roda neste ambiente. Não afirme que algo funciona no Chrome.
