/**
 * cards.js — Card construction and list rendering.
 *
 * createMediaCard (feed.js) produces the HTML string; buildCard turns it
 * into a live element wired to comments, votes, stars, and fullscreen.
 * The feed engine (app.js) and the views (views.js) both render through
 * here so every card behaves the same regardless of which list it's in.
 */

import { createMediaCard, createChannelCard } from './feed.js';
import { state } from './state.js';
import { toggleComments } from './comments-ui.js';
import { toggleVote } from './votes.js';
import { toggleStar, markStarButton } from './stars.js';
import { toggleBookmark, markBookmarkButton } from './bookmarks.js';
import { toggleFullscreen } from './fullscreen.js';
import { shareVideo } from './share.js';
import { observeLazyIframe } from './lazy-iframe.js';

/**
 * Builds a card element from a media item and wires up its comment
 * toggle. Caller inserts it into the DOM, then calls observeLazyIframe —
 * observing must happen after insertion so the first intersection
 * snapshot already sees an attached, visible element.
 */
export function buildCard(video, opts) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = createMediaCard(video, opts);
  const card = wrapper.firstElementChild;

  // Cache the parsed publish time on the element (FE17). Chronological insert
  // and the revalidate reorder pass compare cards by this — reading a numeric
  // expando instead of constructing a fresh Date from data-published-at on
  // every pairwise comparison, which made those passes O(n·m) in Date parses.
  card._publishedAtMs = new Date(card.dataset.publishedAt || 0).getTime();

  const toggle = card.querySelector('.media-card__comments-toggle');
  if (toggle) {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleComments(toggle.dataset.videoId);
    });
  }

  const voteBtn = card.querySelector('.media-card__vote');
  if (voteBtn) {
    if (state.myVotes.has(voteBtn.dataset.videoId)) {
      voteBtn.classList.add('media-card__vote--active');
      voteBtn.setAttribute('aria-pressed', 'true');
    }
    voteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleVote(voteBtn.dataset.videoId);
    });
  }

  const starBtn = card.querySelector('.media-card__star');
  if (starBtn) {
    if (state.myStars.has(video.channel_name)) {
      markStarButton(starBtn, true);
    }
    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleStar(video.channel_name);
    });
  }

  const bookmarkBtn = card.querySelector('.media-card__bookmark');
  if (bookmarkBtn) {
    if (state.myBookmarks.has(bookmarkBtn.dataset.videoId)) {
      markBookmarkButton(bookmarkBtn, true);
    }
    bookmarkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBookmark(bookmarkBtn.dataset.videoId);
    });
  }

  const shareBtn = card.querySelector('.media-card__share');
  if (shareBtn) {
    shareBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      shareVideo(video.video_id, video.title);
    });
  }

  const expandBtn = card.querySelector('.media-card__expand');
  if (expandBtn) {
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFullscreen(card);
    });
  }

  return card;
}

/**
 * Builds a channel card element (Channels tab) and wires its favorite button
 * and avatar fallback. The star reuses the media-card star machinery, so
 * toggling here syncs every other star for the same channel and reconciles on
 * sign-in like any card star. If the avatar image fails to load, it's removed
 * to reveal the monogram tile rendered beneath it.
 */
export function buildChannelCard(creator) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = createChannelCard(creator);
  const card = wrapper.firstElementChild;

  const starBtn = card.querySelector('.media-card__star');
  if (starBtn) {
    if (state.myStars.has(creator.channel_name)) markStarButton(starBtn, true);
    starBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleStar(creator.channel_name);
    });
  }

  const avatar = card.querySelector('.channel-card__avatar');
  if (avatar) {
    avatar.addEventListener('error', () => avatar.remove());
  }

  return card;
}

/**
 * The card's parsed publish time in ms. Prefers the numeric expando cached at
 * build time (buildCard); falls back to a one-off parse for any element not
 * built here (defensive — every feed card goes through buildCard).
 */
export function cardTimeMs(card) {
  const cached = card._publishedAtMs;
  return typeof cached === 'number' ? cached : new Date(card.dataset.publishedAt || 0).getTime();
}

/**
 * Inserts a card at its reverse-chronological position among the
 * container's existing cards (the feed is newest-first).
 */
export function insertCardChronologically(container, card) {
  const t = cardTimeMs(card);
  const existing = container.querySelectorAll('.media-card');
  for (const other of existing) {
    if (cardTimeMs(other) < t) {
      container.insertBefore(card, other);
      return;
    }
  }
  container.appendChild(card);
}

/**
 * Renders a full list synchronously, shorts included, in the given order
 * (chronological for Latest/Starred, vote-ranked for Top This Week).
 * Used by tab switches and filter re-renders: the data is already loaded,
 * so everything appears at once — no deferred reveal, no flicker. The
 * animated shorts reveal is reserved for the Latest feed's network loads
 * (appendCards in app.js).
 */
/**
 * How many cards of a fresh paint load their preview image eagerly at high
 * fetch priority (createMediaCard `priority`). Two covers the first screen on
 * a phone with margin; the rest stay lazy so a slow link spends its bandwidth
 * on what is visible first. Measured 2026-10-07 on Slow 4G: the LCP image
 * took 1.3s after the cards appeared while sharing the link with five others.
 */
export const FIRST_PAINT_PRIORITY_CARDS = 2;

export function renderList(container, videos) {
  // A fresh paint into an empty container: its first cards are the first
  // screen, so their preview images load eagerly at high priority (the LCP
  // candidate). Re-renders into a populated container get no such head start.
  const priorityUntil = container.childElementCount === 0 ? FIRST_PAINT_PRIORITY_CARDS : 0;
  videos.forEach((video, i) => {
    const card = buildCard(video, { priority: i < priorityUntil });
    container.appendChild(card);
    observeLazyIframe(card);
  });
}

/**
 * Reconciles the `.media-card` elements in `container` to exactly `videos`, in
 * order, reusing the card already mounted for a video_id rather than rebuilding
 * it. Unlike renderList (which callers pair with `innerHTML = ''`), a surviving
 * card keeps its live state — an expanded comment thread, a promoted/playing
 * iframe — so incremental search results no longer wipe them on every index
 * chunk (FE10). Only cards are managed; the caller owns any sibling nodes (e.g.
 * a truncation note) and should strip them before calling and re-add after.
 *
 * The fullscreen card (state.fullscreenVideoId) is never removed or moved —
 * it's a fixed, playing overlay and reparenting it would reload the video.
 *
 * @param {HTMLElement} container
 * @param {Object[]} videos - the exact desired card list, in order
 */
export function reconcileList(container, videos) {
  const existing = new Map();
  for (const card of container.querySelectorAll('.media-card')) {
    if (card.dataset.videoId) existing.set(card.dataset.videoId, card);
  }

  const desired = new Set();
  for (const v of videos) {
    if (v && v.video_id != null) desired.add(String(v.video_id));
  }

  // Drop cards no longer wanted (never the fullscreen overlay).
  for (const [id, card] of existing) {
    if (!desired.has(id) && id !== state.fullscreenVideoId) {
      card.remove();
      existing.delete(id);
    }
  }

  // Walk the desired order, reusing or building each card and placing it only
  // when it's not already in position — an unmoved card is never detached, so
  // its iframe and expanded comments survive untouched.
  let prev = null;
  for (const v of videos) {
    const id = v && v.video_id != null ? String(v.video_id) : '';
    let card = existing.get(id);
    if (card) {
      const anchor = prev ? prev.nextElementSibling : container.firstElementChild;
      if (card !== anchor) container.insertBefore(card, anchor);
    } else {
      card = buildCard(v);
      container.insertBefore(card, prev ? prev.nextElementSibling : container.firstElementChild);
      observeLazyIframe(card);
      existing.set(id, card);
    }
    prev = card;
  }
}
