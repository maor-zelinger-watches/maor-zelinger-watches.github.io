/**
 * stars.js — Starred creators: optimistic toggling, persistence, and
 * sign-in reconciliation.
 *
 * Starred channels persist to localStorage so buttons paint instantly on
 * reload, then reconcile against the server on sign-in. The intent itself
 * goes to the action queue (action-queue.js), which sends it as a desired
 * state, retries a lost result, survives a reload, and paces sends to the
 * backend's per-user throttle. This module owns the paint.
 *
 * The 'stars' epoch orders local mutations against the fetchMyStars
 * snapshot so a slow fetch can't clobber a star the user just toggled.
 *
 * The Starred view re-renders when stars change; that render lives in
 * views.js, which registers itself via setOnStarsChanged — stars.js
 * stays free of view knowledge (and of an import cycle).
 */

import { state, epoch } from './state.js';
import { api } from './api-client.js';
import { isSignedIn, getToken, isTokenExpired, refreshToken } from './auth.js';
import { loadStarredChannels, saveStarredChannels, clearStarredChannels } from './cache.js';
import { showToast } from './toast.js';
import { registerActionKind, enqueueAction, isActionInFlight, pendingActions } from './action-queue.js';

const KIND = 'star';

// Called after any confirmed star change (server reconcile) so the
// active view can repaint. Registered by app wiring; no-op until then.
let onStarsChanged = () => {};

export function setOnStarsChanged(fn) {
  onStarsChanged = fn;
}

/** Applies the visual starred/unstarred state to one star button. */
export function markStarButton(btn, starred) {
  btn.classList.toggle('media-card__star--active', starred);
  btn.setAttribute('aria-pressed', starred ? 'true' : 'false');
  btn.textContent = starred ? '★' : '☆';
}

/** Updates every star button for a channel (cards may repeat across views). */
function setStarButtons(channel, starred) {
  document.querySelectorAll('.media-card__star').forEach(btn => {
    if (btn.dataset.channel === channel) markStarButton(btn, starred);
  });
}

/** Persists starred channels so buttons paint instantly on reload. */
function saveStarsToStorage() {
  saveStarredChannels(state.myStars);
}

export function loadStarsFromStorage() {
  state.myStars = loadStarredChannels();
}

/**
 * Paints `starred` for a channel and persists it — the optimistic step
 * shared by a press and a restored queue entry. Persisting here (not only
 * on confirm) keeps the instant-paint cache in step with the queue after a
 * reload: the button shows the intent while the queue is still sending it.
 */
function applyStarLocally(channel, starred) {
  epoch.bump('stars');
  if (starred) state.myStars.add(channel); else state.myStars.delete(channel);
  setStarButtons(channel, starred);
  saveStarsToStorage();
}

/**
 * Toggles the current user's star on a creator, optimistically.
 * The server is the source of truth for the final state.
 */
export function toggleStar(channel) {
  if (!channel) return;
  if (!isSignedIn()) {
    showToast('Please sign in to favorite creators', 'info');
    return;
  }

  // In-flight guard (FE19): ignore a repeat press until its request settles.
  // A press on a star that is queued but not yet sent coalesces in the queue.
  if (isActionInFlight(KIND, channel)) return;

  const wasStarred = state.myStars.has(channel);
  applyStarLocally(channel, !wasStarred);
  enqueueAction(KIND, channel, !wasStarred, wasStarred);
}

registerActionKind(KIND, {
  send: (entry, token) => api.star(entry.id, token, entry.desired),

  apply: (entry) => applyStarLocally(entry.id, entry.desired),

  onConfirmed(entry, res) {
    // Reconcile with server truth
    epoch.bump('stars');
    if (res.starred) state.myStars.add(entry.id); else state.myStars.delete(entry.id);
    setStarButtons(entry.id, !!res.starred);
    saveStarsToStorage();
    onStarsChanged();
  },

  onFailed(entry, error) {
    console.error('Failed to star:', error);
    // Rollback to where the first press started.
    epoch.bump('stars');
    if (entry.prev) state.myStars.add(entry.id); else state.myStars.delete(entry.id);
    setStarButtons(entry.id, entry.prev);
    saveStarsToStorage();
    onStarsChanged();
    // A backend that predates stars answers "Unknown action" — say so plainly
    const msg = /^Unknown action/i.test(error.message || '')
      ? "Starring isn't available yet — please try again later."
      : (error.message || 'Failed to star. Please try again.');
    showToast(msg, 'error');
  },
});

/**
 * Loads the signed-in user's starred creators and marks their buttons.
 * Called on sign-in so the UI reflects past stars.
 */
export async function loadMyStars() {
  if (!isSignedIn()) return;
  let token = getToken();
  if (isTokenExpired()) token = await refreshToken();
  if (!token) return; // can't reconcile right now; the cache stays best-effort
  await reconcileMyStars(api.fetchMyStars(token));
}

/**
 * Applies a myStars snapshot (from fetchMyStars OR the batched bootstrap
 * request) to the UI and localStorage. Captures the star epoch BEFORE awaiting
 * so a star toggled while the request is in flight beats the older snapshot;
 * stars still waiting in the action queue are laid over the snapshot, since
 * the server hasn't heard of them yet. Takes the request promise so the
 * sign-in bootstrap can feed both this and reconcileMyVotes the SAME
 * request — one round trip, two consumers.
 *
 * @param {Promise<{channels?: string[]}>} fetchPromise
 */
export async function reconcileMyStars(fetchPromise) {
  const e = epoch.observe('stars');
  try {
    const data = await fetchPromise;
    // A star toggled while this was in flight beats the older snapshot
    if (!e.current()) return;

    state.myStars = new Set(data.channels || []);
    for (const pending of pendingActions(KIND)) {
      if (pending.desired) state.myStars.add(pending.id); else state.myStars.delete(pending.id);
    }
    saveStarsToStorage();
    document.querySelectorAll('.media-card__star').forEach(btn => {
      markStarButton(btn, state.myStars.has(btn.dataset.channel));
    });
    onStarsChanged();
  } catch (e) {
    /* silent — starring still works, buttons just won't show prior state */
  }
}

/** Clears all star markings (on sign-out). */
export function clearStarMarkings() {
  state.myStars.clear();
  clearStarredChannels();
  document.querySelectorAll('.media-card__star--active').forEach(btn => {
    markStarButton(btn, false);
  });
}
