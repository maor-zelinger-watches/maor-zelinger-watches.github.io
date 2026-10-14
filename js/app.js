/**
 * app.js — Feed engine and application wiring for How You Watch.
 *
 * Owns the paginated Latest feed: initial load, infinite scroll,
 * stale-while-revalidate against the localStorage cache, and the
 * staggered card entrance. Everything else is delegated:
 *
 *   views.js       — tabs, search, category filters, Top/Starred views
 *   prefetch.js    — read-ahead page buffer + pagination cursor math
 *   cards.js       — card construction (shared by all views)
 *   comments-ui.js — inline comment threads and prefetching
 *   votes.js / stars.js / bookmarks.js — optimistic upvotes, starred
 *                    creators and bookmarks (the paint)
 *   action-queue.js — the serial, persisted queue those three send through
 *   fullscreen.js  — the fullscreen watch-and-discuss overlay
 *   state.js       — the shared mutable state all of the above read
 */

import { CONFIG } from './config.js';
import { storageEngine } from './flags.js';
import { state, isFilterActive, typeFilterActive, patchVideoEverywhere, epoch } from './state.js';
import { api } from './api-client.js';
import { isShort, mediaType, sortVideos, typeFilterVisible } from './feed.js';
import { loadFeedCache, saveFeedCache, saveFeedCacheSoon } from './cache.js';
import { initAuth, getCurrentUser, onAuthChange, signOut } from './auth.js';
import { setupAuthOverlay, openAuthOverlay, authOverlayOnAuthChange } from './auth-overlay.js';
import { sanitizeHtml, cssEscape, safeUrl } from './utils.js';
import { showToast } from './toast.js';
import { buildCard, insertCardChronologically, renderList, cardTimeMs, FIRST_PAINT_PRIORITY_CARDS } from './cards.js';
import { observeLazyIframe } from './lazy-iframe.js';
import {
  serverHasMore, cursorAfter,
  invalidatePrefetchBuffer, takeBufferedPage, refillPrefetchBuffer,
  fetchFeedPage,
  stashFeedReserve,
} from './prefetch.js';
import { prefetchComments, updateInlineCommentFormUI, setCommentsToggleCount } from './comments-ui.js';
import { clearVoteMarkings, setOnVotesChanged } from './votes.js';
import { loadStarsFromStorage, clearStarMarkings, setOnStarsChanged } from './stars.js';
import { loadBookmarksFromStorage, clearBookmarkMarkings, setOnBookmarksChanged } from './bookmarks.js';
import { loadMyVotesAndStars } from './bootstrap.js';
import { setupActionQueue, restoreActionQueue, clearActionQueue } from './action-queue.js';
import { setupFullscreenKeys } from './fullscreen.js';
import { handleDeepLink } from './share.js';
import { setupSinglePlay } from './single-play.js';
import { setupFeedback, feedbackOnAuthChange } from './feedback.js';
import { update, setupTabs, setupFeedControls, setOnTypeFilterChanged, loadMoreTop, resortTopRanking } from './views.js';

// The Starred view repaints when a star lands or the server reconciles —
// registered here (not in stars.js) so stars.js stays view-agnostic.
setOnStarsChanged(() => {
  if (state.view === 'starred') update();
});

// Same shape for the Bookmarks view: bookmarks.js stays view-agnostic.
setOnBookmarksChanged(() => {
  if (state.view === 'bookmarks') update();
});

// A confirmed vote changes the count the Top This Week ranking sorts by —
// re-rank the loaded list so the card moves without waiting for a refetch.
setOnVotesChanged(() => resortTopRanking());

// A content-type chip change may leave the filtered Latest feed too shallow —
// registered here (not in views.js) because pagination lives in this module.
setOnTypeFilterChanged(() => {
  // A chip change is explicit intent: clear any parked pagination on BOTH feeds
  // (see FILTER_ZERO_YIELD_MAX_PAGES) and re-reveal the sentinel for whichever
  // one is active, so the new selection can fill and scroll again (FE1 resume).
  state.filterZeroYieldStreak = 0;
  state.topFilterZeroYieldStreak = 0;
  const sentinel = document.getElementById('load-more-container');
  if (sentinel && !isFilterActive()) {
    if (state.view === 'latest' && state.hasMore) sentinel.style.display = '';
    else if (state.view === 'top' && state.topHasMore) sentinel.style.display = '';
  }
  topUpTypeFilter();
});

/**
 * Whether the Latest feed's sentinel-retrigger is parked: a content-type chip
 * is active AND the last FILTER_ZERO_YIELD_MAX_PAGES fetched pages each added
 * no visible card. Parking stops the rAF nudge from walking the whole catalog
 * behind an all-hidden filter (FE1). Cleared by setOnTypeFilterChanged (chip
 * change) or the infinite-scroll observer (a genuine scroll into view).
 */
function filterPaginationParked() {
  return typeFilterActive() &&
    state.filterZeroYieldStreak >= CONFIG.FILTER_ZERO_YIELD_MAX_PAGES;
}

// ============================================================
// INITIALIZATION
// ============================================================

// Installable-app plumbing (service worker, "Install app" link) loads after
// everything else: a dynamic import keeps js/pwa.js off the cold-load
// critical path and out of index.html's modulepreload wave (the preload
// test only follows static imports — by design, see tests/unit/pwa.test.js).
window.addEventListener('load', () => {
  import('./pwa.js')
    .then((m) => m.initPwa())
    .catch((err) => console.warn('[pwa] not initialized:', err && err.message));
});

document.addEventListener('DOMContentLoaded', async () => {
  console.info(`How You Watch frontend v${CONFIG.APP_VERSION}`);
  // Which cache storage this load runs on, and whether a flag chose it — the
  // first thing to check when a report involves stale or missing cached data.
  const storage = storageEngine();
  console.info(`storage engine: ${storage.engine} (${storage.source})`);
  const versionEl = document.getElementById('app-version');
  if (versionEl) versionEl.textContent = `v${CONFIG.APP_VERSION}`;

  // Google Identity Services signals readiness through window.onGoogleLibraryLoad
  // (its official load hook), so we wire that instead of polling for the global.
  // The GIS script is `async defer`, so it may evaluate before or after this
  // module: if google.accounts is already present, init straight away; otherwise
  // let the hook fire it. A single fallback timer surfaces a toast if the script
  // genuinely never loads (blocked, offline) rather than leaving #auth-container
  // empty and silent forever — the feed still works signed-out.
  let authInited = false;
  function startAuth() {
    if (authInited) return;
    authInited = true;
    initAuth(CONFIG.GOOGLE_CLIENT_ID);
    setupAuthUI();
  }
  if (typeof google !== 'undefined' && google.accounts) {
    startAuth();
  } else {
    window.onGoogleLibraryLoad = startAuth;
    setTimeout(() => {
      if (authInited) return;
      if (typeof google !== 'undefined' && google.accounts) {
        startAuth();
      } else {
        showToast('Sign-in is unavailable right now. Please refresh to try again.', 'error');
      }
    }, 10000);
  }

  setupInfiniteScroll();
  setupFeedControls();
  setupTabs();
  setupFullscreenKeys();
  setupSinglePlay();
  setupFeedback();
  setupActionQueue();
  loadStarsFromStorage();
  loadBookmarksFromStorage();

  const cached = await showCachedFeed();
  if (!cached) {
    loadNextPage();
  } else {
    // Stale-while-revalidate: show cache instantly, then fetch fresh data
    revalidateFeed();
  }

  // After the cache paint so a ?v= link to an already-cached video reuses its
  // card; NOT awaited so a shared-link lookup never delays feed startup.
  handleDeepLink();
});

// ============================================================
// FEED — Dynamic initial load, then pagination
// ============================================================

async function loadNextPage() {
  if (state.loading || state.revalidating || !state.hasMore || isFilterActive() || state.view !== 'latest') return;
  // A content-type chip is hiding every fetched page — pagination is parked
  // until the selection changes or the user scrolls with intent. Refuse here so
  // NO caller (the rAF nudge, the top-up loop, a revalidation nudge) can restart
  // the fetch storm while parked (FE1). Keep the sentinel hidden to match.
  if (filterPaginationParked()) {
    const parkedSentinel = document.getElementById('load-more-container');
    if (parkedSentinel) parkedSentinel.style.display = 'none';
    return;
  }
  state.loading = true;
  let loadFailed = false;

  const skeleton = document.getElementById('feed-skeleton');
  const empty = document.getElementById('feed-empty');
  const sentinel = document.getElementById('load-more-container');

  if (state.currentPage === 0 && !state.initialLoadComplete) {
    skeleton.style.display = '';
    empty.style.display = 'none';
  }

  sentinel.style.display = '';

  try {
    if (!state.initialLoadComplete) {
      // Calculate how many items fill the screen (N + 1)
      const cardHeight = window.innerWidth <= 540 ? 320 : 190;
      const N = Math.ceil(window.innerHeight / cardHeight);
      const initialLimit = Math.min(N + 1, CONFIG.PAGE_SIZE);

      // 1. Fetch N+1 items to show something immediately
      const data = await api.fetchFeed(1, initialLimit);
      const newVideos = data.videos || [];
      state.totalVideos = data.total || 0;
      state.nextCursor = data.next_cursor;
      state.videos = state.videos.concat(newVideos);

      skeleton.style.display = 'none';
      await appendCards(newVideos);
      state.initialLoadComplete = true;

      // Persist immediately from the first fetch — a refresh must paint from
      // cache even if the second (full-page) fetch below is slow or fails.
      // Apps Script cold-starts can hang that request; without this early
      // save the cache would never be written and refresh would fall back to
      // the network + skeleton. The second fetch upgrades this snapshot.
      state.currentPage = 1;
      state.hasMore = serverHasMore();
      saveFeedCache(state.videos, state.totalVideos);

      // 2. Fetch the remainder of the first page (up to PAGE_SIZE)
      if (initialLimit < CONFIG.PAGE_SIZE && state.videos.length < state.totalVideos) {
        const fullPageData = await api.fetchFeed(1, CONFIG.PAGE_SIZE);
        const fullVideos = fullPageData.videos || [];
        state.nextCursor = fullPageData.next_cursor;

        // Filter the WHOLE page-1 response against what we already hold — never
        // slice(initialLimit). The two fetches aren't index-aligned: dedupeVideos
        // can shrink the first (N+1) response, and an item prepended between the
        // fetches shifts everything down, so a positional slice would silently
        // drop a genuinely-new card at the boundary.
        const uniqueRemaining = fullVideos.filter(nv => !state.videos.some(sv => sv.video_id === nv.video_id));

        state.videos = state.videos.concat(uniqueRemaining);
        await appendCards(uniqueRemaining);
      }

      state.currentPage = 1;
      state.hasMore = serverHasMore();
      saveFeedCache(state.videos, state.totalVideos);

      // Prefetch comments for all loaded cards in the background
      prefetchComments(state.videos);

      // Start filling the read-ahead buffer so the first scroll is instant
      refillPrefetchBuffer();

      // Page 1 is the baseline for the zero-yield guard — never park on it.
      state.filterZeroYieldStreak = 0;

      if (state.videos.length === 0) {
        empty.style.display = '';
      }

    } else {
      // Normal infinite scroll for page 2 onwards. The read-ahead buffer
      // usually has this page already — render it with zero network wait.
      const nextPage = state.currentPage + 1;
      let batch = takeBufferedPage(nextPage);

      if (!batch) {
        // Outscrolled the prefetch — fall back to fetching on demand.
        // pendingFetchPage stops a concurrent refill response for this same
        // page from poisoning the buffer head (currentPage only advances
        // after this await); the token check discards OUR response if the
        // pagination was reset (feed revalidation) while we waited.
        const epoch = state.prefetchToken;
        state.pendingFetchPage = nextPage;
        try {
          const data = await fetchFeedPage(nextPage, state.nextCursor || '');
          if (epoch !== state.prefetchToken) return;
          batch = { videos: data.videos || [], nextCursor: data.next_cursor };
          state.totalVideos = data.total || 0;
        } finally {
          state.pendingFetchPage = 0;
        }
      }

      state.currentPage = nextPage;
      state.nextCursor = batch.nextCursor;
      const newVideos = batch.videos;

      // Filter out items already in state to handle pagination overlap (e.g., when new items were added since last fetch)
      const uniqueNewVideos = newVideos.filter(nv => !state.videos.some(sv => sv.video_id === nv.video_id));

      state.videos = state.videos.concat(uniqueNewVideos);
      // An empty page means we've walked past the real end of the catalog.
      // Without cursors the server total can overcount what forward
      // pagination can reach (items prepended mid-session shift pages;
      // the dedupe above drops the duplicates), so an unreachable total
      // must not keep hasMore true — that would spin the retrigger loop
      // on empty fetches forever.
      state.hasMore = newVideos.length > 0 && serverHasMore();

      await appendCards(uniqueNewVideos);

      // Track pages that add nothing the active type chip leaves visible. When
      // a chip filter hides every card the page adds zero height, so the rAF
      // retrigger below would fetch forever; a run of these parks it (FE1).
      if (typeFilterActive()) {
        const visibleAdded = uniqueNewVideos.reduce(
          (n, v) => n + (typeFilterVisible(v, state.filter.types) ? 1 : 0), 0);
        state.filterZeroYieldStreak = visibleAdded > 0 ? 0 : state.filterZeroYieldStreak + 1;
      } else {
        state.filterZeroYieldStreak = 0;
      }

      // Persist the grown feed so a refresh restores every page the user
      // scrolled through — not just page 1. showCachedFeed repaints the whole
      // cached list; revalidateFeed then reconciles only its front (see there).
      saveFeedCache(state.videos, state.totalVideos);

      // Prefetch comments for newly loaded cards
      prefetchComments(uniqueNewVideos);

      // Top the buffer back up to PREFETCH_PAGES_AHEAD
      refillPrefetchBuffer();
    }
  } catch (error) {
    loadFailed = true;
    console.error('Failed to load feed:', error);
    // Toast once per failure streak (not on every retry), and only when there's
    // nothing on screen — a mid-scroll page failure retries silently.
    if (state.videos.length === 0 && state.feedErrorStreak === 0) {
      showToast('Failed to load feed. Please try again.', 'error');
    }
    state.feedErrorStreak++;
  } finally {
    state.loading = false;
    skeleton.style.display = 'none';
    if (!loadFailed) state.feedErrorStreak = 0;

    if (state.videos.length === 0 && loadFailed) {
      // FE2: a cold-load failure with nothing on screen. state.hasMore is still
      // its default `true`, so the branches below would keep the sentinel
      // visible and spin a silent backoff-retry loop forever — a bare spinner,
      // no message, no way out. Instead, hide the sentinel and show an explicit
      // failure state with a Retry button (offline vs server error read
      // differently; offline also auto-retries when the connection returns).
      sentinel.style.display = 'none';
      showFeedLoadError();
    } else if (!state.hasMore || isFilterActive() || state.view !== 'latest') {
      sentinel.style.display = 'none';
    } else if (filterPaginationParked()) {
      // A content-type chip is hiding every fetched card, so the page added no
      // height and the sentinel never left view — the rAF nudge below would
      // recurse through the whole catalog. Park: hide the sentinel and stop
      // nudging until the chip selection changes or the user scrolls (FE1).
      sentinel.style.display = 'none';
    } else {
      sentinel.style.display = '';
      if (loadFailed) {
        // A failed load leaves the sentinel in view, so the immediate rAF
        // retrigger below would spin a tight fetch-fail loop (offline / 500s).
        // Back off exponentially instead, capped at 30s, and re-check we're
        // still on an unfiltered Latest feed with more to load before retrying.
        const delay = Math.min(30000, 1000 * Math.pow(2, state.feedErrorStreak - 1));
        setTimeout(() => {
          if (!state.loading && state.hasMore && !isFilterActive() && state.view === 'latest') {
            loadNextPage();
          }
        }, delay);
      } else {
        // If the sentinel is still within the root margin after loading,
        // trigger the next load manually. The IntersectionObserver won't re-fire
        // if it never exited the threshold while state.loading was true.
        requestAnimationFrame(() => {
          const rect = sentinel.getBoundingClientRect();
          if (rect.top > 0 && rect.top <= window.innerHeight + 600) {
            loadNextPage();
          }
        });
      }
    }
  }
}

// The neutral "no videos yet" markup #feed-empty ships with, captured before
// showFeedLoadError overwrites it — so a later empty-but-successful load can
// restore it instead of stranding a stale error message + Retry button.
let _defaultEmptyHtml = null;

/**
 * FE2 — Cold-load failure UI. A first-visit feed fetch failed with nothing to
 * show, so replace the empty state with a message and a Retry button rather
 * than leaving the sentinel spinning a silent backoff loop. Offline (the
 * connection is the fault) and server errors read differently; while offline we
 * also retry the instant connectivity returns, via a one-shot `online`
 * listener that is cleared if the user clicks Retry first.
 */
function showFeedLoadError() {
  const empty = document.getElementById('feed-empty');
  if (!empty) return;
  if (_defaultEmptyHtml === null) _defaultEmptyHtml = empty.innerHTML;

  const offline = navigator.onLine === false;
  const message = offline
    ? "You're offline — check your connection."
    : "Couldn't load the feed.";

  empty.innerHTML = `
    <p class="feed__empty-message">${message}</p>
    <button type="button" class="btn btn--primary feed__retry-btn" id="feed-retry-btn">Retry</button>
  `;
  empty.style.display = '';

  const retry = () => {
    window.removeEventListener('online', retry);
    // Return #feed-empty to its neutral markup and hide it before re-fetching:
    // a fresh failure repaints cleanly, an empty-but-successful load shows the
    // default message, and a success shows cards.
    empty.innerHTML = _defaultEmptyHtml;
    empty.style.display = 'none';
    loadNextPage();
  };

  const retryBtn = document.getElementById('feed-retry-btn');
  if (retryBtn) retryBtn.addEventListener('click', retry);

  if (offline) window.addEventListener('online', retry, { once: true });
}

/**
 * Append video cards one at a time with staggered timing.
 * The whole batch is inserted synchronously in ONE pass — space is
 * allocated in a single layout, so the page never keeps shifting under
 * the user's cursor while cards trickle in (staggered DOM insertion made
 * every interaction land on a moving page for ~1s per batch, and racked
 * up layout-shift for free). The familiar reveal is preserved purely on
 * the compositor: each card starts invisible and fades/slides in on a
 * per-card CSS animation-delay — long-form first (60ms apart), Shorts
 * after (150ms + 80ms apart), same schedule as before. Shorts still land
 * at their chronological position among the batch.
 *
 * This entrance animation is for NETWORK ARRIVALS on the Latest feed only.
 * Re-renders of already-loaded data must use renderList — replaying the
 * animation on every tab switch reads as flicker.
 */
/**
 * Drop a card's entrance classes once the arrival animation has settled.
 * The classes exist only to play the one-time entrance; if they linger, any
 * later rule that overrides `animation` and is then removed (fullscreen's
 * fullscreenIn) re-applies the entrance as a brand-new animation — the card
 * flashes back to opacity 0, and the fullscreen exit re-anchor measures the
 * anchor mid-replay, offset by the from-state's translateY.
 * animationcancel covers an entrance pre-empted before finishing (e.g. the
 * card expanded to fullscreen mid-stagger) — the replay hazard is the same.
 */
function clearEntranceWhenSettled(card) {
  const clear = (e) => {
    if (e.target !== card) return; // animation events bubble up from children
    card.classList.remove('media-card--enter', 'media-card--enter-short');
    card.style.removeProperty('--enter-delay');
    card.removeEventListener('animationend', clear);
    card.removeEventListener('animationcancel', clear);
  };
  card.addEventListener('animationend', clear);
  card.addEventListener('animationcancel', clear);
}

async function appendCards(videos) {
  // Paginated cards belong only to the unfiltered Latest feed — a filter
  // render or another view owns the container otherwise.
  if (videos.length === 0 || isFilterActive() || state.view !== 'latest') return;

  const feedContainer = document.getElementById('feed-container');

  // Deduplicate: skip items already rendered in the DOM
  const deduped = videos.filter(video => {
    const id = video.video_id;
    return id && !feedContainer.querySelector(`[data-video-id="${cssEscape(id)}"]`);
  });
  if (deduped.length === 0) return;

  const mains = deduped.filter(v => !isShort(v));
  const shorts = deduped.filter(isShort);
  const inserted = [];

  // The first network paint into an empty feed: its first cards are the first
  // screen, so their preview images load eagerly at high priority (the LCP
  // candidate). Later pages, and appends to a populated feed, stay lazy.
  const priorityUntil = feedContainer.childElementCount === 0 ? FIRST_PAINT_PRIORITY_CARDS : 0;

  // Long-form cards append in batch order (pages arrive chronological).
  const frag = document.createDocumentFragment();
  mains.forEach((video, i) => {
    const card = buildCard(video, { priority: i < priorityUntil });
    card.classList.add('media-card--enter');
    card.style.setProperty('--enter-delay', `${i * 60}ms`);
    frag.appendChild(card);
    inserted.push(card);
  });
  feedContainer.appendChild(frag);

  // Shorts go to their chronological spot, in the same synchronous task —
  // the browser computes layout once for the whole batch.
  shorts.forEach((video, i) => {
    const card = buildCard(video);
    card.classList.add('media-card--enter-short');
    card.style.setProperty('--enter-delay', `${150 + i * 80}ms`);
    insertCardChronologically(feedContainer, card);
    inserted.push(card);
  });

  for (const card of inserted) {
    clearEntranceWhenSettled(card);
    observeLazyIframe(card);
  }
}

/**
 * Show cached feed instantly on page load (stale-while-revalidate).
 * Called before loadNextPage so the user sees content immediately.
 */
async function showCachedFeed() {
  // Validation and corruption handling live in cache.js — an invalid
  // payload comes back as null and has already been cleared. The read is
  // async (Cache Storage / IndexedDB); nothing paints or paginates the feed
  // until boot's await on this resolves, so there's no race to guard here.
  const cached = await loadFeedCache();
  if (!cached) return false;

  state.videos = cached.videos;
  state.totalVideos = cached.total;
  // The cache can hold several pages (it's rewritten as the user scrolls
  // and votes) — derive the page cursor from its size so the read-ahead
  // buffer prefetches genuinely new pages, not duplicates of what's shown.
  state.currentPage = Math.max(1, Math.ceil(cached.videos.length / CONFIG.PAGE_SIZE));
  state.nextCursor = cursorAfter(cached.videos);
  state.hasMore = state.videos.length < state.totalVideos;
  state.initialLoadComplete = true;

  // Cache restore is a re-render of already-loaded data, not a network arrival:
  // render via renderList (the non-animated path) so the WHOLE cached feed —
  // every scrolled page — paints at once. appendCards' per-card entrance stagger
  // is for live page loads; replaying it here would delay the last cards of a
  // multi-page cache by seconds (--enter-delay grows ~60ms per card).
  const feedContainer = document.getElementById('feed-container');
  renderList(feedContainer, cached.videos);

  // Reveal the sentinel only AFTER the cached cards are in. While the
  // container is still empty the sentinel sits at the top of the viewport,
  // and the observer's first snapshot would fire loadNextPage with zero
  // user intent — auto-fetching pages past a cache nobody scrolled yet.
  if (state.hasMore) {
    const sentinel = document.getElementById('load-more-container');
    if (sentinel) sentinel.style.display = '';
  }
  return true;
}

/**
 * Full stale-while-revalidate with smooth DOM diffing.
 *
 * 1. Fetch fresh page 1 from API
 * 2. Fade out cards no longer in the feed
 * 3. Slide in new cards at the correct position
 * 4. Update comment counts on existing cards (no re-render)
 * 5. Reorder if necessary
 */
async function revalidateFeed() {
  // Stale-while-revalidate must never make the cached feed feel frozen.
  // While THIS background page-1 fetch is in flight the user can keep
  // scrolling and paginating — loadNextPage runs freely, no coarse block.
  // The revalidation guard is claimed only when we commit to the DOM diff
  // (further down), so pagination pauses for the reconciliation, not for the
  // network wait. Two races are handled without blocking:
  //   - A loadNextPage fetch in flight captures the prefetch token; when the
  //     diff resets pagination it bumps that token, so the stale response is
  //     discarded instead of clobbering the fresh feed.
  //   - If pagination advanced during this fetch, the identical-content fast
  //     path keeps the cursor loadNextPage set (startCurrentPage guard below).
  const startCurrentPage = state.currentPage;
  try {
    const data = await api.fetchFeed(1, CONFIG.PAGE_SIZE);
    const freshVideos = data.videos || [];
    if (freshVideos.length === 0) return;

    // The fresh fetch only covers page 1. When the user has scrolled past it,
    // the loaded feed carries a tail (pages 2+) this fetch knows nothing about
    // — so "in the cache but absent from fresh page 1" must NOT be read as
    // "deleted": the item was almost always just pushed down by newer ones.
    const hasTail = state.videos.length > CONFIG.PAGE_SIZE;

    // Quick check: has the FRONT of the feed changed? Compare fresh page 1
    // against the first N cached items (the whole list when single-page).
    const frontIds = state.videos.slice(0, freshVideos.length).map(v => v.video_id).join(',');
    const freshIds = freshVideos.map(v => v.video_id).join(',');
    const countsChanged = freshVideos.some(fv => {
      const cached = state.videos.find(v => v.video_id === fv.video_id);
      return cached && cached.comment_count !== fv.comment_count;
    });

    if (frontIds === freshIds) {
      // Front ORDER is unchanged — at most comment/vote counts drifted. Patch
      // those in place and return WITHOUT the reorder/re-append pass further
      // down: that pass detaches every card and reloads its promoted iframe
      // (stopping inline playback) for a change that moved nothing — the common
      // "someone commented overnight" case.
      if (countsChanged) {
        // Every list holding a copy of the row, not just state.videos (FE13);
        // the feed cache persists once via the coalesced write inside.
        for (const fv of freshVideos) {
          patchVideoEverywhere(fv.video_id, {
            comment_count: fv.comment_count,
            vote_count: fv.vote_count,
          });
        }
        // Touch the DOM only when the Latest feed actually owns the container.
        if (state.view === 'latest' && !isFilterActive()) {
          const container = document.getElementById('feed-container');
          if (container) {
            for (const fv of freshVideos) {
              const toggle = container.querySelector(`.media-card__comments-toggle[data-video-id="${cssEscape(fv.video_id)}"]`);
              setCommentsToggleCount(toggle, fv.comment_count || 0);
            }
          }
        }
        // Drop prefetched comments only where the count actually changed.
        for (const fv of freshVideos) {
          const cached = state.commentsCache[fv.video_id];
          if (cached && cached.comments.length !== (fv.comment_count || 0)) {
            delete state.commentsCache[fv.video_id];
          }
        }
      }
      // Adopt the server's page-1 cursor only when single-page (with a tail the
      // live cursor already points past it; page 1's would rewind it), and only
      // if a concurrent loadNextPage hasn't advanced past page 1.
      if (!hasTail && state.currentPage === startCurrentPage) state.nextCursor = data.next_cursor;
      prefetchComments(state.videos);
      refillPrefetchBuffer();
      return;
    }

    // State-only reconcile: adopt fresh page 1 as the new feed and re-paginate,
    // touching no DOM. Used whenever the Latest feed does NOT own the container
    // — a search query is active, OR the user is on a different tab. When they
    // return to Latest it re-renders from this state.
    const adoptFreshAsState = () => {
      // The replaced list becomes the reserve: pagination serves those cards
      // again, without the network, once it reaches where they start.
      stashFeedReserve(state.videos, freshVideos);
      state.videos = freshVideos;
      state.totalVideos = data.total || freshVideos.length;
      state.currentPage = 1;
      state.nextCursor = data.next_cursor;
      state.hasMore = serverHasMore();
      saveFeedCache(freshVideos, state.totalVideos);
      // Page 1 was replaced — pages buffered against the old pagination no
      // longer line up.
      invalidatePrefetchBuffer();
      refillPrefetchBuffer();
    };

    // The DOM diff below writes into #feed-container. If a search/filter is
    // active, or the user switched to Top/Starred/Channels while this fetch was
    // in flight, that container is NOT the Latest feed — diffing into it would
    // inject Latest cards into the wrong view (and re-sort a vote-ranked list by
    // date). Reconcile state only.
    if (isFilterActive() || state.view !== 'latest') {
      adoptFreshAsState();
      return;
    }

    const container = document.getElementById('feed-container');
    if (!container) return;

    // The diff owns the container from here — pause pagination for the
    // reconciliation. Claimed before the first diff await (the removal
    // animations); everything up to that await is synchronous, so no
    // loadNextPage can slip in and advance underneath the reset.
    state.revalidating = true;

    // Invalidate the buffer eagerly — the old pagination died the moment we
    // decided fresh page 1 differs.
    invalidatePrefetchBuffer();

    const freshIdSet = new Set(freshVideos.map(v => v.video_id));
    // From the DOM, not state, so the diff reconciles what's actually on
    // screen — state.videos may already disagree with the container.
    const existingIdSet = new Set(
      [...container.querySelectorAll('.media-card')].map(c => c.dataset.videoId)
    );

    // The tail-preserving merge below rests on "missing from fresh page 1 ==
    // pushed down, not deleted". That only holds when fresh page 1 still
    // overlaps the cached front — a few items prepended, the rest shifted
    // down. When the cached front shares ZERO ids with fresh page 1 the whole
    // visible window is wholesale-stale, so nothing was "pushed down": keeping
    // those cards strands them interleaved with the fresh ones (prefetch_races
    // bug 4). Fall back to a full replace + re-paginate — but keep the replaced
    // cards as the feed reserve (prefetch.js), so the tail is served from
    // memory once pagination reaches it instead of re-fetched page by page.
    const frontOverlap = state.videos
      .slice(0, freshVideos.length)
      .some(v => freshIdSet.has(v.video_id));
    const fullReplace = !hasTail || !frontOverlap;

    // --- 1. Animate out cards no longer in the fresh feed ---
    // Skipped only for an incremental change with a tail loaded: there an item
    // missing from fresh page 1 was pushed down to a page we didn't refetch,
    // not deleted — removing it would wipe the scrolled feed. A full replace
    // (single page, or a wholesale-stale front) animates the stale cards out.
    if (fullReplace) {
      const removedCards = container.querySelectorAll('.media-card');
      const removePromises = [];

      removedCards.forEach(card => {
        const id = card.dataset.videoId;
        // Never remove the card the user is watching in fullscreen
        if (id === state.fullscreenVideoId) return;
        if (id && !freshIdSet.has(id)) {
          card.classList.add('media-card--leaving');
          removePromises.push(new Promise(resolve => {
            card.addEventListener('transitionend', () => {
              card.remove();
              resolve();
            }, { once: true });
            // Safety timeout in case transitionend doesn't fire
            setTimeout(() => { card.remove(); resolve(); }, 400);
          }));
        }
      });

      // Wait for fade-out animations to complete
      if (removePromises.length > 0) {
        await Promise.all(removePromises);
      }
    }

    // A tab switch or search query landed during the fade-out await — the
    // container is no longer the Latest feed. Abandon the DOM diff and fall
    // back to a state-only reconcile (finally still releases `revalidating`).
    if (state.view !== 'latest' || isFilterActive()) {
      adoptFreshAsState();
      return;
    }

    // --- 2. Update comment counts on surviving cards ---
    for (const video of freshVideos) {
      if (existingIdSet.has(video.video_id)) {
        const toggle = document.querySelector(`.media-card__comments-toggle[data-video-id="${cssEscape(video.video_id)}"]`);
        setCommentsToggleCount(toggle, video.comment_count || 0);
      }
    }

    // --- 3. Insert new cards at the correct position ---
    const newVideos = freshVideos.filter(v => !existingIdSet.has(v.video_id));

    for (const video of newVideos) {
      // Find where this card should go based on the fresh order
      const freshIndex = freshVideos.indexOf(video);
      const existingCards = container.querySelectorAll('.media-card');

      const card = buildCard(video);
      card.classList.add('media-card--entering');

      // Insert at the correct position
      if (freshIndex >= existingCards.length) {
        container.appendChild(card);
      } else {
        container.insertBefore(card, existingCards[freshIndex]);
      }
      observeLazyIframe(card);

      // Trigger enter animation
      requestAnimationFrame(() => {
        card.classList.remove('media-card--entering');
      });
    }

    // --- 4. Reorder to fresh chronological order, moving ONLY cards that are
    // actually out of place. Re-appending a card that's already positioned
    // still detaches+reattaches it, reloading its promoted iframe (and stopping
    // inline playback) — so walk the desired order and insertBefore only on a
    // mismatch. After step 3's positional inserts the order usually already
    // matches, so the common path performs zero moves. The fullscreen card is
    // left untouched: it's position:fixed and playing; moving it would reload.
    const sortedCards = [...container.querySelectorAll('.media-card')]
      .filter(c => c.dataset.videoId !== state.fullscreenVideoId)
      .sort((a, b) => cardTimeMs(b) - cardTimeMs(a));
    let prevCard = null;
    for (const card of sortedCards) {
      const desired = prevCard ? prevCard.nextElementSibling : container.firstElementChild;
      if (card !== desired) {
        if (prevCard) prevCard.after(card);
        else container.insertBefore(card, container.firstElementChild);
      }
      prevCard = card;
    }

    // --- 5. Update state and cache ---
    if (!fullReplace) {
      // Non-destructive merge (the "only add what's missing" reconcile): pull
      // fresh counts onto every held copy of the items (FE13), splice in any
      // genuinely-new top items, and keep the whole scrolled tail. Pagination
      // keeps its live cursor — it already points past the tail, which fresh
      // page 1 never touched.
      for (const fv of freshVideos) {
        patchVideoEverywhere(fv.video_id, {
          comment_count: fv.comment_count,
          vote_count: fv.vote_count,
        });
      }
      const newTop = freshVideos.filter(fv => !state.videos.some(v => v.video_id === fv.video_id));
      state.videos = sortVideos([...newTop, ...state.videos]);
      state.totalVideos = data.total || state.totalVideos;
      state.currentPage = Math.max(1, Math.ceil(state.videos.length / CONFIG.PAGE_SIZE));
      state.nextCursor = cursorAfter(state.videos);
      state.hasMore = state.videos.length < state.totalVideos;
      // The merge REPLACED the array the patches above queued for their
      // coalesced save — queue the final list so the one deferred write
      // persists the merged feed, not the pre-merge snapshot.
      saveFeedCacheSoon(state.videos, state.totalVideos);
    } else {
      // Full replace — the cards just animated out are NOT thrown away: they
      // become the feed reserve, served back as pages (zero network) once
      // pagination reaches the range they cover. Without this a visitor
      // returning after ~6h (enough new items to push the whole cached front
      // off page 1) re-fetched every card they already had, one cursor page
      // at a time, which read as "the feed doesn't load until I reach the
      // articles I had before".
      stashFeedReserve(state.videos, freshVideos);
      state.videos = freshVideos;
      state.totalVideos = data.total || freshVideos.length;
      state.currentPage = 1;
      state.nextCursor = data.next_cursor;
      state.hasMore = serverHasMore();
      saveFeedCache(state.videos, state.totalVideos);
    }
    // Drop prefetched comments only where the server reports a different
    // count — wiping the whole cache defeated the prefetch entirely.
    for (const fv of freshVideos) {
      const cachedComments = state.commentsCache[fv.video_id];
      if (cachedComments && cachedComments.comments.length !== (fv.comment_count || 0)) {
        delete state.commentsCache[fv.video_id];
      }
    }
    // Invalidate again: a refill restarted during the diff would have
    // buffered pages against the pre-reset currentPage.
    invalidatePrefetchBuffer();

    const sentinel = document.getElementById('load-more-container');
    if (sentinel) sentinel.style.display = state.hasMore ? '' : 'none';

    // Prefetch comments for all cards
    prefetchComments(freshVideos);

    refillPrefetchBuffer();
  } catch (e) {
    // Silent fail — stale cache is still visible
    prefetchComments(state.videos);
    // The cached pagination is still what's on screen — buffer from it
    refillPrefetchBuffer();
  } finally {
    // Release pagination on every path — including the early returns above,
    // which claimed the flag at entry but return before reaching here.
    state.revalidating = false;
    // The observer only fires on intersection CHANGES. If the sentinel sat
    // inside its margin the whole time pagination was paused (scrolled to
    // the bottom during the diff, or the diff shrank the feed under the
    // viewport), nothing would ever re-trigger it — nudge it here.
    requestAnimationFrame(() => {
      if (!state.hasMore || state.view !== 'latest' || isFilterActive()) return;
      const sentinel = document.getElementById('load-more-container');
      if (!sentinel || sentinel.style.display === 'none') return;
      const rect = sentinel.getBoundingClientRect();
      if (rect.top > 0 && rect.top <= window.innerHeight + 600) {
        loadNextPage();
      }
    });
  }
}

// ============================================================
// INFINITE SCROLL
// ============================================================

function setupInfiniteScroll() {
  const sentinel = document.getElementById('load-more-container');

  const scrollObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      // A genuine scroll bringing the sentinel into view is user intent — clear
      // the zero-yield park so a sparse type filter can pull a fresh bounded
      // burst instead of staying stuck (FE1 resume path). The rAF self-nudge
      // does NOT come through here, so only real scrolls reset the streak.
      // Route to the active feed's loader. Each self-guards (loading / hasMore /
      // view / filter), so a stray fire on the wrong tab is a harmless no-op.
      if (state.view === 'top') {
        state.topFilterZeroYieldStreak = 0;
        loadMoreTop();
      } else if (!state.loading && state.hasMore) {
        state.filterZeroYieldStreak = 0;
        loadNextPage();
      }
    });
  }, { rootMargin: '600px' });

  scrollObserver.observe(sentinel);
}

// ============================================================
// CONTENT-TYPE FILTER TOP-UP
// The chips only hide cards (CSS), so a filtered feed can look
// nearly empty even though the catalog has plenty more of that
// type. After each chip change, keep pulling pages until at
// least TYPE_FILTER_MIN_CARDS matching items are loaded —
// bounded per interaction by TYPE_FILTER_TOP_UP_MAX_PAGES so a
// sparse type can't trigger a request storm. Infinite scroll
// stays live under the filter and continues from wherever the
// top-up stopped.
// ============================================================

/** How many already-loaded items the current type selection keeps visible. */
function selectedTypeCount() {
  const selected = new Set(state.filter.types);
  return state.videos.reduce((n, v) => n + (selected.has(mediaType(v)) ? 1 : 0), 0);
}

async function topUpTypeFilter() {
  // Claiming the epoch retires any in-flight loop — a newer chip click
  // supersedes it (FE14).
  const e = epoch.claim('typeFilterTopUp');
  let pulled = 0;
  while (
    e.current() &&
    state.view === 'latest' &&
    !isFilterActive() &&                // a query owns rendering — no top-up
    state.filter.types.length > 0 &&    // "All" needs no help
    state.hasMore &&
    pulled < CONFIG.TYPE_FILTER_TOP_UP_MAX_PAGES &&
    selectedTypeCount() < CONFIG.TYPE_FILTER_MIN_CARDS
  ) {
    const before = state.videos.length;
    await loadNextPage();
    if (state.videos.length === before) break; // stalled (mid-load / revalidating / error)
    pulled++;
  }
}

// ============================================================
// AUTH UI
// ============================================================

function setupAuthUI() {
  const container = document.getElementById('auth-container');
  setupAuthOverlay();

  onAuthChange((user) => {
    updateAuthUI(user);
    authOverlayOnAuthChange(user);
    feedbackOnAuthChange(user);
    state.expandedComments.forEach(videoId => updateInlineCommentFormUI(videoId));
    if (user) {
      // Replay actions a previous page load left queued BEFORE the bootstrap
      // snapshot is requested, so the reconcilers lay them over it.
      restoreActionQueue();
      loadMyVotesAndStars();
    } else {
      // An intent queued under this account must never be sent under the next.
      clearActionQueue();
      clearVoteMarkings();
      clearStarMarkings();
      clearBookmarkMarkings();
      if (state.view === 'starred' || state.view === 'bookmarks') update();
    }
  });

  // initAuth restores a saved session and broadcasts it via notifyListeners
  // BEFORE this runs — so that first broadcast reaches no listener. Mirror the
  // onAuthChange handler's reconciliation here so any comments already expanded
  // by then (the deep-linked ?v= card auto-expands its own during load) flip to
  // the signed-in form instead of being stuck on the sign-in prompt.
  const user = getCurrentUser();
  if (user) {
    updateAuthUI(user);
    feedbackOnAuthChange(user);
    restoreActionQueue();
    loadMyVotesAndStars();
    state.expandedComments.forEach(videoId => updateInlineCommentFormUI(videoId));
  } else {
    updateAuthUI(null);
  }
}

// Identity currently painted into the header, so a token-only change (e.g. a
// silent session renewal that re-fires onAuthChange) can't needlessly repaint
// the avatar and name. Null until the first render.
let _authUiKey = null;

function updateAuthUI(user) {
  const container = document.getElementById('auth-container');

  const key = user ? `${user.email}|${user.name}|${user.picture}` : '';
  if (key === _authUiKey) return; // identity unchanged — nothing to repaint
  _authUiKey = key;

  if (user) {
    // Avatar + name double as the door to Email preferences (the consent
    // change/unsubscribe path) in the auth overlay.
    container.innerHTML = `
      <div class="header__user">
        <button class="header__user-info" id="email-prefs-btn" title="Email preferences" aria-label="Email preferences">
          <img src="${sanitizeHtml(safeUrl(user.picture))}" alt="" class="header__user-avatar" referrerpolicy="no-referrer" />
          <span class="header__user-name">${sanitizeHtml(user.name)}</span>
        </button>
        <button class="header__signout-btn" id="signout-btn">Sign out</button>
      </div>
    `;
    document.getElementById('email-prefs-btn').addEventListener('click', () => openAuthOverlay('prefs'));
    document.getElementById('signout-btn').addEventListener('click', () => signOut());
  } else {
    // Our own pill opens the sign-in overlay; the official Google button
    // renders inside the overlay (auth-overlay.js), not in the header.
    container.innerHTML = '<button class="header__signin-btn" id="signin-btn">Sign in</button>';
    document.getElementById('signin-btn').addEventListener('click', () => openAuthOverlay('signin'));
  }
}

// ============================================================
// TEST-ONLY EXPORTS
// Consumed by tests/unit/revalidate_race.test.js to drive the internal feed
// state machine directly. In the browser, app.js is loaded as a plain
// <script type="module"> and nothing imports this binding, so it is inert.
// ============================================================
export const __test__ = { state, revalidateFeed, loadNextPage };
