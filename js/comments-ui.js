/**
 * comments-ui.js — Inline comment threads: expand/collapse, prefetch,
 * optimistic posting, and reply forms.
 *
 * Pure comment logic (tree building, HTML generation) lives in
 * comments.js; this module owns the DOM orchestration around it and the
 * per-video comment cache (state.commentsCache) that makes expanding a
 * card instant.
 */

import { state, patchVideoEverywhere } from './state.js';
import { api } from './api-client.js';
import { CONFIG } from './config.js';
import { buildCommentTree, createCommentThread, createCommentHtml } from './comments.js';
import { isSignedIn, getCurrentUser, renderSignInButton, ensureToken } from './auth.js';
import { showToast } from './toast.js';
import { cssEscape, sanitizeHtml } from './utils.js';

/**
 * Sets the comment count on a toggle button. The button holds a flat SVG
 * icon plus a count span, so callers must never assign textContent (that
 * wipes the icon) — every count update goes through here.
 */
export function setCommentsToggleCount(toggleBtn, count) {
  if (!toggleBtn) return;
  const countEl = toggleBtn.querySelector('.media-card__comments-count');
  if (countEl) countEl.textContent = `${count} comments`;
}

export function toggleComments(videoId) {
  const body = document.querySelector(`.media-card__comments-body[data-video-id="${cssEscape(videoId)}"]`);
  if (!body) return;

  const toggleBtn = document.querySelector(`.media-card__comments-toggle[data-video-id="${videoId}"]`);
  const isExpanded = body.style.display !== 'none';
  if (isExpanded) {
    body.style.display = 'none';
    state.expandedComments.delete(videoId);
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
  } else {
    body.style.display = '';
    state.expandedComments.add(videoId);
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
    loadInlineComments(videoId);
    updateInlineCommentFormUI(videoId);
    setupInlineCommentForm(videoId);
  }
}

/**
 * Cheap order-sensitive change signature for a comment list — one
 * `comment_id:created_at` pair per comment. An add, a removal, or a reorder
 * all change it, without serializing whole trees on every expand (FE12).
 */
function commentsSignature(comments) {
  return comments.map(c => `${c.comment_id}:${c.created_at}`).join('|');
}

async function loadInlineComments(videoId) {
  const listEl = document.querySelector(`.media-card__comments-list[data-video-id="${cssEscape(videoId)}"]`);
  if (!listEl) return;

  // 1. Instantly render cached data if available (Stale-while-revalidate pattern)
  const cached = state.commentsCache[videoId];
  if (cached) {
    renderComments(videoId, listEl, cached.comments, cached.tree);
  } else {
    listEl.innerHTML = '<div class="comments-loading-inline"><div class="spinner"></div></div>';
  }

  // 2. Fetch fresh comments in the background
  try {
    const data = await api.fetchComments(videoId);
    const comments = data.comments || [];
    const tree = buildCommentTree(comments);

    // Check if the fresh data is actually different from our cache
    const hasChanged = !cached || commentsSignature(cached.comments) !== commentsSignature(comments);

    // Update cache
    state.commentsCache[videoId] = { comments, tree };

    if (hasChanged) {
      if (cached) {
        // If it was cached, do a smooth CSS fade transition
        listEl.classList.add('is-updating');
        setTimeout(() => {
          // The card may have collapsed or been rebuilt (revalidation diff,
          // view switch) during the fade — rendering into a detached node
          // would silently lose the fresh comments (FE12). The cache above
          // already holds them; the next expand renders from it.
          if (!listEl.isConnected) return;
          renderComments(videoId, listEl, comments, tree);
          requestAnimationFrame(() => listEl.classList.remove('is-updating'));
        }, 300); // matches CSS transition duration
      } else {
        // First load, just render instantly
        renderComments(videoId, listEl, comments, tree);
      }
    }
  } catch (error) {
    console.error('Failed to load comments:', error);
    if (!cached) {
      listEl.innerHTML = '<p class="comments-empty">Failed to load comments.</p>';
    }
  }
}

/**
 * Renders comments into the DOM for a given video.
 */
function renderComments(videoId, listEl, comments, tree) {
  const toggleBtn = document.querySelector(`.media-card__comments-toggle[data-video-id="${cssEscape(videoId)}"]`);
  setCommentsToggleCount(toggleBtn, comments.length);

  if (tree.length === 0) {
    listEl.innerHTML = '<p class="comments-empty">No comments yet. Be the first!</p>';
  } else {
    listEl.innerHTML = tree.map(c => createCommentThread(c)).join('');
    attachReplyHandlers(videoId);
  }
}

/**
 * Prefetches comments in the background so expanding a card is instant.
 *
 * Only videos with at least one comment are fetched — the feed payload
 * already carries comment_count, and zero-count videos load on expand.
 * IDs are grouped into commentsBatch requests so a page of cards costs
 * one Apps Script execution instead of one per video (the web app caps
 * simultaneous executions, and per-video prefetch was the main load).
 */
export function prefetchComments(videos) {
  // Instantly cache empty state for videos with no comments to avoid network requests
  videos.forEach(v => {
    if (v.video_id && (v.comment_count || 0) === 0 && !state.commentsCache[v.video_id]) {
      state.commentsCache[v.video_id] = { comments: [], tree: [] };
    }
  });

  const queue = videos
    .filter(v => v.video_id && !state.commentsCache[v.video_id] && (v.comment_count || 0) > 0)
    .map(v => v.video_id);

  if (queue.length === 0) return;

  const chunks = [];
  for (let i = 0; i < queue.length; i += CONFIG.COMMENT_BATCH_SIZE) {
    chunks.push(queue.slice(i, i + CONFIG.COMMENT_BATCH_SIZE));
  }

  let index = 0;

  function fetchNextChunk() {
    if (index >= chunks.length) return;

    // Skip ids cached in the meantime (e.g. user expanded manually)
    const ids = chunks[index++].filter(id => !state.commentsCache[id]);
    if (ids.length === 0) {
      fetchNextChunk();
      return;
    }

    api.fetchCommentsBatch(ids)
      .then(data => {
        // Backend without commentsBatch support — comments load on expand
        if (!data.byVideo) return;

        for (const id of ids) {
          const comments = data.byVideo[id] || [];
          const tree = buildCommentTree(comments);
          state.commentsCache[id] = { comments, tree };

          // If the user already expanded this card while we were fetching, render now
          if (state.expandedComments.has(id)) {
            const listEl = document.querySelector(`.media-card__comments-list[data-video-id="${cssEscape(id)}"]`);
            if (listEl) renderComments(id, listEl, comments, tree);
          }

          // Update the comment count badge from real data
          const toggleBtn = document.querySelector(`.media-card__comments-toggle[data-video-id="${cssEscape(id)}"]`);
          setCommentsToggleCount(toggleBtn, comments.length);
        }

        // Stagger next batch to stay under rate limits
        setTimeout(fetchNextChunk, 300);
      })
      .catch(() => { /* silent — stop prefetching, comments still load on expand */ });
  }

  fetchNextChunk();
}

export function updateInlineCommentFormUI(videoId) {
  const authPrompt = document.querySelector(`.media-card__auth-prompt[data-video-id="${cssEscape(videoId)}"]`);
  const form = document.querySelector(`.media-card__comment-form[data-video-id="${cssEscape(videoId)}"]`);
  if (!authPrompt || !form) return;

  if (getCurrentUser()) {
    authPrompt.style.display = 'none';
    form.style.display = '';
  } else {
    authPrompt.style.display = '';
    form.style.display = 'none';
    // Render a real sign-in button into the prompt (once) so signed-out
    // users can sign in from anywhere — including the fullscreen overlay,
    // which covers the header's sign-in button.
    if (!authPrompt.dataset.signinRendered) {
      authPrompt.dataset.signinRendered = 'true';
      const host = document.createElement('div');
      host.className = 'media-card__auth-prompt-btn';
      authPrompt.appendChild(host);
      renderSignInButton(host);
    }
  }
}

function setupInlineCommentForm(videoId) {
  const form = document.querySelector(`.media-card__comment-form[data-video-id="${cssEscape(videoId)}"]`);
  const textarea = document.querySelector(`.media-card__textarea[data-video-id="${cssEscape(videoId)}"]`);
  if (!form || !textarea || form.dataset.bound) return;
  form.dataset.bound = 'true';

  const charcount = form.querySelector('.media-card__charcount');
  textarea.addEventListener('input', () => {
    if (charcount) charcount.textContent = `${textarea.value.length}/2000`;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitInlineComment(videoId, '', textarea);
  });
}

async function submitInlineComment(videoId, parentId, textarea) {
  const body = textarea.value.trim();
  if (!body) return;

  if (!isSignedIn()) {
    showToast('Please sign in to comment', 'info');
    return;
  }

  const form = textarea.closest('form');
  const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
  if (submitBtn) submitBtn.disabled = true;

  const user = getCurrentUser();
  const optId = 'opt_' + Date.now();
  const optimisticComment = {
    comment_id: optId,
    parent_id: parentId,
    user_name: user.name,
    user_avatar: user.picture,
    body: body,
    created_at: new Date().toISOString(),
    isOptimistic: true,
    depth: parentId ? 1 : 0
  };

  // Generate HTML
  const html = parentId ? createCommentHtml(optimisticComment) : createCommentThread(optimisticComment);

  // Inject into DOM
  if (parentId) {
    // The parent node can be gone if the list re-rendered (prefetch
    // refresh, revalidation) while the reply form was open — the post
    // below still goes through, only the optimistic paint is skipped.
    const parentEl = document.querySelector(`.comment[data-comment-id="${parentId}"]`);
    const parentThread = parentEl ? parentEl.closest('.comment-thread') : null;
    if (parentThread) {
      let repliesContainer = parentThread.querySelector('.comment-thread__replies');
      if (!repliesContainer) {
        repliesContainer = document.createElement('div');
        repliesContainer.className = 'comment-thread__replies';
        parentThread.appendChild(repliesContainer);
      }
      repliesContainer.insertAdjacentHTML('beforeend', html);
    }
  } else {
    const listEl = document.querySelector(`.media-card__comments-list[data-video-id="${cssEscape(videoId)}"]`);
    if (listEl) {
      const empty = listEl.querySelector('.comments-empty');
      if (empty) empty.remove();
      listEl.insertAdjacentHTML('beforeend', html);
    }
  }

  // Update comment count
  const toggleBtn = document.querySelector(`.media-card__comments-toggle[data-video-id="${cssEscape(videoId)}"]`);
  let previousCount = 0;
  if (toggleBtn) {
    previousCount = parseInt(toggleBtn.textContent.replace(/[^0-9]/g, '')) || 0;
    setCommentsToggleCount(toggleBtn, previousCount + 1);
  }

  // Hide reply form or clear textarea
  let replyForm = null;
  if (parentId) {
    replyForm = textarea.closest('.reply-form');
    if (replyForm) replyForm.style.display = 'none';
  } else {
    textarea.value = '';
    textarea.dispatchEvent(new Event('input'));
  }

  try {
    // Google ID tokens expire after 1 hour — refresh if needed; a failed
    // refresh signs the user out and throws into the rollback below.
    const token = await ensureToken();

    const response = await api.postComment(videoId, parentId, body, token);

    // Invalidate prefetch cache so next expand fetches fresh data
    delete state.commentsCache[videoId];

    // Success: Update optimistic ID to real ID and remove optimistic class
    const el = document.querySelector(`.comment[data-comment-id="${optId}"]`);
    if (el) {
      el.dataset.commentId = response.comment_id;
      el.classList.remove('comment--optimistic');
      if (!parentId) {
        const actions = el.querySelector('.comment__actions');
        if (actions) {
          actions.innerHTML = `<button class="comment__reply-btn reply-btn" data-comment-id="${sanitizeHtml(response.comment_id)}">↩ Reply</button>`;
          attachReplyHandlers(videoId);
        }
      }
    }

    if (replyForm) replyForm.remove();

    // New count onto every cached copy of the row (+ localStorage) — FE13.
    patchVideoEverywhere(videoId, { comment_count: previousCount + 1 });
  } catch (error) {
    console.error('Failed to post comment:', error);

    // Rollback
    const el = document.querySelector(`.comment[data-comment-id="${optId}"]`);
    if (el) {
      const thread = el.closest('.comment-thread');
      if (thread && thread.firstElementChild === el) {
        thread.remove();
      } else {
        el.remove();
      }
    }

    setCommentsToggleCount(toggleBtn, previousCount);

    if (replyForm) {
      replyForm.style.display = '';
      if (submitBtn) submitBtn.disabled = false;
    } else {
      textarea.value = body;
      textarea.dispatchEvent(new Event('input'));
    }

    showToast('Failed to post comment. Please try again.', 'error');
  } finally {
    if (submitBtn && !replyForm) submitBtn.disabled = false;
  }
}

function attachReplyHandlers(videoId) {
  const card = document.querySelector(`.media-card[data-video-id="${cssEscape(videoId)}"]`);
  if (!card) return;

  card.querySelectorAll('.reply-btn').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = 'true';
    btn.addEventListener('click', (e) => {
      toggleReplyForm(videoId, e.currentTarget.dataset.commentId);
    });
  });
}

function toggleReplyForm(videoId, commentId) {
  const card = document.querySelector(`.media-card[data-video-id="${cssEscape(videoId)}"]`);
  if (card) card.querySelectorAll('.reply-form').forEach(f => f.remove());

  if (!isSignedIn()) {
    showToast('Please sign in to reply', 'info');
    return;
  }

  const commentEl = card.querySelector(`.comment[data-comment-id="${commentId}"]`);
  if (!commentEl) return;

  const replyForm = document.createElement('div');
  replyForm.className = 'reply-form';
  replyForm.innerHTML = `
    <textarea class="reply-form__textarea" placeholder="Write a reply..." maxlength="2000" rows="2"></textarea>
    <div class="reply-form__actions">
      <button class="btn btn--ghost btn--sm reply-cancel-btn">Cancel</button>
      <button class="btn btn--primary btn--sm reply-submit-btn">Reply</button>
    </div>
  `;

  commentEl.parentNode.insertBefore(replyForm, commentEl.nextSibling);
  const textarea = replyForm.querySelector('textarea');
  textarea.focus();

  replyForm.querySelector('.reply-cancel-btn').addEventListener('click', () => replyForm.remove());
  replyForm.querySelector('.reply-submit-btn').addEventListener('click', () => {
    submitInlineComment(videoId, commentId, textarea);
  });
}
