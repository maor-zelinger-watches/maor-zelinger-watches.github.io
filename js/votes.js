/**
 * votes.js — Upvotes: optimistic toggling and sign-in reconciliation.
 *
 * The server is the source of truth for counts; the UI flips instantly
 * and the intent goes to the action queue (action-queue.js), which sends
 * it as a desired state, retries a lost result, survives a reload, and
 * paces sends to the backend's per-user throttle. This module owns the
 * paint: what a confirmed, failed, or restored vote looks like.
 *
 * The 'votes' epoch orders local mutations against the fetchMyVotes
 * snapshot so a slow fetch can't clobber a vote the user just cast.
 */

import { state, patchVideoEverywhere, epoch } from './state.js';
import { api } from './api-client.js';
import { isSignedIn, getToken, isTokenExpired, refreshToken } from './auth.js';
import { showToast } from './toast.js';
import { cssEscape } from './utils.js';
import { registerActionKind, enqueueAction, isActionInFlight, pendingActions } from './action-queue.js';

const KIND = 'vote';

// Fires after a server-confirmed vote lands (count patched into every cached
// row copy). app.js registers the Top This Week re-rank here — same shape as
// stars.js's setOnStarsChanged, keeping votes.js view-agnostic.
let onVotesChanged = () => {};

export function setOnVotesChanged(fn) {
  onVotesChanged = fn;
}

/** Updates every vote button for a video (both views may have one rendered). */
function setVoteButtons(videoId, voted, count) {
  document.querySelectorAll(`.media-card__vote[data-video-id="${cssEscape(videoId)}"]`).forEach(btn => {
    btn.classList.toggle('media-card__vote--active', voted);
    btn.setAttribute('aria-pressed', voted ? 'true' : 'false');
    if (count != null) {
      const countEl = btn.querySelector('.media-card__vote-count');
      if (countEl) countEl.textContent = String(count);
    }
  });
}

/** The count a rendered vote button shows right now (null when none is rendered). */
function shownCount(videoId) {
  const el = document.querySelector(`.media-card__vote[data-video-id="${cssEscape(videoId)}"] .media-card__vote-count`);
  return el ? (parseInt(el.textContent, 10) || 0) : null;
}

/**
 * Paints `voted` for a video and moves the shown count by the matching
 * delta — the optimistic step shared by a press and a restored entry.
 */
function applyVoteLocally(videoId, voted) {
  epoch.bump('votes');
  if (voted) state.myVotes.add(videoId); else state.myVotes.delete(videoId);
  const current = shownCount(videoId);
  const next = current == null ? null : Math.max(0, current + (voted ? 1 : -1));
  setVoteButtons(videoId, voted, next);
}

/**
 * Toggles the current user's upvote on a video, optimistically.
 * The server is the source of truth for the final count.
 */
export function toggleVote(videoId) {
  if (!isSignedIn()) {
    showToast('Please sign in to vote', 'info');
    return;
  }

  // In-flight guard (FE19): one gesture, one toggle. Ignore a repeat click for
  // the same video until its request settles. A press on a vote that is
  // queued but not yet sent is honored — it coalesces in the queue.
  if (isActionInFlight(KIND, videoId)) return;

  const wasVoted = state.myVotes.has(videoId);
  applyVoteLocally(videoId, !wasVoted);
  enqueueAction(KIND, videoId, !wasVoted, wasVoted);
}

registerActionKind(KIND, {
  send: (entry, token) => api.vote(entry.id, token, entry.desired),

  apply: (entry) => applyVoteLocally(entry.id, entry.desired),

  onConfirmed(entry, res) {
    // Reconcile with server truth
    epoch.bump('votes');
    if (res.voted) state.myVotes.add(entry.id); else state.myVotes.delete(entry.id);
    setVoteButtons(entry.id, !!res.voted, res.vote_count);
    // Every cached copy of the row (+ localStorage, coalesced) — FE13.
    patchVideoEverywhere(entry.id, { vote_count: res.vote_count });
    // The new count may move this video within the Top This Week ranking.
    onVotesChanged();
  },

  onFailed(entry, error) {
    console.error('Failed to vote:', error);
    // Rollback to where the first press started. Undo exactly our optimistic
    // delta from whatever count is displayed NOW — a concurrent update may
    // have replaced the pre-press count already.
    epoch.bump('votes');
    if (entry.prev) state.myVotes.add(entry.id); else state.myVotes.delete(entry.id);
    const current = shownCount(entry.id);
    const reverted = current == null ? null : Math.max(0, current - (entry.desired ? 1 : -1));
    setVoteButtons(entry.id, entry.prev, reverted);
    showToast(error.message || 'Failed to vote. Please try again.', 'error');
  },
});

/**
 * Loads the signed-in user's upvotes and marks their buttons.
 * Called on sign-in so the UI reflects past votes.
 */
export async function loadMyVotes() {
  if (!isSignedIn()) return;
  let token = getToken();
  if (isTokenExpired()) token = await refreshToken();
  if (!token) return; // can't reconcile right now
  await reconcileMyVotes(api.fetchMyVotes(token));
}

/**
 * Applies a myVotes snapshot (from fetchMyVotes OR the batched bootstrap
 * request) to the UI. Captures the vote epoch BEFORE awaiting so a vote cast
 * while the request is in flight beats the older snapshot; votes still
 * waiting in the action queue are laid over the snapshot, since the server
 * hasn't heard of them yet. Takes the request promise (not a token) so the
 * sign-in bootstrap can feed both this and reconcileMyStars the SAME
 * request — one round trip, two consumers.
 *
 * @param {Promise<{video_ids?: string[]}>} fetchPromise
 */
export async function reconcileMyVotes(fetchPromise) {
  const e = epoch.observe('votes');
  try {
    const data = await fetchPromise;
    // A vote cast while this was in flight beats the older snapshot
    if (!e.current()) return;

    state.myVotes = new Set(data.video_ids || []);
    for (const pending of pendingActions(KIND)) {
      if (pending.desired) state.myVotes.add(pending.id); else state.myVotes.delete(pending.id);
    }
    document.querySelectorAll('.media-card__vote').forEach(btn => {
      const voted = state.myVotes.has(btn.dataset.videoId);
      btn.classList.toggle('media-card__vote--active', voted);
      btn.setAttribute('aria-pressed', voted ? 'true' : 'false');
    });
  } catch (e) {
    /* silent — voting still works, buttons just won't show prior state */
  }
}

/** Clears all vote markings (on sign-out). */
export function clearVoteMarkings() {
  state.myVotes.clear();
  document.querySelectorAll('.media-card__vote--active').forEach(btn => {
    btn.classList.remove('media-card__vote--active');
    btn.setAttribute('aria-pressed', 'false');
  });
}
