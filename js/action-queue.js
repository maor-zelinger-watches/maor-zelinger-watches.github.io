/**
 * action-queue.js — one serial, persisted queue for the user's toggle
 * actions (upvotes, starred creators, bookmarks).
 *
 * The UI flips the instant a button is pressed; this module owns what
 * happens next. Every action is stored as the END STATE the user wants
 * ("video X: voted = true"), never as "toggle X" — that is what makes the
 * rest safe:
 *
 *   - Coalescing. One entry per (kind, id). Pressing a button twice before
 *     anything was sent collapses to nothing; pressing it again after a
 *     different intent just overwrites the intent. The last press wins.
 *   - Retries. A send that fails on the way back (Google's echo hop, see
 *     api.js `resultLost`) is simply sent again: the backend answers a
 *     request that finds its desired state already in place with a no-op.
 *   - Refresh. Entries persist to localStorage as they change and are
 *     replayed by the next page load of the same account, so a reload in
 *     the middle of a burst loses nothing.
 *
 * Sends are serial and spaced per kind (CONFIG.ACTION_QUEUE_SPACING_MS)
 * because the backend throttles each user to one vote / star / bookmark
 * write every two seconds. Before the queue, the second of two quick votes
 * was simply refused and rolled back; now it waits its turn. Kinds use
 * separate throttle keys server-side, so a vote and a star can go out back
 * to back.
 *
 * The queue knows nothing about the DOM. Each kind registers a handler
 * (registerActionKind) with the API call to make and what to do when an
 * entry is confirmed, fails, or is restored after a reload. votes.js,
 * stars.js and bookmarks.js own the paint; this file owns the order.
 *
 * Errors are per entry: a failure reverts that one button to the state the
 * entry started from and shows one toast; the rest of the queue carries on.
 * Only a lost session empties the queue.
 */

import { CONFIG } from './config.js';
import { getCurrentUser, isSignedIn, ensureToken } from './auth.js';

const STORAGE_KEY = 'wd_action_queue';
const STORAGE_VERSION = 1;
const LOCK_NAME = 'wd_action_queue';

// The backend's own "not now" answers. Worth a second attempt after the
// spacing window; anything else is a real failure for that entry.
const RETRYABLE_RE = /too fast|server busy/i;

/**
 * @typedef {Object} ActionEntry
 * @property {string} key      - `${kind}:${id}` — one entry per target
 * @property {string} kind     - registered kind ('vote' | 'star' | 'bookmark')
 * @property {string} id       - the target: a video id or a channel name
 * @property {boolean} desired - the end state the user wants
 * @property {boolean} prev    - the state the FIRST press started from, kept
 *                               across coalesced presses; what a failure reverts to
 * @property {string} owner    - email of the account that queued it
 * @property {number} enqueuedAt - ms epoch of the latest press
 * @property {number} attempts - backend "not now" answers so far
 */

/**
 * @typedef {Object} ActionKindHandlers
 * @property {(entry: ActionEntry, token: string) => Promise<Object>} send
 *   The API call. Must pass entry.desired through so the backend can no-op.
 * @property {(entry: ActionEntry, res: Object) => void} onConfirmed
 *   The server answered: reconcile state + UI with its truth.
 * @property {(entry: ActionEntry, error: Error) => void} onFailed
 *   The entry is being dropped: revert to entry.prev and tell the user.
 * @property {(entry: ActionEntry) => void} apply
 *   A restored entry (page reload): paint entry.desired as if just pressed.
 */

/** @type {Record<string, ActionKindHandlers>} */
const kinds = Object.create(null);
/** @type {Map<string, ActionEntry>} insertion order = send order */
const entries = new Map();
// Keys this page has ever held — on persist, storage rows under these keys
// are ours to replace or drop; rows under other keys belong to another tab.
const touched = new Set();
// ms epoch when the last send of each kind settled (response or error) —
// the per-kind spacing clock.
const lastSettled = Object.create(null);

// Every clearActionQueue() starts a new generation. A drain loop (and a
// request already on the wire) belongs to the generation it started in and
// stands down the moment it sees a newer one, so a result that lands after
// sign-out paints nothing and a stale loop never blocks a fresh one.
let generation = 0;
let activeLoop = null;   // generation of the running drain loop (null = none)
let sendingKey = null;   // key of the entry whose request is in flight
let wake = null;         // resolves the drain loop's current wait early
let listening = false;

// --- registration -----------------------------------------------------

/**
 * Registers the handlers for one kind of action. Called at module load by
 * votes.js / stars.js / bookmarks.js, so handlers exist before any restore.
 *
 * @param {string} kind
 * @param {ActionKindHandlers} handlers
 */
export function registerActionKind(kind, handlers) {
  kinds[kind] = handlers;
}

// --- public API --------------------------------------------------------

/**
 * Records that the user wants `id` of `kind` in state `desired`. The caller
 * has already painted that state optimistically.
 *
 * Coalesces with a queued entry for the same target: a press that lands the
 * user back where the first press started (desired === prev) cancels the
 * entry outright; otherwise the newer intent replaces the older. An entry
 * whose request is in flight keeps the new intent and is sent again once
 * the current request settles (the server then holds the newer state).
 *
 * @param {string} kind
 * @param {string} id
 * @param {boolean} desired
 * @param {boolean} prev - the state before this press
 */
export function enqueueAction(kind, id, desired, prev) {
  const key = keyOf(kind, id);
  const existing = entries.get(key);
  if (existing) {
    if (key !== sendingKey && existing.prev === desired) {
      // Back where it started before anything was sent — nothing to send.
      entries.delete(key);
      persist();
      return;
    }
    existing.desired = desired;
    existing.enqueuedAt = Date.now();
    persist();
    drain();
    return;
  }
  entries.set(key, {
    key, kind, id, desired, prev,
    owner: ownerEmail(),
    enqueuedAt: Date.now(),
    attempts: 0,
  });
  touched.add(key);
  persist();
  drain();
}

/**
 * Whether a request for this target is on the wire right now. Callers use
 * it to ignore a repeat press until the request settles — a double-tap
 * must not land the user back where they started (FE19). A press on a
 * target that is queued but not yet sent is NOT in flight: it coalesces.
 *
 * @param {string} kind
 * @param {string} id
 */
export function isActionInFlight(kind, id) {
  return sendingKey === keyOf(kind, id);
}

/**
 * Entries of one kind that have not been confirmed yet, oldest first. The
 * reconcilers overlay these on a server snapshot so a fetch that started
 * before a press (or a restore) can't paint the pre-press state.
 *
 * @param {string} kind
 * @returns {ActionEntry[]}
 */
export function pendingActions(kind) {
  const out = [];
  for (const entry of entries.values()) if (entry.kind === kind) out.push(entry);
  return out;
}

/**
 * Replays the queue a previous page load of this account left behind.
 * Call once the session is known (sign-in restored) and the kinds are
 * registered. Entries of another account, of an unknown kind, or older
 * than CONFIG.ACTION_QUEUE_MAX_AGE_MS are discarded. Each kept entry is
 * handed to its kind's `apply` so the UI shows the intent, then the drain
 * starts. Safe to call again (a session renewal re-fires auth listeners):
 * entries already in memory are left alone.
 */
export function restoreActionQueue() {
  const owner = ownerEmail();
  if (!owner) return;
  const now = Date.now();
  for (const stored of readStored()) {
    if (!stored || typeof stored !== 'object') continue;
    if (stored.owner !== owner || !kinds[stored.kind]) continue;
    if (typeof stored.desired !== 'boolean' || typeof stored.prev !== 'boolean') continue;
    if (!(now - Number(stored.enqueuedAt) <= CONFIG.ACTION_QUEUE_MAX_AGE_MS)) continue;
    const key = keyOf(stored.kind, stored.id);
    if (entries.has(key)) continue;
    const entry = {
      key, kind: stored.kind, id: String(stored.id),
      desired: stored.desired, prev: stored.prev,
      owner, enqueuedAt: Number(stored.enqueuedAt), attempts: 0,
    };
    entries.set(key, entry);
    touched.add(key);
    safely(() => kinds[entry.kind].apply(entry));
  }
  persist(); // drops what was filtered out above
  if (entries.size) drain();
}

/**
 * Forgets every queued action, in memory and in storage. For sign-out: an
 * intent recorded under one account must never be sent under the next.
 * A request already on the wire finishes on its own; its result is ignored
 * because the kind handlers check isSignedIn() first.
 */
export function clearActionQueue() {
  generation += 1;
  sendingKey = null;
  entries.clear();
  touched.clear();
  // The backend throttles per account, so the next account starts with a
  // fresh spacing clock.
  for (const kind of Object.keys(lastSettled)) delete lastSettled[kind];
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* nothing stored */ }
  if (wake) wake();
}

/**
 * Wires the one environment signal the queue reacts to: connectivity. A
 * send that failed because the network was away keeps its entry; the
 * `online` event (or any later press) resumes the drain. Idempotent.
 */
export function setupActionQueue() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('online', () => drain());
}

// --- the drain loop ----------------------------------------------------

/**
 * Sends entries one at a time until the queue is empty. One loop per page;
 * a call while a loop runs just nudges it awake. The loop holds a Web Lock
 * (where available) so two tabs of the same account take turns instead of
 * racing the backend's per-user throttle.
 */
async function drain() {
  if (activeLoop === generation) { if (wake) wake(); return; }
  const mine = generation;
  activeLoop = mine;
  try {
    await withLock(async () => {
      for (;;) {
        if (generation !== mine) return; // cleared under us — a newer loop owns the queue
        if (!isSignedIn()) { clearActionQueue(); return; }
        if (!entries.size) return;
        if (isOffline()) { await waitFor(null); continue; }
        const entry = nextReady();
        if (!entry) { await waitFor(msUntilReady()); continue; }
        await sendEntry(entry, mine);
      }
    });
  } finally {
    if (activeLoop === mine) activeLoop = null;
    // A press that arrived between the last check and the lock release.
    if (generation === mine && entries.size && isSignedIn()) drain();
  }
}

/**
 * One request for one entry. Classifies the outcome:
 *   confirmed → handler.onConfirmed, entry gone (unless a newer intent
 *               arrived mid-flight — then it stays, to be sent again)
 *   "not now" from the backend → wait a spacing window, try again
 *   offline → keep the entry; the loop waits for `online`
 *   anything else → handler.onFailed, entry gone
 */
async function sendEntry(entry, mine) {
  const handlers = kinds[entry.kind];
  if (!handlers) { dropEntry(entry); return; }

  sendingKey = entry.key;
  let sentDesired = entry.desired;
  let res = null;
  let error = null;
  try {
    const token = await ensureToken();
    // Captured right before the request is built: a press that landed while
    // the token was being fetched is already in it.
    sentDesired = entry.desired;
    res = await handlers.send(entry, token);
  } catch (e) {
    error = e;
  } finally {
    if (generation === mine) sendingKey = null;
    lastSettled[entry.kind] = Date.now();
  }

  // The queue was cleared while the request was out (sign-out, or
  // ensureToken itself signing out on a dead session): this result belongs
  // to an account that is gone. Never paint it.
  if (generation !== mine) return;
  if (!isSignedIn()) { clearActionQueue(); return; }

  if (!error) {
    if (entry.desired !== sentDesired) {
      // The user changed their mind mid-flight; the server holds the older
      // intent. Send the newer one next (a fresh attempt budget).
      entry.attempts = 0;
      persist();
      return;
    }
    dropEntry(entry);
    safely(() => handlers.onConfirmed(entry, res));
    return;
  }

  const retryable = RETRYABLE_RE.test(String(error && error.message || ''));
  if (retryable && entry.attempts + 1 < CONFIG.ACTION_QUEUE_MAX_ATTEMPTS) {
    entry.attempts += 1;
    persist();
    return; // the spacing clock just reset; nextReady() holds it back
  }
  if (!retryable && isOffline()) {
    return; // keep it; the loop parks until `online`
  }
  dropEntry(entry);
  safely(() => handlers.onFailed(entry, error));
}

/** The oldest entry whose kind is past its spacing window, if any. */
function nextReady() {
  const now = Date.now();
  for (const entry of entries.values()) {
    if (entry.key === sendingKey) continue;
    const settled = lastSettled[entry.kind];
    if (settled == null || now - settled >= CONFIG.ACTION_QUEUE_SPACING_MS) return entry;
  }
  return null;
}

/** ms until the soonest entry becomes ready (0 when one already is). */
function msUntilReady() {
  const now = Date.now();
  let soonest = Infinity;
  for (const entry of entries.values()) {
    const settled = lastSettled[entry.kind];
    const wait = settled == null ? 0 : Math.max(0, CONFIG.ACTION_QUEUE_SPACING_MS - (now - settled));
    if (wait < soonest) soonest = wait;
  }
  return soonest === Infinity ? 0 : soonest;
}

/**
 * Sleeps `ms` (or, with null, indefinitely) but wakes early on the next
 * press, sign-out, or `online` event, so a queued star never waits out a
 * vote's spacing window.
 */
function waitFor(ms) {
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      if (wake === done) wake = null;
      resolve();
    };
    wake = done;
    if (ms != null) timer = setTimeout(done, ms);
  });
}

function dropEntry(entry) {
  entries.delete(entry.key);
  persist();
}

// --- persistence -------------------------------------------------------

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.entries)) return [];
    return parsed.entries;
  } catch (e) {
    return [];
  }
}

/**
 * Writes this page's entries to storage, merged with rows another tab of
 * the same origin may have written under keys this page never held. A
 * key this page has touched is replaced by (or dropped with) its in-memory
 * state, so a confirmed action leaves storage even if a sibling tab had
 * queued the same target. Rows past the max age are pruned either way.
 */
function persist() {
  const now = Date.now();
  const others = readStored().filter((row) =>
    row && typeof row === 'object' && !touched.has(keyOf(row.kind, row.id))
      && now - Number(row.enqueuedAt) <= CONFIG.ACTION_QUEUE_MAX_AGE_MS);
  const mine = [...entries.values()].map(({ key, attempts, ...rest }) => rest);
  try {
    if (!others.length && !mine.length) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, entries: [...others, ...mine] }));
  } catch (e) {
    /* storage full or blocked — the in-memory queue still drains */
  }
}

// --- helpers -----------------------------------------------------------

function keyOf(kind, id) {
  return `${kind}:${id}`;
}

function ownerEmail() {
  const user = getCurrentUser();
  return user && user.email ? String(user.email) : '';
}

function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Runs the drain under a Web Lock when the browser has them; plain otherwise. */
function withLock(fn) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (locks && typeof locks.request === 'function') {
    try { return locks.request(LOCK_NAME, fn); } catch (e) { /* fall through */ }
  }
  return fn();
}

/** A handler that throws must not kill the drain loop. */
function safely(fn) {
  try { fn(); } catch (e) { console.error('Action queue handler failed:', e); }
}
