/**
 * pwa.js — service worker registration and the "Install app" entry point.
 *
 * Loaded by js/app.js with a dynamic import after the window load event, on
 * purpose: nothing here matters for first paint, and a static import would
 * put it (and the worker registration) on the cold-load critical path that
 * index.html's modulepreload wave is tuned for.
 *
 * Three jobs:
 *  1. Register /sw.js (a module worker, see the comments there). Browsers
 *     without module-worker support, Playwright contexts that block service
 *     workers, and plain HTTP all make register() reject — the site works
 *     exactly as before, so the failure is logged and otherwise ignored.
 *  2. Tell the visitor when a new version has taken over, so they can reload
 *     for it. The worker calls skipWaiting + clients.claim, which only swaps
 *     what FUTURE requests get; the page keeps the modules it already runs.
 *     Reloading is left to the visitor — a forced reload would cut off a
 *     video or a half-written comment.
 *  3. Surface the browser's install prompt as a footer link. Chromium fires
 *     `beforeinstallprompt` when the site qualifies; the link stays hidden
 *     everywhere else (Safari installs through its own share-sheet flow and
 *     never fires the event).
 */

import { showToast } from './toast.js';

let deferredInstallPrompt = null;

export function initPwa() {
  registerServiceWorker();
  setupInstallLink();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  // A controller at this point means a worker from a previous visit is already
  // serving this page; only then does a later takeover mean "new version".
  const hadController = Boolean(sw.controller);
  sw.addEventListener('controllerchange', () => {
    if (hadController) showToast('A new version is ready — reload to get it.', 'info');
  });
  // updateViaCache 'none': the update check fetches sw.js and js/config.js
  // past the HTTP cache (GitHub Pages: max-age=600), so a deploy is noticed on
  // the next visit rather than up to ten minutes later.
  sw.register('/sw.js', { type: 'module', updateViaCache: 'none' })
    .catch((err) => console.warn('[pwa] service worker not registered:', err && err.message));
}

function setupInstallLink() {
  const link = document.getElementById('install-app');
  if (!link) return;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // keep Chromium's mini-infobar quiet; we offer our own entry
    deferredInstallPrompt = event;
    link.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    link.hidden = true;
  });

  link.addEventListener('click', async (event) => {
    event.preventDefault();
    const prompt = deferredInstallPrompt;
    if (!prompt) return;
    deferredInstallPrompt = null;
    link.hidden = true;
    try {
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      // Dismissed: the browser may fire beforeinstallprompt again later, and
      // the link comes back with it. Until then there is nothing to offer.
      if (outcome !== 'accepted') link.hidden = true;
    } catch (err) {
      console.warn('[pwa] install prompt failed:', err && err.message);
    }
  });
}
