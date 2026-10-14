/**
 * analytics.js — Google Analytics 4 behind a cookie-consent banner.
 *
 * Opt-in ("basic" Google Consent Mode v2): nothing is fetched from Google and
 * no _ga cookie is set until the visitor clicks Accept. Consent defaults to
 * denied for every storage type; Accept flips analytics_storage to granted and
 * only then injects gtag.js. Advertising signals stay denied — we don't use them.
 *
 * The choice is remembered in localStorage (wd_analytics_consent = 'granted' |
 * 'denied'), so the banner shows once. Any element with [data-cookie-settings]
 * (the "Cookies" footer link) reopens it so consent can be withdrawn as easily
 * as it was given; withdrawing deletes the _ga cookies.
 *
 * Classic script, not inline: the strict CSP has no 'unsafe-inline'. The CSP
 * allowlists www.googletagmanager.com (script/connect) and
 * *.google-analytics.com / *.analytics.google.com (connect). Loaded by
 * index.html, terms.html, privacy.html, and 404.html.
 */
(function () {
  var GA_ID = 'G-M9PXYBQ5X7';
  var STORAGE_KEY = 'wd_analytics_consent';
  var loaded = false;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag('consent', 'default', {
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });

  function readChoice() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return v === 'granted' || v === 'denied' ? v : null;
    } catch (e) {
      return null; // storage blocked: treat as undecided, banner asks again
    }
  }

  function saveChoice(v) {
    try { localStorage.setItem(STORAGE_KEY, v); } catch (e) { /* non-fatal */ }
  }

  function loadGa() {
    if (loaded) return;
    loaded = true;
    gtag('consent', 'update', { analytics_storage: 'granted' });
    gtag('js', new Date());
    gtag('config', GA_ID);
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
  }

  // GA sets _ga and _ga_<stream> on the registrable domain, so expire them
  // on every parent domain of the current host as well as host-only.
  function clearGaCookies() {
    var parts = location.hostname.split('.');
    var domains = [''];
    for (var i = 0; i < parts.length - 1; i++) domains.push('; domain=.' + parts.slice(i).join('.'));
    document.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].trim();
      if (name !== '_ga' && name.indexOf('_ga_') !== 0) return;
      domains.forEach(function (d) {
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + d;
      });
    });
  }

  function decide(v) {
    saveChoice(v);
    hideBanner();
    if (v === 'granted') {
      loadGa();
    } else {
      gtag('consent', 'update', { analytics_storage: 'denied' });
      clearGaCookies();
    }
  }

  var banner = null;

  function buildBanner() {
    banner = document.createElement('section');
    banner.className = 'cookie-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookie consent');
    banner.innerHTML =
      '<p class="cookie-banner__text">We use cookies for anonymous usage analytics (Google Analytics) ' +
      'to improve How You Watch. They’re off unless you accept. ' +
      '<a href="/privacy.html#cookies" class="cookie-banner__link">Privacy policy</a></p>' +
      '<div class="cookie-banner__actions">' +
      '<button type="button" class="btn btn--ghost btn--sm" data-consent="denied">Reject</button>' +
      '<button type="button" class="btn btn--primary btn--sm" data-consent="granted">Accept</button>' +
      '</div>';
    banner.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-consent]');
      if (btn) decide(btn.getAttribute('data-consent'));
    });
    document.body.appendChild(banner);
  }

  function showBanner() {
    if (!banner) buildBanner();
    banner.hidden = false;
  }

  function hideBanner() {
    if (banner) banner.hidden = true;
  }

  var choice = readChoice();
  if (choice === 'granted') loadGa();

  function init() {
    if (!choice) showBanner();
    document.addEventListener('click', function (e) {
      var link = e.target.closest('[data-cookie-settings]');
      if (!link) return;
      e.preventDefault();
      showBanner();
      var first = banner.querySelector('[data-consent]');
      if (first) first.focus();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
