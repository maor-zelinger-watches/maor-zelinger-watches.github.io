/**
 * views.js — View routing: tabs, search, and category filtering.
 *
 * Owns which list the feed container shows — the chronological Latest
 * feed, the Top This Week ranking, the Starred feed, the Bookmarks feed,
 * or filtered search results — and the search index that powers filtering
 * across the whole catalog. The paginated Latest feed itself (loading, prefetch,
 * revalidation) lives in app.js; this module only re-renders lists that
 * are already in memory.
 */

import { state, isFilterActive, activeFilter, typeFilterActive } from './state.js';
import { api } from './api-client.js';
import { CONFIG } from './config.js';
import { filterVideos, sortVideos, sortTopRanking, dedupeVideos, mergeTopRanking, typeFilterVisible, searchFields } from './feed.js';
import { renderList, reconcileList, buildChannelCard } from './cards.js';
import { prefetchComments } from './comments-ui.js';
import { exitFullscreen } from './fullscreen.js';
import { isSignedIn } from './auth.js';
import { showToast } from './toast.js';
import { sanitizeHtml } from './utils.js';
import {
  loadSearchIndex, saveSearchIndex,
  loadTopCache, saveTopCache,
  loadChannelsCache, saveChannelsCache,
  loadFilterTypes, saveFilterTypes,
} from './cache.js';

// True while the current index build is running off a cached catalog, so a
// network failure can degrade to that cache instead of failing search.
let indexFromCache = false;

// Cap on catalog/archive page fetches in flight at once during an index build.
// Offset pages are order-independent, so they CAN all fire together — but doing
// so hammers the backend (which caps simultaneous executions) in one burst; a
// small pool keeps results streaming without the thundering herd.
const SEARCH_FETCH_CONCURRENCY = 4;

/**
 * Runs `worker` over `items` with at most `limit` calls in flight at once — a
 * bounded fan-out instead of one Promise.all burst over every page. Resolves
 * when all items are processed. Workers are expected to swallow their own
 * failures (a dropped chunk is best-effort), so this never rejects.
 */
async function runBounded(items, limit, worker) {
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

/** Fires every registered onProgress callback with the current (partial) index. */
function notifyIndexProgress() {
  for (const cb of state.searchIndexProgress) {
    // A stale render callback throwing must not abort the build for the others.
    try { cb(state.searchIndex); } catch (e) { /* ignore */ }
  }
}

/**
 * Instant, network-free starting point for search: everything already in
 * memory (the scrolled feed), deduped. Lets the first keystroke match against
 * something before any chunk lands. The persisted feed snapshot needs no
 * separate read here: boot restored it into state.videos, which only grows
 * from there.
 */
function seedFromMemory() {
  return dedupeVideos(Array.isArray(state.videos) ? state.videos : []);
}

/** Same identity key dedupeVideos uses: url when present, else video_id. */
function indexKey(v) {
  return v && v.url ? String(v.url).trim().toLowerCase() : `id:${v && v.video_id}`;
}

/**
 * Merges a freshly fetched chunk into the index. Fresh rows REPLACE stale
 * same-key rows — dedupeVideos' engagement contest is only right within a
 * single fetch (the doubled-article case); across fetches the re-fetched row
 * is newer truth even when its counts went down (an un-vote), so competing
 * on engagement would freeze counts at their cached high-water mark.
 * Keeps the index newest-first: chunks resolve in arbitrary order, and
 * category-only filtering renders index order directly.
 */
function mergeIndexChunk(index, chunkVideos) {
  const fresh = dedupeVideos(chunkVideos); // collapse intra-fetch doubles
  // Warm each row's normalized search tokens once, here at merge time, so the
  // per-keystroke filter pass reads a cache instead of re-tokenizing the whole
  // index on every progress render (FE10).
  for (const v of fresh) searchFields(v);
  const freshKeys = new Set(fresh.map(indexKey));
  return sortVideos(index.filter(v => !freshKeys.has(indexKey(v))).concat(fresh));
}

// Frame scheduler with a timer fallback for environments without rAF.
const scheduleFrame = typeof requestAnimationFrame === 'function'
  ? (cb) => requestAnimationFrame(cb)
  : (cb) => setTimeout(cb, 250);

/**
 * Coalesces a burst of progress renders into ~1 per animation frame (FE10).
 * A search session merges a dozen-plus index chunks; without throttling each
 * merge re-ran the full match-and-paint. Leading-edge: the first call renders
 * synchronously (so the seeded first paint stays instant) and any further calls
 * within that frame collapse into a single trailing render on the next frame.
 * `.cancel()` drops a pending trailing render before the authoritative final one.
 */
function throttleToFrame(fn) {
  let scheduled = false;
  let trailing = false;
  let lastArgs = [];
  const flush = () => {
    scheduled = false;
    if (trailing) { trailing = false; fn(...lastArgs); }
  };
  const wrapper = (...args) => {
    lastArgs = args;
    if (scheduled) { trailing = true; return; }
    scheduled = true;
    fn(...args);
    scheduleFrame(flush);
  };
  wrapper.cancel = () => { scheduled = false; trailing = false; };
  return wrapper;
}

/**
 * Keeps state.expandedComments consistent with a diffed list: an entry for a
 * card the diff dropped no longer tracks a live thread. The fullscreen overlay
 * is always retained (it stays mounted even when filtered out of the list).
 * Replaces the blanket `expandedComments.clear()` that the old innerHTML=''
 * renders needed — the diff preserves surviving cards, so their entries stay.
 */
function syncExpandedComments(keepIds) {
  for (const id of [...state.expandedComments]) {
    if (!keepIds.has(id) && id !== state.fullscreenVideoId) {
      state.expandedComments.delete(id);
    }
  }
}

/**
 * Fetches the whole catalog in parallel chunks, merging each into the live
 * index as it arrives (fresh rows replace stale seed/cache rows).
 * Every merge notifies progress subscribers so results paint incrementally.
 * Uses offset pagination — unlike cursors, pages are order-independent and
 * can be fetched concurrently. Returns the complete index.
 *
 * Two phases: the live catalog (recent, small — this is what makes search feel
 * instant) first, then the archive (everything aged past the backend's
 * retention window) via a SEPARATE endpoint so it never delays the live
 * results. Archived items merge in as they arrive, extending search and
 * Favorites back through the whole history.
 */
async function buildSearchIndex() {
  const chunk = CONFIG.SEARCH_CHUNK_SIZE;
  const cap = CONFIG.SEARCH_INDEX_LIMIT;

  // First chunk is the newest page and tells us the catalog total.
  const first = await api.fetchFeed(1, chunk);
  const firstVideos = first.videos || [];
  state.searchIndex = mergeIndexChunk(state.searchIndex || [], firstVideos);
  notifyIndexProgress();

  const total = Math.min(first.total || firstVideos.length, cap);
  if (firstVideos.length > 0 && total > firstVideos.length) {
    // Page math MUST use the page size the backend actually served, not the
    // size we asked for: the server clamps oversized limits (MAX_PAGE_LIMIT)
    // and computes offsets from the CLAMPED value. Assuming our requested
    // chunk here made pages 2..N land on already-fetched offsets, silently
    // capping the index at a fraction of the catalog. Page 1 came back short
    // of the request, so its length IS the server's effective page size
    // (a short LAST page only happens when total <= its length, excluded above).
    const served = firstVideos.length;
    const pages = [];
    for (let p = 2; (p - 1) * served < total; p++) pages.push(p);
    await runBounded(pages, SEARCH_FETCH_CONCURRENCY, p =>
      api.fetchFeed(p, chunk)
        .then(data => {
          state.searchIndex = mergeIndexChunk(state.searchIndex, data.videos || []);
          notifyIndexProgress();
        })
        // A dropped chunk just means those items miss this session's index.
        .catch(() => { /* best-effort */ })
    );
  }

  // Phase 2: backfill the archive (older than the live window) into the index.
  await appendArchiveToIndex();

  return state.searchIndex;
}

/**
 * Backfills the archive into the search index as a separate, best-effort phase.
 * Runs after the live catalog so recent results are already searchable; each
 * archived chunk merges in and repaints via the progress subscribers. Honors
 * the same SEARCH_INDEX_LIMIT ceiling as the live build (the archive is the
 * long tail, so it's what the cap bites first). Fully silent on any failure —
 * an older backend without the `archive` action, an empty archive, or a flaky
 * network just leaves the live index as the whole index.
 */
async function appendArchiveToIndex() {
  const chunk = CONFIG.SEARCH_CHUNK_SIZE;
  const cap = CONFIG.SEARCH_INDEX_LIMIT;
  if ((state.searchIndex ? state.searchIndex.length : 0) >= cap) return;

  let firstArchive;
  try {
    firstArchive = await api.fetchArchive(1, chunk);
  } catch (e) {
    return; // no archive action / empty / offline — live index stands
  }
  const firstVideos = firstArchive.videos || [];
  if (firstVideos.length === 0) return;

  state.searchIndex = mergeIndexChunk(state.searchIndex || [], firstVideos);
  notifyIndexProgress();

  // Build the page list from the REMAINING index headroom, not the full cap.
  // The cap is the absolute index ceiling (5000); with the live catalog already
  // near it, only a page or two of archive can actually land. Sizing the fetch
  // to `cap - length` (ceil to whole chunks) stops us downloading — then
  // discarding in the merge guard below — pages the ceiling has no room for.
  const remaining = cap - (state.searchIndex ? state.searchIndex.length : 0);
  if (remaining <= 0) return;

  // Same served-size rule as buildSearchIndex: offsets follow the CLAMPED
  // limit the backend applied, so page math trusts what page 1 returned.
  // (A short page 1 here can also mean a small archive — then archiveTotal
  // bounds the loop to no pages at all, so the fallback is harmless.)
  const served = firstVideos.length;
  const archiveTotal = firstArchive.total || firstVideos.length;
  const morePages = Math.ceil(remaining / served);
  const pages = [];
  for (let p = 2; p <= 1 + morePages && (p - 1) * served < archiveTotal; p++) pages.push(p);

  await runBounded(pages, SEARCH_FETCH_CONCURRENCY, p =>
    api.fetchArchive(p, chunk)
      .then(data => {
        // Stop merging once the combined index hits the ceiling.
        if ((state.searchIndex ? state.searchIndex.length : 0) >= cap) return;
        state.searchIndex = mergeIndexChunk(state.searchIndex, data.videos || []);
        notifyIndexProgress();
      })
      .catch(() => { /* best-effort — those archived items miss this session */ })
  );
}

/**
 * Refreshes a complete cached index instead of re-walking the whole catalog.
 *
 * A persisted index is only ever saved after a COMPLETE build, so everything
 * the catalog held at save time is already in it — including every archived
 * row (items only enter the archive by aging out of the live feed, and the
 * live retention window is weeks, far past the cache's 24h TTL). The only
 * rows a fresh-cached session can be missing are new items at the HEAD of the
 * live feed. So: walk feed pages newest-first, sequentially, and stop at the
 * first page that adds no unknown key — that page and everything older is
 * already indexed. Usually that's one request, where a full rebuild is ~40
 * (and the backend serializes concurrent executions, so a full walk costs
 * minutes of wall clock every session).
 *
 * Rows deleted server-side linger until the cache's 24h TTL forces the next
 * full rebuild — the same staleness window the TTL already accepts.
 */
async function topUpSearchIndex() {
  const chunk = CONFIG.SEARCH_CHUNK_SIZE;
  const cap = CONFIG.SEARCH_INDEX_LIMIT;
  const known = new Set((state.searchIndex || []).map(indexKey));

  let page = 1;
  let served = 0; // effective server page size, learned from page 1
  for (;;) {
    const data = await api.fetchFeed(page, chunk);
    const videos = data.videos || [];
    if (videos.length === 0) break;
    if (page === 1) served = videos.length;

    const unknown = videos.filter(v => !known.has(indexKey(v)));
    state.searchIndex = mergeIndexChunk(state.searchIndex || [], videos);
    notifyIndexProgress();

    // Fully-known page: the cached index already covers from here on down.
    if (unknown.length === 0) break;
    for (const v of unknown) known.add(indexKey(v));

    const total = Math.min(data.total || videos.length, cap);
    if (page * served >= total) break; // walked the whole live catalog
    if (state.searchIndex.length >= cap) break;
    page++;
  }
  return state.searchIndex;
}

/**
 * Restores the persisted index and tops it up, or — with no usable snapshot —
 * walks the whole catalog. A persisted index is a COMPLETE snapshot (it's only
 * saved after a full build), so it just needs new head items merged in.
 *
 * The restored snapshot is merged UNDER the memory seed: rows already in
 * memory are this session's (fresher counts after a vote or revalidate), so
 * they replace their snapshot copies rather than the other way round.
 *
 * @returns {Promise<{full: Object[], rebuilt: boolean}>}
 */
async function restoreOrBuildIndex() {
  const cached = await loadSearchIndex();
  if (cached && cached.length) {
    indexFromCache = true;
    const seed = state.searchIndex || [];
    state.searchIndex = seed.length ? mergeIndexChunk(cached, seed) : cached;
    notifyIndexProgress();
    return { full: await topUpSearchIndex(), rebuilt: false };
  }
  return { full: await buildSearchIndex(), rebuilt: true };
}

/**
 * Ensures the full-catalog search index is (being) built, so search and
 * filters reach everything, not just the pages scrolled so far.
 *
 * Returns a promise that resolves with the COMPLETE index. Pass `onProgress`
 * to also paint partial results: it's called with the current index right
 * away (from an in-memory/cached seed) and again after each chunk merges in.
 * The seed makes the first keystroke feel instant; the resolved promise is
 * the authoritative final state (empty-state, prefetch) for callers to render.
 */
export function ensureSearchIndex(onProgress) {
  // Already complete: fire the callback once (don't retain it — there's no
  // build left to clear the subscriber set) and hand back the final index.
  if (state.searchIndexComplete) {
    if (typeof onProgress === 'function' && state.searchIndex && state.searchIndex.length) {
      try { onProgress(state.searchIndex); } catch (e) { /* ignore */ }
    }
    return Promise.resolve(state.searchIndex);
  }

  if (typeof onProgress === 'function') {
    state.searchIndexProgress.add(onProgress);
    // Late subscriber (index already seeded/partial): paint immediately.
    if (state.searchIndex && state.searchIndex.length) {
      try { onProgress(state.searchIndex); } catch (e) { /* ignore */ }
    }
  }

  // Seed synchronously from memory so progress subscribers have something to
  // show now. The persisted index is async; restoreOrBuildIndex swaps it in a
  // few milliseconds later.
  if (!state.searchIndex) {
    state.searchIndex = seedFromMemory();
    indexFromCache = false;
    if (state.searchIndex.length) notifyIndexProgress();
  }

  if (!state.searchIndexPromise) {
    state.searchIndexPromise = restoreOrBuildIndex()
      .then(({ full, rebuilt }) => {
        state.searchIndex = full;
        state.searchIndexComplete = true;
        // Only a full walk may overwrite the persisted snapshot: a top-up
        // re-stamping savedAt would keep deferring the TTL'd full rebuild —
        // the pass that lets server-side deletions age out — indefinitely.
        if (rebuilt) saveSearchIndex(full);
        state.searchIndexProgress.clear();
        return full;
      })
      .catch(error => {
        // A cached catalog is a good-enough fallback — run the session on it
        // rather than failing search outright over a flaky network.
        if (indexFromCache && state.searchIndex && state.searchIndex.length) {
          state.searchIndexComplete = true;
          state.searchIndexProgress.clear();
          return state.searchIndex;
        }
        // Nothing usable — reset so the next keystroke retries from scratch.
        state.searchIndexPromise = null;
        state.searchIndex = null;
        state.searchIndexProgress.clear();
        throw error;
      });
  }

  return state.searchIndexPromise;
}

/** Commits a creator list to state: the list itself and the search host-map. */
function applyCreators(creators) {
  state.creators = creators;
  const hosts = {};
  for (const c of creators) {
    if (c.channel_name && c.host) hosts[c.channel_name] = c.host;
  }
  state.hostsByChannel = hosts;
}

/** Cheap identity of the creator list — re-render only when this changes. */
function creatorsSignature(creators) {
  return (creators || [])
    .map(c => `${c.channel_name}|${c.url || ''}|${c.avatar || ''}|${c.host || ''}|${c.platform || ''}`)
    .sort()
    .join('\n');
}

/**
 * Background freshness check for the Channels tab (stale-while-revalidate):
 * the cached list painted instantly; this fetches the live list, updates
 * state + cache, and repaints only if the curated list actually changed (a
 * rare event — so most opens never touch the DOM after the cached paint).
 */
async function revalidateChannels() {
  let creators;
  try {
    const data = await api.fetchChannels();
    creators = data.channels || [];
  } catch (e) {
    return; // the cached list stays on screen
  }
  if (creators.length === 0) return; // don't wipe on a transient empty
  const changed = creatorsSignature(creators) !== creatorsSignature(state.creators);
  applyCreators(creators);
  saveChannelsCache(creators);
  if (changed && state.view === 'channels') renderChannels();
}

// Single in-flight load of the creator list, shared by the host map (search
// matching) and the Channels tab. Cached on state.creators (session) and in
// the snapshot store (across sessions); a failure clears the promise so the
// next caller retries.
let creatorsPromise = null;
export function loadCreators() {
  if (state.creators) return Promise.resolve(state.creators);

  if (!creatorsPromise) {
    creatorsPromise = (async () => {
      // Instant paint from the persisted list, then revalidate in the background.
      const cached = await loadChannelsCache();
      if (cached && cached.length) {
        applyCreators(cached);
        revalidateChannels();
        return cached;
      }
      const data = await api.fetchChannels();
      const creators = data.channels || [];
      applyCreators(creators);
      saveChannelsCache(creators);
      return creators;
    })().catch(err => {
      creatorsPromise = null; // allow a later view to retry
      throw err;
    });
  }
  return creatorsPromise;
}

export function setupFeedControls() {
  const input = document.getElementById('search-input');
  const chipsContainer = document.getElementById('category-chips');
  if (!input) return;

  // Content-type chips are a fixed set — render them right away, no fetch needed.
  renderTypeChips(chipsContainer);

  // Channels-tab platform chips are fixed too; their container stays hidden
  // until the Channels view shows it (update()).
  renderPlatformChips(document.getElementById('platform-chips'));

  // Warm the creator list so the host map (search matching) and the Channels
  // tab are ready before they're needed. Host matching is an enhancement —
  // search still works without it — so a failure is swallowed here.
  loadCreators().catch(() => {});

  // Warm the search index as soon as the user shows intent
  input.addEventListener('focus', () => {
    ensureSearchIndex().catch(() => {});
  }, { once: true });

  // Short debounce: matching is in-memory and the render is capped, so the
  // main thread can keep up per keystroke. A tighter delay keeps the first
  // keystroke from feeling laggy; applyFilter shows a "Searching…" state
  // while the catalog index is still warming so the box never flashes blank.
  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.filter.query = input.value;
      update();
    }, 120);
  });
}

/**
 * Renders whichever view is active, honoring the current search/filter.
 * Single entry point for the search box, chips, and tab switches.
 */
export function update() {
  // Every render path may wipe the container — never destroy an active
  // fullscreen card (it would leave the page scroll-locked with no exit).
  if (state.fullscreenVideoId) exitFullscreen();

  const isChannels = state.view === 'channels';
  // The Channels grid layout and the video search/type controls belong only to
  // their own views — flip both here so every entry point (tab click, star
  // re-render, filter) leaves the container in the right mode.
  const container = document.getElementById('feed-container');
  if (container) {
    container.classList.toggle('feed--channels', isChannels);
    // Channel cards must be purged here too: the reconcile-based renders
    // (Starred, searched Latest) diff only .media-card elements, so a grid
    // left behind by the Channels tab is invisible to them and would survive
    // the switch, burying the incoming feed under stale channel cards.
    if (!isChannels) {
      container.querySelectorAll('.channel-card').forEach(card => card.remove());
    }
  }
  const controls = document.getElementById('feed-controls');
  if (controls) controls.style.display = isChannels ? 'none' : '';
  // The platform chips are the Channels tab's own controls row — the mirror
  // image of the video controls above.
  const channelsControls = document.getElementById('channels-controls');
  if (channelsControls) channelsControls.style.display = isChannels ? '' : 'none';

  if (state.view === 'top') {
    renderTop();
  } else if (state.view === 'starred') {
    renderStarred();
  } else if (state.view === 'bookmarks') {
    renderBookmarks();
  } else if (isChannels) {
    renderChannels();
  } else {
    applyFilter();
  }
}

export function setupTabs() {
  const tabs = Array.from(document.querySelectorAll('.feed-tab'));
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));

    // ARIA tablist keyboard support: arrow keys (Home/End) move focus between
    // tabs with a roving tabindex, and selection follows focus. switchView
    // synchronously updates aria-selected + tabindex before it awaits, so the
    // target is focusable by the time we call focus() below.
    tab.addEventListener('keydown', (e) => {
      let next = null;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      else return;
      e.preventDefault();
      const target = tabs[next];
      switchView(target.dataset.view);
      target.focus();
    });
  });
}

/**
 * Syncs the tablist's ARIA + roving-tabindex state to the active view and
 * points the shared tabpanel's label at the active tab. Called from every place
 * that changes which tab is selected so the two stay in lockstep.
 */
function syncTabState(view) {
  document.querySelectorAll('.feed-tab').forEach(t => {
    const active = t.dataset.view === view;
    t.classList.toggle('feed-tab--active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
    t.tabIndex = active ? 0 : -1;
  });
  const panel = document.getElementById('feed-container');
  if (panel) panel.setAttribute('aria-labelledby', `tab-${view}`);
}

// Bumped on every tab switch so an older switch's async work (top list,
// starred index) can't repaint — or error-revert — the tab the user has
// since moved on from.
let viewToken = 0;

/**
 * Switches between the chronological "Latest" feed and the "Top This Week"
 * upvote ranking. The top list is fetched once, then cached for the session.
 */
async function switchView(view) {
  if (view === state.view) return;
  const token = ++viewToken;
  state.view = view;

  // A tab switch is explicit intent — clear any parked zero-yield pagination so
  // the newly-entered feed can fill and scroll again from a clean slate (FE1).
  state.filterZeroYieldStreak = 0;
  state.topFilterZeroYieldStreak = 0;

  syncTabState(view);
  // FE9: tear down any open fullscreen overlay BEFORE resetting scroll. Exiting
  // restores the pre-fullscreen scroll offset (and strips ?v=); doing it first
  // lets the scroll-to-top below win, so the freshly-opened view starts at the
  // top instead of landing mid-list at the old offset. update() further down
  // then finds no overlay to tear down (its own exitFullscreen guard no-ops).
  if (state.fullscreenVideoId) exitFullscreen();
  window.scrollTo({ top: 0 });

  // A superseded switch bails before its skeleton cleanup — clear any
  // skeleton it left showing before this view takes over the container.
  document.getElementById('feed-skeleton').style.display = 'none';
  // Latest-view search may have left the "Searching…" indicator up; the new
  // view owns the container now, so it must not linger below its cards.
  document.getElementById('feed-searching').style.display = 'none';

  if (view === 'top' && !state.topLoaded) {
    // Instant paint from the cached first page, then revalidate in the
    // background. Only fall back to the skeleton + blocking fetch when there's
    // no cache to show — a first-ever open (or a cleared cache).
    const cachedTop = await loadTopCache();
    if (state.topLoaded) {
      // A newer switch to Top restored (or fetched) the list during that
      // await — it owns the revalidate; don't start a second one.
    } else if (cachedTop) {
      state.topVideos = cachedTop.videos;
      state.topTotal = cachedTop.total;
      state.topCursor = cachedTop.cursor;
      state.topHasMore = typeof cachedTop.cursor === 'string' && cachedTop.cursor !== '';
      state.topLoaded = true;
      revalidateTop(); // background freshness; repaints only if the ranking moved
    } else if (token !== viewToken) {
      // The user left Top while the snapshot was being read. The cold path
      // below wipes the container for its skeleton — that container belongs
      // to the newer view now. Reopening Top re-runs this branch.
      return;
    } else {
      const container = document.getElementById('feed-container');
      const skeleton = document.getElementById('feed-skeleton');
      const sentinel = document.getElementById('load-more-container');
      container.innerHTML = '';
      state.expandedComments.clear();
      sentinel.style.display = 'none';
      skeleton.style.display = '';
      try {
        const data = await api.fetchTopWeek(CONFIG.PAGE_SIZE);
        // Keep the loaded list even if this switch is stale — reopening the tab
        // renders it instantly and keeps paginating. Only the DOM work below
        // needs the token guard.
        state.topVideos = data.videos || [];
        state.topTotal = data.total || 0;
        state.topCursor = data.next_cursor;
        state.topHasMore = typeof data.next_cursor === 'string' && data.next_cursor !== '';
        // Don't freeze an empty result for the whole session. An empty list can
        // come from a transient hiccup or a refresh still in flight; leaving
        // topLoaded false lets reopening the tab refetch instead of sticking.
        state.topLoaded = state.topVideos.length > 0;
        if (state.topVideos.length > 0) saveTopCache(state.topVideos, state.topTotal, state.topCursor);
      } catch (e) {
        console.error('Failed to load top videos:', e);
        // A newer switch owns the tabs and container now — don't yank the
        // user to Latest over a request they've already navigated away from.
        if (token !== viewToken) return;
        showToast('Failed to load top videos. Please try again.', 'error');
        state.view = 'latest';
        syncTabState('latest');
        skeleton.style.display = 'none';
        applyFilter();
        return;
      }
      if (token !== viewToken) return;
      skeleton.style.display = 'none';
    }
  }

  // Starred paints instantly from the cached/seeded search index and
  // reconciles as fresh catalog chunks land (renderStarred owns that
  // stale-while-revalidate flow) — no blocking skeleton wait here.

  // Only the most recent switch may repaint — a stale update() here
  // caused redundant re-renders and lost scroll on rapid tab flips.
  if (token !== viewToken) return;
  update();
}

/**
 * Renders the Top This Week list loaded so far, honoring any active filter.
 * Cursor-paginated with infinite scroll (loadMoreTop appends further pages) —
 * this full render is for tab switches and filter changes; scroll-in pages
 * append without re-rendering what's already shown.
 */
function renderTop() {
  const container = document.getElementById('feed-container');
  const sentinel = document.getElementById('load-more-container');
  const empty = document.getElementById('feed-empty');
  if (!container) return;

  const filtered = isFilterActive();
  let list = state.topVideos || [];
  if (filtered) list = filterVideos(list, activeFilter());

  container.innerHTML = '';
  state.expandedComments.clear();
  renderList(container, list);

  empty.querySelector('p').textContent = filtered
    ? 'No videos match your search.'
    : 'No videos yet this week. Check back soon!';
  empty.style.display = list.length === 0 ? '' : 'none';

  // Infinite scroll: reveal the sentinel while more ranked pages remain and no
  // search query is narrowing the loaded set. A query pauses pagination — we
  // just filter what's already loaded — exactly like the Latest feed.
  sentinel.style.display = (state.topHasMore && !filtered) ? '' : 'none';

  prefetchComments(list.slice(0, CONFIG.PAGE_SIZE));
}

/**
 * Background freshness check for Top This Week (stale-while-revalidate).
 *
 * The cached first page painted instantly; this refetches that first ranked
 * page and reconciles the window it covers — new items in, dropped items out,
 * counts and order updated (fresh is authoritative for the top). Any deeper
 * pages the user scrolled to are preserved: fresh page 1 knows nothing about
 * them, so "absent from fresh" beyond the window is not "removed." Repaints
 * only when the visible list actually moved, so an unchanged open never flashes.
 */
async function revalidateTop() {
  let data;
  try {
    data = await api.fetchTopWeek(CONFIG.PAGE_SIZE);
  } catch (e) {
    return; // the stale ranking stays on screen
  }
  const fresh = data.videos || [];
  if (fresh.length === 0) return; // don't wipe the list on a transient empty

  const merged = mergeTopRanking(state.topVideos || [], fresh);
  const hadTail = (state.topVideos || []).length > fresh.length;

  const sig = (list) => list.map(v => `${v.video_id}:${v.vote_count || 0}:${v.comment_count || 0}`).join(',');
  const changed = sig(state.topVideos || []) !== sig(merged);

  state.topVideos = merged;
  state.topTotal = data.total || state.topTotal;
  // The cursor only advances when there's no deeper tail — with a tail loaded
  // the live cursor already points past it; fresh page 1's would rewind it.
  if (!hadTail) {
    state.topCursor = data.next_cursor;
    state.topHasMore = typeof data.next_cursor === 'string' && data.next_cursor !== '';
  }
  saveTopCache(fresh, state.topTotal, data.next_cursor);

  // Only the ranked-content render is driven here; a search query owns the
  // container (renderTop filters the loaded set) and must not be interrupted.
  if (changed && state.view === 'top' && !isFilterActive()) renderTop();
}

/**
 * Re-ranks the loaded Top This Week list after a confirmed vote changes a
 * count (votes.js patched the row copies; app.js routes its callback here).
 * The sort mirrors the server's compareTopWeek order, so the liked card lands
 * exactly where the next fetch would put it — no round trip, no waiting on
 * topLoaded (which stays true all session, so a tab re-open never refetches).
 *
 * Repaints only when the order actually moved and the ranked list owns the
 * container — an active search keeps filtering the loaded set, which now
 * holds the new order for when it clears (same rule as revalidateTop). The
 * saved first-page snapshot is refreshed only while it covers the whole
 * loaded window: with deeper pages loaded, a page-1 slice paired with the
 * deep cursor would disagree on restore, and the next session's revalidate
 * refreshes the snapshot anyway.
 */
export function resortTopRanking() {
  const list = state.topVideos;
  if (!list || list.length === 0) return;

  const before = list.map(v => v.video_id).join(',');
  const sorted = sortTopRanking(list);
  state.topVideos = sorted;

  if (sorted.length <= CONFIG.PAGE_SIZE) {
    saveTopCache(sorted, state.topTotal, state.topCursor);
  }

  if (sorted.map(v => v.video_id).join(',') === before) return;
  if (state.view === 'top' && !isFilterActive()) renderTop();
}

/**
 * Whether the Top feed's sentinel-retrigger is parked: a content-type chip is
 * active AND the last FILTER_ZERO_YIELD_MAX_PAGES appended pages each added no
 * visible card. Mirrors app.js's Latest-feed guard — the chips hide cards via
 * CSS, so an all-hidden page adds zero height and the rAF nudge would walk the
 * whole ranking (FE1). Cleared on a chip change, a genuine scroll, or a tab
 * switch.
 */
function topFilterPaginationParked() {
  return typeFilterActive() &&
    state.topFilterZeroYieldStreak >= CONFIG.FILTER_ZERO_YIELD_MAX_PAGES;
}

/**
 * Loads and appends the next page of the Top This Week ranking. The list is
 * cursor-paginated and vote-ranked server-side; new cards append in rank order
 * (no re-render of what's already shown). An active search query pauses this —
 * renderTop filters the loaded set instead — mirroring the Latest feed.
 *
 * Exported so the shared infinite-scroll observer in app.js can drive it when
 * the Top tab is active.
 */
export async function loadMoreTop() {
  if (state.view !== 'top' || state.topLoading || !state.topHasMore || isFilterActive()) return;
  // A content-type chip is hiding every appended page — pagination is parked
  // until the selection changes or the user scrolls with intent. Refuse here so
  // neither the rAF nudge nor the observer can restart the storm while parked.
  if (topFilterPaginationParked()) {
    const parkedSentinel = document.getElementById('load-more-container');
    if (parkedSentinel) parkedSentinel.style.display = 'none';
    return;
  }
  if (!state.topCursor) { state.topHasMore = false; return; }

  const token = viewToken;
  state.topLoading = true;
  let loadFailed = false;
  const sentinel = document.getElementById('load-more-container');

  try {
    const data = await api.fetchTopWeek(CONFIG.PAGE_SIZE, state.topCursor);
    // A tab switch landed while we waited — don't paint into a view we've left.
    if (token !== viewToken || state.view !== 'top') return;

    state.topTotal = data.total || state.topTotal;
    state.topCursor = data.next_cursor;
    state.topHasMore = typeof data.next_cursor === 'string' && data.next_cursor !== '';

    // Dedupe against what's already loaded: a vote that reorders the ranking
    // mid-scroll can nudge one item across the page boundary.
    const seen = new Set((state.topVideos || []).map(v => v.video_id));
    const fresh = (data.videos || []).filter(v => v.video_id && !seen.has(v.video_id));
    state.topVideos = (state.topVideos || []).concat(fresh);

    // Append only when a search filter isn't currently overriding the render.
    if (!isFilterActive() && fresh.length) {
      const container = document.getElementById('feed-container');
      if (container) renderList(container, fresh);
    }

    // Track pages that add nothing the active type chip leaves visible — a run
    // of them parks the retrigger below so a sparse type can't walk the whole
    // ranking behind an all-hidden filter (FE1).
    if (typeFilterActive()) {
      const visibleAdded = fresh.reduce(
        (n, v) => n + (typeFilterVisible(v, state.filter.types) ? 1 : 0), 0);
      state.topFilterZeroYieldStreak = visibleAdded > 0 ? 0 : state.topFilterZeroYieldStreak + 1;
    } else {
      state.topFilterZeroYieldStreak = 0;
    }

    prefetchComments(fresh);
  } catch (e) {
    loadFailed = true;
    console.error('Failed to load more top videos:', e);
    // Leave what's shown in place; retry with backoff below.
    state.topErrorStreak++;
  } finally {
    state.topLoading = false;
    if (!loadFailed) state.topErrorStreak = 0;
    if (token === viewToken && state.view === 'top') {
      // Parked (all fetched cards hidden by the type chip): hide the sentinel
      // and skip the rAF nudge, exactly like app.js's Latest guard (FE1).
      const show = state.topHasMore && !isFilterActive() && !topFilterPaginationParked();
      if (sentinel) sentinel.style.display = show ? '' : 'none';
      if (show && sentinel) {
        if (loadFailed) {
          // A failed load leaves the sentinel in view; the immediate rAF nudge
          // would spin a tight fetch-fail loop. Back off exponentially (cap 30s).
          const delay = Math.min(30000, 1000 * Math.pow(2, state.topErrorStreak - 1));
          setTimeout(() => {
            if (state.view === 'top' && state.topHasMore && !isFilterActive() && !state.topLoading) loadMoreTop();
          }, delay);
        } else {
          // The observer only fires on intersection CHANGES. If the sentinel is
          // still within the root margin after this append (a tall viewport, or a
          // short page), nudge the next load manually — the same guard the feed uses.
          requestAnimationFrame(() => {
            if (state.view !== 'top' || !state.topHasMore || isFilterActive() || state.topLoading) return;
            const rect = sentinel.getBoundingClientRect();
            if (rect.top > 0 && rect.top <= window.innerHeight + 600) loadMoreTop();
          });
        }
      }
    }
  }
}

/**
 * Renders the Starred feed: every video from creators the signed-in user
 * has starred, newest first, honoring any active search filter.
 * Uses the full search index so starred feeds reach the whole catalog.
 */
async function renderStarred() {
  const container = document.getElementById('feed-container');
  const sentinel = document.getElementById('load-more-container');
  const empty = document.getElementById('feed-empty');
  const searching = document.getElementById('feed-searching');
  if (!container) return;

  sentinel.style.display = 'none';

  if (!isSignedIn()) {
    container.innerHTML = '';
    state.expandedComments.clear();
    if (searching) searching.style.display = 'none';
    empty.querySelector('p').textContent = 'Sign in to see videos from your favorite creators.';
    empty.style.display = '';
    return;
  }

  const token = ++state.filterRenderToken;
  let painted = false;

  // Paints the starred set for the current index snapshot. Runs first from the
  // seeded/cached index (instant), again per fresh chunk, and finally when the
  // rebuilt index is complete — the same stale-while-revalidate shape as search.
  const renderFrom = (index, final) => {
    if (token !== state.filterRenderToken || state.view !== 'starred') return;
    let list = sortVideos((index || []).filter(v => state.myStars.has(v.channel_name)));
    // Same render cap as applyFilter — a one-letter search over a large starred
    // catalog would otherwise paint thousands of cards in one go.
    if (isFilterActive()) list = filterVideos(list, activeFilter()).slice(0, CONFIG.SEARCH_RENDER_LIMIT);

    // Diff by video_id (FE10): reconcile as fresh index chunks land instead of
    // wiping the container each time — surviving starred cards keep their
    // expanded comments and playing iframe. Strip any truncation note a prior
    // Latest-search render may have left in this shared container.
    const prevNote = container.querySelector('.feed-truncation-note');
    if (prevNote) prevNote.remove();
    reconcileList(container, list);
    syncExpandedComments(new Set(list.map(v => String(v.video_id))));
    painted = true;

    empty.querySelector('p').textContent = state.myStars.size === 0
      ? 'No favorite creators yet. Tap the ☆ next to a channel name to build your feed.'
      : (isFilterActive()
        ? 'No videos match your search.'
        : 'No videos from your favorite creators yet.');
    // Don't flash "no videos" while the catalog is still streaming in behind the
    // seed — a favorite's videos may simply not be in the partial index yet. The
    // "no stars" copy is safe to show immediately (it doesn't depend on the index).
    const noItems = list.length === 0;
    const stillBuilding = !final && !state.searchIndexComplete;
    empty.style.display = (noItems && (final || state.myStars.size === 0)) ? '' : 'none';
    if (searching) searching.style.display = (noItems && stillBuilding && state.myStars.size > 0) ? '' : 'none';
    if (final) prefetchComments(list.slice(0, CONFIG.PAGE_SIZE));
  };

  // Throttle the per-chunk progress renders to ~1/frame (FE10); the seed fires
  // synchronously on the leading edge so the first paint stays instant.
  const throttledRender = throttleToFrame((idx) => renderFrom(idx, false));

  // Kicks off the index (seeds synchronously from cache/memory, fires onProgress
  // for any seed and again per chunk); resolves with the authoritative index.
  const indexPromise = ensureSearchIndex(partial => throttledRender(partial));
  // Guarantee a first paint even when the seed was empty (cold, no cache): clear
  // the previous view and show the searching state rather than leaving it blank.
  if (!painted) renderFrom(state.searchIndex || [], false);

  let index;
  try {
    index = await indexPromise;
  } catch (error) {
    throttledRender.cancel();
    if (token !== state.filterRenderToken || state.view !== 'starred') return;
    console.error('Failed to load starred feed:', error);
    showToast('Favorite feed is unavailable right now. Please try again.', 'error');
    // Keep any seeded cards on screen; only show the error when nothing painted.
    if (!(state.searchIndex && state.searchIndex.length)) {
      container.innerHTML = '';
      state.expandedComments.clear();
      if (searching) searching.style.display = 'none';
      empty.querySelector('p').textContent = 'Favorite feed is unavailable right now. Please try again.';
      empty.style.display = '';
    }
    return;
  }

  throttledRender.cancel(); // drop any pending partial render before the final one
  renderFrom(index, true);
}

/**
 * Renders the Bookmarks feed: every item the signed-in user has bookmarked,
 * newest first, honoring any active search filter. The stars pattern applied
 * to items: uses the full search index so bookmarks reach the whole catalog,
 * painting from the seeded/cached index instantly and reconciling as fresh
 * chunks land (same stale-while-revalidate flow as renderStarred).
 */
async function renderBookmarks() {
  const container = document.getElementById('feed-container');
  const sentinel = document.getElementById('load-more-container');
  const empty = document.getElementById('feed-empty');
  const searching = document.getElementById('feed-searching');
  if (!container) return;

  sentinel.style.display = 'none';

  if (!isSignedIn()) {
    container.innerHTML = '';
    state.expandedComments.clear();
    if (searching) searching.style.display = 'none';
    empty.querySelector('p').textContent = 'Sign in to see the videos and articles you bookmarked.';
    empty.style.display = '';
    return;
  }

  const token = ++state.filterRenderToken;
  let painted = false;

  const renderFrom = (index, final) => {
    if (token !== state.filterRenderToken || state.view !== 'bookmarks') return;
    let list = sortVideos((index || []).filter(v => state.myBookmarks.has(String(v.video_id))));
    if (isFilterActive()) list = filterVideos(list, activeFilter()).slice(0, CONFIG.SEARCH_RENDER_LIMIT);

    const prevNote = container.querySelector('.feed-truncation-note');
    if (prevNote) prevNote.remove();
    reconcileList(container, list);
    syncExpandedComments(new Set(list.map(v => String(v.video_id))));
    painted = true;

    empty.querySelector('p').textContent = state.myBookmarks.size === 0
      ? 'No bookmarks yet. Tap the bookmark on any video or article to save it for later.'
      : (isFilterActive()
        ? 'No videos match your search.'
        : 'Your bookmarked items are no longer available.');
    // Don't flash the empty state while the catalog is still streaming in — a
    // bookmarked item may simply not be in the partial index yet. The "no
    // bookmarks" copy is safe immediately (it doesn't depend on the index).
    const noItems = list.length === 0;
    const stillBuilding = !final && !state.searchIndexComplete;
    empty.style.display = (noItems && (final || state.myBookmarks.size === 0)) ? '' : 'none';
    if (searching) searching.style.display = (noItems && stillBuilding && state.myBookmarks.size > 0) ? '' : 'none';
    if (final) prefetchComments(list.slice(0, CONFIG.PAGE_SIZE));
  };

  const throttledRender = throttleToFrame((idx) => renderFrom(idx, false));

  const indexPromise = ensureSearchIndex(partial => throttledRender(partial));
  if (!painted) renderFrom(state.searchIndex || [], false);

  let index;
  try {
    index = await indexPromise;
  } catch (error) {
    throttledRender.cancel();
    if (token !== state.filterRenderToken || state.view !== 'bookmarks') return;
    console.error('Failed to load bookmarks feed:', error);
    showToast('Bookmarks are unavailable right now. Please try again.', 'error');
    if (!(state.searchIndex && state.searchIndex.length)) {
      container.innerHTML = '';
      state.expandedComments.clear();
      if (searching) searching.style.display = 'none';
      empty.querySelector('p').textContent = 'Bookmarks are unavailable right now. Please try again.';
      empty.style.display = '';
    }
    return;
  }

  throttledRender.cancel();
  renderFrom(index, true);
}

/**
 * Renders the Channels tab: every curated creator as a card (avatar, name, and
 * a favorite ☆), three across on desktop. Browsing here doesn't depend on being
 * signed in — starring does, which toggleStar enforces. Cards are sorted by
 * name so the grid is scannable and stable across reloads.
 */
async function renderChannels() {
  const container = document.getElementById('feed-container');
  const sentinel = document.getElementById('load-more-container');
  const empty = document.getElementById('feed-empty');
  if (!container) return;

  sentinel.style.display = 'none';

  // Clear the prior view's cards up front so they don't linger while the
  // creator list loads on a cold open (it's usually already warm from boot).
  if (!state.creators) {
    state.expandedComments.clear();
    container.innerHTML = '';
  }

  let creators;
  try {
    creators = await loadCreators();
  } catch (error) {
    console.error('Failed to load channels:', error);
    if (state.view !== 'channels') return;
    container.innerHTML = '';
    empty.querySelector('p').textContent = 'Channels are unavailable right now. Please try again.';
    empty.style.display = '';
    return;
  }

  // The user may have switched tabs while the list was loading.
  if (state.view !== 'channels') return;

  const sorted = [...creators].sort((a, b) =>
    String(a.channel_name).localeCompare(String(b.channel_name)));

  state.expandedComments.clear();
  container.innerHTML = '';
  for (const creator of sorted) {
    container.appendChild(buildChannelCard(creator));
  }

  empty.querySelector('p').textContent = 'No channels yet.';
  empty.style.display = sorted.length === 0 ? '' : 'none';
}

// Fixed content-type chips. '' is the exclusive "All" chip; the rest map to
// mediaType() values and are multi-selectable.
const TYPE_CHIPS = [
  { value: '', label: 'All' },
  { value: 'video', label: 'Videos' },
  { value: 'article', label: 'Articles' },
  { value: 'short', label: 'Shorts' },
];
const ALL_TYPE_VALUES = TYPE_CHIPS.filter(c => c.value).map(c => c.value);

// Fired after every chip change, once visibility is applied. app.js registers
// the Latest-feed top-up here (pull more pages when the filtered feed is
// shallow) — registered rather than imported so views.js stays a dependency
// of app.js, not the other way around.
let onTypeFilterChanged = null;
export function setOnTypeFilterChanged(cb) { onTypeFilterChanged = cb; }

function renderTypeChips(container) {
  if (!container) return;

  // Restore last session's selection over the state.js default. null means
  // nothing was ever saved, so the default (Videos + Articles) stands.
  const saved = loadFilterTypes();
  if (saved) state.filter.types = saved;

  container.innerHTML = TYPE_CHIPS.map(({ value, label }) =>
    `<button type="button" class="chip" data-type="${sanitizeHtml(value)}">${sanitizeHtml(label)}</button>`
  ).join('');

  container.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      toggleType(chip.dataset.type);
      // Persist the new selection so it survives across sessions ([] = "All").
      saveFilterTypes(state.filter.types);
      syncTypeChips(container);
      // Pure CSS visibility flip — no re-render, no search-index build.
      // Re-rendering here is what froze the app: a type-only filter matches
      // most of the catalog, and painting thousands of cards per click
      // (again per index chunk) locked the main thread.
      applyTypeVisibility();
      if (onTypeFilterChanged) onTypeFilterChanged();
    });
  });

  syncTypeChips(container);
  applyTypeVisibility();
}

/**
 * Reflects state.filter.types onto the feed container as one
 * feed--hide-<type> class per deselected type. Cards carry data-media-type,
 * so hiding is pure CSS — instant, and it composes with every view (Latest,
 * Top, Starred, search results) because they all render into this container
 * and the container element itself is never replaced.
 */
export function applyTypeVisibility() {
  const container = document.getElementById('feed-container');
  if (!container) return;
  const selected = new Set(state.filter.types);
  const showAll = selected.size === 0;
  for (const value of ALL_TYPE_VALUES) {
    container.classList.toggle(`feed--hide-${value}`, !showAll && !selected.has(value));
  }
}

/**
 * Applies the multi-select rules to state.filter.types:
 * - "All" (empty value) clears every type selection.
 * - Any type toggles on/off, and clears "All".
 * - Selecting every type (or clearing the last one) collapses back to "All".
 */
function toggleType(value) {
  if (!value) {
    state.filter.types = [];
    return;
  }
  const set = new Set(state.filter.types);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  // Everything selected is the same as nothing selected: "All".
  state.filter.types = ALL_TYPE_VALUES.every(v => set.has(v)) ? [] : [...set];
}

/** Reflects state.filter.types onto the chip active classes. */
function syncTypeChips(container) {
  const selected = new Set(state.filter.types);
  container.querySelectorAll('.chip').forEach(chip => {
    const value = chip.dataset.type;
    const active = value ? selected.has(value) : selected.size === 0;
    chip.classList.toggle('chip--active', active);
  });
}

// Channels-tab platform chips. Exclusive select — with only two platforms,
// multi-select collapses to "All" anyway. Values match channelPlatform()
// (feed.js) and the data-platform attribute on channel cards.
const PLATFORM_CHIPS = [
  { value: '', label: 'All' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'article', label: 'Articles' },
];
const ALL_PLATFORM_VALUES = PLATFORM_CHIPS.filter(c => c.value).map(c => c.value);

function renderPlatformChips(container) {
  if (!container) return;

  container.innerHTML = PLATFORM_CHIPS.map(({ value, label }) =>
    `<button type="button" class="chip" data-platform="${sanitizeHtml(value)}">${sanitizeHtml(label)}</button>`
  ).join('');

  container.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      state.channelsPlatform = chip.dataset.platform;
      syncPlatformChips(container);
      // Pure CSS visibility flip, same trick as the content-type chips —
      // cards carry data-platform, so no re-render is needed.
      applyPlatformVisibility();
    });
  });

  syncPlatformChips(container);
  applyPlatformVisibility();
}

/**
 * Reflects state.channelsPlatform onto the feed container as one
 * feed--hide-platform-<value> class per hidden platform. The CSS rules are
 * scoped to .feed--channels, so these classes are inert on every other view.
 */
function applyPlatformVisibility() {
  const container = document.getElementById('feed-container');
  if (!container) return;
  const selected = state.channelsPlatform;
  for (const value of ALL_PLATFORM_VALUES) {
    container.classList.toggle(`feed--hide-platform-${value}`, !!selected && selected !== value);
  }
}

/** Reflects state.channelsPlatform onto the platform chip active classes. */
function syncPlatformChips(container) {
  container.querySelectorAll('.chip').forEach(chip => {
    chip.classList.toggle('chip--active', chip.dataset.platform === state.channelsPlatform);
  });
}

/**
 * Renders the feed for the current filter state.
 * Active filter: matches from the full search index, no infinite scroll.
 * Cleared filter: restores the normal paginated feed from state.videos.
 */
async function applyFilter() {
  const container = document.getElementById('feed-container');
  const sentinel = document.getElementById('load-more-container');
  const empty = document.getElementById('feed-empty');
  const searching = document.getElementById('feed-searching');
  if (!container) return;

  const token = ++state.filterRenderToken;

  if (!isFilterActive()) {
    // Restore the normal infinite-scroll feed
    if (searching) searching.style.display = 'none';
    container.innerHTML = '';
    state.expandedComments.clear();
    renderList(container, state.videos);
    empty.querySelector('p').textContent = 'No videos yet. Check back soon!';
    empty.style.display = state.videos.length === 0 ? '' : 'none';
    sentinel.style.display = state.hasMore ? '' : 'none';
    return;
  }

  sentinel.style.display = 'none';

  // Paints the matches for the current index snapshot. `final` is held back
  // until the index is complete — a slow chunk that would add a match must
  // not flash "No videos match" or prefetch a soon-to-change result set.
  const renderMatches = (index, final) => {
    if (token !== state.filterRenderToken || state.view !== 'latest') return;
    const matches = filterVideos(index, activeFilter());
    // A broad query (a single letter matches almost everything) must not
    // paint the whole index — cap the render; results are ranked best-first.
    const shown = matches.slice(0, CONFIG.SEARCH_RENDER_LIMIT);
    // Diff by video_id instead of innerHTML='' (FE10): a card that survives
    // from the previous (partial) result keeps its expanded comment thread and
    // promoted/playing iframe across every incremental index chunk, instead of
    // being wiped and rebuilt ~15× per search session.
    const prevNote = container.querySelector('.feed-truncation-note');
    if (prevNote) prevNote.remove();
    reconcileList(container, shown);
    syncExpandedComments(new Set(shown.map(v => String(v.video_id))));
    if (matches.length > shown.length) {
      const note = document.createElement('p');
      note.className = 'feed-truncation-note';
      note.textContent = `Showing the top ${shown.length} of ${matches.length} matches — keep typing to narrow your search.`;
      container.appendChild(note);
    }
    // Distinguish "no matches yet, still building the index" from "done, and
    // nothing matches". Only the latter is a real empty state; the former gets
    // a "Searching…" indicator so the container never flashes blank while the
    // catalog is still streaming in behind the seed.
    const noMatches = matches.length === 0;
    const stillBuilding = !final && !state.searchIndexComplete;
    empty.querySelector('p').textContent = 'No videos match your search.';
    empty.style.display = (final && noMatches) ? '' : 'none';
    if (searching) searching.style.display = (noMatches && stillBuilding) ? '' : 'none';
    if (final) prefetchComments(shown.slice(0, CONFIG.PAGE_SIZE));
  };

  // Throttle the per-chunk progress renders to ~1/frame (FE10); the final
  // render below is authoritative and runs unthrottled.
  const throttledRender = throttleToFrame(renderMatches);

  let index;
  try {
    // Render each chunk as it lands; the promise resolves with the full index.
    index = await ensureSearchIndex(partial => throttledRender(partial, false));
  } catch (error) {
    throttledRender.cancel();
    if (token !== state.filterRenderToken || state.view !== 'latest') return;
    console.error('Failed to load search index:', error);
    showToast('Search is unavailable right now. Please try again.', 'error');
    return;
  }

  throttledRender.cancel(); // drop any pending partial render before the final one
  renderMatches(index, true);
}

// Internal seams exposed for unit tests (bounded fan-out / archive headroom /
// cached-index top-up / progress-render throttle).
export const __test__ = { buildSearchIndex, appendArchiveToIndex, topUpSearchIndex, runBounded, throttleToFrame };
