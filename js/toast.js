/**
 * toast.js — Transient notification banners.
 */

// Ceiling on toasts stacked at once. A burst of failures (offline, a storm of
// vote/comment errors) would otherwise pile up an unbounded column that covers
// the screen and outlives its usefulness — drop the oldest to make room.
const MAX_TOASTS = 4;

export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  // The container is absent on some entry points (early boot, tests, a stripped
  // page) — a missing host is a no-op, never a thrown "appendChild of null".
  if (!container) return;

  // Cap concurrent toasts: evict the oldest so the new one keeps the total at
  // MAX_TOASTS. querySelectorAll returns them in document (oldest-first) order.
  const toasts = container.querySelectorAll('.toast');
  for (let i = 0; i <= toasts.length - MAX_TOASTS; i++) {
    toasts[i].remove();
  }

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3900);
}
