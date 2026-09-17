# HANDOFF 5 — O PWA

Continuação de `HANDOFF.md` a `HANDOFF-4.md`. **Leia o `HANDOFF.md` §1, §2 e §3
primeiro** — regras, projeto e armadilhas. Nada dali se repete aqui.

Plano completo: `PLANEJAMENTO.md`, seção `## v3.0`.

---

## 1. Onde estamos

A sincronização por pasta local está pronta, ligada e testada: **556
verificações**. Notas, modelos e imagens atravessam; conflito preserva os dois
lados e aparece na interface; o nome do arquivo acompanha o título.

Esta rodada faz o QuickDock rodar **fora da extensão**, como página web
instalável. Sem Google, sem OAuth, sem Cloud Console.

O PWA sincroniza desde o primeiro dia: o `LocalFolderAdapter` usa File System
Access API, que funciona em qualquer página HTTPS. Extensão e PWA apontando para
a mesma pasta são **dois clientes independentes** — e é a primeira vez que a
sincronização vai ser exercitada entre dois de verdade.

### Por que isto cabe numa rodada

As chamadas a `chrome.*` no projeto inteiro:

```
15 ·  storage.js          chrome.storage.local
 5 ·  inject/content/background   (inserir na página, tabs, atalho)
 1 ·  app.js              chrome.runtime.connect
```

O `note.js` — 3600 linhas de editor com `contenteditable`, o arquivo mais fácil
de quebrar — **não aparece na lista**. Ele é DOM puro e não precisa ser tocado.

A camada de plataforma é essencialmente um arquivo.

---

## Tarefa 1 — Versão do formato precisa ser verificada  ⟵ PORTÃO

`buildNoteFile` grava `quickdock: 1` no frontmatter como marca de versão do
formato. `parseNoteFile` **nunca lê essa marca**.

Até hoje isso era inofensivo: havia um cliente só, e ele sempre concordava
consigo mesmo. A partir desta rodada existem dois clientes gravando na **mesma
pasta**, e eles podem estar em versões diferentes — um PWA com service worker
segurando código antigo em cache é exatamente esse caso, e é comum.

Um cliente antigo lendo um arquivo de formato mais novo hoje não recusa: lê como
der, perde o que não entende, e regrava. Uma volta dessas apaga em silêncio o
que a versão nova tinha escrito.

- `parseNoteFile` passa a ler `quickdock` e a **recusar** o que não souber ler,
  devolvendo `null` como já faz para arquivo que não é do QuickDock.
- Recusar é não escrever por cima: o motor pula o arquivo e o deixa intacto.
  Nunca "melhor esforço" — melhor esforço aqui é perda de dado.
- Isso precisa aparecer para a pessoa: um arquivo recusado por versão vira aviso
  na interface de sincronização ("esta nota foi criada por uma versão mais nova
  do QuickDock"), não um silêncio.

**Pronto quando:** há teste de que um arquivo com `quickdock: 2` é recusado, não
sobrescrito, e que a nota local correspondente continua intacta.

---

## Tarefa 2 — A camada de plataforma

Um módulo só, com duas implementações. **A extensão não pode mudar de
comportamento em nada** — o que existe hoje continua exatamente igual, e a web
entra como segunda implementação atrás da mesma interface.

O que precisa de equivalente (só isso):

| Hoje | Na web |
|---|---|
| `chrome.storage.local` (6 chaves + marcas de exemplo semeado) | `localStorage` ou uma tabela do Dexie |
| `chrome.runtime.connect` em `app.js` | não existe — o atalho Ctrl+Q é da extensão |

As chaves guardadas são: `theme`, `split_ratio`, `active_note_id`, `docs_view`,
`math_history`, `note_content` (só a migração legada), mais as marcas de
`wasSeeded`/`markSeeded`.

Prefira a tabela do Dexie ao `localStorage`: já existe banco, e `localStorage` é
síncrono e some quando o usuário limpa dados do site. Mas não invente migração —
quem abre o PWA pela primeira vez começa do zero, porque o banco é por origem.

**Pronto quando:** `storage.js` não menciona `chrome.` em nenhuma linha, e a
suíte continua acima de 556.

---

## Tarefa 3 — O que não existe na web precisa sumir, não quebrar

`documents.js` importa `inject.js` para o botão "Enviar para campo da página".
Isso depende de `chrome.tabs` e de content script, e **não tem equivalente
nenhum** num PWA. Não é para emular: é para não existir.

- A camada da Tarefa 2 expõe uma consulta de capacidade
  (algo como `podeInserirNaPagina`).
- Onde a capacidade falta, o botão **não é criado**. Nada de botão visível que
  falha ao clicar, e nada de botão desabilitado sem explicação.
- Varra o resto da interface pelo mesmo critério antes de terminar: qualquer
  coisa que dependa de aba, de página ativa ou do atalho global tem que sumir.

---

## Tarefa 4 — A casca do PWA

- `manifest.webmanifest` próprio. **Cuidado:** o `manifest.json` da raiz é o da
  extensão; são arquivos diferentes com propósitos diferentes e não podem se
  misturar.
- Service worker, ícones, e uma página que carrega o mesmo editor.
- **Reaproveite os módulos, não copie.** `blocks.js`, `calc.js`, `note.js` e o
  resto têm que ser os mesmos arquivos. Duas cópias divergem, e aí um bug
  corrigido num lado sobrevive no outro.
- O site será servido de uma **subpasta** (`usuario.github.io/QuickDock/`). O
  escopo do service worker fica preso a ela, e `start_url`, `scope`, ícones e o
  registro do SW precisam todos carregar esse prefixo. É o erro clássico: o app
  instala e abre em branco.
- Sem regra de rewrite no GitHub Pages: copiar `index.html` como `404.html`.

**Sobre o cache do service worker.** Ele é o que cria o cenário da Tarefa 1, e
esta sessão já foi enganada duas vezes por cache de módulo. Use versionamento de
cache e ative a versão nova assim que ela existir. Ninguém pode ficar presa numa
versão antiga sem saber — ainda mais gravando numa pasta compartilhada com a
extensão.

---

## Fora desta rodada

Google Drive, OAuth, Cloud Console e domínio próprio. O PWA desta rodada
sincroniza por pasta local e é completo assim.

Pendente com o dono do projeto: publicar no GitHub Pages, o campo `key` do
manifesto da extensão, e **qualquer operação de git**.

---

## Como verificar

```bash
node test/run.mjs
```

Acima de 556, tudo verde. A suíte cobre o núcleo sem DOM; a camada de plataforma
e a casca do PWA não são alcançadas por ela.

Sirva a pasta em localhost e abra o PWA no navegador. `test/banco-de-provas.html`
continua servindo para exercitar o motor isoladamente.

**Não quebre a extensão.** Ela é usada todo dia, e nenhum teste desta suíte
percebe se o painel parar de abrir. Se qualquer mudança tocar em `app.js`,
`documents.js` ou `index.html`, diga isso em destaque no relatório para que seja
conferido à mão.

No relatório final, separe: o que ganhou teste, o que só foi verificado no
navegador, e o que não foi verificado de jeito nenhum.
