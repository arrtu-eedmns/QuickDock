// QuickDock — content script
// Recebe arquivo do side panel e injeta em inputs/dropzones da página

function base64ToFile(base64, name, type) {
  const binary = atob(base64);
  const uint8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);
  return new File([uint8], name, { type, lastModified: Date.now() });
}

let overlays = [];
let escHandler = null;

// --- Heurística para encontrar targets de upload ---
function findUploadTargets() {
  const targets = [];

  // 1. Inputs de arquivo (visíveis ou não)
  document.querySelectorAll('input[type="file"]').forEach(el => {
    targets.push({ el, kind: 'input' });
  });

  // 2. Dropzones por atributo e classes comuns
  const dropzoneSelectors = [
    '[dropzone]',
    '[data-dropzone]',
    '.dropzone',
    '.drop-zone',
    '.upload-area',
    '.upload-zone',
    '.file-drop',
    '.file-drop-area',
    '.dz-clickable',
  ].join(',');

  document.querySelectorAll(dropzoneSelectors).forEach(el => {
    if (!targets.find(t => t.el === el)) {
      targets.push({ el, kind: 'dropzone' });
    }
  });

  // 3. Elementos com handler ondrop inline
  document.querySelectorAll('[ondrop]').forEach(el => {
    if (!targets.find(t => t.el === el)) {
      targets.push({ el, kind: 'dropzone' });
    }
  });

  return targets;
}

// --- Injeta arquivos num input[type=file] ---
function injectIntoInput(input, files) {
  try {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  } catch (e) {
    return false;
  }
}

// --- Injeta arquivos numa dropzone via DragEvent sintético ---
function injectIntoDropzone(el, files) {
  try {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    ['dragenter', 'dragover', 'drop'].forEach(type => {
      el.dispatchEvent(new DragEvent(type, {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      }));
    });
    return true;
  } catch (e) {
    return false;
  }
}

// --- Injeta no elemento correto ---
function injectIntoElement(el, kind, files) {
  const ok = kind === 'input'
    ? injectIntoInput(el, files)
    : injectIntoDropzone(el, files);
  clearOverlays();
  chrome.runtime.sendMessage({ type: 'QD_INJECT_RESULT', ok, kind });
}

// --- Cria overlay visual sobre o target ---
function createOverlay(el, kind, files) {
  // Para inputs display:none, tenta usar o label ou o pai como âncora visual
  let anchor = el;
  if (kind === 'input') {
    const style = window.getComputedStyle(el);
    const isHidden = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
    if (isHidden) {
      const label = document.querySelector(`label[for="${el.id}"]`) || el.closest('label') || el.parentElement;
      if (label) anchor = label;
    }
  }

  const rect = anchor.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return; // não renderizável

  const ov = document.createElement('div');
  ov.className = '__qd-overlay';
  ov.style.cssText = `
    position: fixed;
    top: ${rect.top}px;
    left: ${rect.left}px;
    width: ${rect.width}px;
    height: ${Math.max(rect.height, 32)}px;
    background: rgba(35,131,226,0.18);
    border: 2px solid #2383e2;
    border-radius: 5px;
    z-index: 2147483647;
    cursor: pointer;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: all;
    transition: background 0.15s;
  `;

  const label = document.createElement('span');
  label.textContent = '📥 Clique para enviar';
  label.style.cssText = `
    background: #2383e2;
    color: #fff;
    font-size: 11px;
    font-family: -apple-system, sans-serif;
    padding: 3px 8px;
    border-radius: 3px;
    pointer-events: none;
    white-space: nowrap;
  `;
  ov.appendChild(label);

  ov.addEventListener('mouseenter', () => {
    ov.style.background = 'rgba(35,131,226,0.28)';
  });
  ov.addEventListener('mouseleave', () => {
    ov.style.background = 'rgba(35,131,226,0.18)';
  });
  ov.addEventListener('click', () => injectIntoElement(el, kind, files));

  document.body.appendChild(ov);
  overlays.push(ov);
}

// --- Limpa todos os overlays ---
function clearOverlays() {
  overlays.forEach(o => o.remove());
  overlays = [];
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
}

// --- Listener de mensagens do side panel ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'QD_PREPARE_INJECT') {
    clearOverlays();

    // Suporta arquivo único (msg.file) e múltiplos (msg.files)
    const files = msg.files
      ? msg.files.map(f => base64ToFile(f.base64, f.name, f.type))
      : [base64ToFile(msg.file.base64, msg.file.name, msg.file.type)];

    const targets = findUploadTargets();
    targets.forEach(({ el, kind }) => createOverlay(el, kind, files));

    // Cancela com Esc
    escHandler = e => {
      if (e.key === 'Escape') {
        clearOverlays();
        chrome.runtime.sendMessage({ type: 'QD_INJECT_CANCELLED' });
      }
    };
    document.addEventListener('keydown', escHandler);

    sendResponse({ found: targets.length });
    return true;
  }

  if (msg.type === 'QD_CANCEL_INJECT') {
    clearOverlays();
    sendResponse({ ok: true });
    return true;
  }
});
