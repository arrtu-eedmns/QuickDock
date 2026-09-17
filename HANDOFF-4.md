# HANDOFF 4 — Identidade de imagem e a pasta legível

Continuação de `HANDOFF.md`, `HANDOFF-2.md` e `HANDOFF-3.md`. **Leia o
`HANDOFF.md` §1, §2 e §3 primeiro** — regras, projeto e armadilhas. Nada dali se
repete aqui.

---

## 1. Onde estamos

A rodada passada entregou as quatro tarefas: imagem sincroniza por hash de
conteúdo, conflito aparece na interface, modelos sincronizam e o tutorial fala
do assunto. São **541 verificações** passando.

O hash está certo: SHA-256 truncado em 12 dígitos hex, sem fraqueza estrutural,
com folga enorme para a escala deste app. O download é preguiçoso de verdade e
imagem remota nunca é apagada, como pedido.

Esta rodada conserta dois defeitos de **identidade de imagem** e devolve
legibilidade à pasta.

---

## Tarefa 1 — Nunca adivinhar qual imagem é qual  ⟵ PORTÃO

`_preservarImagensLocais` em `sync-engine.js` casa bloco de imagem que desceu
com imagem local por texto alternativo e, quando isso falha, **pela ordem de
ocorrência**.

Casar por posição não é identificação, é chute. Reproduzido:

```
locais:  [ imagem fileId 10, imagem fileId 11 ]   (alt vazio nos dois)
desceu:  [ um bloco de imagem ]
resultado: fileId 10 atribuído
```

Nada garante que era a 10. Se o outro aparelho apagou a primeira imagem e
manteve a segunda, o bloco passa a mostrar **a imagem errada** — com toda a
confiança, sem aviso. É exatamente o bug que o portão do `HANDOFF-2` existiu
para impedir, voltando por uma heurística.

**A regra:** quando a identidade não puder ser estabelecida com certeza, o bloco
fica **sem `fileId`**. Uma imagem marcada como indisponível é honesta; a imagem
errada não é. Errar para menos aqui é sempre melhor.

- Remova o casamento por ordem de ocorrência.
- Casamento por texto alternativo só vale quando o alt for **não-vazio e único**
  dos dois lados. Dois blocos com o mesmo alt não identificam nada.
- Identidade de verdade é o hash. Onde houver `imagePath`, use-o e ignore
  heurística.

**Pronto quando:** existe teste com duas imagens locais de alt vazio e um bloco
descendo, provando que **nenhum** `fileId` é atribuído. E teste de que alt
não-vazio e único continua casando.

---

## Tarefa 2 — Dedup local por hash

O teste atual (`imagem · dedup: mesma imagem em duas notas gera apenas um
arquivo em imagens/`) mede a pasta **remota**. Lá o dedup é garantido por
construção — o nome vem do conteúdo, não tem como duplicar. O teste confirma
algo que não podia falhar.

O que pode falhar, e falha, é o lado que **recebe**. Reproduzido:

```
mesma imagem, duas notas, duas sessões diferentes
remoto:  1 arquivo
local:   2 arquivos  (ids 1 e 2)
```

`cacheImagensLocais` é um `Map` em memória, criado no construtor do motor. Ele
resolve o caso de duas notas na mesma sessão. Reabriu o painel, o cache zerou, e
a mesma imagem é baixada e guardada de novo.

Não corrompe nada — é desperdício. Mas é desperdício do disco do usuário, com
prints de 2 MB, e acumula.

A correção é barata: **o nome do arquivo já é o hash** (`<hash>.<ext>`), e a
tabela `files` **já indexa `name`**. Não precisa de migração de esquema.

- Antes de baixar, procure um arquivo local com esse nome. Se existir, reaproveite.
- Hidrate o cache a partir dessa busca, ou dispense o cache e use sempre a busca.
- O store precisa expor essa busca; acrescente ao `DexieSyncStore` e ao
  `InMemoryStore` (eles compartilham contrato — se um mudar, o outro muda junto).

**Pronto quando:** o teste de dedup passa a medir o **lado local**, com duas
instâncias diferentes do motor (simulando duas sessões), e afirma que existe um
só arquivo local. O teste que mede a pasta remota pode continuar; ele só não
pode ser o único.

---

## Tarefa 3 — O nome do arquivo precisa acompanhar o título

Renomear uma nota hoje não renomeia o arquivo. O conteúdo é atualizado e o
`titulo:` do frontmatter muda, mas o arquivo continua `notas/nome-antigo.md`.

Isso **não é bug de dados** — é correto por desenho: a identidade mora no `id`
do frontmatter, nunca no nome, e é isso que faz o usuário poder renomear
arquivos na mão sem quebrar nada. Não mude essa regra.

O problema é outro. O motivo de esta arquitetura ter sido escolhida foi o
usuário poder abrir a pasta e **ler as próprias notas sem o QuickDock**. Uma
pasta onde metade dos nomes não corresponde ao conteúdo destrói exatamente isso.

- Quando o título mudar, renomeie o arquivo para acompanhar.
- **O conteúdo nunca pode se perder no caminho.** Escreva o novo antes de apagar
  o velho; se o novo falhar, o velho fica. Nunca o contrário.
- Se o destino já existir (dois títulos gerando o mesmo slug), mantenha o nome
  atual em vez de sobrescrever. Nome feio é melhor que nota perdida.
- O `id` do frontmatter continua sendo a identidade. Um arquivo renomeado **na
  mão pelo usuário** continua tendo que funcionar — não vincule nada ao nome.

**Pronto quando:** há teste de renomear nota mostrando um só arquivo ao final,
com o nome novo e o conteúdo íntegro; e teste de colisão de slug provando que
nenhuma das duas notas é sobrescrita.

---

## Fora desta rodada

Google Drive, OAuth, PWA, mesclagem de três vias, faxina de imagem órfã e
redução de imagem grande na colagem.

Pendente com o dono do projeto, como sempre: Cloud Console, o campo `key` do
manifesto, e **qualquer operação de git**.

---

## Como verificar

```bash
node test/run.mjs
```

Acima de 541, tudo verde.

Para o que depende de navegador, use `test/banco-de-provas.html`.

No relatório final, separe: o que ganhou teste, o que só foi verificado no banco
de provas, e o que não foi verificado de jeito nenhum. A extensão não roda neste
ambiente — não afirme que algo funciona no Chrome.
