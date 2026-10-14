/**
 * lazy-iframe.js — Deferred iframe loading.
 *
 * Cards render their embed URL into data-src; the shared observer
 * promotes it to src only when the card scrolls near the viewport, so a
 * page of cards doesn't load a page of players at once.
 */

import { registerPlayer } from './single-play.js';

/**
 * Promotes a data-src iframe to a live player: sets src and, once it
 * loads, registers as a listener so single-play.js hears its state
 * changes. No-op if the iframe was already promoted.
 */
function promote(iframe) {
  if (!iframe.dataset.src) return;
  iframe.addEventListener('load', () => registerPlayer(iframe), { once: true });
  iframe.src = iframe.dataset.src;
  delete iframe.dataset.src;
}

const iframeObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      promote(entry.target);
      iframeObserver.unobserve(entry.target);
    }
  });
}, { rootMargin: '150px' });

/**
 * Starts lazy-loading a card's iframe. Must be called after the card is
 * inserted into the DOM — observing must happen after insertion so the
 * first intersection snapshot already sees an attached, visible element.
 */
export function observeLazyIframe(card) {
  const iframe = card.querySelector('iframe[data-src]');
  if (iframe) {
    iframeObserver.observe(iframe);
  }
}

/**
 * Loads a card's iframe immediately, bypassing the observer. Used when a
 * card is promoted to the fullscreen overlay: it's on screen now, but the
 * IntersectionObserver no longer sees it move.
 */
export function forceLoadIframe(card) {
  const iframe = card.querySelector('iframe[data-src]');
  if (iframe) {
    promote(iframe);
    iframeObserver.unobserve(iframe);
  }
}
