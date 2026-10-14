/**
 * footer-year.js — Stamps the current year into the footer copyright.
 *
 * Extracted from an inline <script> so every page can ship a strict
 * Content-Security-Policy (script-src without 'unsafe-inline'). Loaded by
 * index.html, terms.html, and privacy.html.
 */
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('footer-year');
  if (el) el.textContent = String(new Date().getFullYear());
});
