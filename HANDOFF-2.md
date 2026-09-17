# HANDOFF 2 — Ligar a sincronização na extensão

Continuação de `HANDOFF.md`. **Leia o `HANDOFF.md` primeiro**, seções 1 (regras
absolutas), 2 (o projeto em dois minutos) e 3 (armadilhas). Tudo ali continua
valendo e não se repete aqui.

O plano completo está em `PLANEJAMENTO.md`, seção `## v3.0`.

---

## 1. Onde estamos

O alicerce da sincronização está pronto e testado: `notefile.js`,
`sync-adapter.js`, `sync-engine.js`, `local-folder-adapter.js` e a ponte
`DexieSyncStore` (em `storage.js`). São **465 verificações** passando.

**Mas nada disso está ligado.** Nenhum desses módulos é importado pelo editor.
Do ponto de vista de quem usa o QuickDock, não existe sincronização.

Esta rodada liga — com o adaptador de **pasta local**, sem Google, sem OAuth,
sem PWA. O usuário aponta uma pasta (que pode já estar dentro do OneDrive ou do
Syncthing) e passa a ter sincronização entre máquinas.

Ferramenta que você vai usar o tempo todo: `test/banco-de-provas.html`, servido
em localhost. Ela exercita o motor fora da extensão, inclusive contra um banco
Dexie descartável (`criarBancoDeProvas`). Nenhum teste em node alcança o
`File System Access API`; o banco de provas alcança.

---

## 2. Regras desta rodada

Além das do `HANDOFF.md` §1:

- **Não mexa em `note.js` além do necessário.** São ~3600 linhas de DOM, com
  `contenteditable`, seleção e cursor. É o arquivo mais fácil de quebrar de um
  jeito que nenhum teste pega.
- **A sincronização nunca pode bloquear o editor.** Nada de `await` de rede no
  caminho de digitar, salvar ou trocar de nota.
- **Nada de sincronização automática antes de o usuário escolher uma pasta.**
  Sem pasta escolhida, o QuickDock continua exatamente como é hoje.
- As 465 verificações só podem subir.

---

## Tarefa 1 — A referência de imagem não pode viajar  ⟵ PORTÃO

**Isto é um bug de corrupção de dados e bloqueia todo o resto.**

`imageSrcOf()` em `blocks.js` grava a imagem como `quickdock:file/12`, e
`parseImageLine()` lê de volta como `{ type: 'image', fileId: 12 }`. Esse número
é a chave primária **local** do IndexedDB.

No outro aparelho, o arquivo 12 é outra imagem qualquer. Sincronizar uma nota
com imagem não mostra imagem quebrada do outro lado — mostra **a imagem errada**,
sem nenhum aviso. Uma nota de atendimento com o print de outro cliente.

Sincronização de imagem inteira (hash do conteúdo, pasta `imagens/`) **não é
desta rodada**. O que é desta rodada é impedir o dano:

- Ao **serializar para o arquivo**, uma imagem local não pode sair com o id
  local. Escreva um marcador que não carregue id resolvível — o texto
  alternativo deve sobreviver, porque é a única pista do que era a imagem.
- Ao **ler um arquivo**, um marcador desses vira um bloco de imagem ausente:
  visível, dizendo que a imagem não foi sincronizada, e **nunca** resolvido
  contra o banco local.
- O arquivo local **não pode ser apagado** por causa disso. No aparelho de
  origem a imagem continua lá e continua aparecendo.
- Isto vale só no caminho de sincronização. Exportar e fazer backup continuam
  como estão hoje (`blocksToMarkdownForExport` embute em base64) — não mexa.

**Pronto quando:** existe teste provando que um bloco de imagem com `fileId`
serializado para sincronização e lido de volta **não** produz um bloco com
`fileId`, e que o texto alternativo sobrevive. E um teste de que duas notas de
aparelhos diferentes, com `fileId` iguais por coincidência, não se confundem.

---

## Tarefa 2 — A nota aberta

O segundo risco grave, e o mais sutil.

O motor escreve direto no banco. O editor mantém a nota aberta **no DOM**, e
`flushSave()` grava DOM → banco por temporizador. Se a sincronização atualizar a
linha da nota que está aberta, o próximo `flushSave()` sobrescreve o que desceu,
em silêncio. E recarregar o editor no meio da digitação perde o cursor e o que
estava sendo escrito.

Regra a implementar:

1. Antes de cada rodada, chame `flushSave()` (exportado de `note.js`) para que o
   banco reflita o DOM.
2. Se uma descida for modificar a nota **aberta**: só aplique e recarregue o
   editor (`switchToNote(id)`, exportado de `note.js`) quando o editor **não**
   estiver com foco e não houver edição pendente. Caso contrário, **pule essa
   nota nesta rodada** — ela sincroniza na próxima.
3. Nunca sincronize enquanto `isEditingTemplate()` for verdadeiro. O editor está
   mostrando um modelo, não uma nota; gravar por cima seria perda de conteúdo.

Pular é sempre preferível a arriscar. Uma nota que sincroniza um minuto depois
não incomoda ninguém; uma frase perdida no meio da digitação, sim.

**Pronto quando:** há teste do cenário "nota aberta e suja recebe mudança remota"
provando que o conteúdo local não é perdido e que a mudança remota não some (ela
é aplicada numa rodada seguinte).

---

## Tarefa 3 — Guardar o acesso à pasta

`FileSystemDirectoryHandle` é clonável e pode ser guardado no IndexedDB. Sem
isso o usuário escolhe a pasta toda vez que abre o painel, o que na prática
significa que ninguém usa.

- Guarde o handle (a tabela `syncMeta`, criada na v7, serve).
- Na abertura, recupere e verifique com `queryPermission({ mode: 'readwrite' })`.
  Se não estiver concedida, **não** peça sozinho — `requestPermission` exige
  gesto do usuário. Mostre o estado como "precisa reautorizar" e peça no clique.
- O `LocalFolderAdapter` já aceita `{ rootHandle }` no construtor.

**Pronto quando:** fechar e reabrir o painel mantém a pasta, e a perda de
permissão aparece como um estado claro em vez de um erro no console.

---

## Tarefa 4 — A seção de sincronização no painel

Interface mínima e honesta:

- Pasta escolhida (nome) ou botão "Escolher pasta…"
- Estado: última sincronização, "sincronizando…", ou o erro da última tentativa
- Botão "Sincronizar agora"
- Botão para desconectar (**para de sincronizar; não apaga arquivo nem nota**)

Siga o visual que já existe — variáveis CSS de `style.css`, tema claro e escuro,
e o padrão de popover de `popover.js`. Não invente estilo novo.

**Estado de erro é requisito, não enfeite.** Uma sincronização que falha calada
é pior que nenhuma: a pessoa acha que está protegida e não está.

---

## Tarefa 5 — Quando roda sozinha

Decidido: **automática**, depois que a pasta for escolhida. Sincronização que
depende de lembrar do botão não sincroniza.

- Ao abrir o painel
- Ao a janela recuperar o foco
- ~20 segundos depois de parar de editar (debounce; **nunca** a cada tecla)

Duas rodadas não podem se sobrepor — se uma está em andamento, a próxima espera
ou é descartada. E falha de rodada não pode virar laço de tentativas: erre,
mostre, e espere o próximo gatilho.

---

## Tarefa 6 — Conflito visível

Decidido: a cópia aparece sozinha na lista, com aviso discreto. Não interrompa
a pessoa para decidir sobre conflito — mostre as duas versões e deixe resolver
quando der.

A cópia já nasce com título `(conflito <data>, <aparelho>)` e com ordem própria,
logo depois da original. O `deviceName` passado ao `SyncEngine` precisa ser algo
reconhecível; deixe o usuário nomear o aparelho, com um padrão razoável.

---

## Fora desta rodada

Sincronização de imagem (pasta `imagens/` com nome por hash), Google Drive,
OAuth, PWA, mesclagem de três vias, e sincronização de modelos. Não comece
nenhum.

O que fica pendente com o dono do projeto continua igual ao `HANDOFF.md` §7:
Cloud Console, o campo `key` do manifesto, e **qualquer operação de git**.

---

## Como verificar

```bash
node test/run.mjs
```

Acima de 465, tudo verde.

Para o que depende de navegador, use `test/banco-de-provas.html` e **diga no
relatório o que só foi verificado ali e o que não foi verificado de jeito
nenhum**. A extensão em si não roda neste ambiente: nada que você escrever terá
sido visto funcionando no Chrome.

No relatório final, separe: o que ganhou teste, qualquer perda de dado que a
Tarefa 1 ou 2 tenha revelado, e o que ficou sem verificação.
