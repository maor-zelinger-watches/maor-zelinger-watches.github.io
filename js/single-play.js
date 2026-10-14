/**
 * single-play.js — One video at a time.
 *
 * YouTube embeds play independently: start a second and the first keeps
 * running, so two soundtracks overlap. Each embed carries enablejsapi=1,
 * which opens a postMessage channel to the player. We register as a
 * listener on every player (registerPlayer, fired when its iframe loads),
 * and when one reports it started playing we send pauseVideo to all the
 * others.
 *
 * Pause, not stop — the paused player keeps its position, so a tap
 * resumes it. Fullscreen never touches playback: expanding a card is a
 * pure CSS overlay, and the only thing that pauses a player is another
 * player starting.
 */

// Player state 1 = PLAYING in the YouTube IFrame API.
const YT_PLAYING = 1;

// Messages we act on must come from a YouTube player window.
const YT_ORIGIN = /^https?:\/\/(www\.)?youtube(-nocookie)?\.com$/;

/** All inline video players currently in the DOM (article cards have none). */
function playerIframes() {
  return [...document.querySelectorAll('.media-card__embed iframe')];
}

/** Posts a YouTube IFrame API command (no args) to a single player. */
function command(iframe, func) {
  iframe.contentWindow?.postMessage(
    JSON.stringify({ event: 'command', func, args: [] }),
    '*'
  );
}

/**
 * Registers the parent as a listener so the player emits state-change
 * messages. Call once the iframe has loaded — lazy-iframe.js wires this
 * to the iframe's load event.
 */
export function registerPlayer(iframe) {
  iframe.contentWindow?.postMessage(
    JSON.stringify({ event: 'listening', id: iframe.dataset.videoId || '', channel: 'widget' }),
    '*'
  );
}

/** Pauses every inline player except the one passed in. */
export function pauseOthers(playing) {
  for (const iframe of playerIframes()) {
    if (iframe !== playing) command(iframe, 'pauseVideo');
  }
}

/**
 * Reads a raw postMessage payload; returns the reported player-state
 * number (1 = playing) if the message carries one, else null. Handles
 * both onStateChange and the API's infoDelivery envelope, and shrugs off
 * any non-YouTube / non-JSON noise.
 */
export function playerStateFrom(data) {
  // Cheap guard before the parse. The IFrame API streams `infoDelivery`
  // envelopes several times a second (currentTime, buffering, …), almost all
  // of them irrelevant here — JSON.parsing every one just to discard it is the
  // hot path. Only a message that names a player state can yield one, so skip
  // the parse for any string that mentions neither. (Non-string data — an
  // already-parsed object — falls through to the object handling below.)
  if (typeof data === 'string' &&
      data.indexOf('playerState') === -1 &&
      data.indexOf('onStateChange') === -1) {
    return null;
  }
  let msg;
  try {
    msg = typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  if (msg.event === 'onStateChange' && typeof msg.info === 'number') return msg.info;
  if (msg.event === 'infoDelivery' && msg.info && typeof msg.info.playerState === 'number') {
    return msg.info.playerState;
  }
  return null;
}

/**
 * Window message handler: when a player reports it started playing, pause
 * the rest. The playing player is matched by window identity (a safe
 * cross-origin comparison) so it never pauses itself; if the source can't
 * be identified we do nothing rather than pause everything.
 */
export function handleMessage(e) {
  if (!YT_ORIGIN.test(e.origin)) return;
  if (playerStateFrom(e.data) !== YT_PLAYING) return;
  const source = playerIframes().find(f => f.contentWindow === e.source);
  if (!source) return;
  pauseOthers(source);
}

/** Wires the single-play listener. Call once at boot. */
export function setupSinglePlay() {
  window.addEventListener('message', handleMessage);
}
