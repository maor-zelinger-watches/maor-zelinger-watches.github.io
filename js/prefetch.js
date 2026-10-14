/**
 * prefetch.js — Read-ahead buffer and pagination-cursor math.
 *
 * Keeps PREFETCH_PAGES_AHEAD pages fetched beyond the rendered feed so
 * infinite scroll renders from memory. Entries are contiguous, starting
 * at currentPage+1; a pagination reset (feed revalidation) invalidates
 * both the buffer and any refill fetch still in flight via
 * state.prefetchToken.
 *
 * The cursor helpers also serve the feed engine directly: serverHasMore
 * and cursorAfter are how loadNextPage / showCachedFeed decide whether
 * and where pagination continues.
 */

import { state, isFilterActive } from './state.js';
import { api } from './api-client.js';
import { CONFIG } from './config.js';
import { sortVideos } from './feed.js';

/** Total videos sitting in the buffer, for end-of-catalog math. */
export function bufferedVideoCount() {
  return state.prefetchBuffer.reduce((n, entry) => n + entry.videos.length, 0);
}

/** Whether the server still has pages we haven't fetched (rendered or buffered). */
function hasUnfetchedPages() {
  return state.videos.length + bufferedVideoCount() < state.totalVideos;
}

/**
 * Whether more pages exist beyond what's rendered. Prefers the server's
 * cursor (exact — prepended items can't skew it); backends without
 * cursor support fall back to the count math.
 */
export function serverHasMore() {
  if (typeof state.nextCursor === 'string') return state.nextCursor !== '';
  return state.videos.length < state.totalVideos;
}

/**
 * Derives the pagination cursor that resumes after the last item of
 * `videos` (same format the backend emits: "<ISO time>|<video_id>").
 * Used when restoring a cached feed, where no server cursor was kept.
 * Returns undefined when it can't be derived — page-offset fallback.
 */
export function cursorAfter(videos) {
  if (!videos || videos.length === 0) return undefined;
  const last = videos[videos.length - 1];
  if (!last || !last.video_id) return undefined;
  const t = new Date(last.published_at).getTime();
  return `${new Date(Number.isFinite(t) ? t : 0).toISOString()}|${last.video_id}`;
}

/** The cursor the refill loop should continue from (after the last
 *  buffered page, or after the rendered feed when the buffer is empty).
 *  undefined = backend without cursor support — use page numbers. */
function nextCursorToFetch() {
  const last = state.prefetchBuffer[state.prefetchBuffer.length - 1];
  return last ? last.nextCursor : state.nextCursor;
}

/** Whether the refill loop has anything left to prefetch. */
function hasMoreToPrefetch() {
  const cursor = nextCursorToFetch();
  if (typeof cursor === 'string') return cursor !== '';
  return hasUnfetchedPages();
}

/** The next page the refill loop should fetch: after the last buffered page.
 *  Counts a page being direct-fetched by loadNextPage as taken, so a refill
 *  response for it is discarded instead of poisoning the buffer head. */
function nextPageToFetch() {
  const last = state.prefetchBuffer[state.prefetchBuffer.length - 1];
  return (last ? last.page : Math.max(state.currentPage, state.pendingFetchPage)) + 1;
}

// ============================================================
// Feed reserve — cached cards the revalidate replaced, kept as pages
// ============================================================
//
// On return after a few hours, fresh page 1 often shares nothing with the
// cached front (the feed gains ~10 items per 6h), so revalidateFeed replaces
// the whole cached list with fresh page 1 and re-paginates from the server.
// Before this, the cards the visitor already had were simply thrown away and
// re-fetched one cursor page at a time — "it doesn't load until I get to the
// articles I already had". Now they are kept here, in feed order, and served
// as pages the moment pagination reaches the range they cover.
//
// Correctness rests on one fact: the cached list was a CONTIGUOUS slice of the
// server's feed, starting at its newest item (the `anchor`). Server pages are
// contiguous from the cursor too. So once a server page ends at or past the
// anchor, the server's continuation after that page IS the reserve's remaining
// items (minus anything deleted since) — no gap is possible, and the reserve
// can answer every following page without the network. Until a page reaches
// the anchor there may be newer items we have never seen, so pages keep coming
// from the server; each one trims the reserve (items the page contained, or
// that now sit before the cursor and were therefore deleted) and never serves.
//
// The reserve is session-only, positional (keyed by cursor, so pagination
// resets don't confuse it) and ignored in page-offset mode (a backend without
// cursors), where positions are meaningless.

/** Feed position of a cursor string ("<ISO time>|<video_id>"). */
function cursorParts(cursor) {
  const sep = cursor.indexOf('|');
  const t = new Date(sep === -1 ? cursor : cursor.slice(0, sep)).getTime();
  return { t: Number.isFinite(t) ? t : 0, id: sep === -1 ? '' : cursor.slice(sep + 1) };
}

/** Feed position of a video (same tiebreak the backend's cursor uses). */
function itemParts(v) {
  const t = new Date(v.published_at).getTime();
  return { t: Number.isFinite(t) ? t : 0, id: String(v.video_id || '') };
}

/** True when position `a` comes strictly AFTER `b` in feed order (older). */
function isAfter(a, b) {
  return a.t < b.t || (a.t === b.t && a.id < b.id);
}

/**
 * Keeps the cached list `cachedVideos` — minus whatever fresh page 1 already
 * shows — as the reserve, then lets fresh page 1 trim it (and mark it reached
 * when page 1 already ends inside the cached range: the partial-overlap case).
 */
export function stashFeedReserve(cachedVideos, freshVideos) {
  const freshIds = new Set(freshVideos.map(v => v.video_id));
  const ordered = sortVideos((cachedVideos || []).filter(v => v && v.video_id));
  const videos = ordered.filter(v => !freshIds.has(v.video_id));
  if (ordered.length === 0 || videos.length === 0) {
    state.feedReserve = null;
    return;
  }
  state.feedReserve = { videos, anchor: itemParts(ordered[0]), reached: false };
  absorbServerPage(freshVideos);
}

export function clearFeedReserve() {
  state.feedReserve = null;
}

/**
 * Reconciles the reserve with a page that just came from the server: drops
 * the items that page contained (the server copy is fresher) and the items
 * that now sit at or before its last item (they were deleted upstream — the
 * server would have returned them otherwise), and marks the reserve reached
 * once the page ends at or past the anchor. Empties out to null.
 */
export function absorbServerPage(pageVideos) {
  const r = state.feedReserve;
  if (!r || !pageVideos || pageVideos.length === 0) return;
  const last = itemParts(pageVideos[pageVideos.length - 1]);
  const pageIds = new Set(pageVideos.map(v => v.video_id));
  r.videos = r.videos.filter(v => !pageIds.has(v.video_id) && isAfter(itemParts(v), last));
  if (!isAfter(r.anchor, last)) r.reached = true; // the page ends at/after the anchor
  if (r.videos.length === 0) state.feedReserve = null;
}

/**
 * Drop-in for api.fetchFeed on the pagination paths. Serves the next page
 * from the reserve when it has been reached and holds items past `cursor`;
 * otherwise fetches from the server and lets the response trim the reserve.
 * A served page carries `fromReserve: true` and a cursor after its last item,
 * so pagination continues seamlessly into the server once the reserve drains.
 */
export function fetchFeedPage(page, cursor) {
  const r = state.feedReserve;
  if (r && r.reached && typeof cursor === 'string' && cursor !== '') {
    const pos = cursorParts(cursor);
    // Anything at or before the cursor has been passed already — a page we
    // didn't see absorbed covered it, or it was deleted. Only what lies past
    // the cursor is servable.
    const past = r.videos.filter(v => isAfter(itemParts(v), pos));
    if (past.length > 0) {
      const videos = past.slice(0, CONFIG.PAGE_SIZE);
      r.videos = past.slice(videos.length);
      if (r.videos.length === 0) state.feedReserve = null;
      return Promise.resolve({
        status: 'ok',
        videos,
        total: state.totalVideos,
        page,
        next_cursor: cursorAfter(videos),
        fromReserve: true,
      });
    }
    state.feedReserve = null;
  }
  const pending = api.fetchFeed(page, CONFIG.PAGE_SIZE, cursor || '');
  // No reserve: hand back the API promise itself. The refill loop and
  // loadNextPage race on microtask order (pendingFetchPage / token checks);
  // an extra hop here changed which responses got discarded.
  if (!state.feedReserve) return pending;
  return pending.then(data => {
    absorbServerPage(data.videos || []);
    return data;
  });
}

/** Drops the buffer and cancels any in-flight refill (pagination reset). */
export function invalidatePrefetchBuffer() {
  state.prefetchBuffer = [];
  state.prefetchToken++;
}

/**
 * Takes the buffered entry ({videos, nextCursor}) for `page` if it's at
 * the head of the buffer. Anything else means the buffer no longer lines
 * up with the feed's pagination — discard it rather than render
 * out-of-order pages.
 */
export function takeBufferedPage(page) {
  if (state.prefetchBuffer.length === 0) return null;
  if (state.prefetchBuffer[0].page === page) {
    return state.prefetchBuffer.shift();
  }
  invalidatePrefetchBuffer();
  return null;
}

/**
 * Fetches pages sequentially until the buffer holds PREFETCH_PAGES_AHEAD
 * pages (or the catalog is exhausted). One loop runs at a time; responses
 * that no longer line up with the pagination — because the user consumed
 * pages mid-flight or the feed revalidated — are discarded, and the loop
 * recomputes what to fetch next.
 */
export async function refillPrefetchBuffer() {
  if (state.prefetching || !state.initialLoadComplete) return;
  state.prefetching = true;
  const token = state.prefetchToken;

  try {
    while (
      token === state.prefetchToken &&
      state.prefetchBuffer.length < CONFIG.PREFETCH_PAGES_AHEAD &&
      hasMoreToPrefetch()
    ) {
      const page = nextPageToFetch();
      const cursor = nextCursorToFetch();

      // Cursor mode can't leapfrog a page loadNextPage is direct-fetching:
      // the cursor to continue from is inside that response. Stop here —
      // loadNextPage refills again once its fetch lands.
      if (typeof cursor === 'string' && state.prefetchBuffer.length === 0 && state.pendingFetchPage) return;

      const data = await fetchFeedPage(page, cursor || '');
      if (token !== state.prefetchToken) return;

      if (data.total) state.totalVideos = data.total;
      const videos = data.videos || [];
      if (videos.length === 0) {
        // Past the real end — the server total overcounts what forward
        // pagination can reach (items prepended mid-session shift pages).
        // Clamp the total to what's actually rendered + buffered so
        // scrolling drains the remaining buffer, then stops cleanly.
        state.totalVideos = state.videos.length + bufferedVideoCount();
        state.hasMore = state.videos.length < state.totalVideos;
        // Nothing buffered and the server confirmed the end — mark the
        // rendered feed's cursor exhausted too.
        if (data.next_cursor === '' && state.prefetchBuffer.length === 0) state.nextCursor = '';
        if (!state.hasMore && state.view === 'latest' && !isFilterActive()) {
          const sentinel = document.getElementById('load-more-container');
          if (sentinel) sentinel.style.display = 'none';
        }
        break;
      }

      // A scroll may have consumed pages while this fetch was in flight;
      // only append if the response still extends the buffer contiguously.
      if (page === nextPageToFetch()) {
        state.prefetchBuffer.push({ page, videos, nextCursor: data.next_cursor });
      }
    }
  } catch (e) {
    /* network hiccup — scrolling falls back to on-demand fetching */
  } finally {
    state.prefetching = false;
    // A pagination reset mid-loop invalidated this run — service the new
    // token now instead of waiting for the next scroll.
    if (token !== state.prefetchToken) refillPrefetchBuffer();
  }
}
