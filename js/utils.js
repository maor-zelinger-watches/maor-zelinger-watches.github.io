/**
 * utils.js — Utility functions for How You Watch
 * 
 * Pure functions with no side effects. Used across feed, comments, and API modules.
 */

/**
 * Formats a date as a relative time string (e.g., "3h", "2d", "1w").
 * 
 * @param {string|Date|number} date - ISO date string, Date object, or timestamp in ms
 * @returns {string} Relative time string
 */
export function timeAgo(date) {
  const now = Date.now();
  const then = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(then)) return '';

  // Future dates (clock skew, bad feed data) read as "just now", not "-3m"
  const seconds = Math.max(0, Math.floor((now - then) / 1000));

  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;

  // Buckets are bounded by days, not by their own unit, so the seams
  // can't produce "0mo" (28-29 days) or "0y" (360-364 days).
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;

  return `${Math.floor(days / 365)}y`;
}

/**
 * Formats a count as a compact string (e.g., 950, "1.2K", "3.4M").
 * Used for view counts on video cards.
 *
 * @param {number} n - The count
 * @returns {string} Abbreviated count
 */
export function formatCount(n) {
  const num = Math.max(0, Number(n) || 0);
  if (num < 1000) return String(num);
  // Upper bounds are set just below each magnitude so values that would
  // round up to "1000K"/"1000M" promote to the next unit ("1M"/"1B").
  if (num < 999500) {
    const k = num / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}K`;
  }
  if (num < 999500000) {
    const m = num / 1000000;
    return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`;
  }
  const b = num / 1000000000;
  return `${b >= 100 ? Math.round(b) : Math.round(b * 10) / 10}B`;
}

/**
 * Validates a URL is safe to embed (only http/https protocols).
 * @param {string} url - URL to validate
 * @returns {string} The URL if safe, or empty string
 */
export function safeUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
  } catch (e) { /* invalid URL */ }
  return '';
}

/**
 * Escapes a value for safe interpolation into a CSS attribute selector, e.g.
 * `[data-video-id="${cssEscape(id)}"]`. Article ids are base64 digests that
 * can carry `+`, `/`, `=` (and, in theory, a quote), any of which would break
 * or mismatch an unescaped selector. Uses the platform `CSS.escape` where
 * present; falls back to escaping just the quote and backslash — the only
 * characters special inside a double-quoted selector string — for engines and
 * test runtimes (jsdom) that don't expose it.
 *
 * @param {string} value - The dynamic value to place inside the selector
 * @returns {string} The value, safe to embed in a quoted attribute selector
 */
export function cssEscape(value) {
  const s = String(value == null ? '' : value);
  return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}

/**
 * Escapes HTML special characters to prevent XSS in user-generated content.
 * Preserves newlines and spaces but escapes everything that could be interpreted as HTML.
 * 
 * @param {string} text - Raw user input
 * @returns {string} Sanitized string safe for innerHTML
 */
export function sanitizeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
