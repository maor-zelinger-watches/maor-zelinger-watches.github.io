/**
 * cache.js — Client-side persistence for How You Watch
 *
 * Single owner of every key the feed persists. Import from here instead of
 * touching storage directly, so cache behavior is testable in isolation and
 * storage failures are handled in one place.
 *
 * Guarantees:
 * - Reads self-heal: a corrupt or invalid payload is cleared and reported
 *   as absent, never thrown.
 * - Writes never throw: quota errors and private-browsing restrictions
 *   degrade to "no cache" (the app re-fetches), not a crash.
 *
 * Two tiers:
 * - Large snapshots are ASYNC and live in the engine the storage-engine flag
 *   picks for this page load (js/flags.js): localStorage in 'legacy' mode (the
 *   default), IndexedDB in 'idb' mode, falling back to localStorage when
 *   IndexedDB won't open or stalls (storage.js):
 *   - wd_feed_cache   — the feed the user scrolled {videos, total} (stale-while-revalidate)
 *   - wd_search_index — full catalog for search {videos} (stale-while-revalidate)
 *   - wd_top_cache    — Top This Week first-page snapshot {videos, total, cursor}
 *   - wd_channels     — curated creator list {creators}
 * - Small preferences stay in localStorage and stay SYNCHRONOUS: they're a few
 *   bytes, and the first paint needs them before any await (star/bookmark
 *   marks on the very first cards, the chip selection before the first render):
 *   - wd_my_stars     — starred channel names, instant paint before server reconcile
 *   - wd_my_bookmarks — bookmarked video ids, instant paint before server reconcile
 *   - wd_filter_types — persisted content-type chip selection ([] = "All")
 * ('wd_user' is the auth session, owned by auth.js — a credential, not a cache.
 * 'wd_storage_engine' is the engine flag, owned by flags.js — never a cache, so
 * no cache clear may touch it.)
 *
 * Why IndexedDB exists: localStorage's per-origin cap varies by browser,
 * and in WebKit (Safari's engine) the full search index — 3.4M characters on
 * production in Sep 2026 — exceeded it. write() swallows the quota error by
 * design, so the index silently never persisted there and every returning
 * session re-walked the whole catalog (43 requests). IndexedDB stores it by
 * structured clone, under a quota that's a share of the disk.
 */

import { pickEngine } from './storage.js';
import { storageEngine } from './flags.js';

export const CACHE_KEYS = {
  FEED: 'wd_feed_cache',
  SEARCH_INDEX: 'wd_search_index',
  TOP: 'wd_top_cache',
  CHANNELS: 'wd_channels',
  STARS: 'wd_my_stars',
  BOOKMARKS: 'wd_my_bookmarks',
  FILTER_TYPES: 'wd_filter_types',
};

// The content-type values a saved selection may contain — must mirror the
// chips in views.js. Unknown values in a stored payload mean it's stale or
// tampered, so the whole payload is discarded and the default applies.
const VALID_FILTER_TYPES = ['video', 'article', 'short'];

// --- storage primitives — never throw -------------------------------

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) { /* nothing to heal */ }
}

// --- cache freshness (schema version + TTL) --------------------------
//
// The large stale-while-revalidate snapshots (feed, search index) carry a
// {version, savedAt} envelope. A payload whose version doesn't match this
// build's schema, or that's older than the TTL, is treated as absent and
// self-heals (cleared on read) exactly like a corrupt one — so a flaky build
// can't strand a session on a months-old catalog with no way to notice.

export const CACHE_VERSION = 2;      // bump when a payload's shape changes.
                                     // v2: discard indexes built before the
                                     // page-clamp fix — they silently hold only
                                     // ~a fifth of the catalog, and the top-up
                                     // path trusts a cached index as complete
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/** Wraps a payload with the current schema version and a save timestamp. */
function stamp(payload) {
  return { ...payload, version: CACHE_VERSION, savedAt: Date.now() };
}

/** True only for a payload of the current version saved within the TTL. */
function isFresh(data) {
  return !!data
    && data.version === CACHE_VERSION
    && typeof data.savedAt === 'number'
    && (Date.now() - data.savedAt) <= CACHE_MAX_AGE_MS;
}


// --- snapshot storage (IndexedDB or localStorage, async) -------------

// Which engines each mode may use, most preferred first (storage.js
// pickEngine). The mode is the per-browser flag in js/flags.js, read once per
// page load.
//
//   legacy — localStorage only: exactly the storage that shipped before the
//            IndexedDB engine. IndexedDB is never probed, opened or created,
//            which is what makes this mode a safe kill switch.
//   idb    — IndexedDB, falling back to localStorage for the rest of the page
//            load when IndexedDB won't open or stalls (storage.js).
export const LEGACY_PREFERENCE = Object.freeze(['local']);
export const IDB_PREFERENCE = Object.freeze(['idb', 'local']);

/** The engine preference for this page load's storage mode. */
export function enginePreference() {
  return storageEngine().engine === 'idb' ? IDB_PREFERENCE : LEGACY_PREFERENCE;
}

// Per-key operation queue. Saves are fire-and-forget, so two in flight for the
// same key (a page save, then a vote's coalesced save) could otherwise land out
// of order and persist the older snapshot. Chaining every read, write and
// clear of a key keeps them in call order: last call wins, and a load always
// sees the writes issued before it. Every engine call is time-bounded
// (storage.js), so one stuck call can't wedge the queue behind it.
const queues = new Map();

function serialize(key, op) {
  const run = (queues.get(key) || Promise.resolve()).then(op);
  queues.set(key, run.then(() => {}, () => {}));
  return run;
}

// Seam for unit tests: resolves once every queued snapshot operation settles.
export const __test__ = {
  settled: () => Promise.all([...queues.values()]),
};

const CORRUPT = Symbol('corrupt');
const TIMED_OUT = Symbol('timed-out');

function parseLegacy(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return CORRUPT;
  }
}

/**
 * Loads one snapshot and runs it through `normalize`, which returns the value
 * to hand back or null when the payload is stale or invalid. Anything that
 * doesn't normalize is deleted so the next load starts clean.
 *
 * When the engine in use is IndexedDB, a copy found in localStorage is always
 * the NEWER one: this mode deletes it on every load and save of the key, so it
 * can only be there because legacy mode (after a flag flip, or in another tab)
 * or an older build wrote it since. It wins, is written through to IndexedDB,
 * and is removed from localStorage only once that write has landed — a failed
 * migration keeps the copy for the next load instead of losing it.
 *
 * A read that times out is "no snapshot this load", never corruption: nothing
 * is deleted over it.
 *
 * @param {string} key
 * @param {function(Object): (any|null)} normalize
 * @returns {Promise<any|null>}
 */
function loadSnapshot(key, normalize) {
  return serialize(key, async () => {
    const engine = await pickEngine(enginePreference());
    if (!engine) return null;

    if (engine.name !== 'local') {
      const text = read(key);
      if (text !== null) {
        const legacy = parseLegacy(text);
        const result = legacy === CORRUPT ? null : normalize(legacy);
        if (result !== null) {
          try {
            await engine.set(key, legacy);
            remove(key);
          } catch (e) {
            /* keep the localStorage copy — the next load retries */
          }
          return result;
        }
        remove(key); // corrupt or stale — nothing worth keeping
      }
    }

    let data;
    try {
      data = await engine.get(key);
    } catch (e) {
      data = e && e.name === 'StorageTimeoutError' ? TIMED_OUT : CORRUPT;
    }
    if (data === null || data === TIMED_OUT) return null;

    const result = data === CORRUPT ? null : normalize(data);
    if (result === null) {
      await engine.del(key).catch(() => {});
      return null;
    }
    return result;
  }).catch(() => null);
}

/** Persists one snapshot. Resolves true once written, false on any failure. */
function saveSnapshot(key, value) {
  return serialize(key, async () => {
    const engine = await pickEngine(enginePreference());
    if (!engine) return false;
    await engine.set(key, value);
    if (engine.name !== 'local') remove(key); // never leave a stale copy behind
    return true;
  }).catch(() => false);
}

/**
 * Deletes one snapshot from localStorage and, in idb mode, from IndexedDB.
 * Legacy mode never touches IndexedDB, not even to delete.
 */
function removeSnapshot(key) {
  return serialize(key, async () => {
    remove(key);
    const engine = await pickEngine(enginePreference());
    if (engine && engine.name !== 'local') await engine.del(key);
  }).catch(() => {});
}

/**
 * Rows persisted without the memoized search tokens. feed.js searchFields()
 * caches each row's tokens on the row itself (`_searchFields`) as an ordinary
 * property, so it would otherwise be stored alongside every row — roughly
 * doubling the payload for data that is recomputed on demand anyway.
 */
function persistableRows(videos) {
  if (!Array.isArray(videos)) return videos;
  return videos.map((v) => {
    if (!v || typeof v !== 'object' || !('_searchFields' in v)) return v;
    const { _searchFields, ...row } = v;
    return row;
  });
}

// --- feed cache (stale-while-revalidate snapshot) --------------------

/**
 * Loads the cached feed.
 * Resolves {videos, total} or null. Payloads that are corrupt, stale (wrong
 * version or older than the TTL), or invalid (non-array videos, missing/zero
 * total — pagination math needs it) are cleared and reported as absent.
 */
export function loadFeedCache() {
  return loadSnapshot(CACHE_KEYS.FEED, (data) => {
    if (!isFresh(data)) return null;
    const videos = Array.isArray(data.videos) ? data.videos : [];
    if (videos.length === 0 || typeof data.total !== 'number' || data.total === 0) return null;
    return { videos, total: data.total };
  });
}

/** Saves the feed snapshot. Best-effort — resolves false on any failure. */
export function saveFeedCache(videos, total) {
  return saveSnapshot(CACHE_KEYS.FEED, stamp({ videos: persistableRows(videos), total }));
}

export function clearFeedCache() {
  cancelPendingFeedSnapshot();
  return removeSnapshot(CACHE_KEYS.FEED);
}

// Coalesced, capped feed-cache write for the hot path (votes/comments).
//
// Serializing the accumulated feed on every vote/comment (twice per vote,
// counting the reconcile) is wasted work: the restore only needs the top
// pages, and back-to-back mutations each re-serialize the whole list. So this
// defers the write to an idle callback (falling back to a trailing timer),
// keeps only the LATEST snapshot, and caps it to the first N items.
export const FEED_CACHE_SNAPSHOT_MAX = 60; // ~6 pages at PAGE_SIZE 10; the deep
                                           // tail re-fetches on scroll

let pendingFeedSnapshot = null;
let feedSnapshotHandle = null;
let feedSnapshotViaIdle = false;

function flushFeedSnapshot() {
  feedSnapshotHandle = null;
  const snap = pendingFeedSnapshot;
  pendingFeedSnapshot = null;
  if (!snap) return;
  const videos = Array.isArray(snap.videos)
    ? snap.videos.slice(0, FEED_CACHE_SNAPSHOT_MAX)
    : snap.videos;
  saveFeedCache(videos, snap.total);
}

/** Drops any queued snapshot so a clear isn't overwritten by a late write. */
function cancelPendingFeedSnapshot() {
  if (feedSnapshotHandle === null) return;
  if (feedSnapshotViaIdle && typeof globalThis.cancelIdleCallback === 'function') {
    globalThis.cancelIdleCallback(feedSnapshotHandle);
  } else if (!feedSnapshotViaIdle) {
    clearTimeout(feedSnapshotHandle);
  }
  feedSnapshotHandle = null;
  pendingFeedSnapshot = null;
}

/**
 * Queues a capped feed-cache write, coalescing bursts into one deferred save.
 * Never writes synchronously — the actual serialization runs at idle time (or
 * on a short trailing timer where requestIdleCallback is unavailable).
 */
export function saveFeedCacheSoon(videos, total) {
  pendingFeedSnapshot = { videos, total };
  if (feedSnapshotHandle !== null) return; // a flush is already queued
  const ric = typeof globalThis.requestIdleCallback === 'function'
    ? globalThis.requestIdleCallback
    : null;
  if (ric) {
    feedSnapshotViaIdle = true;
    feedSnapshotHandle = ric(flushFeedSnapshot, { timeout: 2000 });
  } else {
    feedSnapshotViaIdle = false;
    feedSnapshotHandle = setTimeout(flushFeedSnapshot, 500);
  }
}

// --- search index (full catalog, stale-while-revalidate) -------------

/**
 * Loads the cached search index (the whole catalog).
 * Resolves an array of videos, or null when absent/corrupt/stale. A payload
 * that's the wrong version, older than the TTL, or non-array/empty is cleared
 * and reported as absent so search rebuilds. (A stale-version catalog would
 * otherwise run the whole session as the search corpus — see the module doc.)
 */
export function loadSearchIndex() {
  return loadSnapshot(CACHE_KEYS.SEARCH_INDEX, (data) => {
    if (!isFresh(data)) return null;
    const videos = Array.isArray(data.videos) ? data.videos : null;
    return videos && videos.length > 0 ? videos : null;
  });
}

/**
 * Saves the full search index. Best-effort — resolves false on any failure,
 * which just leaves search to rebuild from the network next session.
 */
export function saveSearchIndex(videos) {
  if (!Array.isArray(videos) || videos.length === 0) return Promise.resolve(false);
  return saveSnapshot(CACHE_KEYS.SEARCH_INDEX, stamp({ videos: persistableRows(videos) }));
}

export function clearSearchIndex() {
  return removeSnapshot(CACHE_KEYS.SEARCH_INDEX);
}

// --- Top This Week (first-page snapshot, stale-while-revalidate) -----

/**
 * Loads the cached Top This Week first page.
 * Resolves {videos, total, cursor} or null. Only the first ranked page is
 * cached — deeper pages are re-fetched on scroll — so the payload stays small
 * and the revalidate can fully reconcile (add/remove/reorder) the window it
 * covers. Invalid payloads (corrupt, empty videos) are cleared.
 * `cursor` may be '' (end of the week) or a string; both are valid.
 */
export function loadTopCache() {
  return loadSnapshot(CACHE_KEYS.TOP, (data) => {
    const videos = Array.isArray(data.videos) ? data.videos : [];
    if (videos.length === 0) return null;
    return {
      videos,
      total: typeof data.total === 'number' ? data.total : videos.length,
      cursor: typeof data.cursor === 'string' ? data.cursor : undefined,
    };
  });
}

/** Saves the Top first-page snapshot. Best-effort — resolves false on failure. */
export function saveTopCache(videos, total, cursor) {
  if (!Array.isArray(videos) || videos.length === 0) return Promise.resolve(false);
  return saveSnapshot(CACHE_KEYS.TOP, { videos: persistableRows(videos), total, cursor });
}

export function clearTopCache() {
  return removeSnapshot(CACHE_KEYS.TOP);
}

// --- Channels (curated creator list, fully cached) -------------------

/**
 * Loads the cached creator list.
 * Resolves an array of creators, or null when absent/corrupt. The list is
 * small and curated, so the whole thing is cached; a non-array or empty
 * payload is cleared and reported as absent so the tab rebuilds from network.
 */
export function loadChannelsCache() {
  return loadSnapshot(CACHE_KEYS.CHANNELS, (data) => {
    const creators = Array.isArray(data) ? data : (Array.isArray(data.creators) ? data.creators : null);
    return creators && creators.length > 0 ? creators : null;
  });
}

/** Saves the creator list. Best-effort — resolves false on failure. */
export function saveChannelsCache(creators) {
  if (!Array.isArray(creators) || creators.length === 0) return Promise.resolve(false);
  return saveSnapshot(CACHE_KEYS.CHANNELS, { creators });
}

export function clearChannelsCache() {
  return removeSnapshot(CACHE_KEYS.CHANNELS);
}

// --- starred creators (instant paint, reconciled by the server) ------

/**
 * Loads the cached starred channel names as a Set.
 * Corrupt or non-array payloads are cleared and yield an empty Set.
 */
export function loadStarredChannels() {
  const raw = read(CACHE_KEYS.STARS);
  if (!raw) return new Set();

  try {
    const stored = JSON.parse(raw);
    if (!Array.isArray(stored)) {
      remove(CACHE_KEYS.STARS);
      return new Set();
    }
    return new Set(stored);
  } catch (e) {
    remove(CACHE_KEYS.STARS);
    return new Set();
  }
}

/** Saves starred channels. Accepts a Set or an array. */
export function saveStarredChannels(channels) {
  return write(CACHE_KEYS.STARS, JSON.stringify([...channels]));
}

export function clearStarredChannels() {
  remove(CACHE_KEYS.STARS);
}

// --- bookmarked items (instant paint, reconciled by the server) ------

/**
 * Loads the cached bookmarked video ids as a Set of strings.
 * Corrupt or non-array payloads are cleared and yield an empty Set.
 */
export function loadBookmarkedIds() {
  const raw = read(CACHE_KEYS.BOOKMARKS);
  if (!raw) return new Set();

  try {
    const stored = JSON.parse(raw);
    if (!Array.isArray(stored)) {
      remove(CACHE_KEYS.BOOKMARKS);
      return new Set();
    }
    return new Set(stored.map(String));
  } catch (e) {
    remove(CACHE_KEYS.BOOKMARKS);
    return new Set();
  }
}

/** Saves bookmarked video ids. Accepts a Set or an array. */
export function saveBookmarkedIds(ids) {
  return write(CACHE_KEYS.BOOKMARKS, JSON.stringify([...ids]));
}

export function clearBookmarkedIds() {
  remove(CACHE_KEYS.BOOKMARKS);
}

// --- content-type filter selection (persists across sessions) --------

/**
 * Loads the saved content-type chip selection.
 * Returns an array of type values, or null when nothing was ever saved (so
 * the caller applies the default). A saved empty array [] is a real value —
 * it means the user chose "All" — and is returned as-is, distinct from null.
 * Corrupt payloads or ones with unknown type values are cleared and reported
 * as absent so the default takes over.
 */
export function loadFilterTypes() {
  const raw = read(CACHE_KEYS.FILTER_TYPES);
  if (raw === null) return null;

  try {
    const stored = JSON.parse(raw);
    if (!Array.isArray(stored) || stored.some(v => !VALID_FILTER_TYPES.includes(v))) {
      remove(CACHE_KEYS.FILTER_TYPES);
      return null;
    }
    // Normalize to canonical order and drop duplicates.
    return VALID_FILTER_TYPES.filter(v => stored.includes(v));
  } catch (e) {
    remove(CACHE_KEYS.FILTER_TYPES);
    return null;
  }
}

/** Saves the content-type chip selection ([] = "All"). Best-effort. */
export function saveFilterTypes(types) {
  if (!Array.isArray(types)) return false;
  return write(CACHE_KEYS.FILTER_TYPES, JSON.stringify(types));
}

export function clearFilterTypes() {
  remove(CACHE_KEYS.FILTER_TYPES);
}
