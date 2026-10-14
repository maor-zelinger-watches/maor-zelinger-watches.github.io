/**
 * state.js — Shared mutable application state.
 *
 * A single object every feature module imports and mutates directly —
 * the same discipline app.js used before it was split, now with one
 * owner file. Fields are grouped by the module that primarily drives
 * them; cross-module reads are expected (e.g. prefetch checks view,
 * views check hasMore).
 *
 * Derived helpers that are pure reads of this state live here too, so
 * modules don't need to reach into each other for them — as do the two
 * cross-cutting mutation helpers: patchVideoEverywhere (one video row,
 * every list that holds a copy) and epoch (the single owner of the app's
 * generation counters).
 */

import { saveFeedCacheSoon } from './cache.js';

export const state = {
  videos: [],          // All loaded videos so far
  currentPage: 0,      // Last page that was loaded
  totalVideos: 0,      // Total available from API
  nextCursor: undefined, // server cursor after the last rendered page:
                         // string = resume here ('' = end of catalog),
                         // undefined = backend without cursors (page math)
  loading: false,      // Prevents concurrent fetches
  feedErrorStreak: 0,  // consecutive failed Latest page loads — drives retry backoff
  topErrorStreak: 0,   // consecutive failed Top page loads — drives retry backoff
  hasMore: true,       // Whether more pages exist
  expandedComments: new Set(),
  commentsCache: {},   // videoId -> { comments, tree } — prefetched comment data
  initialLoadComplete: false,
  filter: { query: '', types: ['video', 'article'] }, // types: content-type multi-select ('video'|'article'|'short');
                                    // [] === All. Default is Videos + Articles; a saved selection from a
                                    // prior session (cache.js loadFilterTypes) overrides this at setup.
                                    // Applied as pure CSS visibility, never a re-render.
  channelsPlatform: '',     // Channels-tab platform filter: '' (All) | 'youtube' | 'article'.
                            // Exclusive select, session-only, applied as pure CSS visibility.
  searchIndex: null,        // videos available to search — seeded from memory/cache,
                            // grows as index chunks land (may be partial mid-build)
  searchIndexComplete: false, // true once the whole catalog is loaded (or restored
                              // from cache); until then searchIndex is best-effort
  searchIndexPromise: null, // in-flight index build (dedupes concurrent requests)
  searchIndexProgress: new Set(), // onProgress callbacks fired as chunks merge in
  filterRenderToken: 0,     // invalidates stale filter renders after async index load
  view: 'latest',           // 'latest' (chronological), 'top' (weekly upvotes),
                            // 'starred', 'bookmarks', or 'channels'
  prefetchBuffer: [],       // [{page, videos}] fetched ahead, contiguous from currentPage+1
  feedReserve: null,        // {videos, anchor, reached} — cached Latest cards the
                            // revalidate replaced instead of keeping (fresh page 1
                            // shared nothing with the cached front). Served as pages
                            // once pagination reaches where they start, so a returning
                            // visitor scrolls back through familiar cards with zero
                            // network calls. See prefetch.js "feed reserve".
  prefetching: false,       // single refill loop at a time
  prefetchToken: 0,         // invalidates in-flight refills when pagination resets
  pendingFetchPage: 0,      // page loadNextPage is fetching on demand (0 = none)
  revalidating: false,      // revalidateFeed owns the DOM — pagination pauses
  topVideos: null,          // Top This Week list loaded so far (accumulates as you scroll)
  topLoaded: false,         // whether the first top page has been fetched
  topCursor: undefined,     // server cursor after the last rendered top page:
                            // string = resume here ('' = end of the week),
                            // undefined = not loaded yet
  topLoading: false,        // prevents concurrent top-page fetches
  topHasMore: false,        // whether more ranked pages remain to load
  topTotal: 0,              // total videos in the 7-day window (from the server)
  myVotes: new Set(),       // video IDs the signed-in user has upvoted
  myStars: new Set(),       // channel names the signed-in user has starred
  myBookmarks: new Set(),   // video IDs the signed-in user has bookmarked
  emailConsent: undefined,  // marketing-email consent: 'yes' | 'no' | null
                            // (asked the server; never answered) | undefined
                            // (not loaded / signed out / backend predates it)
  hostsByChannel: {},       // channel_name -> host, from getChannels (search matching)
  creators: null,           // full channel list, loaded once via getChannels (Channels tab + host map)
  fullscreenVideoId: null,      // video expanded to fullscreen, or null
  fullscreenReturnId: null,     // topmost visible card before fullscreen (scroll anchor)
  fullscreenReturnScrollY: 0,   // exact scroll offset before fullscreen
  fullscreenReturnAnchorTop: null, // the anchor card's viewport offset before fullscreen

  // Consecutive fetched pages that added no card the active content-type chip
  // leaves visible. The chips hide cards via CSS, so a fully-hidden page adds
  // zero height and the sentinel never leaves view; once either streak reaches
  // CONFIG.FILTER_ZERO_YIELD_MAX_PAGES the sentinel-retrigger parks so a sparse
  // type can't walk the whole catalog (FE1). Reset on a chip change, a genuine
  // scroll, or a tab switch — pagination is never permanently disabled.
  filterZeroYieldStreak: 0,    // Latest feed (app.js loadNextPage)
  topFilterZeroYieldStreak: 0, // Top This Week feed (views.js loadMoreTop)
};

/**
 * Registry of every state list that holds its own copy of feed rows.
 * patchVideoEverywhere walks this, so a new row-holding list only needs an
 * entry here — any list missing would re-render its rows with stale fields
 * (that's exactly how search cards lost their counts).
 */
const VIDEO_ROW_LISTS = ['videos', 'topVideos', 'searchIndex'];

/**
 * Patches one video's row in EVERY list that holds a copy (FE13) — the feed,
 * Top This Week, and the search index — then persists the feed once through
 * the coalesced cache write. Replaces the four hand-rolled walk-every-list
 * blocks (votes, comments, revalidateFeed's two) that kept drifting apart.
 *
 * @param {string} videoId
 * @param {object} fields — row fields to overwrite (e.g. {vote_count: 3})
 * @returns {boolean} whether the feed list held the row (and was persisted)
 */
export function patchVideoEverywhere(videoId, fields) {
  let inFeed = false;
  for (const key of VIDEO_ROW_LISTS) {
    const list = state[key];
    if (!list) continue;
    const row = list.find(v => v.video_id === videoId);
    if (!row) continue;
    Object.assign(row, fields);
    if (key === 'videos') inFeed = true;
  }
  // Coalesced + capped: a burst of patches serializes the feed once at idle
  // time, not the whole accumulated list synchronously on every mutation.
  if (inFeed) saveFeedCacheSoon(state.videos, state.totalVideos);
  return inFeed;
}

/**
 * epoch — single owner for the app's generation counters (FE14).
 *
 * Async work claims a generation up front and re-checks it after every
 * await; any later claim (or explicit bump) retires all older handles:
 *
 *   const e = epoch.claim('feed');  // supersedes prior claims of 'feed'
 *   ...await...
 *   if (!e.current()) return;       // a newer claim/bump won — abandon
 *
 * Snapshot readers that must only DETECT invalidation (without superseding
 * anything) observe the current generation instead:
 *
 *   const e = epoch.observe('votes');
 *   ...await...
 *   if (!e.current()) return;       // something bumped while we were away
 *
 * The remaining hand-rolled counters (filterRenderToken, viewToken,
 * prefetchToken, starEpoch) migrate here incrementally.
 */
const epochs = Object.create(null);
export const epoch = {
  /** Claims a NEW generation of `name`, retiring every older handle. */
  claim(name) {
    const mine = (epochs[name] || 0) + 1;
    epochs[name] = mine;
    return { current: () => epochs[name] === mine };
  },
  /** A handle on the CURRENT generation of `name`, without claiming. */
  observe(name) {
    const mine = epochs[name] || 0;
    return { current: () => (epochs[name] || 0) === mine };
  },
  /** Retires every outstanding handle of `name` without claiming one. */
  bump(name) {
    epochs[name] = (epochs[name] || 0) + 1;
  },
};

export function isFilterActive() {
  // Only the query counts: it re-routes rendering through the search index.
  // The type chips (filter.types) are a pure CSS visibility filter and must
  // NOT pause pagination — the feed keeps loading beneath them.
  return !!state.filter.query.trim();
}

/**
 * Whether a content-type chip selection is currently narrowing the feed.
 * Empty === "All" (nothing hidden). Unlike isFilterActive(), this DOES reflect
 * the type chips — it gates the zero-yield pagination guard, not rendering.
 */
export function typeFilterActive() {
  return state.filter.types.length > 0;
}

/** The current filter plus the channel→host map used for query matching. */
export function activeFilter() {
  return { ...state.filter, hostsByChannel: state.hostsByChannel };
}
