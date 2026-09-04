import { loadFileBlob } from './storage.js';

// ArrayBuffer → base64 em chunks para não estourar a call stack
async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const uint8 = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < uint8.length; i += chunk) {
    binary += String.fromCharCode(...uint8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const toast    = document.getElementById('inject-toast');
const toastMsg = document.getElementById('inject-toast-msg');
const btnCancel = document.getElementById('inject-cancel');

let activeTabId = null;

function showToast(msg) {
  toastMsg.textContent = msg;
  toast.classList.remove('hidden');
}

function hideToast() {
  toast.classList.add('hidden');
  toastMsg.textContent = '';
}

async function getActiveTabId() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      resolve(tabs[0]?.id ?? null);
    });
  });
}

export async function startInject(id, name, type) {
  activeTabId = await getActiveTabId();
  if (!activeTabId) {
    showToast('⚠️ Nenhuma aba ativa encontrada.');
    setTimeout(hideToast, 3000);
    return;
  }

  showToast('⏳ Lendo arquivo...');

  const blob = await loadFileBlob(id);
  if (!blob) {
    showToast('⚠️ Arquivo não encontrado.');
    setTimeout(hideToast, 3000);
    return;
  }

  const base64 = await blobToBase64(blob);

  let response;
  try {
    response = await chrome.tabs.sendMessage(activeTabId, {
      type: 'QD_PREPARE_INJECT',
      file: { base64, name, type },
    });
  } catch {
    showToast('⚠️ Extensão não ativa nesta aba. Recarregue a página e tente novamente.');
    setTimeout(hideToast, 4000);
    return;
  }

  if (response?.found === 0) {
    showToast('⚠️ Nenhum campo de upload encontrado nesta página.');
    setTimeout(hideToast, 3500);
    return;
  }

  const count = response?.found ?? '?';
  showToast(`📥 ${count} campo(s) encontrado(s) — clique no azul na página. Esc para cancelar.`);
}

export async function startInjectMultiple(metas) {
  activeTabId = await getActiveTabId();
  if (!activeTabId) {
    showToast('⚠️ Nenhuma aba ativa encontrada.');
    setTimeout(hideToast, 3000);
    return;
  }

  showToast(`⏳ Preparando ${metas.length} arquivo(s)...`);

  const files = [];
  for (const { id, name, type } of metas) {
    const blob = await loadFileBlob(id);
    if (!blob) continue;
    const base64 = await blobToBase64(blob);
    files.push({ base64, name, type });
  }

  if (!files.length) {
    showToast('⚠️ Nenhum arquivo encontrado.');
    setTimeout(hideToast, 3000);
    return;
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(activeTabId, {
      type: 'QD_PREPARE_INJECT',
      files,
    });
  } catch {
    showToast('⚠️ Extensão não ativa nesta aba. Recarregue a página e tente novamente.');
    setTimeout(hideToast, 4000);
    return;
  }

  if (response?.found === 0) {
    showToast('⚠️ Nenhum campo de upload encontrado nesta página.');
    setTimeout(hideToast, 3500);
    return;
  }

  const count = response?.found ?? '?';
  showToast(`📥 ${count} campo(s) encontrado(s) — clique no azul na página. Esc para cancelar.`);
}

export async function cancelInject() {
  if (activeTabId) {
    try {
      await chrome.tabs.sendMessage(activeTabId, { type: 'QD_CANCEL_INJECT' });
    } catch { /* aba pode ter mudado */ }
    activeTabId = null;
  }
  hideToast();
}

// Ouve resultado da injeção vindo do content script
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'QD_INJECT_RESULT') {
    activeTabId = null;
    if (msg.ok) {
      showToast('✅ Arquivo enviado com sucesso!');
    } else {
      showToast('⚠️ Não foi possível injetar o arquivo neste elemento.');
    }
    setTimeout(hideToast, 3000);
  }

  if (msg.type === 'QD_INJECT_CANCELLED') {
    activeTabId = null;
    hideToast();
  }
});

btnCancel.addEventListener('click', cancelInject);
