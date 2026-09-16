// ── templates.js ───────────────────────────────────────────────────────────
// Modelos de nota: markdown guardado como texto puro, exatamente o formato que
// sai na exportação. É isso que faz "compartilhar um modelo" e "baixar um .md"
// serem a mesma coisa — quem recebe importa o arquivo e tem o modelo de volta.

import {
  loadAllTemplates, createTemplateRecord, deleteTemplateById,
  wasSeeded, markSeeded,
} from './storage.js';
import { positionPopover } from './popover.js';

const EXEMPLO_NOTA = {
  kind: 'note',
  name: 'Atendimento',
  content: `# Atendimento —

**Nome:**
**CPF:**
**Protocolo:**
**Data:**
**Canal:**

## O que foi pedido

## Validações

- [ ] Conferir elegibilidade no portal
- [ ] Documentação completa e legível
- [ ] CPF confere com o do titular
- [ ] Prazo ainda em aberto

## Ações

- [ ] Abrir o protocolo no sistema
- [ ] Anexar os documentos
- [ ] Informar o prazo ao beneficiário
- [ ] Registrar o número de retorno

## Retorno

**Responsável:**
**Prazo:**

## Observações
`,
};

// Modelo de bloco: um pedaço que entra no meio da nota, não uma nota inteira.
const EXEMPLO_BLOCO = {
  kind: 'block',
  name: 'Conferência',
  content: `## Conferência

- [ ] Documento legível e dentro da validade
- [ ] Dados batem com o cadastro
- [ ] Prazo ainda em aberto

**Conferido por:**
**Data:**
`,
};

// O menu "/" é montado de forma síncrona enquanto a pessoa digita, então os
// modelos ficam em cache na memória em vez de serem lidos do banco na hora.
let cache = [];

export async function refreshTemplates() {
  cache = await loadAllTemplates();
  return cache;
}

export function noteTemplates()  { return cache.filter(t => t.kind === 'note'); }
export function blockTemplates() { return cache.filter(t => t.kind === 'block'); }

export async function initTemplates() {
  for (const [chave, exemplo] of [
    ['templates_seeded', EXEMPLO_NOTA],
    ['block_template_seeded', EXEMPLO_BLOCO],
  ]) {
    if (await wasSeeded(chave)) continue;
    await createTemplateRecord(exemplo);
    await markSeeded(chave);
  }
  await refreshTemplates();
}

export async function getTemplates() {
  return refreshTemplates();
}


function safeFilename(name) {
  return (name || 'modelo').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'modelo';
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Pedir "abre este modelo no editor". Vai por evento porque quem atende é o
// notes-tabs, que já importa este módulo — chamar de volta seria ciclo.
export function requestTemplateEdit(tpl) {
  closeTemplatesManager();
  document.dispatchEvent(new CustomEvent('quickdock:edit-template', { detail: tpl }));
}

// Cria o registro e abre direto no editor, pra nomear e ajustar lá.
async function createAndEdit({ name, content, kind }) {
  const id = await createTemplateRecord({ name, content, kind });
  await refreshTemplates();
  requestTemplateEdit({ id, name, content, kind });
}

// ── Gerenciador ──────────────────────────────────────────────────────────────
let managerEl = null;
export function closeTemplatesManager() { managerEl?.remove(); managerEl = null; }

function opt(label, onClick, className = '') {
  const btn = document.createElement('button');
  btn.className = `copy-opt ${className}`.trim();
  const span = document.createElement('span');
  span.className = 'copy-opt-value';
  span.textContent = label;
  btn.appendChild(span);
  btn.addEventListener('mousedown', e => e.stopPropagation());
  btn.addEventListener('click', async e => { e.stopPropagation(); await onClick(); });
  return btn;
}


// Salvar a seleção como modelo de bloco: cria e já abre no editor, onde dá
// pra dar o nome e ajustar antes de usar.
export async function openSaveBlockTemplate(_anchorEl, markdown, onSaved) {
  await createAndEdit({ name: 'Novo modelo', content: markdown, kind: 'block' });
  onSaved?.();
}

/**
 * @param anchorEl  elemento que ancora o popover
 * @param opts.onUse           (template) => void — usa o modelo
 * @param opts.getCurrentNote  () => Promise<{title, markdown}> — pra "salvar nota atual"
 */
export async function openTemplatesManager(anchorEl, opts) {
  const { onUse, getCurrentNote } = opts;
  closeTemplatesManager();

  const pop = document.createElement('div');
  pop.className = 'copy-menu templates-manager';

  const reopen = async () => {
    await refreshTemplates();
    return openTemplatesManager(anchorEl, opts);
  };

  const templates = await refreshTemplates();

  const renderRow = (tpl) => {
    const row = document.createElement('div');
    row.className = 'template-row';

    const use = document.createElement('button');
    use.className = 'template-use';
    use.textContent = tpl.name;
    use.title = tpl.kind === 'block'
      ? 'Inserir este bloco na nota aberta'
      : 'Criar uma nota com este modelo';
    use.addEventListener('mousedown', e => e.stopPropagation());
    use.addEventListener('click', async e => {
      e.stopPropagation();
      closeTemplatesManager();
      await onUse(tpl);
    });

    const acoes = document.createElement('div');
    acoes.className = 'template-actions';

    const mk = (glyph, title, run) => {
      const b = document.createElement('button');
      b.className = 'template-btn';
      b.textContent = glyph;
      b.title = title;
      b.addEventListener('mousedown', e => e.stopPropagation());
      b.addEventListener('click', async e => { e.stopPropagation(); await run(); });
      return b;
    };

    acoes.append(
      mk('↓', 'Baixar .md para compartilhar', () => {
        downloadText(`${safeFilename(tpl.name)}.md`, tpl.content);
      }),
      mk('✎', 'Editar no editor de notas', () => requestTemplateEdit(tpl)),
      mk('✕', 'Excluir modelo', async () => {
        if (!confirm(`Excluir o modelo "${tpl.name}"?`)) return;
        await deleteTemplateById(tpl.id);
        await reopen();
      }),
    );

    row.append(use, acoes);
    pop.appendChild(row);
  };

  const grupos = [
    ['Modelos de nota',  templates.filter(t => t.kind === 'note'),  'Nenhum modelo de nota ainda.'],
    ['Modelos de bloco', templates.filter(t => t.kind === 'block'), 'Nenhum modelo de bloco ainda.'],
  ];

  for (const [titulo, lista, vazioTxt] of grupos) {
    const head = document.createElement('div');
    head.className = 'copy-menu-header';
    head.textContent = titulo;
    pop.appendChild(head);

    if (lista.length === 0) {
      const vazio = document.createElement('div');
      vazio.className = 'templates-empty';
      vazio.textContent = vazioTxt;
      pop.appendChild(vazio);
    }
    lista.forEach(renderRow);
  }

  pop.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));

  pop.appendChild(opt('Salvar a nota atual como modelo', async () => {
    const atual = await getCurrentNote();
    if (!atual?.markdown?.trim()) { alert('A nota atual está vazia.'); return; }
    await createAndEdit({ name: atual.title || 'Novo modelo', content: atual.markdown, kind: 'note' });
  }));

  pop.appendChild(opt('Criar modelo do zero', () =>
    createAndEdit({ name: 'Novo modelo', content: '', kind: 'note' })));

  // Dois botões em vez de um: o arquivo .md não diz se é nota ou bloco, e
  // adivinhar erraria justamente no caso de compartilhar um modelo de bloco.
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.md,.txt,text/markdown,text/plain';
  importInput.hidden = true;
  let importKind = 'note';
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    const content = await file.text();
    const name = file.name.replace(/\.(md|txt)$/i, '') || 'Modelo importado';
    await createTemplateRecord({ name, content, kind: importKind });
    await reopen();
  });
  pop.appendChild(importInput);

  pop.appendChild(opt('Importar como modelo de nota', () => { importKind = 'note'; importInput.click(); }));
  pop.appendChild(opt('Importar como modelo de bloco', () => { importKind = 'block'; importInput.click(); }));

  document.body.appendChild(pop);
  managerEl = pop;
  positionPopover(pop, anchorEl);
}

document.addEventListener('mousedown', e => {
  if (managerEl && !managerEl.contains(e.target)) closeTemplatesManager();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeTemplatesManager();
});
