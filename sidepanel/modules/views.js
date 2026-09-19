// ── views.js ─────────────────────────────────────────────────────────────────
// Gerenciador de visões / telas do QuickDock (View Engine).
// Alterna entre a visão principal do editor de notas e outras telas completas,
// como a Galeria de Modelos (#templates-gallery-view).

let currentView = 'editor';
let previousView = 'editor';
const listeners = new Set();

export function getCurrentView() {
  return currentView;
}

export function onViewChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function switchView(viewName, params = {}) {
  if (!viewName) return;

  if (viewName === currentView) {
    if (viewName === 'templates') {
      document.dispatchEvent(new CustomEvent('quickdock:refresh-templates-gallery', { detail: params }));
    }
    return;
  }

  previousView = currentView;
  currentView = viewName;

  const noteSection = document.querySelector('.note-section');
  const templatesView = document.getElementById('templates-gallery-view');
  const btnNavTemplates = document.getElementById('btn-nav-templates');

  if (viewName === 'templates') {
    if (noteSection) noteSection.hidden = true;
    if (templatesView) {
      templatesView.hidden = false;
      templatesView.classList.add('active');
    }
    document.documentElement.classList.add('view-templates');
    document.body.classList.add('view-templates');
    if (btnNavTemplates) btnNavTemplates.classList.add('active');
    document.dispatchEvent(new CustomEvent('quickdock:refresh-templates-gallery', { detail: params }));
  } else {
    // Visão padrão: editor de notas
    if (templatesView) {
      templatesView.hidden = true;
      templatesView.classList.remove('active');
    }
    if (noteSection) {
      noteSection.hidden = false;
    }
    document.documentElement.classList.remove('view-templates');
    document.body.classList.remove('view-templates');
    if (btnNavTemplates) btnNavTemplates.classList.remove('active');
  }

  listeners.forEach(fn => {
    try { fn(currentView, previousView, params); } catch (err) { console.error(err); }
  });

  document.dispatchEvent(new CustomEvent('quickdock:view-changed', {
    detail: { view: currentView, previousView, params },
  }));
}

export function goBack() {
  if (currentView !== 'editor') {
    switchView('editor');
  }
}

// Tecla Escape retorna ao editor caso não haja modal aberto
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && currentView !== 'editor') {
    if (document.querySelector('.modal:not(.hidden), .copy-menu')) return;
    goBack();
  }
});
