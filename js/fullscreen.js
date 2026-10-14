/**
 * fullscreen.js — Fullscreen watch-and-discuss mode.
 *
 * The expand button turns a card into a fixed overlay covering the
 * viewport — pure CSS, no navigation, no loading. On exit, the feed
 * scrolls back to whichever card was at the top before expanding.
 */

import { state } from './state.js';
import { toggleComments } from './comments-ui.js';
import { forceLoadIframe } from './lazy-iframe.js';
import { cssEscape } from './utils.js';

/** Finds the video_id of the topmost card currently visible under the header. */
function topmostVisibleCardId() {
  const headerHeight = document.getElementById('header')?.offsetHeight || 0;
  for (const card of document.querySelectorAll('#feed-container .media-card')) {
    if (card.offsetParent === null) continue; // not laid out (hidden/detached)
    // Require a meaningful part of the card below the header — a sub-pixel
    // sliver of the previous card must not steal the scroll anchor.
    if (card.getBoundingClientRect().bottom > headerHeight + 40) {
      return card.dataset.videoId || null;
    }
  }
  return null;
}

// Selector for the controls a keyboard user can Tab through inside the overlay.
const FULLSCREEN_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Elements marked `inert` while the overlay is open so the background feed,
// header, and footer can't be clicked, tabbed into, or read by a screen
// reader. The fullscreen card is a DESCENDANT of a feed container, so inerting
// one of its ancestors would disable the card itself — instead we inert every
// sibling along the card's path up to <body>, sealing the page while leaving
// the card (and its ancestors) interactive. Restored verbatim on exit.
let inertedBackground = [];

function applyBackgroundInert(card) {
  inertedBackground = [];
  let node = card;
  while (node && node.parentElement) {
    const parent = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node) continue;
      // Keep the toast layer live so status announcements still reach AT.
      if (sibling.id === 'toast-container') continue;
      if (sibling.hasAttribute('inert')) continue; // leave any pre-existing inert alone
      sibling.setAttribute('inert', '');
      inertedBackground.push(sibling);
    }
    if (parent === document.body) break;
    node = parent;
  }
}

function clearBackgroundInert() {
  for (const el of inertedBackground) el.removeAttribute('inert');
  inertedBackground = [];
}

/** Visible, tabbable descendants of the overlay, in DOM order. */
function focusableInOverlay(root) {
  return Array.from(root.querySelectorAll(FULLSCREEN_FOCUSABLE)).filter((el) => {
    if (el.getAttribute('tabindex') === '-1') return false;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.hasAttribute('inert')) return false;
      if (n.hidden) return false;
      if (n.style && n.style.display === 'none') return false;
    }
    return true;
  });
}

/**
 * Keeps Tab focus cycling within the open overlay. The inert background already
 * blocks the page; this wraps focus at the ends and pulls stray focus back in
 * so Tab can't escape to the browser chrome and then re-enter the hidden feed.
 */
function handleFocusTrap(e) {
  if (e.key !== 'Tab') return;
  const card = document.querySelector('.media-card--fullscreen');
  if (!card) return;
  const focusable = focusableInOverlay(card);
  if (focusable.length === 0) {
    e.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!card.contains(active)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

export function toggleFullscreen(card) {
  if (state.fullscreenVideoId) {
    exitFullscreen();
  } else {
    enterFullscreen(card);
  }
}

export function enterFullscreen(card) {
  const videoId = card.dataset.videoId;
  if (!videoId || state.fullscreenVideoId) return;

  state.fullscreenReturnId = topmostVisibleCardId();
  state.fullscreenReturnScrollY = window.scrollY;
  const anchor = state.fullscreenReturnId
    ? document.querySelector(`#feed-container .media-card[data-video-id="${cssEscape(state.fullscreenReturnId)}"]`)
    : null;
  state.fullscreenReturnAnchorTop = anchor ? anchor.getBoundingClientRect().top : null;
  state.fullscreenVideoId = videoId;

  document.body.classList.add('fullscreen-mode');
  card.classList.add('media-card--fullscreen');

  // The overlay is a modal: announce it as a dialog and seal off the rest of
  // the page so assistive tech and Tab focus can't reach the hidden feed
  // behind it (the fixed overlay visually covers header, feed, and footer).
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  applyBackgroundInert(card);

  // The overlay is on screen now — load its iframe immediately instead of
  // waiting for the IntersectionObserver (which no longer sees it move).
  forceLoadIframe(card);

  // Fullscreen is the watch-and-discuss view — open the comments.
  const body = card.querySelector(`.media-card__comments-body[data-video-id="${cssEscape(videoId)}"]`);
  if (body && body.style.display === 'none') {
    toggleComments(videoId);
  }

  const expandBtn = card.querySelector('.media-card__expand');
  if (expandBtn) {
    expandBtn.title = 'Exit fullscreen';
    expandBtn.setAttribute('aria-label', 'Exit fullscreen');
    const icon = expandBtn.querySelector('.media-card__expand-icon');
    if (icon) icon.textContent = '✕';
  }

  // Trap Tab focus inside the overlay and move focus to the exit control so a
  // keyboard/screen-reader user starts inside the dialog, not on the (now
  // inert) page behind it.
  document.addEventListener('keydown', handleFocusTrap, true);
  if (expandBtn) expandBtn.focus();
}

export function exitFullscreen() {
  const card = document.querySelector('.media-card--fullscreen');
  const returnId = state.fullscreenReturnId;
  const returnScrollY = state.fullscreenReturnScrollY;
  const returnAnchorTop = state.fullscreenReturnAnchorTop;

  state.fullscreenVideoId = null;
  state.fullscreenReturnId = null;
  state.fullscreenReturnAnchorTop = null;

  // Reverse the modal wiring set up on enter: drop the focus trap and make the
  // background interactive again.
  document.removeEventListener('keydown', handleFocusTrap, true);
  clearBackgroundInert();

  document.body.classList.remove('fullscreen-mode');
  let expandToRefocus = null;
  if (card) {
    card.classList.remove('media-card--fullscreen');
    card.removeAttribute('role');
    card.removeAttribute('aria-modal');
    const expandBtn = card.querySelector('.media-card__expand');
    if (expandBtn) {
      expandBtn.title = 'Expand';
      expandBtn.setAttribute('aria-label', 'Expand');
      const icon = expandBtn.querySelector('.media-card__expand-icon');
      if (icon) icon.textContent = '⛶';
      expandToRefocus = expandBtn; // return focus here once teardown settles
    }
    // A deep-linked card (share.js) is a temporary mount outside the feed —
    // remove it so the feed is all that remains.
    if (card.dataset.deepLink === '1') {
      card.remove();
      expandToRefocus = null; // its expand control is gone with it
    }
  }

  // A shared link's ?v= stays in the URL while the overlay is open (so a
  // refresh reopens the video); leaving the overlay is leaving the video,
  // whether it was a temp card or one already in the feed — strip it so the
  // URL matches what's on screen. (Inline rather than share.js's
  // clearShareParam: share.js imports enterFullscreen from here.)
  if (new URLSearchParams(location.search).has('v')) {
    history.replaceState(null, '', location.pathname);
  }

  // Land back exactly where the user was. The exact offset is right when
  // nothing moved; if the feed shifted while fullscreen (revalidation,
  // inserted cards), nudge so the top card sits where it was before.
  window.scrollTo({ top: returnScrollY, behavior: 'auto' });
  if (returnId) {
    const anchor = document.querySelector(`#feed-container .media-card[data-video-id="${cssEscape(returnId)}"]`);
    if (anchor && returnAnchorTop != null) {
      const delta = anchor.getBoundingClientRect().top - returnAnchorTop;
      if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: 'auto' });
    } else if (anchor) {
      anchor.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }

  // Return focus to the control that opened the overlay so keyboard users land
  // back where they were (skipped when a deep-link card was removed above).
  if (expandToRefocus && document.contains(expandToRefocus)) {
    expandToRefocus.focus();
  }
}

export function setupFullscreenKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.fullscreenVideoId) {
      exitFullscreen();
    }
  });
}
