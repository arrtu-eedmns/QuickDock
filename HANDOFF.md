# HANDOFF — QuickDock v3.0, Etapas 0 e 1

Documento de passagem de bastão. Quem lê isto vai continuar um trabalho já
planejado, num código que tem convenções fortes e várias armadilhas conhecidas.
Leia até o fim antes de escrever a primeira linha.

O plano completo está em `PLANEJAMENTO.md`, seção `## v3.0`. Este arquivo é o
recorte executável dele: o que dá pra construir **sem** conta em serviço nenhum.

---

## 1. Regras absolutas

**Não fazer, em hipótese alguma:**

- `git commit`, `git push`, criar branch ou tag — o dono do projeto faz isso.
- Gerar `.zip` ou empacotar a extensão. Há instrução explícita em vigor: *"não
  vamos zipar agora"*.
- Qualquer coisa no Google Cloud Console, OAuth, Drive API ou PWA. Fica pendente
  de propósito.
- Adicionar dependência npm. O projeto **não usa npm** em produção; o
  `package.json` existe só para rodar `node test/run.mjs`.
- Enfraquecer teste existente para fazer passar. Se um teste novo acusa perda de
  dado, **conserta-se o código**, não o teste.

**Fazer sempre:**

- Comentários em **português**, explicando *por quê*, não *o quê*. O código é
  denso de comentário que justifica decisão. Leia qualquer arquivo em
  `sidepanel/modules/` antes de escrever: o tom é esse e precisa continuar.
- Rodar `node test/run.mjs` depois de cada mudança. Estavam **307 verificações
  passando** no início desta rodada. Esse número só pode subir.
- `node --check <arquivo>` em todo arquivo alterado.

---

## 2. O projeto em dois minutos

QuickDock é uma extensão do Chrome (Manifest V3) que abre um painel lateral com
notas em editor de blocos. Desenvolvedor solo, tudo em português.

- **Sem build.** ES modules puros, carregados direto pelo navegador. Não existe
  bundler, transpilador nem passo de compilação.
- **Sem `eval` e sem `new Function`.** A CSP do MV3 proíbe. O avaliador de
  cálculo é um parser recursivo escrito à mão por causa disso.
- **Dados locais**: IndexedDB via Dexie (tabelas `notes`, `files`, `templates`),
  mais `chrome.storage.local` para preferências. Hoje está na versão 5 do
  esquema.
- **Modelo de blocos plano**: uma nota é um array de blocos. Aninhamento é
  implícito, via campo `depth: 0..5` — não há árvore.
- **Decoração não é tipo**: `quoted`, `callout` e `underlined` são campos
  ortogonais que qualquer bloco pode ter. Isso é proposital: impede a explosão
  do menu de tipos.

### Forma de um bloco

```js
{ id, type, html }                       // paragraph, heading1..3, bullet,
                                         // number, code, calc
{ id, type: 'checklist', html, checked }
{ id, type: 'table', rows: [[celula]] }
{ id, type: 'divider' }
{ id, type: 'image', fileId: 12, alt }   // ou { dataUrl } quando vem de fora
```

Campos que qualquer bloco pode carregar, além dos acima:
`depth` (número, ausente = 0), `quoted` (true), `callout`
(`'note'|'tip'|'important'|'warning'|'caution'`), `underlined` (true, só em
heading1/heading2).

**Corrida (run)**: blocos `calc` contíguos formam uma folha única; blocos com o
mesmo `callout` contíguos formam um cartão único. As pontas são marcadas em JS
(`recalcCalcSheets`, `markCalloutEdges` em `note.js`) porque CSS não consegue
expressar "o vizinho é do mesmo tipo".

### Mapa dos arquivos que importam aqui

| Arquivo | Papel |
|---|---|
| `sidepanel/modules/blocks.js` | Parser e serializador markdown ⇄ blocos. **O núcleo da fidelidade de dados.** Sem DOM. |
| `sidepanel/modules/backup.js` | Formato "todas as notas" em um `.md`. Sem DOM, testável. **Leia como referência de estilo.** |
| `sidepanel/modules/storage.js` | Dexie: esquema, migrações, CRUD. |
| `sidepanel/modules/note.js` | O editor (~3600 linhas). Cheio de DOM. Evite mexer nesta rodada. |
| `sidepanel/modules/calc.js` | Avaliação da folha de cálculo. Sem DOM. |
| `sidepanel/modules/math-parser.js` | Parser de expressão com valores tipados `{ n, moeda, pct }`. |
| `test/run.mjs` | Suíte principal. |
| `test/fixtures.mjs` | Notas reais em formato gravado. **Só se acrescenta, nunca se apaga.** |
| `test/dom-shim.mjs` | Mini-DOM para rodar `blocks.js` no node. |

---

## 3. Armadilhas que não estão escritas em lugar nenhum

Cada uma destas custou tempo real. Não redescubra.

**IndexedDB não indexa booleano.** Um índice sobre `true`/`false` fica
silenciosamente vazio. Por isso `files.inline` vale `1` ou está **ausente** —
nunca `false`. Qualquer campo indexado novo segue a mesma regra.

**Versão de Dexie é imutável.** Nunca edite um `db.version(n)` existente —
acrescente `db.version(n+1)`. Pessoas têm dados gravados nos esquemas antigos.

**Campo ausente é um estado com significado.** Arquivos anteriores ao recurso
`inline` não têm o campo, e é assim que eles ficam fora do índice e continuam
sendo documentos comuns. Ao migrar, preservar a ausência costuma ser mais
correto que preencher com um padrão.

**Não dá pra testar no Chrome aqui.** Nenhuma das ferramentas desta sessão
carrega extensão descompactada. **A extensão nunca foi executada no Chrome de
verdade.** Tudo é verificado por teste em node, `node --check` e leitura. Se
você escrever algo que só dá pra validar no navegador, **diga isso
explicitamente no relatório** em vez de afirmar que funciona.

**`test/fixtures.mjs` é prova, não exemplo.** Cada fixture é um formato que
alguém pode ter gravado. Apagar uma é apagar a prova de que aquele formato ainda
abre.

---

## 4. Para onde estamos indo

Decisão tomada: as notas deixam de morar só no perfil do Chrome e passam a ser
**arquivos markdown numa pasta do Google Drive do próprio usuário**. Não haverá
banco de dados nosso. Custo zero por usuário, e ninguém vira depositário de dado
alheio (as notas detectam CPF e CNPJ).

O formato de destino:

```
QuickDock/
├── notas/      um .md por nota, com frontmatter
├── modelos/
└── imagens/    nome = hash do conteúdo
```

**O risco central da arquitetura**, e o motivo da ordem das tarefas abaixo: hoje
o bloco é a verdade e o markdown é exportação — se a exportação perde algo, dá
pra dar de ombros. Quando o arquivo virar a verdade, toda sincronização é um
`blocos → md → blocos`, e qualquer perda vira **corrosão**: a nota degrada um
pouco a cada ciclo, em todos os aparelhos, em silêncio, e o backup já está
corroído junto.

Por isso a Tarefa 1 é um portão. Nada de sincronização antes dela fechar.

---

## 5. O que já foi medido (não refaça)

Rodei `blocos → md → blocos`, duas voltas, em todas as 15 fixtures existentes:

```
── fixpoint idêntico: 15 · quebrado: 0
```

A única diferença é na primeira passada e é intencional: `type:'quote'` vira
`paragraph + quoted:true` (migração legada documentada em `normalizeBlock`).

**Mas a cobertura tem um buraco grande.** Os tipos presentes nas fixtures são
só: `paragraph`, `table`, `number`, `checklist`, `quote`, `heading1..3`,
`divider`, `code`, `bullet`. Ou seja, o QuickDock de v1.8.

**Zero fixtures com `image`, `calc`, `callout` ou `underlined`** — tudo que foi
construído nas três últimas versões está fora da medição. E é justamente onde eu
esperaria problema: `calc` e `callout` têm pontas de corrida calculadas em JS, e
`image` carrega `fileId`.

**Segundo buraco, no mesmo lugar:** a função `forma()` em `test/run.mjs` (linha
~30), que normaliza blocos para comparação, **não compara `fileId`, `alt` nem
`dataUrl`**. Mesmo que a fixture de imagem existisse, um `fileId` perdido
passaria despercebido.

---

## 6. As tarefas, em ordem

### Tarefa 1 — Fechar o buraco da medição  ⟵ PORTÃO

Nada depois disto começa antes desta terminar.

**1a.** Estender `forma()` em `test/run.mjs` para comparar também `fileId`,
`alt` e `dataUrl`.

**1b.** Acrescentar fixtures em `test/fixtures.mjs` cobrindo, no mínimo:

- bloco `image` com `fileId` e `alt`
- bloco `image` com `dataUrl` (o formato que chega de importação)
- uma **corrida de `calc`** com 3+ linhas, incluindo atribuição (`boleto = R$ 1.000,00`), referência entre linhas e uma linha de texto puro
- **callout de cada um dos 5 tipos**, e ao menos um com 2+ blocos dentro (corrida)
- `underlined` em `heading1` e em `heading2`
- combinações: callout com `depth`, imagem dentro de citação, `calc` com `quoted`

**1c.** Acrescentar, para **toda** fixture, uma asserção explícita de
**identidade de blocos** — não só de estabilidade do markdown. Hoje o teste
afirma `md === md2`, o que é mais fraco: um campo que o markdown não saiba
expressar some nas duas voltas igualmente e o teste continua verde.

A asserção correta, com `b` já normalizado por uma passada:

```js
forma(parseMarkdownToBlocks(blocksToMarkdown(b))) === forma(b)
```

**Pronto quando:** `node test/run.mjs` passa, com as asserções novas de
identidade valendo para todas as fixtures, velhas e novas.

**Se falhar:** conserte `blocks.js`, não o teste. Se algum campo genuinamente
não couber em markdown, crie uma válvula explícita (comentário HTML, no estilo
do marcador de `backup.js`) — **nunca deixe sumir em silêncio**. Documente cada
caso desses no relatório final.

---

### Tarefa 2 — `sidepanel/modules/notefile.js`

O formato de um arquivo de nota. Módulo novo, **sem DOM e sem Dexie** — só texto
entrando e saindo, para ser testável. Espelhe o estilo de `backup.js`.

```js
export function buildNoteFile({ meta, md })   // → string
export function parseNoteFile(texto)          // → { meta, md } | null
```

O arquivo:

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
...
```

Regras:

- O `content` da nota **não** vai para o arquivo. Ele é derivado dos blocos e
  seria uma segunda verdade esperando divergir.
- **Campos desconhecidos são preservados na ida e volta.** Uma versão futura vai
  gravar campo que esta não conhece; descartá-lo destruiria dado de quem usa
  duas versões. Isto é requisito, não refinamento.
- Casos que precisam de teste: título com `:`, com aspas e com `---`; corpo que
  começa com `---`; arquivo sem frontmatter (devolve `null`, não explode);
  frontmatter malformado; valor vazio.
- Não use biblioteca de YAML. É um subconjunto `chave: valor` plano, escrito à
  mão, como o resto do projeto.

**Pronto quando:** testes cobrindo os casos acima passam em `test/run.mjs`.

---

### Tarefa 3 — Dexie v6: `uid` e ordem fracionária

**ATENÇÃO — isto corrige o que está escrito em `PLANEJAMENTO.md`.** O plano diz
para trocar a chave primária `++id` por UUID e reescrever toda referência
`fileId`. **Não faça isso.** Há um caminho mais simples e muito mais seguro:

**Acrescente um campo `uid` ao lado do `id` inteiro, sem tocar na chave
primária.** O `id` continua sendo auto-incremento e **local** — ele nunca sai do
aparelho. O `uid` é a identidade que viaja no arquivo.

Por que basta: dois aparelhos offline podem criar, cada um, uma nota com `id` 7
— e não há colisão, porque o que casa nota com arquivo é o `uid`, que é único. O
`id` local de cada aparelho pode ser diferente para a mesma nota, e tudo bem.

E a referência de imagem não precisa migrar: no arquivo, a imagem é
`../imagens/<hash>.png` (nome derivado do conteúdo). A tradução entre `fileId`
local e hash acontece na camada de sincronização, em tempo de execução — não é
migração de dado.

Trabalho:

- `db.version(6)` acrescentando `uid` a `notes` e `templates`, indexado.
- `upgrade()` preenchendo `uid` em todo registro existente com
  `crypto.randomUUID()`.
- Ordem fracionária: helper `ordemEntre(a, b)` devolvendo uma string que ordena
  entre as duas. Serve para inserir/reordenar sem tocar nas outras notas — é o
  que dispensa um arquivo de índice compartilhado.
- Migrar `order` (inteiro) para `ordem` (string fracionária) no mesmo `upgrade`.

**Pronto quando:** existe teste do caminho de migração (registro no formato v5
entra, sai com `uid` e `ordem` válidos, sem perder nenhum outro campo), e
`ordemEntre` tem teste de propriedade: para quaisquer `a < b`, vale
`a < ordemEntre(a,b) < b`.

---

### Tarefa 4 — O adaptador e um adaptador de memória

Interface mínima, documentada num módulo próprio:

```js
autenticar()
listarMudancas(desde)   // → [{ caminho, rev, apagado }]
ler(caminho)            // → { texto | bytes, rev }
escrever(caminho, conteudo, revBase)   // → { rev } | conflito
apagar(caminho)
```

Primeira implementação: **adaptador de memória**, um objeto JS fingindo ser a
pasta. Parece desvio, mas é o que torna a Tarefa 5 testável em node, sem
navegador e sem rede. Faça este antes de qualquer coisa real.

**Pronto quando:** o contrato está escrito em comentário no topo do módulo, e o
adaptador de memória tem teste próprio, inclusive de escrita com `revBase`
desatualizado devolvendo conflito.

---

### Tarefa 5 — Motor de sincronização

Sem DOM, usando o adaptador. Testado contra o de memória.

```
1. pergunta o que mudou lá
2. baixa o que mudou, compara com o hash da última sincronização
3. sobe o que mudou aqui (debounce ~20s — nunca a cada tecla)
4. colisão → cópia de conflito + aviso
```

Baixar antes de subir, sempre.

O estado de sincronização (`{ uid, caminho, rev, hash, sincronizadoEm }`) é
**local, por aparelho, e nunca sobe**. É ele que distingue "arquivo apagado" de
"arquivo que nunca chegou".

Conflito na primeira versão é **cópia, nunca mesclagem**: grava
`ideias (conflito 2026-09-16, Celular).md` e avisa. Chato, raro, e não perde
nada. Mesclagem de três vias fica para depois.

**Pronto quando:** há teste para cada um destes cenários:

- nota nova aqui sobe
- nota nova lá desce
- edição dos dois lados → cópia de conflito, **nenhum dos dois conteúdos perdido**
- exclusão lá propaga para cá
- exclusão lá + edição aqui → a nota **ressuscita** (edição do usuário nunca é descartada em silêncio)
- aparelho sem estado local reconcilia tudo como novo, sem duplicar nota

---

### Tarefa 6 — Adaptador de pasta local (só se as anteriores fecharem)

`File System Access API`: o usuário aponta uma pasta e a sincronização roda nela,
sem nuvem e sem OAuth. É o que valida o mecanismo inteiro antes de o Drive
existir.

**Não é testável em node.** Implemente contra a interface da Tarefa 4 e diga no
relatório que só dá pra validar em navegador.

---

## 7. O que fica pendente de propósito

Estes itens dependem do dono do projeto e **não devem ser tentados**:

- Criar o projeto no Google Cloud Console, ativar a Drive API, configurar tela de
  consentimento e OAuth clients.
- Adaptador do Google Drive, `chrome.identity`, qualquer token.
- Fixar o campo `key` no `manifest.json` (e o `.pem` correspondente — que é chave
  **privada** e não pode entrar no repositório, que é público; `*.pem` no
  `.gitignore` antes de gerar, não depois).
- PWA, GitHub Pages, `manifest.webmanifest`, service worker.
- Qualquer operação de git.

---

## 8. Como verificar o trabalho

```bash
node test/run.mjs
```

Tem que passar inteiro, com número de verificações **maior** que 307.

```bash
node --check sidepanel/modules/<arquivo>.js
```

Em todo arquivo alterado.

No relatório final, seja explícito sobre três coisas:

1. O que passou a ser coberto por teste que antes não era.
2. Qualquer perda de dado que a Tarefa 1 tenha revelado, e como foi corrigida.
3. O que **não** foi possível verificar sem navegador.

Não afirme que algo funciona no Chrome. Nada aqui foi executado no Chrome.
