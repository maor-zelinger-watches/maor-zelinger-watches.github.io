/**
 * feedback.js — The floating "Send feedback" button and its dialog.
 *
 * Signed-in only: the button is hidden until a user signs in (and hides
 * again on sign-out, closing the dialog if it was open), and every send
 * carries the session token so the row in the Feedback tab of the
 * CUSTOMERS spreadsheet names its sender. One dialog: a textarea, an ✕,
 * a Submit. Nothing is written until Submit; ✕, the backdrop and Escape
 * just close, keeping any draft for the next open this page load.
 */

import { api } from './api-client.js';
import { getCurrentUser, ensureToken } from './auth.js';
import { showToast } from './toast.js';

let fabEl = null;
let overlayEl = null;
let dialogEl = null;
let textareaEl = null;
let submitEl = null;
let identityEl = null;
let openerEl = null;   // focus returns here on close
let inFlight = false;  // one gesture, one POST

export function setupFeedback() {
  fabEl = document.getElementById('feedback-fab');
  overlayEl = document.getElementById('feedback-overlay');
  if (!fabEl || !overlayEl) return;
  dialogEl = overlayEl.querySelector('.feedback-overlay__dialog');
  textareaEl = document.getElementById('feedback-message');
  submitEl = document.getElementById('feedback-submit');
  identityEl = document.getElementById('feedback-identity');

  fabEl.addEventListener('click', openFeedback);
  // Backdrop and ✕ both carry data-close.
  overlayEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeFeedback();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) closeFeedback();
  });
  dialogEl.addEventListener('submit', (e) => {
    e.preventDefault();
    submitFeedback();
  });

  feedbackOnAuthChange(getCurrentUser());
}

/**
 * Shows the button for a signed-in user, hides it (and closes the dialog)
 * otherwise. Called from app.js's onAuthChange and at setup.
 * @param {{email:string}|null} user
 */
export function feedbackOnAuthChange(user) {
  if (!fabEl) return;
  fabEl.hidden = !user;
  if (!user) closeFeedback();
}

function isOpen() {
  return !!overlayEl && !overlayEl.hidden;
}

export function openFeedback() {
  if (!overlayEl || isOpen()) return;
  const user = getCurrentUser();
  if (!user) {
    showToast('Please sign in first', 'info');
    return;
  }
  openerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  identityEl.textContent = `Sending as ${user.email}`;
  overlayEl.hidden = false;
  textareaEl.focus();
}

export function closeFeedback() {
  if (!isOpen()) return;
  overlayEl.hidden = true;
  if (openerEl && document.contains(openerEl)) openerEl.focus();
  openerEl = null;
}

async function submitFeedback() {
  const message = textareaEl.value.trim();
  if (!message) {
    showToast('Write something first', 'info');
    textareaEl.focus();
    return;
  }
  if (inFlight) return;
  inFlight = true;
  submitEl.disabled = true;
  textareaEl.disabled = true;

  try {
    // ensureToken renews a stale session or signs the user out and throws —
    // a send never goes out without a sender.
    const token = await ensureToken();
    await api.sendFeedback(message, token);
    textareaEl.value = '';
    closeFeedback();
    showToast('Thanks for the feedback!', 'success');
  } catch (error) {
    console.error('Failed to send feedback:', error);
    const msg = /^Unknown action/i.test(error.message || '')
      ? "Feedback isn't available yet — please try again later."
      : (error.message || 'Failed to send. Please try again.');
    showToast(msg, 'error');
    // The draft stays in the box so a retry is one tap away.
  } finally {
    inFlight = false;
    submitEl.disabled = false;
    textareaEl.disabled = false;
    if (isOpen()) textareaEl.focus();
  }
}
