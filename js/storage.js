/**
 * storage.js — Async key/value engines behind cache.js.
 *
 * Two interchangeable engines share one interface: `get(key)` resolves the
 * stored value (null when absent), `set(key, value)` and `del(key)` resolve
 * once the write lands. Values are plain JSON-able objects; each engine owns
 * its own serialization, so callers never stringify.
 *
 *   idb   — IndexedDB through the vendored idb-keyval. Values are stored by
 *           structured clone, under a quota that's a share of the disk.
 *   local — localStorage: the proven path, and the whole of 'legacy' mode
 *           (js/flags.js). Synchronous, with a per-origin cap of 5-10 MiB that
 *           varies by browser; WebKit refused the full search index outright.
 *
 * (A Cache Storage engine was tried and dropped: slower than IndexedDB on the
 * real index in Chromium and WebKit, and in WebKit under Playwright its writes
 * vanished on reload while caches.open() still succeeded — a failure no probe
 * can detect. The fallback from IndexedDB is localStorage, nothing in between.)
 *
 * Every engine call is time-bounded. A store that never answers is a real
 * WebKit failure mode (indexedDB.open hanging on some iOS versions), and an
 * unbounded await there would stall boot — and every later operation queued
 * behind it — forever. A call that overruns rejects with StorageTimeoutError,
 * and the engine is marked STALLED for the rest of the page load: pickEngine
 * skips it from then on instead of paying the timeout again.
 *
 * pickEngine(preference) probes each candidate once (memoized per page load)
 * and returns the first that works and hasn't stalled.
 */

import { createStore, get as idbGet, set as idbSet, del as idbDel } from './vendor/idb-keyval.js';

const IDB_NAME = 'wd-store';
const IDB_STORE = 'kv';

/** A storage call that didn't settle within its budget. */
export class StorageTimeoutError extends Error {
  constructor(what, ms) {
    super(`${what} did not settle within ${ms}ms`);
    this.name = 'StorageTimeoutError';
  }
}

// Per-call budgets (ms). Generous against a healthy store — an IndexedDB read
// of the full ~2.4 MB search index measured 3-8 ms — and short enough that a
// stuck one costs boot about a second before it falls back to the network.
const DEFAULT_TIMEOUTS = { probe: 1000, get: 2000, set: 4000, del: 2000 };
let timeouts = { ...DEFAULT_TIMEOUTS };

function bounded(promise, ms, what) {
  let timer;
  const overrun = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StorageTimeoutError(what, ms)), ms);
  });
  return Promise.race([promise, overrun]).finally(() => clearTimeout(timer));
}

// One connection for the page's lifetime; idb-keyval reopens it if the browser
// drops it (Safari does).
let idbStore = null;
function idb() {
  if (!idbStore) idbStore = createStore(IDB_NAME, IDB_STORE);
  return idbStore;
}

const raw = {
  idb: {
    async probe() {
      if (typeof indexedDB === 'undefined') return false;
      // Open the database (creating it on first use) and start a transaction on
      // our store — which throws if the store is missing — but issue no read:
      // on a slow disk each IndexedDB request is a full round trip, and a probe
      // read would add one to every cold boot for nothing.
      await idb()('readonly', () => undefined);
      return true;
    },
    async get(key) {
      const value = await idbGet(key, idb());
      return value === undefined ? null : value;
    },
    async set(key, value) {
      await idbSet(key, value, idb());
    },
    async del(key) {
      await idbDel(key, idb());
    },
  },

  local: {
    async probe() {
      localStorage.getItem('__wd_probe__'); // merely touching it throws where blocked
      return true;
    },
    async get(key) {
      const text = localStorage.getItem(key);
      return text === null ? null : JSON.parse(text);
    },
    async set(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    },
    async del(key) {
      localStorage.removeItem(key);
    },
  },
};

// Engines that overran a budget this page load.
const stalled = new Set();

function guarded(name, op) {
  return (...args) => bounded(
    Promise.resolve().then(() => raw[name][op](...args)),
    timeouts[op],
    `${name}.${op}`,
  ).catch((e) => {
    if (e instanceof StorageTimeoutError) stalled.add(name);
    throw e;
  });
}

export const engines = Object.fromEntries(Object.keys(raw).map((name) => [name, {
  name,
  probe: guarded(name, 'probe'),
  get: guarded(name, 'get'),
  set: guarded(name, 'set'),
  del: guarded(name, 'del'),
}]));

const probes = new Map();

/** Resolves whether `name` works in this browser; probed once, then memoized. */
function available(name) {
  if (stalled.has(name)) return Promise.resolve(false);
  if (!probes.has(name)) {
    probes.set(name, engines[name].probe().then(Boolean, () => false));
  }
  return probes.get(name).then((ok) => ok && !stalled.has(name));
}

/**
 * The first engine in `preference` that works here and hasn't stalled, or null
 * when none does. Later candidates are probed only if every earlier one failed.
 *
 * @param {Array<'idb'|'local'>} preference
 */
export async function pickEngine(preference) {
  for (const name of preference) {
    if (await available(name)) return engines[name];
  }
  return null;
}

/** Whether `name` overran a budget this page load (see module doc). */
export function isStalled(name) {
  return stalled.has(name);
}

// Seams for unit tests: forget probes, stalls and the cached IDB connection,
// and shrink the budgets so timeouts can be exercised quickly.
export const __test__ = {
  reset() {
    probes.clear();
    stalled.clear();
    idbStore = null;
    timeouts = { ...DEFAULT_TIMEOUTS };
  },
  setTimeouts(overrides) {
    timeouts = { ...timeouts, ...overrides };
  },
  DEFAULT_TIMEOUTS,
};
