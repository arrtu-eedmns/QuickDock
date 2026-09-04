chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// ── Janela focada (cacheada para uso síncrono no handler do atalho) ───────────
let lastWindowId = null;

chrome.tabs.onActivated.addListener(({ windowId }) => {
  lastWindowId = windowId;
});

chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([tab]) => {
  if (tab) lastWindowId = tab.windowId;
});

// ── Rastreia painéis abertos: windowId → port ─────────────────────────────────
const panelPorts = new Map();

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'sidepanel') return;

  // Descobre o windowId consultando a aba ativa no momento em que o painel conecta
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([tab]) => {
    if (!tab) return;
    const winId = tab.windowId;
    panelPorts.set(winId, port);

    port.onDisconnect.addListener(() => {
      panelPorts.delete(winId);
    });
  });
});

// ── Ctrl+Q → toggle ───────────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(command => {
  if (command !== 'toggle-panel' || !lastWindowId) return;

  const port = panelPorts.get(lastWindowId);

  if (port) {
    // Painel aberto → pede que ele se feche via window.close()
    port.postMessage({ type: 'close' });
  } else {
    // Painel fechado → abre (deve ser síncrono dentro do handler de gesto)
    chrome.sidePanel.open({ windowId: lastWindowId });
  }
});
