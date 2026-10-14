/**
 * auth.js — Google Sign-In integration for How You Watch
 *
 * Uses Google Identity Services (GIS). Sign-in happens through the button in
 * the auth overlay (auth-overlay.js) — there is no automatic One Tap for
 * signed-out visitors. On first sign-in we verify the Google ID token once,
 * then exchange it for a long-lived, app-issued session token (see
 * apps-script/Code.gs). From then on `currentUser.token` holds that session
 * token: page loads and authenticated calls reuse it, and it renews itself
 * with a silent fetch — so a returning visitor never sees any Google UI on
 * open. GIS's One Tap is only re-invoked if the session lapses entirely (an
 * absence longer than the session lifetime).
 */

import { api } from './api-client.js';
import { showToast } from './toast.js';

/**
 * Decodes a base64url-encoded token payload segment (the part between the dots
 * of a Google JWT or an app session token) into an object.
 *
 * JWT/session segments are base64url (`-`/`_`, no padding), which `atob()`
 * rejects — most often triggered by non-ASCII profile names — and the decoded
 * bytes are UTF-8, which `atob()`'s Latin-1 output mojibakes. So convert to
 * standard base64 and decode through TextDecoder.
 *
 * @param {string} segment - the payload segment between the dots
 * @returns {Object} the parsed payload
 */
function decodeTokenPayload(segment) {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * @typedef {Object} User
 * @property {string} name - Display name
 * @property {string} email - Email address
 * @property {string} picture - Avatar URL
 * @property {string} token - Auth token for the backend: an app session token
 *   after exchange, or a raw Google ID token as a fallback before exchange.
 */

// App session tokens are `wds1.<base64url(payload)>.<sig>`; the prefix lets us
// tell one from a Google JWT without decoding. Kept in sync with
// SESSION_TOKEN_PREFIX in apps-script/Code.gs.
const SESSION_TOKEN_PREFIX = 'wds1.';

// Slide a session forward once it's within this long of expiring, so a regular
// visitor's token never lapses. Smaller than the backend's SESSION_TTL_DAYS.
const SESSION_SLIDE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** @type {User|null} */
let currentUser = null;

/** @type {string} */
let _clientId = '';

/**
 * In-flight token refresh, memoized so concurrent callers share ONE refresh.
 * @type {Promise<string|null>|null}
 */
let _refreshPromise = null;

/** @type {Function[]} */
const listeners = [];

// --- guarded localStorage primitives — never throw ------------------
// auth.js owns the `wd_user` key (a credential, not a cache — see cache.js's
// header). Persistence is best-effort: Safari private mode and a full quota
// make setItem throw, but a throw here must never abort a sign-in that already
// succeeded in memory, so every access is wrapped and failures degrade to
// "not persisted" rather than crashing the caller.
function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

function removeStored(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) { /* nothing to heal */ }
}

/**
 * Initializes Google Sign-In.
 * Call this once after the Google Identity Services SDK has loaded.
 * 
 * @param {string} clientId - Google OAuth 2.0 Client ID
 */
export function initAuth(clientId) {
  _clientId = clientId;

  if (typeof google === 'undefined' || !google.accounts) {
    console.warn('Google Identity Services SDK not loaded');
    return;
  }

  // Restore session from localStorage (GIS doesn't persist across refresh)
  const saved = readStored('wd_user');
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      notifyListeners();
    } catch (e) {
      removeStored('wd_user');
    }
  }

  google.accounts.id.initialize({
    client_id: clientId,
    callback: handleCredentialResponse,
    auto_select: true,
  });

  // Deliberately NO automatic One Tap for signed-out visitors: the only
  // Google UI on the page is the button inside the sign-in overlay (opened
  // from the header's Sign in pill). One Tap remains solely the last-resort
  // re-auth path for a lapsed session (interactiveRefresh).
  if (currentUser) {
    // Signed in from a restored session — if the token is getting old, slide it
    // forward in the background. Fire-and-forget and fully silent (no UI); it
    // never blocks first paint.
    maybeSlideSession();
  }
}

/**
 * Silently renews the session token if it's within the slide window of expiry.
 * Best-effort and strictly silent: on any failure the token is still valid, so
 * we just try again on the next load — crucially NOT falling back to the
 * interactive One Tap the way refreshToken() would. No-op for a Google-token
 * fallback session (those can't be slid without GIS).
 */
async function maybeSlideSession() {
  const token = getToken();
  if (!token || !isSessionToken(token)) return;
  const exp = tokenExpiryMs(token);
  if (!(exp && exp > Date.now() && exp - Date.now() < SESSION_SLIDE_WINDOW_MS)) return;
  try {
    const res = await api.createSession(token);
    if (res && res.sessionToken) updateSessionToken(res.sessionToken);
  } catch (e) {
    // Best-effort — the current token is still valid; retry next load.
  }
}

/**
 * Renders the Google Sign-In button in a container element. Always the full
 * "Sign in with Google" pill: its only home is the auth overlay's dialog,
 * which has room on every viewport — the icon-only compact mode existed for
 * the cramped mobile header the button no longer lives in.
 *
 * @param {HTMLElement} container - DOM element to render the button in
 */
export function renderSignInButton(container) {
  if (typeof google === 'undefined' || !google.accounts) return;

  google.accounts.id.renderButton(container, {
    theme: 'filled_black',
    size: 'large',
    shape: 'pill',
    text: 'signin_with',
    type: 'standard',
  });
}

/**
 * Handles the credential response from Google Sign-In.
 * Decodes the JWT for display identity (verification happens server-side), then
 * exchanges the Google ID token for a long-lived app session token so future
 * loads re-authenticate silently. Falls back to the raw Google token if the
 * exchange fails (e.g. an older backend that doesn't mint sessions yet).
 *
 * @param {Object} response - Google credential response
 * @returns {Promise<void>}
 */
async function handleCredentialResponse(response) {
  const googleToken = response.credential;

  try {
    // Decode the JWT payload (base64url) to get user info. Verification happens
    // server-side; this is display-only.
    const payload = decodeTokenPayload(googleToken.split('.')[1]);
    const identity = {
      name: payload.name || payload.email.split('@')[0],
      email: payload.email,
      picture: payload.picture || '',
    };

    // Exchange the Google ID token for an app session token. If anything goes
    // wrong, keep the Google token — sign-in still works, just without the
    // silent-refresh benefit.
    let token = googleToken;
    try {
      const res = await api.createSession(googleToken);
      if (res && res.sessionToken) token = res.sessionToken;
    } catch (e) {
      console.warn('Session exchange failed; using Google token:', e);
    }

    currentUser = { ...identity, token };

    // Persist to localStorage so session survives refresh. Guarded: a storage
    // failure (Safari private mode, quota full from the search index) must NOT
    // reach the outer catch — the user IS signed in, so we always notify
    // listeners regardless of whether persistence succeeded. A non-persisted
    // session simply won't survive a refresh.
    writeStored('wd_user', JSON.stringify(currentUser));

    notifyListeners();
  } catch (error) {
    // Log only the error name, never the error object: the console.error hook
    // in error-reporter.js ships every arg to the backend sheet, and a
    // JSON.parse SyntaxError message can embed fragments of the user's token
    // (SEC8). The name (e.g. "SyntaxError") is enough to triage.
    console.error('Failed to decode credential:', error && error.name);
    showToast('Sign-in failed. Please try again.', 'error');
  }
}

/**
 * Signs out the current user. Also revokes the session server-side — which
 * retires the user's tokens on EVERY device, not just this one — best-effort
 * and fire-and-forget: local state clears immediately either way, and a
 * failed revoke just leaves the token to age out as before.
 */
export function signOut() {
  const token = getToken();
  if (typeof google !== 'undefined' && google.accounts) {
    google.accounts.id.disableAutoSelect();
  }
  currentUser = null;
  removeStored('wd_user');
  notifyListeners();
  if (token) {
    api.revokeSession(token).catch(() => { /* best-effort */ });
  }
}

/**
 * Gets the currently signed-in user.
 * @returns {User|null}
 */
export function getCurrentUser() {
  return currentUser;
}

/**
 * Checks if a user is currently signed in.
 * @returns {boolean}
 */
export function isSignedIn() {
  return currentUser !== null;
}

/**
 * Gets the Google ID token for API authentication.
 * @returns {string|null}
 */
export function getToken() {
  return currentUser ? currentUser.token : null;
}

/** True if the token is an app session token (vs a Google ID token). */
function isSessionToken(token) {
  return typeof token === 'string' && token.indexOf(SESSION_TOKEN_PREFIX) === 0;
}

/**
 * Expiry (ms since epoch) for either token format, or null if undecodable.
 * Session tokens: wds1.<base64url(payload)>.<sig>; Google JWTs: header.payload.sig.
 */
function tokenExpiryMs(token) {
  try {
    if (isSessionToken(token)) {
      const start = SESSION_TOKEN_PREFIX.length;
      const body = token.slice(start, token.indexOf('.', start));
      const payload = decodeTokenPayload(body);
      return payload.exp ? payload.exp * 1000 : null;
    }
    const payload = decodeTokenPayload(token.split('.')[1]);
    return payload.exp ? payload.exp * 1000 : null; // JWT exp is in seconds
  } catch {
    return null;
  }
}

/**
 * Checks if the stored token is expired or about to expire (within 5 min buffer).
 * @returns {boolean}
 */
export function isTokenExpired() {
  if (!currentUser || !currentUser.token) return true;
  const expiresAt = tokenExpiryMs(currentUser.token);
  if (expiresAt === null) return true;
  return Date.now() > expiresAt - 5 * 60 * 1000; // 5 min buffer
}

/**
 * Updates just the auth token in place — after a silent session renewal — and
 * persists it. Deliberately does NOT notify listeners: the user's identity is
 * unchanged, only the token rotated, so there's nothing for the UI to repaint.
 *
 * @param {string} newToken
 */
function updateSessionToken(newToken) {
  if (!currentUser || !newToken) return;
  currentUser.token = newToken;
  writeStored('wd_user', JSON.stringify(currentUser));
}

/**
 * Refreshes the auth token. The common path is SILENT: exchange the current
 * session token for a fresh one via a plain fetch — no Google UI. Only if that
 * fails (the session lapsed past its lifetime, or we're on a Google-token
 * fallback) do we fall back to re-invoking Google One Tap.
 *
 * @returns {Promise<string|null>} Fresh token or null
 */
export async function refreshToken() {
  // In-flight dedupe: rapid mutations after expiry (e.g. multi-vote) each call
  // refreshToken; without this each would issue its own createSession, and the
  // last-write-wins response orphans the other freshly minted tokens. Memoize
  // a single promise and clear it once it settles, so a later expiry refreshes
  // anew rather than returning a stale resolved value.
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = doRefreshToken();
  _refreshPromise.finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

async function doRefreshToken() {
  const current = getToken();

  // Silent renewal — works whenever the backend still accepts the token
  // (session token within its lifetime, or a still-valid Google token).
  if (current) {
    try {
      const res = await api.createSession(current);
      if (res && res.sessionToken) {
        updateSessionToken(res.sessionToken);
        return res.sessionToken;
      }
    } catch (e) {
      // Fall through to interactive re-auth below.
    }
  }

  return interactiveRefresh();
}

/**
 * Last-resort refresh via Google One Tap. Shows the overlay, so it's reserved
 * for a visitor whose session lapsed entirely (away longer than the session
 * lifetime). Resolves with the fresh token or null.
 *
 * @returns {Promise<string|null>}
 */
function interactiveRefresh() {
  return new Promise((resolve) => {
    if (typeof google === 'undefined' || !google.accounts) {
      resolve(null);
      return;
    }

    // This re-initializes GIS with a one-shot closure to capture the fresh
    // token. Once we settle we MUST restore the global callback to
    // handleCredentialResponse — otherwise the stale closure stays wired as the
    // GIS callback, and a later One Tap (auto_select on the next prompt) would
    // resolve THIS already-settled promise instead of signing the user in.
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      google.accounts.id.initialize({
        client_id: _clientId,
        callback: handleCredentialResponse,
        auto_select: true,
      });
      resolve(value);
    };

    // Set a timeout — if GIS doesn't respond in 5s, give up
    const timeout = setTimeout(() => {
      settle(null);
    }, 5000);

    // Temporarily override the callback to capture the fresh token
    google.accounts.id.initialize({
      client_id: _clientId,
      callback: async (response) => {
        clearTimeout(timeout);
        await handleCredentialResponse(response); // exchanges for a session token
        settle(currentUser ? currentUser.token : null);
      },
      auto_select: true,
    });

    google.accounts.id.prompt((notification) => {
      // If prompt was dismissed or skipped, resolve null
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        clearTimeout(timeout);
        settle(null);
      }
    });
  });
}

/**
 * Returns a valid (non-expired) Google ID token, refreshing if needed.
 * Signs the user out and throws if the session can't be renewed —
 * callers surface the message and roll back their optimistic UI.
 *
 * @returns {Promise<string>} A usable ID token
 */
export async function ensureToken() {
  const token = getToken();
  if (isTokenExpired()) {
    const fresh = await refreshToken();
    if (fresh) return fresh;
    signOut();
    throw new Error('Session expired. Please sign in again.');
  }
  return token;
}

/**
 * Registers a callback for auth state changes.
 * @param {Function} callback - Called with (user: User|null)
 */
export function onAuthChange(callback) {
  listeners.push(callback);
}

/**
 * Notifies all auth state listeners.
 */
function notifyListeners() {
  for (const listener of listeners) {
    try {
      listener(currentUser);
    } catch (e) {
      console.error('Auth listener error:', e);
    }
  }
}
