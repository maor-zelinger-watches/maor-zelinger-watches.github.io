/**
 * auth-overlay.js — The sign-in overlay and its email-consent step.
 *
 * One dialog, three faces:
 *  - 'signin'  — hosts the official Google Sign-In button (opened from the
 *                header's Sign in pill).
 *  - 'consent' — the first-sign-in question: an explicit yes/no on marketing
 *                emails. Shown in the SAME overlay right after signing in
 *                through it, or auto-opened once per page load for a
 *                signed-in visitor the server says never answered.
 *  - 'prefs'   — the change-your-mind view (avatar → Email preferences),
 *                which doubles as the unsubscribe path.
 *
 * Consent truth lives on the server (the CUSTOMERS sheet); the client keeps
 * state.emailConsent from the sign-in bootstrap: 'yes' | 'no' | null (never
 * answered → prompt) | undefined (unknown, or a backend that predates
 * consent → never prompt). Dismissing the prompt records nothing — it asks
 * again next load; only an explicit button click writes.
 */

import { state } from './state.js';
import { api } from './api-client.js';
import { isSignedIn, renderSignInButton, ensureToken } from './auth.js';
import { showToast } from './toast.js';

let overlayEl = null;
let dialogEl = null;
let titleEl = null;
let bodyEl = null;
let currentStep = null;
let openerEl = null;          // focus returns here on close
let consentInFlight = false;  // one gesture, one POST (FE19)
let autoPromptedThisLoad = false; // a dismissed prompt doesn't re-open until next load
let pendingTimer = null;

export function setupAuthOverlay() {
  overlayEl = document.getElementById('auth-overlay');
  if (!overlayEl) return;
  dialogEl = overlayEl.querySelector('.auth-overlay__dialog');
  titleEl = document.getElementById('auth-overlay-title');
  bodyEl = overlayEl.querySelector('.auth-overlay__body');

  // Backdrop and ✕ both carry data-close; consent buttons handle themselves.
  overlayEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeAuthOverlay();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlayEl.hidden) closeAuthOverlay();
  });
}

function isOpen() {
  return !!overlayEl && !overlayEl.hidden;
}

export function openAuthOverlay(step) {
  if (!overlayEl) return;
  openerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlayEl.hidden = false;
  renderStep(step);
  dialogEl.focus();
}

export function closeAuthOverlay() {
  if (!isOpen()) return;
  clearTimeout(pendingTimer);
  overlayEl.hidden = true;
  currentStep = null;
  bodyEl.innerHTML = '';
  if (openerEl && document.contains(openerEl)) openerEl.focus();
  openerEl = null;
}

/**
 * Auth changes steer the open overlay: a sign-in that happened through the
 * 'signin' face flips it to a holding state until the bootstrap answers
 * (reconcileMyEmailConsent then picks consent vs close); a sign-out closes
 * it and forgets the consent snapshot. Called from app.js's onAuthChange.
 */
export function authOverlayOnAuthChange(user) {
  if (!user) {
    state.emailConsent = undefined;
    closeAuthOverlay();
    return;
  }
  if (isOpen() && currentStep === 'signin') renderStep('pending');
}

/**
 * Applies the bootstrap's marketing_consent to state and decides whether to
 * ask. Same transport shape as the vote/star/bookmark reconcilers: takes the
 * SHARED bootstrap promise. A payload without the key (older backend) leaves
 * state undefined and never prompts.
 *
 * @param {Promise<{marketing_consent?: 'yes'|'no'|null}>} fetchPromise
 */
export async function reconcileMyEmailConsent(fetchPromise) {
  try {
    const data = await fetchPromise;
    if (!data || !('marketing_consent' in data)) {
      // Old backend: nothing to reconcile. Un-stick a waiting sign-in overlay.
      if (isOpen() && (currentStep === 'pending' || currentStep === 'signin')) closeAuthOverlay();
      return;
    }
    const v = data.marketing_consent;
    state.emailConsent = v === 'yes' || v === 'no' ? v : null;
    maybePromptConsent();
  } catch (e) {
    // Silent, like the other reconcilers — but never leave the overlay
    // stuck on the holding state.
    if (isOpen() && currentStep === 'pending') closeAuthOverlay();
  }
}

function maybePromptConsent() {
  if (!isSignedIn()) return;
  if (state.emailConsent !== null) {
    // Already answered — a sign-in overlay waiting on this has nothing to ask.
    if (isOpen() && (currentStep === 'pending' || currentStep === 'signin')) closeAuthOverlay();
    return;
  }
  if (isOpen()) {
    // The same overlay the user signed in through moves to the question.
    autoPromptedThisLoad = true;
    renderStep('consent');
    return;
  }
  if (autoPromptedThisLoad) return; // dismissed once — don't nag this load
  autoPromptedThisLoad = true;
  openAuthOverlay('consent');
}

// --- step rendering --------------------------------------------------

function renderStep(step) {
  currentStep = step;
  clearTimeout(pendingTimer);

  if (step === 'signin') {
    titleEl.textContent = 'Sign in';
    bodyEl.innerHTML = `
      <p class="auth-overlay__copy">Comment, vote, favorite and bookmark — with one Google account.</p>
      <div class="auth-overlay__gsi" id="auth-overlay-gsi"></div>
    `;
    const gsi = document.getElementById('auth-overlay-gsi');
    if (typeof google !== 'undefined' && google.accounts) {
      renderSignInButton(gsi);
    } else {
      gsi.innerHTML = '<p class="auth-overlay__copy auth-overlay__copy--muted">Sign-in is unavailable right now. Please refresh and try again.</p>';
    }
    return;
  }

  if (step === 'pending') {
    titleEl.textContent = 'Signed in';
    bodyEl.innerHTML = '<div class="auth-overlay__pending"><div class="spinner"></div></div>';
    // The bootstrap normally answers in well under a second; if it never
    // does (offline, blocked), don't hold the page hostage.
    pendingTimer = setTimeout(() => {
      if (isOpen() && currentStep === 'pending') closeAuthOverlay();
    }, 6000);
    return;
  }

  if (step === 'consent') {
    titleEl.textContent = 'One more thing';
    bodyEl.innerHTML = `
      <p class="auth-overlay__copy">Want an occasional email with the best new watch content? No spam, and you can unsubscribe anytime.</p>
      <div class="auth-overlay__actions">
        <button type="button" class="btn btn--ghost" data-consent="no">No thanks</button>
        <button type="button" class="btn btn--primary" data-consent="yes">Yes, email me</button>
      </div>
      <p class="auth-overlay__note">Change this anytime: tap your avatar, then Email preferences.</p>
    `;
    wireConsentButtons();
    return;
  }

  // 'prefs' — current status + the same explicit yes/no pair.
  titleEl.textContent = 'Email preferences';
  const status = state.emailConsent === 'yes'
    ? "You're on the list — we may send you an occasional email with new watch content."
    : (state.emailConsent === undefined && isSignedIn()
      ? 'Checking your current preference…'
      : "You're not receiving emails from us.");
  const mark = (v) => state.emailConsent === v ? '✓ ' : '';
  bodyEl.innerHTML = `
    <p class="auth-overlay__copy">${status}</p>
    <div class="auth-overlay__actions">
      <button type="button" class="btn btn--ghost" data-consent="no" aria-pressed="${state.emailConsent === 'no'}">${mark('no')}No emails</button>
      <button type="button" class="btn btn--primary" data-consent="yes" aria-pressed="${state.emailConsent === 'yes'}">${mark('yes')}Email me</button>
    </div>
  `;
  wireConsentButtons();
}

function wireConsentButtons() {
  bodyEl.querySelectorAll('[data-consent]').forEach((btn) => {
    btn.addEventListener('click', () => submitConsent(btn.dataset.consent === 'yes'));
  });
}

// Internal seam exposed for unit tests (the once-per-load prompt latch).
export const __test__ = {
  resetPromptLatch() { autoPromptedThisLoad = false; },
};

async function submitConsent(consent) {
  if (!isSignedIn()) {
    showToast('Please sign in first', 'info');
    renderStep('signin');
    return;
  }
  if (consentInFlight) return;
  consentInFlight = true;
  bodyEl.querySelectorAll('[data-consent]').forEach((b) => { b.disabled = true; });

  try {
    const token = await ensureToken();
    const res = await api.emailConsent(consent, token);
    state.emailConsent = res.marketing_consent === 'yes' ? 'yes' : 'no';
    closeAuthOverlay();
    showToast(
      state.emailConsent === 'yes' ? "You're on the list." : 'No emails — got it.',
      state.emailConsent === 'yes' ? 'success' : 'info',
    );
  } catch (error) {
    console.error('Failed to save email preference:', error);
    const msg = /^Unknown action/i.test(error.message || '')
      ? "Email preferences aren't available yet — please try again later."
      : (error.message || 'Failed to save. Please try again.');
    showToast(msg, 'error');
    bodyEl.querySelectorAll('[data-consent]').forEach((b) => { b.disabled = false; });
  } finally {
    consentInFlight = false;
  }
}
