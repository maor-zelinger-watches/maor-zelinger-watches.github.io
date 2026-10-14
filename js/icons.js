/**
 * icons.js — Flat inline SVG icons for card chrome.
 *
 * One monochrome stroke set so every action icon matches the flat ☆/▲/⛶
 * text glyphs: drawn in currentColor, they inherit each button's normal,
 * hover, and active colors from CSS — which colored emoji (💬 🔗 📰 🎬)
 * never could. The active bookmark fill is CSS-driven
 * (.media-card__bookmark--active), not a second icon.
 */

const ICON_PATHS = {
  // Play lozenge outline — the long-form/shorts channel mark in card meta.
  video: '<rect x="3" y="5.5" width="18" height="13" rx="3.5"></rect><path d="M10.5 9.3 15.3 12l-4.8 2.7z" fill="currentColor" stroke="none"></path>',
  // Newspaper — article channel mark, article placeholder, platform mark.
  article: '<rect x="3.5" y="5" width="17" height="14" rx="2"></rect><path d="M7.5 9.5h9M7.5 12.5h9M7.5 15.5h5"></path>',
  // Speech bubble — the comments toggle.
  comment: '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"></path>',
  // Chain link — the share button.
  share: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>',
  // Bookmark — outline when unsaved; the active class fills it via CSS.
  bookmark: '<path d="M6 3h12v18l-6-4.2L6 21z"></path>',
};

/**
 * Returns the inline SVG markup for a flat icon, sized in CSS pixels.
 * Unknown names return '' so a typo degrades to a blank, never a crash.
 *
 * @param {'video'|'article'|'comment'|'share'|'bookmark'} name
 * @param {number} [size=15]
 * @returns {string}
 */
export function iconSvg(name, size = 15) {
  const paths = ICON_PATHS[name];
  if (!paths) return '';
  return `<svg class="icon icon--${name}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}
