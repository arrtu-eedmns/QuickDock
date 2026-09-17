# HANDOFF 3 — Imagens, conflito visível e modelos

Continuação de `HANDOFF.md` e `HANDOFF-2.md`. **Leia o `HANDOFF.md` §1, §2 e §3
primeiro** — regras, projeto e armadilhas. Nada dali se repete aqui.

Plano completo: `PLANEJAMENTO.md`, seção `## v3.0`.

---

## 1. Onde estamos

A rodada anterior fechou bem. A sincronização está **ligada e funcionando** com
pasta local: botão no painel, agendamento automático com debounce, mutex contra
rodadas concorrentes, permissão pedida só no clique, e estado de erro visível.
São **505 verificações** passando.

Os dois portões seguraram e estão provados por teste:

- A chave local de imagem não viaja mais (`{ sync: true }` em `blocksToMarkdown`).
- A nota aberta é pulada quando há digitação em curso, e o cursor **não avança**
  quando algo é pulado — então a mudança remota volta na rodada seguinte.

Esta rodada fecha três lacunas que sobraram.

---

## Tarefa 1 — Sincronizar imagem de verdade

Hoje a imagem simplesmente não atravessa. A rodada passada impediu o dano
(mostrar a imagem errada), mas o resultado é que uma nota com print chega
**vazia de imagem** do outro lado, com só o texto alternativo.

Justamente as notas com print são as que a pessoa mais quer no outro aparelho.

**Formato** (já definido no `PLANEJAMENTO.md`): a imagem vai para
`imagens/<hash>.<ext>`, com o nome derivado do **conteúdo** do arquivo. Três
coisas vêm de graça: o mesmo print colado duas vezes é um arquivo só; o arquivo
nunca muda, então nunca conflita; e o nome é igual em todos os aparelhos.

No markdown do arquivo, a imagem vira caminho relativo: `![alt](../imagens/<hash>.png)`.

**Regras:**

- **Download preguiçoso.** Não baixe todas as imagens numa rodada de
  sincronização. Baixe quando a nota for aberta e o bloco for renderizado. Um
  aparelho novo com 300 notas não pode puxar 400 MB de uma vez.
- **Não apague imagem remota nesta rodada.** Uma imagem é referenciada por
  várias notas e por vários aparelhos; apagar cedo demais some com a imagem de
  outra pessoa. Faxina fica para depois, e sobra acumulada é mais barata que
  perda.
- A tradução entre `fileId` local e hash é da camada de sincronização, em tempo
  de execução — **não** é migração de dado. O `fileId` continua local e continua
  sendo a verdade dentro do aparelho.
- O marcador `quickdock:nao-sincronizado` continua existindo para o caso de a
  imagem ainda não ter subido. Notas já sincronizadas com o marcador se curam
  sozinhas: no aparelho de origem o bloco ainda tem `fileId`, então a próxima
  serialização grava o hash de verdade.
- Exportar e fazer backup continuam embutindo base64 (`blocksToMarkdownForExport`).
  **Não mexa nesse caminho.**

**Pronto quando:** há teste de que a mesma imagem em duas notas produz um só
arquivo; de que o hash é estável entre aparelhos; e de que abrir uma nota
baixada resolve a imagem contra o arquivo certo. O banco de provas deve
conseguir mostrar o `.md` apontando para `../imagens/<hash>` e o arquivo
aparecendo na pasta.

---

## Tarefa 2 — O conflito precisa ser visto

A rodada passada criou a cópia de conflito corretamente, com título e ordem
próprios. Mas **a palavra "conflito" não aparece em lugar nenhum da interface**.
A cópia surge na lista e é só isso.

Quem não reparar no título nunca vai saber que houve conflito — e vai conviver
com duas notas quase iguais sem entender por quê. Um conflito que ninguém nota
é um conflito que não é resolvido.

- O resumo que o `SyncController` entrega aos ouvintes precisa carregar quantos
  conflitos a rodada gerou.
- O popover de sincronização mostra isso: quantas cópias e de quais notas.
- Aviso discreto, **não** modal. A decisão da rodada anterior continua valendo:
  não interrompa a pessoa para decidir sobre conflito. Mostre, e deixe resolver
  quando der.
- O aviso persiste até a pessoa vê-lo — não pode sumir sozinho em três segundos,
  porque o conflito costuma acontecer quando ela nem está olhando.

---

## Tarefa 3 — Modelos

Os modelos ganharam `uid` e `ordem` na v6 e até hoje não sincronizam nada. A
pasta `modelos/` do formato está vazia e o motor nem olha para ela.

Um modelo é markdown puro guardado como texto — é o caso **mais simples** de
todos, mais simples que nota. Siga o mesmo caminho: arquivo por modelo,
frontmatter com `id`/`uid`, nome e ordem.

Reaproveite o que já existe em vez de duplicar o motor. Se for preciso
generalizar `sincronizar()` para tratar duas pastas, generalize — mas não faça
uma segunda cópia da mesma lógica.

---

## Tarefa 4 — A nota-tutorial

O QuickDock semeia uma nota-tutorial no primeiro acesso (`createTutorialNote`
em `notes-tabs.js`). Ela **não menciona sincronização** em nenhuma linha.

Acrescente uma seção curta: o que o botão faz, que a pasta é do próprio usuário,
que dá para apontar uma pasta dentro do OneDrive ou do Syncthing, e o que
acontece quando duas máquinas editam a mesma nota (aparece uma cópia, nada é
perdido).

Escreva no tom do resto do tutorial. Sem jargão: "cópia de conflito" precisa ser
explicada na primeira vez que aparece.

---

## Fora desta rodada

Google Drive, OAuth, PWA, mesclagem de três vias, e faxina de imagem órfã.

Pendente com o dono do projeto, como sempre: Cloud Console, o campo `key` do
manifesto, e **qualquer operação de git**.

---

## Como verificar

```bash
node test/run.mjs
```

Acima de 505, tudo verde.

Para o que depende de navegador, use `test/banco-de-provas.html`. Ele já sabe
rodar contra a pasta real e contra um banco Dexie descartável.

No relatório final, separe: o que ganhou teste, o que só foi verificado no banco
de provas, e o que não foi verificado de jeito nenhum. A extensão não roda neste
ambiente — não afirme que algo funciona no Chrome.
