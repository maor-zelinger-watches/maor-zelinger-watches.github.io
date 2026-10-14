/**
 * add-channel.js — logic for the operator-only add-channel.html page.
 *
 * Posts the pasted URL plus the password to the backend, which checks the
 * password server-side (constant-time against the admin token in META — the
 * page itself holds no secret: the repo is public, so a client-side check
 * would protect nothing), resolves the channel, and appends it to the
 * CHANNELS sheet. The password lives only in the form field for the length
 * of the visit — it is never written to storage.
 */

import { CONFIG } from './config.js';
import { createApiClient } from './api.js';

const api = createApiClient(CONFIG.APPS_SCRIPT_URL);

const form = document.getElementById('add-channel-form');
const urlInput = document.getElementById('channel-url');
const passwordInput = document.getElementById('admin-password');
const submitBtn = document.getElementById('add-channel-submit');
const result = document.getElementById('add-channel-result');

function showResult(kind, text) {
  result.hidden = false;
  result.className = `add-channel__result add-channel__result--${kind}`;
  result.textContent = text; // textContent, never innerHTML — backend text is data
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  const password = passwordInput.value;
  if (!url || !password) return;

  submitBtn.disabled = true;
  showResult('pending', 'Checking the link…');
  try {
    const { channel = {} } = await api.addChannel(url, password);
    const name = channel.channel_name ? `“${channel.channel_name}”` : 'The channel';
    const kind = channel.platform === 'youtube' ? 'a YouTube channel' : 'an article site';
    showResult('ok', `${name} was added as ${kind} — its content will appear on the site within a few minutes.`);
    urlInput.value = ''; // keep the password so several adds in a row are painless
    urlInput.focus();
  } catch (err) {
    showResult('error', err.message || 'Something went wrong — please try again.');
  } finally {
    submitBtn.disabled = false;
  }
});
