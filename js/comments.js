/**
 * comments.js — Comment system for How You Watch
 * 
 * Handles comment threading, depth validation, and HTML rendering.
 * Max depth: 1 (top-level + one reply level).
 */

import { timeAgo, sanitizeHtml, safeUrl } from './utils.js';

const MAX_DEPTH = 1;

/**
 * Builds a nested comment tree from a flat array of comments.
 * Top-level comments (depth 0, no parent_id) become root nodes.
 * Replies (depth 1, with parent_id) are nested under their parent.
 *
 * Replies whose parent isn't a root — a reply-to-reply, or a reply whose
 * parent is missing from this batch — attach to the nearest known
 * ancestor instead of being dropped; with no known ancestor at all they
 * surface as their own thread. A comment must never silently vanish.
 *
 * @param {Object[]} comments - Flat array of comment objects
 * @returns {Object[]} Tree of comments with `.replies` arrays
 */
export function buildCommentTree(comments) {
  if (!comments || comments.length === 0) return [];

  // Separate top-level and replies
  const rootMap = new Map(); // root comment_id -> tree node
  const topLevel = [];
  const replies = [];

  for (const comment of comments) {
    if (!comment.parent_id) {
      const node = { ...comment, replies: [] };
      topLevel.push(node);
      rootMap.set(node.comment_id, node);
    } else {
      replies.push(comment);
    }
  }

  // parent chain lookup across ALL comments, roots or not
  const parentOf = new Map();
  for (const comment of comments) {
    parentOf.set(comment.comment_id, comment.parent_id || '');
  }

  // Attach replies (sorted chronologically) to their nearest known root
  replies.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  for (const reply of replies) {
    let ancestorId = reply.parent_id;
    const seen = new Set();
    while (ancestorId && !rootMap.has(ancestorId) && parentOf.has(ancestorId) && !seen.has(ancestorId)) {
      seen.add(ancestorId);
      ancestorId = parentOf.get(ancestorId);
    }

    const root = rootMap.get(ancestorId);
    if (root) {
      root.replies.push(reply);
    } else {
      // Orphan — parent paginated out or deleted. Promote to its own
      // thread (and register it so its own replies can find it).
      const node = { ...reply, replies: [] };
      topLevel.push(node);
      rootMap.set(node.comment_id, node);
    }
  }

  // Sort roots by created_at (chronological), promoted orphans included
  topLevel.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  return topLevel;
}

/**
 * Validates whether a comment at the given depth is allowed.
 * Max depth is 1 (top-level = 0, reply = 1).
 * 
 * @param {number} depth - The depth to validate
 * @returns {boolean} True if the depth is valid
 */
export function validateCommentDepth(depth) {
  return Number.isInteger(depth) && depth >= 0 && depth <= MAX_DEPTH;
}

/**
 * Creates an HTML string for a single comment.
 * Includes user avatar, name, time, body text, and reply button (for depth-0 only).
 * 
 * @param {Object} comment - Comment object
 * @returns {string} HTML string
 */
export function createCommentHtml(comment) {
  const escapedBody = sanitizeHtml(comment.body);
  const escapedName = sanitizeHtml(comment.user_name);
  const escapedId = sanitizeHtml(comment.comment_id);
  // http(s) only — a javascript:/data: avatar URL must not reach <img src>
  const escapedAvatar = sanitizeHtml(safeUrl(comment.user_avatar));
  const depth = comment.depth || 0;

  const replyButton = (depth === 0 && !comment.isOptimistic)
    ? `<button class="comment__reply-btn reply-btn" data-comment-id="${escapedId}">↩ Reply</button>`
    : '';

  const optimisticClass = comment.isOptimistic ? ' comment--optimistic' : '';

  return `
    <div class="comment comment--depth-${depth}${optimisticClass}" data-comment-id="${escapedId}">
      <div class="comment__avatar">
        ${escapedAvatar
          ? `<img src="${escapedAvatar}" alt="${escapedName}" class="comment__avatar-img" referrerpolicy="no-referrer" />`
          : `<span class="comment__avatar-img" aria-hidden="true"></span>`}
      </div>
      <div class="comment__body">
        <div class="comment__header">
          <span class="comment__author">${escapedName}</span>
          <span class="comment__separator">·</span>
          <span class="comment__time">${timeAgo(comment.created_at)}</span>
        </div>
        <p class="comment__text">${escapedBody}</p>
        <div class="comment__actions">
          ${replyButton}
        </div>
      </div>
    </div>
  `.trim();
}

/**
 * Renders a full comment thread (top-level comment + its replies).
 * 
 * @param {Object} comment - Top-level comment with `.replies` array
 * @returns {string} HTML string for the thread
 */
export function createCommentThread(comment) {
  const mainComment = createCommentHtml(comment);
  const replies = (comment.replies || [])
    .map(reply => createCommentHtml(reply))
    .join('\n');

  return `
    <div class="comment-thread">
      ${mainComment}
      ${replies ? `<div class="comment-thread__replies">${replies}</div>` : ''}
    </div>
  `.trim();
}
