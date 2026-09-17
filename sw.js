// ── sw.js ──────────────────────────────────────────────────────────────────
// Service Worker do QuickDock PWA.
//
// Projetado para operar com versionamento estrito de cache e ativação imediata:
// - Quando uma nova versão é publicada, ela assume o controle sem esperar o
//   usuário fechar abas (skipWaiting + clients.claim).
// - Estratégia Network-First para navegação e scripts: garante que arquivos de
//   código atualizados sejam obtidos da rede imediatamente quando online,
//   eliminando o risco de um SW antigo reter código desatualizado e corromper
//   formatos compartilhados com a extensão (ver HANDOFF-5.md).
// - Fallback para cache quando offline.

const CACHE_NAME = 'quickdock-v3.0.0-1';

const ASSET_PATHS = [
  '',
  'index.html',
  '404.html',
  'manifest.webmanifest',
  'sidepanel/style.css',
  'lib/dexie.min.js',
  'sidepanel/app.js',
  'sidepanel/modules/platform.js',
  'sidepanel/modules/storage.js',
  'sidepanel/modules/notes-tabs.js',
  'sidepanel/modules/note.js',
  'sidepanel/modules/blocks.js',
  'sidepanel/modules/calc.js',
  'sidepanel/modules/math-parser.js',
  'sidepanel/modules/documents.js',
  'sidepanel/modules/inject.js',
  'sidepanel/modules/modal.js',
  'sidepanel/modules/selection.js',
  'sidepanel/modules/resizer.js',
  'sidepanel/modules/active-area.js',
  'sidepanel/modules/popover.js',
  'sidepanel/modules/templates.js',
  'sidepanel/modules/backup.js',
  'sidepanel/modules/snapshot.js',
  'sidepanel/modules/sync-engine.js',
  'sidepanel/modules/sync-controller.js',
  'sidepanel/modules/sync-adapter.js',
  'sidepanel/modules/local-folder-adapter.js',
  'sidepanel/modules/notefile.js',
  'icons/16.png',
  'icons/48.png',
  'icons/128.png',
  'icons/192.png',
  'icons/512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      for (const caminho of ASSET_PATHS) {
        try {
          const url = new URL(caminho, self.registration.scope).href;
          await cache.add(url);
        } catch (err) {
          console.warn('Falha no pré-carregamento do recurso:', caminho, err);
        }
      }
    })
  );
  // Não espera abas fecharem: assume controle para que atualizações entrem logo
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Network-First: tenta a rede primeiro para garantir que a versão mais nova
  // do código seja sempre servida. Em caso de falha (offline), usa o cache.
  event.respondWith(
    fetch(req)
      .then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;

        // Se for navegação (abertura de página) e offline, devolve a casca index.html
        if (req.mode === 'navigate') {
          const indexUrl = new URL('index.html', self.registration.scope).href;
          const rootUrl = new URL('', self.registration.scope).href;
          return (await caches.match(indexUrl)) || (await caches.match(rootUrl));
        }

        return new Response('Offline e recurso não encontrado em cache.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
