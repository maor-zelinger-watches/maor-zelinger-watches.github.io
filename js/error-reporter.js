/**
 * error-reporter.js — Ships frontend errors to the backend's error sheet.
 *
 * Captures three streams: uncaught exceptions (window 'error'), unhandled
 * promise rejections, and console.error calls — the codebase's existing
 * convention for surfacing handled failures (e.g. a failed comment post).
 * Reports are deduped, capped, batched, and POSTed fire-and-forget to the
 * `clientError` backend action, which appends them to a dedicated
 * spreadsheet (see SPREADSHEET_IDS.CLIENT_ERRORS in apps-script/Code.gs).
 *
 * Loaded as its own module tag BEFORE app.js so an error thrown while the
 * main module graph evaluates is already being observed.
 *
 * Invariants:
 *  - Never throws, never logs its own failures — a broken reporter must
 *    not take the app down or recurse into itself.
 *  - Sends no identity: a random per-page-load session id correlates rows,
 *    but no email/name/token ever leaves the page from here.
 */

import { CONFIG } from './config.js';

// One report per (message, source) beyond this count is dropped — a render
// loop re-throwing per frame must not fill the sheet with one error.
const MAX_PER_KEY = 3;
// Hard per-page-load ceiling across all keys; the sheet is for signal.
const MAX_PER_SESSION = 25;
// Collect for this long after the first queued report before sending, so
// an error burst (one failure cascading through modules) ships as one POST.
const FLUSH_DELAY_MS = 3000;
// Matches the backend's per-request cap (CLIENT_ERRORS_PER_REQUEST).
const MAX_BATCH = 10;

// Known third-party noise, dropped before it costs sheet rows or session
// budget. The Google Sign-In library console.errors its own telemetry on
// every signed-out visit where FedCM declines (most of them) — that's the
// library narrating an expected state, not a defect in this app.
const IGNORED_PATTERNS = [
  /\[GSI_LOGGER\]/,
  /FedCM/,
  /Not signed in with the identity provider/,
];

const sessionId = 's_' + Math.random().toString(36).slice(2, 10);
const counts = new Map();
let queue = [];
let totalCaptured = 0;
let flushTimer = null;
let installed = false;

function truncate(value, n) {
  const s = String(value == null ? '' : value);
  return s.length > n ? s.slice(0, n) : s;
}

// Redact JWT / app-session-token shapes (three dot-separated base64url
// segments, the last two long) before a report leaves the page — a stray token
// in a console.error arg or an error message must never reach the sheet, per
// this module's "no token ever leaves the page" invariant (SEC8). The segment
// lengths are tuned to match real tokens (long payload + signature) without
// touching ordinary dotted identifiers like module paths.
const TOKEN_RE = /[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g;
function scrubTokens(value) {
  return String(value == null ? '' : value).replace(TOKEN_RE, '[redacted-token]');
}

/** Queues one report; all guards live here so every stream shares them. */
function capture(message, stack, source) {
  try {
    if (totalCaptured >= MAX_PER_SESSION) return;
    const text = String(message == null ? '' : message);
    if (IGNORED_PATTERNS.some((p) => p.test(text))) return;

    const key = `${message}|${source}`;
    const seen = counts.get(key) || 0;
    if (seen >= MAX_PER_KEY) return;
    counts.set(key, seen + 1);
    totalCaptured++;

    queue.push({
      ts: new Date().toISOString(),
      message: truncate(message, 500),
      stack: truncate(stack, 2000),
      source: truncate(source, 300),
    });

    if (!flushTimer) {
      flushTimer = setTimeout(() => flush(false), FLUSH_DELAY_MS);
    }
  } catch (e) {
    // Swallow: the reporter must never become an error source itself.
  }
}

/**
 * Sends everything queued. On pagehide (`sync` true) fetch would be
 * aborted with the page, so sendBeacon takes over — it outlives the
 * document. No retries either way: a failed report is dropped, because
 * retrying against a struggling backend just adds to the trouble.
 */
function flush(sync) {
  try {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (queue.length === 0) return;

    const batch = queue.slice(0, MAX_BATCH);
    queue = queue.slice(MAX_BATCH);

    const body = JSON.stringify({
      action: 'clientError',
      sessionId,
      appVersion: CONFIG.APP_VERSION,
      page: truncate(location.href, 300),
      userAgent: truncate(navigator.userAgent, 300),
      errors: batch,
    });

    if (sync && navigator.sendBeacon) {
      navigator.sendBeacon(
        CONFIG.APPS_SCRIPT_URL,
        new Blob([body], { type: 'text/plain;charset=utf-8' })
      );
    } else {
      fetch(CONFIG.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        keepalive: true,
      }).catch(() => {});
    }

    // More than one batch queued (a big burst): the rest goes on the next
    // timer tick rather than hammering the backend in one volley.
    if (queue.length > 0 && !sync) {
      flushTimer = setTimeout(() => flush(false), FLUSH_DELAY_MS);
    }
  } catch (e) {
    queue = [];
  }
}

export function initErrorReporter() {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (event) => {
    // Resource load failures (dead <img>/<script>) reach this listener with
    // no error object and target !== window; skip them — they're network
    // noise, not code defects, and they'd burn the session cap.
    if (!event.message && event.target !== window) return;
    const stack = event.error && event.error.stack;
    const source = `${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}`;
    capture(event.message || 'Unknown error', stack || '', source);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    if (reason instanceof Error) {
      capture(reason.message, reason.stack || '', 'unhandledrejection');
    } else {
      capture(truncate(reason, 500), '', 'unhandledrejection');
    }
  });

  // console.error is how this codebase reports handled failures (comment
  // post rollback, feed load errors) — wrap it so those count too. The
  // original always runs first; devtools behavior is unchanged.
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    originalError(...args);
    try {
      const parts = args.map((a) =>
        a instanceof Error ? `${a.message}` : truncate(a, 200)
      );
      const firstError = args.find((a) => a instanceof Error);
      capture(
        scrubTokens(parts.join(' ')),
        scrubTokens((firstError && firstError.stack) || ''),
        'console.error'
      );
    } catch (e) {
      // Never let reporting break console.error callers.
    }
  };

  // Last chance to ship whatever is queued before the page goes away.
  // pagehide over unload: fires on mobile bfcache navigations too.
  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
}

// Self-initialize on import: the module tag in index.html is the wiring;
// nothing else needs to remember to call init.
initErrorReporter();
