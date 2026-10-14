/**
 * config.js — Deployment constants and tuning knobs.
 *
 * One place to point the frontend at a different backend, client ID,
 * or pagination behavior. Imported by every module that needs a knob;
 * nothing here is mutated at runtime.
 */

export const CONFIG = {
  APP_VERSION: '1.38.1+8fb28ea',      // frontend version (npm semver) — bump on every
                              // user-visible change; shown in the header and
                              // logged at boot. Backend has its own VERSION
                              // in apps-script/Code.gs; package.json tracks
                              // the repo/tooling. See CHANGELOG.md.
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbxLSiG_2DnEkVbvgyUOUPvFJ3aMJkMRYMt7bwAAxzBq3iwKCMaiGDwAmgZeBwB-m3SPfQ/exec',
  GOOGLE_CLIENT_ID: '58088759188-uhqgajeoe8h218h3o6pql634pkcjsu70.apps.googleusercontent.com',
  // Shared secret used to HMAC-sign write requests (SEC-Sybil). This is NOT
  // secret in any real sense — a static site ships it to every visitor, so it's
  // visible in View Source. It's a speed bump against drive-by/curl abuse and
  // stale replay, layered on top of the real Google Sign-In auth; it is not an
  // authorization boundary. Duplicated verbatim as REQUEST_SIGNING_SECRET in
  // apps-script/Code.gs — keep the two in sync, and rotate both together
  // (frontend + backend) so in-flight requests from cached clients don't break.
  REQUEST_SIGNING_SECRET: '34d720bfa37ac54ff4a75065950ebd0017404951a73f89a97ada58da56271b62',
  PAGE_SIZE: 10,
  TOP_WEEK_VIEWS_PER_VOTE: 5000, // Top This Week ranking weight: every this
                              // many views counts as one upvote in the score
                              // (floor division). Mirrors
                              // TOP_WEEK_VIEWS_PER_VOTE in apps-script/Code.gs
                              // — keep the two in sync.
  COMMENT_BATCH_SIZE: 10,     // ids per commentsBatch request (backend caps at 20)
  API_RETRY_DELAYS_MS: [400, 1200], // backoff before each retry of a request that
                              // failed transiently on Google's side (the /exec →
                              // googleusercontent echo hop intermittently 404s;
                              // see api.js requestOnce). One entry per retry.
  ACTION_QUEUE_SPACING_MS: 2100, // minimum gap between two sends of the SAME
                              // action kind (vote / star / bookmark) from the
                              // action queue, measured from the previous one's
                              // response. Mirrors the backend's per-user
                              // VOTE_STAR_RATE_LIMIT_SECONDS (2s, keyed per
                              // action) with a margin — keep it above that.
  ACTION_QUEUE_MAX_AGE_MS: 10 * 60 * 1000, // a queued action older than this
                              // when a page restores the queue is dropped, not
                              // sent: an intent from a tab abandoned an hour
                              // ago is not what the user wants replayed now.
  ACTION_QUEUE_MAX_ATTEMPTS: 3, // sends of one action before it is reported
                              // failed, counting only the backend's own
                              // "too fast" / "server busy" answers (network
                              // blips are retried inside api.js already).
  SEARCH_CHUNK_SIZE: 100,     // page size for building the search index; the
                              // catalog is fetched in parallel chunks of this
                              // size so results paint as each chunk lands.
                              // Matches the backend's MAX_PAGE_LIMIT (BE11) —
                              // asking for more gets clamped to 100 anyway,
                              // and the index build's page math follows the
                              // size the server actually returns
  SEARCH_RENDER_LIMIT: 200,   // max cards painted for a filtered render — a
                              // broad query (e.g. a single letter) can match
                              // nearly the whole index, and building thousands
                              // of cards synchronously freezes the page
  SEARCH_INDEX_LIMIT: 5000,   // absolute ceiling on indexed/cached items — a
                              // backstop against an unbounded sheet, not a
                              // normal limit (see ensureSearchIndex)
  PREFETCH_PAGES_AHEAD: 3,    // pages fetched ahead of the scroll position so
                              // infinite scroll renders instantly from memory
  TYPE_FILTER_MIN_CARDS: 20,  // when the content-type chips leave fewer than
                              // this many matching items loaded, more pages
                              // are pulled automatically (Latest feed only)
  TYPE_FILTER_TOP_UP_MAX_PAGES: 10, // per-interaction cap on those automatic
                              // pulls — a near-empty type must not fetch the
                              // whole catalog in one burst; scrolling (or the
                              // next chip click) continues from where it left off
  STORAGE_ENGINE_DEFAULT: 'idb', // which engine persists the large cache
                              // snapshots when a browser has no explicit
                              // wd_storage_engine flag (js/flags.js):
                              // 'legacy' = localStorage (the proven path),
                              // 'idb' = IndexedDB. Rolling IndexedDB out to
                              // everyone is flipping this one value; browsers
                              // that set the flag explicitly keep their choice
  FILTER_ZERO_YIELD_MAX_PAGES: 5, // consecutive fetched pages that add NO card
                              // the active content-type chip leaves visible
                              // before the sentinel-retrigger parks. The chips
                              // hide cards via CSS, so a fully-hidden page adds
                              // zero height and the sentinel never leaves view —
                              // without this cap the rAF nudge would walk the
                              // whole catalog 10 items/page (FE1). Pagination
                              // resumes on the next chip change or a deliberate
                              // scroll; it is never permanently disabled.
};
