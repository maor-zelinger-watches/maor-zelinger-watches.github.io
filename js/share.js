/**
 * share.js — Sharing a specific video and opening shared links.
 *
 * A share is a plain URL: `<origin><pathname>?v=<video_id>`. On load,
 * handleDeepLink resolves ?v= to a card — the already-painted one when the
 * video is in the feed, otherwise a temporary card fetched by id (so links to
 * archived videos keep working) — and opens the fullscreen watch-and-discuss
 * overlay on it. Only sharing and deep links touch the URL; manually
 * expanding a card never does.
 */

import { api } from './api-client.js';
import { buildCard } from './cards.js';
import { enterFullscreen } from './fullscreen.js';
import { showToast } from './toast.js';
import { cssEscape } from './utils.js';

// Anything longer than this can't be a real id (YouTube ids are 11 chars,
// article ids are base64 digests) — refuse early instead of shipping junk
// to the backend.
const MAX_ID_LENGTH = 200;

/** The shareable URL for a media item. */
export function shareUrlFor(videoId) {
  return `${location.origin}${location.pathname}?v=${encodeURIComponent(videoId)}`;
}

/** Strips the ?v= param without reloading. */
export function clearShareParam() {
  history.replaceState(null, '', location.pathname);
}

/**
 * Shares a media item: the native share sheet where available (mobile),
 * otherwise copy-to-clipboard with a toast.
 */
export async function shareVideo(videoId, title) {
  const url = shareUrlFor(videoId);

  if (navigator.share) {
    try {
      await navigator.share({ title, url });
    } catch (err) {
      // AbortError is the user closing the share sheet — not a failure.
      if (err && err.name !== 'AbortError') {
        showToast('Could not share link', 'error');
      }
    }
    return;
  }

  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied', 'success');
  } catch (err) {
    showToast('Could not copy link', 'error');
  }
}

/**
 * Opens the video a shared ?v= link points at, in the fullscreen overlay.
 *
 * Fast path: the video is already painted in the feed (cached page 1) — use
 * its card. Otherwise fetch it by id and mount a temporary card in
 * #deeplink-container, which sits OUTSIDE #feed-container so the feed's
 * revalidation diff, dedupe, and scroll-anchor logic never see it;
 * exitFullscreen removes it and strips ?v=. Never blocks or blanks the feed:
 * any failure toasts, clears the param, and lets startup continue.
 */
export async function handleDeepLink() {
  const videoId = new URLSearchParams(location.search).get('v');
  if (!videoId || videoId.length > MAX_ID_LENGTH) return;

  const inFeed = document.querySelector(
    `#feed-container .media-card[data-video-id="${cssEscape(videoId)}"]`);
  if (inFeed) {
    enterFullscreen(inFeed);
    return;
  }

  try {
    const data = await api.fetchVideo(videoId);
    if (!data.video) {
      showToast('That video is no longer available', 'error');
      clearShareParam();
      return;
    }
    const card = buildCard(data.video);
    card.dataset.deepLink = '1';
    document.getElementById('deeplink-container').appendChild(card);
    // Same task as the append — the overlay class lands before the browser
    // ever paints the card in the flow.
    enterFullscreen(card);
  } catch (err) {
    console.warn('Deep link failed:', err);
    showToast('Could not load the shared video', 'error');
    clearShareParam();
  }
}
