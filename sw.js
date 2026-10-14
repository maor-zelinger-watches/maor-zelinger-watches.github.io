/**
 * sw.js — service worker: makes the site installable and gives it an offline
 * app shell. Registered by js/pwa.js after the window load event.
 *
 * Scope and strategy, deliberately narrow:
 *
 * - The worker only answers same-origin GET requests. Everything cross-origin
 *   (the Apps Script backend, Google Sign-In, YouTube embeds, analytics,
 *   avatars) is not touched — `fetch` events for them get no respondWith, so
 *   the browser handles them exactly as it did before. The feed's own caching
 *   and stale-while-revalidate logic lives in js/cache.js over IndexedDB; the
 *   worker never caches API responses.
 *
 * - The app shell (HTML, CSS, every ES module, fonts, icons) is precached on
 *   install into a cache named after CONFIG.APP_VERSION, and served cache-first
 *   from then on. The version comes straight from js/config.js — this is a
 *   module worker, so the import is the single source of truth and a version
 *   bump is also what makes the browser see a "changed" worker (the update
 *   check compares every imported script, not just this file).
 *
 * - On activate every cache with another version is deleted, so a deploy
 *   swaps the WHOLE shell at once. That is why nothing is written into the
 *   cache at runtime: the unbundled modules import each other by path, and a
 *   stale-while-revalidate cache could hand a page half old and half new
 *   modules. Precache-or-network, never mix.
 *
 * - Navigations are network-first (a fresh HTML wins whenever the network is
 *   there) and fall back to the precached page when offline. Deep links such
 *   as /?v=<id> fall back to the shell ignoring the query string.
 *
 * Playwright blocks service workers in e2e runs (playwright.config.js, use
 * .serviceWorkers) so specs keep intercepting same-origin requests directly;
 * tests/e2e/pwa.spec.js opts back in to exercise this file.
 */

import { CONFIG } from './js/config.js';

const CACHE_PREFIX = 'hyw-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${CONFIG.APP_VERSION}`;

// Everything a visitor needs to open the site with no network. Keep in sync
// with index.html (tests/unit/pwa.test.js fails when a modulepreload, the
// stylesheet, or a font is missing here, or when a listed file is gone).
export const PRECACHE_URLS = [
  '/',
  '/privacy.html',
  '/terms.html',
  '/manifest.webmanifest',
  '/css/style.css',
  '/js/analytics.js',
  '/js/footer-year.js',
  '/js/app.js',
  '/js/error-reporter.js',
  '/js/action-queue.js',
  '/js/api-client.js',
  '/js/api.js',
  '/js/auth-overlay.js',
  '/js/auth.js',
  '/js/bookmarks.js',
  '/js/bootstrap.js',
  '/js/cache.js',
  '/js/cards.js',
  '/js/comments-ui.js',
  '/js/comments.js',
  '/js/config.js',
  '/js/feed.js',
  '/js/feedback.js',
  '/js/flags.js',
  '/js/fullscreen.js',
  '/js/icons.js',
  '/js/lazy-iframe.js',
  '/js/prefetch.js',
  '/js/pwa.js',
  '/js/share.js',
  '/js/single-play.js',
  '/js/stars.js',
  '/js/state.js',
  '/js/storage.js',
  '/js/toast.js',
  '/js/utils.js',
  '/js/vendor/idb-keyval.js',
  '/js/views.js',
  '/js/votes.js',
  '/assets/fonts/poppins-400-latin.woff2',
  '/assets/fonts/poppins-500-latin.woff2',
  '/assets/fonts/poppins-600-latin.woff2',
  '/assets/fonts/poppins-700-latin.woff2',
  '/assets/fonts/poppins-400-latin-ext.woff2',
  '/assets/fonts/poppins-500-latin-ext.woff2',
  '/assets/fonts/poppins-600-latin-ext.woff2',
  '/assets/fonts/poppins-700-latin-ext.woff2',
  '/assets/favicon.svg',
  '/assets/favicon.ico',
  '/assets/apple-touch-icon.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-maskable-512.png',
];

/**
 * Fetch one shell URL past the HTTP cache and store it under exactly that URL.
 *
 * `cache: 'reload'` because a new worker installs right after a deploy, when
 * the browser's HTTP cache may still hold the previous version's modules
 * (GitHub Pages serves them with max-age=600) — the versioned shell must be
 * built from what is live, not from what was cached.
 *
 * The response is re-wrapped before storing: a dev server that redirects
 * /privacy.html → /privacy (`serve` does) yields a `redirected` response, and
 * browsers refuse to answer a navigation with one of those from the cache.
 */
async function precacheOne(cache, url) {
  const res = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
  if (!res.ok) throw new Error(`precache ${url}: HTTP ${res.status}`);
  const body = await res.arrayBuffer();
  await cache.put(url, new Response(body, { status: 200, headers: res.headers }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(PRECACHE_URLS.map((url) => precacheOne(cache, url)));
    // Take over from the previous version without waiting for every tab to
    // close; the open page keeps running the modules it already loaded and
    // js/pwa.js tells the visitor a reload brings the new version.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // backend, Google, YouTube: untouched

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (err) {
        const cache = await caches.open(CACHE_NAME);
        // /?v=<id> deep links and /index.html both resolve to the shell.
        const key = url.pathname === '/index.html' ? '/' : url.pathname;
        const cached = await cache.match(key, { ignoreSearch: true });
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url.pathname);
    return cached || fetch(request);
  })());
});
