// ── templates.js ───────────────────────────────────────────────────────────
// Modelos de nota: markdown guardado como texto puro, exatamente o formato que
// sai na exportação. É isso que faz "compartilhar um modelo" e "baixar um .md"
// serem a mesma coisa — quem recebe importa o arquivo e tem o modelo de volta.

import {
  loadAllTemplates, createTemplateRecord, updateTemplateById, deleteTemplateById,
  templatesWereSeeded, markTemplatesSeeded,
} from './storage.js';
import { positionPopover } from './popover.js';

const EXEMPLO = {
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

// Semeia o exemplo uma vez só. A marca fica fora da tabela pra que apagar o
// exemplo não o traga de volta na próxima abertura.
export async function initTemplates() {
  if (await templatesWereSeeded()) return;
  await createTemplateRecord(EXEMPLO);
  await markTemplatesSeeded();
}

export async function getTemplates() {
  return loadAllTemplates();
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

// Campo de nome embutido no próprio popover, em vez de um prompt() do
// navegador — mesmo critério do menu de link.
function nameField({ value, placeholder, onConfirm, onCancel }) {
  const row = document.createElement('div');
  row.className = 'template-name-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'template-name-input';
  input.value = value ?? '';
  input.placeholder = placeholder ?? 'Nome do modelo';

  const ok = document.createElement('button');
  ok.className = 'template-name-ok';
  ok.textContent = 'Salvar';

  const commit = async () => {
    const nome = input.value.trim();
    if (!nome) { input.focus(); return; }
    await onConfirm(nome);
  };

  input.addEventListener('mousedown', e => e.stopPropagation());
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel?.(); }
  });
  ok.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
  ok.addEventListener('click', e => { e.stopPropagation(); commit(); });

  row.append(input, ok);
  queueMicrotask(() => { input.focus(); input.select(); });
  return row;
}

/**
 * @param anchorEl  elemento que ancora o popover
 * @param onUse     (template) => void — cria a nota a partir do modelo
 * @param getCurrentNote  () => Promise<{title, markdown}> — pra "salvar nota atual"
 */
/**
 * @param state  null | {mode:'rename', id} | {mode:'save', nome, markdown}
 *               — qual campo de nome está aberto no momento
 */
export async function openTemplatesManager(anchorEl, opts, state = null) {
  const { onUse, getCurrentNote } = opts;
  closeTemplatesManager();

  const pop = document.createElement('div');
  pop.className = 'copy-menu templates-manager';

  const reopen = (proximo = null) => openTemplatesManager(anchorEl, opts, proximo);

  const header = document.createElement('div');
  header.className = 'copy-menu-header';
  header.textContent = 'Modelos de nota';
  pop.appendChild(header);

  const templates = await loadAllTemplates();

  if (templates.length === 0) {
    const vazio = document.createElement('div');
    vazio.className = 'templates-empty';
    vazio.textContent = 'Nenhum modelo salvo ainda.';
    pop.appendChild(vazio);
  }

  for (const tpl of templates) {
    if (state?.mode === 'rename' && state.id === tpl.id) {
      pop.appendChild(nameField({
        value: tpl.name,
        onConfirm: async nome => {
          if (nome !== tpl.name) await updateTemplateById(tpl.id, { name: nome });
          await reopen();
        },
        onCancel: () => reopen(),
      }));
      continue;
    }

    const row = document.createElement('div');
    row.className = 'template-row';

    const use = document.createElement('button');
    use.className = 'template-use';
    use.textContent = tpl.name;
    use.title = 'Criar uma nota com este modelo';
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
      mk('✎', 'Renomear', () => reopen({ mode: 'rename', id: tpl.id })),
      mk('✕', 'Excluir modelo', async () => {
        if (!confirm(`Excluir o modelo "${tpl.name}"?`)) return;
        await deleteTemplateById(tpl.id);
        await reopen();
      }),
    );

    row.append(use, acoes);
    pop.appendChild(row);
  }

  pop.appendChild(Object.assign(document.createElement('div'), { className: 'math-divider' }));

  if (state?.mode === 'save') {
    const aviso = document.createElement('div');
    aviso.className = 'copy-menu-header';
    aviso.textContent = 'Nome do novo modelo';
    pop.appendChild(aviso);
    pop.appendChild(nameField({
      value: state.nome,
      onConfirm: async nome => {
        await createTemplateRecord({ name: nome, content: state.markdown });
        await reopen();
      },
      onCancel: () => reopen(),
    }));
  } else {
    pop.appendChild(opt('Salvar a nota atual como modelo', async () => {
      const atual = await getCurrentNote();
      if (!atual?.markdown?.trim()) { alert('A nota atual está vazia.'); return; }
      await reopen({ mode: 'save', nome: atual.title || 'Novo modelo', markdown: atual.markdown });
    }));
  }

  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.md,.txt,text/markdown,text/plain';
  importInput.hidden = true;
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    const content = await file.text();
    const name = file.name.replace(/\.(md|txt)$/i, '') || 'Modelo importado';
    await createTemplateRecord({ name, content });
    await reopen();
  });
  pop.appendChild(importInput);

  pop.appendChild(opt('Importar modelo (.md/.txt)', () => importInput.click()));

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
