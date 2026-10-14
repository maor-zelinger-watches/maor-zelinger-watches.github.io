/**
 * api.js — API client for How You Watch
 * 
 * Communicates with the Google Apps Script web app backend.
 * All API calls go through this module for centralized error handling.
 * 
 * Authentication: Comment requests are authenticated via Google ID token,
 * which is verified server-side.
 */

import { dedupeVideos } from './feed.js';
import { CONFIG } from './config.js';

/**
 * base64url (with padding, matching Apps Script's Utilities.base64EncodeWebSafe)
 * of an ArrayBuffer.
 */
function toBase64Url(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Signs a write request: returns { ts, sig } to add to the POST body, where sig
 * is base64url(HMAC-SHA256(`${action}\n${ts}`, REQUEST_SIGNING_SECRET)). The
 * canonicalization MUST match requestSigningBase in apps-script/Code.gs.
 *
 * This is a speed bump, not auth (the secret ships to every visitor — see
 * config.js). Best-effort: if Web Crypto is unavailable (an insecure context or
 * a test runtime without crypto.subtle), we return null and send the request
 * unsigned. The backend's soft-launch window accepts that; once enforcement is
 * on, only a context that can sign can write — which every real https client is.
 */
async function signRequest(action) {
  const ts = Math.floor(Date.now() / 1000);
  try {
    const subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;
    if (!subtle) return null;
    const enc = new TextEncoder();
    const key = await subtle.importKey(
      'raw', enc.encode(CONFIG.REQUEST_SIGNING_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuf = await subtle.sign('HMAC', key, enc.encode(`${action}\n${ts}`));
    return { ts, sig: toBase64Url(sigBuf) };
  } catch (e) {
    return null; // best-effort — send unsigned rather than block the action
  }
}

// Backoff between attempts at a request that failed transiently (see
// requestOnce). Two retries: the observed failures are single-request blips
// inside otherwise healthy windows, so the second attempt almost always lands.
const DEFAULT_RETRY_DELAYS_MS = [400, 1200];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Adds `desired` to a toggle body only when the caller named a real boolean. */
function withDesired(body, desired) {
  return typeof desired === 'boolean' ? { ...body, desired } : body;
}

/** True for the googleusercontent "echo" URL /exec redirects to with its result. */
function isEchoUrl(url) {
  return typeof url === 'string' && url.includes('/macros/echo');
}

/**
 * Reads a response body as parsed JSON, or null when it isn't JSON at all (the
 * HTML error page Google serves instead of our result). Real Responses expose
 * text(); a bare `{ json }` stub (tests) falls back to json().
 */
async function readJsonBody(response) {
  try {
    if (typeof response.text === 'function') {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
    if (typeof response.json === 'function') return await response.json();
  } catch (e) {
    /* not JSON */
  }
  return null;
}

/**
 * Creates an API client bound to a specific Apps Script URL.
 *
 * @param {string} baseUrl - The deployed Google Apps Script web app URL
 * @param {{retryDelaysMs?: number[]}} [options] - Backoff schedule for transient
 *   failures (one entry per retry). Tests pass zeros; production uses the default.
 * @returns {Object} API client with fetchFeed, fetchComments, postComment methods
 */
export function createApiClient(baseUrl, options = {}) {
  const retryDelaysMs = Array.isArray(options.retryDelaysMs)
    ? options.retryDelaysMs
    : DEFAULT_RETRY_DELAYS_MS;

  /**
   * One attempt at a request, classifying every failure.
   *
   * An Apps Script web app answers through a redirect: /exec runs the script,
   * then 302s to a one-shot googleusercontent "echo" URL that serves the result.
   * That second hop intermittently fails on Google's side — a 404 "page not
   * found" HTML page instead of our JSON, in bursts, with the script itself
   * healthy — and occasionally /exec answers a 302 that carries the JSON body
   * and no Location. Surfaced to users as "API error: 404" on feed pages and
   * votes. So:
   *   - Any body that parses as a JSON result with a `status` IS the result,
   *     whatever the HTTP status (the Location-less 302 case).
   *   - Otherwise the failure is `transient` (safe to retry) when the request
   *     is idempotent, or when it never reached the script — the response came
   *     straight from /exec, not the echo hop, so nothing executed.
   *   - A non-idempotent request whose failure came from the echo hop DID
   *     execute; only its result was lost. That is `resultLost`, never retried
   *     (a toggle would double-fire) — callers reconcile from the server instead.
   *
   * @param {string} url
   * @param {RequestInit} init
   * @param {boolean} idempotent - GETs; a POST that ran twice would double-apply
   */
  async function requestOnce(url, init, idempotent) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      // No response at all. A GET is safe to repeat; a POST may or may not
      // have run, so it keeps the existing rollback path (not retried).
      if (idempotent) error.transient = true;
      throw error;
    }

    const data = await readJsonBody(response);
    if (data && typeof data === 'object' && 'status' in data) {
      // Apps Script returns 200 even for app-level errors
      if (data.status === 'error') {
        throw new Error(data.message || 'Unknown error');
      }
      return data;
    }

    const error = new Error(response.ok
      ? 'API error: unexpected response'
      : `API error: ${response.status} ${response.statusText || ''}`.trim());
    error.status = response.status;
    if (idempotent || !isEchoUrl(response.url)) error.transient = true;
    else error.resultLost = true;
    throw error;
  }

  /**
   * Runs requestOnce, retrying transient failures on the backoff schedule.
   * Warns (not console.error) per retry so the error reporter isn't spammed
   * by blips that the next attempt absorbs.
   */
  async function requestWithRetry(url, init, idempotent) {
    let attempt = 0;
    for (;;) {
      try {
        return await requestOnce(url, init, idempotent);
      } catch (error) {
        if (!error.transient || attempt >= retryDelaysMs.length) throw error;
        const delay = retryDelaysMs[attempt++];
        console.warn(`Transient API failure (${error.message}) — retry ${attempt}/${retryDelaysMs.length} in ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  /**
   * Makes a GET request to the Apps Script backend.
   * @param {string} params - Query string (without leading ?)
   * @returns {Promise<Object>} Parsed JSON response
   */
  async function get(params) {
    const url = `${baseUrl}?${params}`;
    return requestWithRetry(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    }, true);
  }

  /**
   * Makes a POST request to the Apps Script backend.
   * @param {Object} body - Request body (will be JSON-stringified)
   * @param {{idempotent?: boolean}} [options] - `idempotent: true` marks a write
   *   that is safe to send twice (it names the end state it wants, so a repeat
   *   is a no-op server-side); requestWithRetry then retries it on every
   *   transient failure, echo-hop result loss included, the way it does GETs.
   *   Default false: a plain toggle, where a repeat would flip the state back.
   * @returns {Promise<Object>} Parsed JSON response
   */
  async function post(body, options = {}) {
    // Sign the request (SEC-Sybil). Adds { ts, sig } to the body when Web Crypto
    // is available; the backend verifies signed actions and, once enforcement is
    // on, rejects unsigned/stale ones. Unsigned actions (the backend ignores the
    // fields it doesn't check) and best-effort failures are harmless.
    const signed = await signRequest(body && body.action);
    const signedBody = signed ? { ...body, ts: signed.ts, sig: signed.sig } : body;

    return requestWithRetry(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
        'Accept': 'application/json',
      },
      body: JSON.stringify(signedBody),
    }, options.idempotent === true);
  }

  return {
    /**
     * Fetches the video feed. Triggers server-side RSS refresh if stale.
     *
     * When `cursor` is given, the server resumes strictly after that
     * (published_at, video_id) position — new items ingested mid-session
     * can't shift the window the way page offsets do. `page` is still
     * sent so older backends (which ignore cursors) keep working.
     *
     * @param {number} [page=1] - Page number for pagination
     * @param {number} [limit=20] - Videos per page
     * @param {string} [cursor=''] - "published_at|video_id" of the last item seen
     * @returns {Promise<{videos: Object[], total: number, page: number, next_cursor?: string}>}
     */
    async fetchFeed(page = 1, limit = 20, cursor = '') {
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const data = await get(`action=feed&page=${page}&limit=${limit}${cursorParam}`);
      // Defense in depth: a backend that hasn't yet deduped its store can
      // return the same article twice under two ids (same url). Collapse them
      // here so the feed never renders doubled, even against an old deployment.
      if (Array.isArray(data.videos)) data.videos = dedupeVideos(data.videos);
      return data;
    },

    /**
     * Fetches comments for a specific video.
     * 
     * @param {string} videoId - YouTube video ID or article item ID
     * @returns {Promise<{comments: Object[]}>}
     */
    async fetchComments(videoId) {
      return get(`action=comments&videoId=${encodeURIComponent(videoId)}`);
    },

    /**
     * Fetches comments for multiple videos in one request.
     * Costs a single Apps Script execution for the whole batch.
     *
     * @param {string[]} videoIds - YouTube video IDs / article item IDs (max 20)
     * @returns {Promise<{byVideo: Object<string, Object[]>}>}
     */
    async fetchCommentsBatch(videoIds) {
      const ids = videoIds.map(encodeURIComponent).join(',');
      return get(`action=commentsBatch&videoIds=${ids}`);
    },

    /**
     * Posts a new comment. Requires a valid Google ID token.
     * Token is verified server-side via Google's tokeninfo endpoint.
     * 
     * @param {string} videoId - YouTube video ID or article item ID
     * @param {string} parentId - Parent comment ID (empty string for top-level)
     * @param {string} body - Comment text
     * @param {string} token - Google Sign-In ID token
     * @returns {Promise<{comment_id: string}>}
     */
    async postComment(videoId, parentId, body, token) {
      return post({
        action: 'comment',
        videoId,
        parentId,
        body,
        token,
      });
    },

    /**
     * Fetches a page of the Top This Week ranking (last 7 days, vote-ranked).
     *
     * Cursor-paginated like fetchFeed: pass the previous response's
     * `next_cursor` to resume strictly after the last ranked item seen; omit
     * it for the first page. The server returns `next_cursor` on every page
     * ('' once the end of the week is reached).
     *
     * @param {number} [limit=50] - Max videos to return in this page
     * @param {string} [cursor=''] - "votes|published_at|video_id" of the last item seen
     * @returns {Promise<{videos: Object[], total: number, next_cursor?: string}>}
     */
    async fetchTopWeek(limit = 50, cursor = '') {
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const data = await get(`action=topWeek&limit=${limit}${cursorParam}`);
      if (Array.isArray(data.videos)) data.videos = dedupeVideos(data.videos);
      return data;
    },

    /**
     * Fetches a page of the archive — videos aged out of the live catalog
     * (older than the backend's retention window) into the Archive tab. A
     * SEPARATE endpoint from the feed by design: the live catalog loads first
     * and stays fast, and this backfills full history into the search index in
     * the background. Offset-paginated like fetchFeed so the same chunked
     * index-build loop consumes it. Requires backend ≥ 1.10.0; an older backend
     * throws "Unknown action" here, which the caller treats as an empty archive.
     *
     * @param {number} [page=1]
     * @param {number} [limit=500]
     * @returns {Promise<{videos: Object[], total: number, page: number}>}
     */
    async fetchArchive(page = 1, limit = 500) {
      const data = await get(`action=archive&page=${page}&limit=${limit}`);
      if (Array.isArray(data.videos)) data.videos = dedupeVideos(data.videos);
      return data;
    },

    /**
     * Fetches a single media item by id, for shared deep links (?v=<id>).
     * The backend checks the live catalog first, then the archive, so links
     * keep working after the video ages out of the feed. Resolves with
     * `video: null` when the id genuinely doesn't exist — distinct from the
     * thrown transport/backend errors. Requires backend ≥ 1.12.0; an older
     * backend throws "Unknown action" here.
     *
     * @param {string} videoId - YouTube video ID or article item ID
     * @returns {Promise<{video: Object|null}>}
     */
    async fetchVideo(videoId) {
      return get(`action=video&videoId=${encodeURIComponent(videoId)}`);
    },

    /**
     * Fetches the curated creator list (name, host, url, avatar, etc.) that
     * backs the Channels tab and search's host-name matching.
     *
     * @returns {Promise<{channels: Object[]}>}
     */
    async fetchChannels() {
      return get('action=getChannels');
    },

    /**
     * Toggles the signed-in user's upvote on a video.
     * Requires a valid Google ID token.
     *
     * @param {string} videoId - YouTube video ID / article item ID
     * @param {string} token - Google Sign-In ID token
     * @param {boolean} [desired] - the end state wanted (voted or not). When
     *   given, the backend treats a request that finds that state already in
     *   place as a no-op, so the request is idempotent and is retried on every
     *   transient failure. Omitted: a plain toggle (never retried).
     * @returns {Promise<{voted: boolean, vote_count: number}>}
     */
    async vote(videoId, token, desired) {
      return post(withDesired({ action: 'vote', videoId, token }, desired), { idempotent: typeof desired === 'boolean' });
    },

    /**
     * Fetches the set of video IDs the signed-in user has upvoted,
     * so the UI can mark its buttons. Requires a valid Google ID token.
     *
     * @param {string} token - Google Sign-In ID token
     * @returns {Promise<{video_ids: string[]}>}
     */
    async fetchMyVotes(token) {
      return post({ action: 'myVotes', token });
    },

    /**
     * Toggles the signed-in user's star on a creator (channel).
     * Requires a valid Google ID token.
     *
     * @param {string} channel - Channel name as it appears on feed items
     * @param {string} token - Google Sign-In ID token
     * @param {boolean} [desired] - end state wanted; see vote()
     * @returns {Promise<{starred: boolean}>}
     */
    async star(channel, token, desired) {
      return post(withDesired({ action: 'star', channel, token }, desired), { idempotent: typeof desired === 'boolean' });
    },

    /**
     * Fetches the channel names the signed-in user has starred,
     * so the UI can mark star buttons and build the Starred feed.
     *
     * @param {string} token - Google Sign-In ID token
     * @returns {Promise<{channels: string[]}>}
     */
    async fetchMyStars(token) {
      return post({ action: 'myStars', token });
    },

    /**
     * Toggles the signed-in user's bookmark on an item (video or article).
     * Requires a valid Google ID token.
     *
     * @param {string} videoId - YouTube video ID / article item ID
     * @param {string} token - Google Sign-In ID token
     * @param {boolean} [desired] - end state wanted; see vote()
     * @returns {Promise<{bookmarked: boolean}>}
     */
    async bookmark(videoId, token, desired) {
      return post(withDesired({ action: 'bookmark', videoId, token }, desired), { idempotent: typeof desired === 'boolean' });
    },

    /**
     * Records the signed-in user's marketing-email choice (the consent step
     * of the sign-in overlay, or a later change from Email preferences).
     * Requires a valid Google ID token.
     *
     * @param {boolean} consent - explicit yes (true) / no (false)
     * @param {string} token - Google Sign-In ID token
     * @returns {Promise<{marketing_consent: 'yes'|'no'}>}
     */
    async emailConsent(consent, token) {
      return post({ action: 'emailConsent', consent: !!consent, token });
    },

    /**
     * Sends a feedback message from the floating "Send feedback" button.
     * Requires a valid Google ID / app session token — the backend files the
     * row under the sender's verified email and name. Page URL, app version
     * and user agent ride along (like clientError) so a bug report is
     * reproducible. Requires backend >= 1.26.0; an older backend throws
     * "Unknown action".
     *
     * @param {string} message - The feedback text (backend caps at 2000 chars)
     * @param {string} token - Google Sign-In ID token or app session token
     * @returns {Promise<{feedback_id: string}>}
     */
    async sendFeedback(message, token) {
      return post({
        action: 'feedback',
        message,
        token,
        appVersion: CONFIG.APP_VERSION,
        page: typeof location !== 'undefined' ? String(location.href).slice(0, 300) : '',
        userAgent: typeof navigator !== 'undefined' ? String(navigator.userAgent).slice(0, 300) : '',
      });
    },

    /**
     * Fetches the signed-in user's votes, starred channels, bookmarks AND
     * marketing-consent state in one request. Replaces the separate
     * per-feature round trips at sign-in: the backend serializes a user's
     * requests and re-verifies the token on each, so batching cuts both the
     * queue depth and the token checks. A backend that predates a feature
     * omits its key (bookmark_ids / marketing_consent).
     *
     * @param {string} token - Google Sign-In ID token
     * @returns {Promise<{video_ids: string[], channels: string[], bookmark_ids?: string[], marketing_consent?: 'yes'|'no'|null}>}
     */
    async fetchBootstrap(token) {
      return post({ action: 'bootstrap', token });
    },

    /**
     * Adds a channel to the curated list from a bare URL (admin only, from
     * the add-channel.html page). The password is the operator's admin token,
     * sent in the POST body so it never appears in a URL. The backend
     * resolves the URL (YouTube channel, site homepage, or RSS feed), refuses
     * duplicates, appends an enabled row, and schedules a crawl.
     *
     * @param {string} url - YouTube channel / site homepage / RSS feed URL
     * @param {string} password - The admin password
     * @returns {Promise<{channel: {channel_name: string, platform: string, feed_url: string, avatar: string}}>}
     */
    async addChannel(url, password) {
      return post({ action: 'addChannel', url, token: password });
    },

    /**
     * Exchanges a credential for a fresh app session token. Pass a Google ID
     * token (the first exchange right after sign-in) or an existing session
     * token (a silent renewal) — the backend accepts either and mints a new
     * long-lived session token. This is what lets the client re-authenticate
     * without re-invoking Google One Tap.
     *
     * @param {string} token - Google ID token or existing app session token
     * @returns {Promise<{sessionToken: string, email: string, name: string, picture: string, exp: number}>}
     */
    async createSession(token) {
      return post({ action: 'session', token });
    },

    /**
     * Revokes ALL of the user's outstanding session tokens server-side — on
     * every device, not just this one. Called on sign-out so a token captured
     * elsewhere (kiosk, extension, backup) dies with the session instead of
     * remaining a live credential until it expires.
     *
     * @param {string} token - the current app session token (or Google ID token)
     * @returns {Promise<{revoked: boolean}>}
     */
    async revokeSession(token) {
      return post({ action: 'signOut', token });
    },
  };
}

