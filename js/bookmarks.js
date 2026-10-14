/**
 * bookmarks.js — Bookmarked items: optimistic toggling, persistence, and
 * sign-in reconciliation.
 *
 * The stars pattern applied to individual items instead of channels:
 * bookmarked video ids persist to localStorage so buttons paint instantly
 * on reload, then reconcile against the server via the sign-in bootstrap.
 * The intent itself goes to the action queue (action-queue.js), which sends
 * it as a desired state, retries a lost result, survives a reload, and
 * paces sends to the backend's per-user throttle. This module owns the
 * paint. The 'bookmarks' epoch orders local mutations against the bootstrap
 * snapshot so a slow fetch can't clobber a bookmark the user just toggled.
 *
 * The Bookmarks view re-renders when bookmarks change; that render lives
 * in views.js, which registers itself via setOnBookmarksChanged —
 * bookmarks.js stays free of view knowledge (and of an import cycle).
 */

import { state, epoch } from './state.js';
import { api } from './api-client.js';
import { isSignedIn, getToken, isTokenExpired, refreshToken } from './auth.js';
import { loadBookmarkedIds, saveBookmarkedIds, clearBookmarkedIds } from './cache.js';
import { showToast } from './toast.js';
import { cssEscape } from './utils.js';
import { registerActionKind, enqueueAction, isActionInFlight, pendingActions } from './action-queue.js';

const KIND = 'bookmark';

// Called after any confirmed bookmark change (server reconcile) so the
// active view can repaint. Registered by app wiring; no-op until then.
let onBookmarksChanged = () => {};

export function setOnBookmarksChanged(fn) {
  onBookmarksChanged = fn;
}

/** Applies the visual saved/unsaved state to one bookmark button. */
export function markBookmarkButton(btn, bookmarked) {
  btn.classList.toggle('media-card__bookmark--active', bookmarked);
  btn.setAttribute('aria-pressed', bookmarked ? 'true' : 'false');
  btn.title = bookmarked ? 'Remove bookmark' : 'Save for later';
}

/** Updates every bookmark button for a video (cards may repeat across views). */
function setBookmarkButtons(videoId, bookmarked) {
  document.querySelectorAll(`.media-card__bookmark[data-video-id="${cssEscape(videoId)}"]`).forEach(btn => {
    markBookmarkButton(btn, bookmarked);
  });
}

/** Persists bookmarked ids so buttons paint instantly on reload. */
function saveBookmarksToStorage() {
  saveBookmarkedIds(state.myBookmarks);
}

export function loadBookmarksFromStorage() {
  state.myBookmarks = loadBookmarkedIds();
}

/**
 * Paints `bookmarked` for a video and persists it — the optimistic step
 * shared by a press and a restored queue entry (see stars.js for why the
 * cache is written here and not only on confirm).
 */
function applyBookmarkLocally(videoId, bookmarked) {
  epoch.bump('bookmarks');
  if (bookmarked) state.myBookmarks.add(videoId); else state.myBookmarks.delete(videoId);
  setBookmarkButtons(videoId, bookmarked);
  saveBookmarksToStorage();
}

/**
 * Toggles the current user's bookmark on an item, optimistically.
 * The server is the source of truth for the final state.
 */
export function toggleBookmark(videoId) {
  if (!videoId) return;
  if (!isSignedIn()) {
    showToast('Please sign in to bookmark', 'info');
    return;
  }

  // In-flight guard (FE19): one gesture, one toggle. Ignore a repeat click for
  // the same video until its request settles. A press on a bookmark that is
  // queued but not yet sent is honored — it coalesces in the queue.
  if (isActionInFlight(KIND, videoId)) return;

  const wasBookmarked = state.myBookmarks.has(videoId);
  applyBookmarkLocally(videoId, !wasBookmarked);
  enqueueAction(KIND, videoId, !wasBookmarked, wasBookmarked);
}

registerActionKind(KIND, {
  send: (entry, token) => api.bookmark(entry.id, token, entry.desired),

  apply: (entry) => applyBookmarkLocally(entry.id, entry.desired),

  onConfirmed(entry, res) {
    // Reconcile with server truth
    epoch.bump('bookmarks');
    if (res.bookmarked) state.myBookmarks.add(entry.id); else state.myBookmarks.delete(entry.id);
    setBookmarkButtons(entry.id, !!res.bookmarked);
    saveBookmarksToStorage();
    onBookmarksChanged();
  },

  onFailed(entry, error) {
    console.error('Failed to bookmark:', error);
    // Rollback to where the first press started.
    epoch.bump('bookmarks');
    if (entry.prev) state.myBookmarks.add(entry.id); else state.myBookmarks.delete(entry.id);
    setBookmarkButtons(entry.id, entry.prev);
    saveBookmarksToStorage();
    onBookmarksChanged();
    // A backend that predates bookmarks answers "Unknown action" — say so plainly
    const msg = /^Unknown action/i.test(error.message || '')
      ? "Bookmarking isn't available yet — please try again later."
      : (error.message || 'Failed to bookmark. Please try again.');
    showToast(msg, 'error');
  },
});

/**
 * Re-fetches the signed-in user's bookmarks and marks their buttons. There is
 * no standalone myBookmarks action — the batched bootstrap request is the
 * only server source — so this rides that (its votes/stars payload is ignored).
 */
export async function loadMyBookmarks() {
  if (!isSignedIn()) return;
  let token = getToken();
  if (isTokenExpired()) token = await refreshToken();
  if (!token) return; // can't reconcile right now; the cache stays best-effort
  await reconcileMyBookmarks(api.fetchBootstrap(token));
}

/**
 * Applies a bookmark snapshot from the batched bootstrap request to the UI
 * and localStorage. Captures the bookmarks epoch BEFORE awaiting so a
 * bookmark toggled while the request is in flight beats the older snapshot;
 * bookmarks still waiting in the action queue are laid over the snapshot,
 * since the server hasn't heard of them yet. Takes the request promise so
 * the sign-in bootstrap feeds this, the vote reconciler, and the star
 * reconciler the SAME request — one round trip.
 *
 * @param {Promise<{bookmark_ids?: string[]}>} fetchPromise
 */
export async function reconcileMyBookmarks(fetchPromise) {
  const e = epoch.observe('bookmarks');
  try {
    const data = await fetchPromise;
    // A bookmark toggled while this was in flight beats the older snapshot
    if (!e.current()) return;

    // A live backend that predates bookmarks omits bookmark_ids from the
    // bootstrap payload — keep the local cache rather than wiping it.
    if (!data || !Array.isArray(data.bookmark_ids)) return;

    state.myBookmarks = new Set(data.bookmark_ids.map(String));
    for (const pending of pendingActions(KIND)) {
      if (pending.desired) state.myBookmarks.add(pending.id); else state.myBookmarks.delete(pending.id);
    }
    saveBookmarksToStorage();
    document.querySelectorAll('.media-card__bookmark').forEach(btn => {
      markBookmarkButton(btn, state.myBookmarks.has(btn.dataset.videoId));
    });
    onBookmarksChanged();
  } catch (err) {
    /* silent — bookmarking still works, buttons just won't show prior state */
  }
}

/** Clears all bookmark markings (on sign-out). */
export function clearBookmarkMarkings() {
  state.myBookmarks.clear();
  clearBookmarkedIds();
  document.querySelectorAll('.media-card__bookmark--active').forEach(btn => {
    markBookmarkButton(btn, false);
  });
}
