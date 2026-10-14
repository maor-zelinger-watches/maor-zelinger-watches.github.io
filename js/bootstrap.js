/**
 * bootstrap.js — one-round-trip sign-in reconciliation.
 *
 * On sign-in the client needs four things about the user: which videos
 * they've upvoted, which creators they've starred, which items they've
 * bookmarked, and whether they've answered the marketing-email question.
 * Fetched separately those were POSTs that — because Apps Script serializes
 * a user's requests — queued nose-to-tail at boot, and each re-verified the
 * ID token over the network.
 *
 * loadMyVotesAndStars fires the single batched `bootstrap` request and hands
 * the SAME promise to every reconciler. Each still captures its own epoch
 * before awaiting, so a vote, star, or bookmark toggled while the request is
 * in flight wins — the batching changes the transport, not the race semantics.
 */

/*
 * Clickjacking frame-buster. This JS is the ONLY working protection: the CSP
 * in index.html ships via <meta http-equiv>, and the spec says frame-ancestors
 * is IGNORED when delivered that way — and GitHub Pages can't send real HTTP
 * headers (X-Frame-Options / frame-ancestors). Without this, an attacker can
 * frame the site invisibly over decoy UI and a returning visitor's restored
 * localStorage session makes their clicks land on vote/star/comment controls.
 * Do not "simplify" this away. If the site ever moves behind a host that can
 * send headers, add X-Frame-Options: DENY / frame-ancestors 'none' there and
 * keep this as defense-in-depth.
 */
if (self !== top) {
  document.documentElement.style.display = 'none';
  try { top.location = self.location; } catch (e) {}
}

import { api } from './api-client.js';
import { isSignedIn, getToken, isTokenExpired, refreshToken, signOut } from './auth.js';
import { reconcileMyVotes } from './votes.js';
import { reconcileMyStars } from './stars.js';
import { reconcileMyBookmarks } from './bookmarks.js';
import { reconcileMyEmailConsent } from './auth-overlay.js';

export async function loadMyVotesAndStars() {
  if (!isSignedIn()) return;
  let token = getToken();
  if (isTokenExpired()) token = await refreshToken();
  if (!token) return; // can't reconcile right now; caches stay best-effort

  // One promise for every reconciler — created BEFORE anything is awaited so
  // each reconciler's epoch capture still precedes the request (see above).
  const pending = fetchBootstrapWithReauth(token);
  await Promise.all([
    reconcileMyVotes(pending),
    reconcileMyStars(pending),
    reconcileMyBookmarks(pending),
    reconcileMyEmailConsent(pending),
  ]);
}

// The backend's answers that mean "this session is no longer accepted" even
// though the token's own exp hasn't passed: a revoked session (server
// sign-out on another device, a block), a session past its absolute max age,
// or a token minted before sessions carried a version (the one-time cutover).
const SESSION_REJECTED_RE = /invalid authentication token|session too old|have been blocked/i;

/** True when an API error says the server no longer accepts our session. */
export function isSessionRejected(err) {
  return !!(err && SESSION_REJECTED_RE.test(String(err.message || err)));
}

/**
 * The bootstrap request, with one recovery attempt when the server rejects
 * the session: a locally-valid token can still be refused server-side (see
 * SESSION_REJECTED_RE), and without this the page would sit "signed in" while
 * every action failed. refreshToken() first tries a silent renewal, then
 * Google One Tap (auto-select — usually no UI for a live Google session); if
 * that yields a token the bootstrap is retried once, otherwise — or if the
 * retry is refused too — the page signs out so the UI matches the server.
 *
 * @param {string} token
 * @returns {Promise<Object>} the bootstrap payload
 */
async function fetchBootstrapWithReauth(token) {
  try {
    return await api.fetchBootstrap(token);
  } catch (err) {
    if (!isSessionRejected(err)) throw err;
    const fresh = await refreshToken().catch(() => null);
    if (fresh) {
      try {
        return await api.fetchBootstrap(fresh);
      } catch (err2) {
        if (!isSessionRejected(err2)) throw err2;
      }
    }
    signOut();
    throw err;
  }
}
