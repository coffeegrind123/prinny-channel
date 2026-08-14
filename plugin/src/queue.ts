/**
 * A durable outbox for inbound messages.
 *
 * The channel server only exists while a Claude Code session does. Close the
 * session and the bot is not merely idle — it is gone, and anything sent to it
 * meanwhile would be lost. Matrix holds those messages server-side, but a bot
 * ignores everything older than its own startup precisely so a restart does
 * not re-answer old conversations. Without something tracking what has
 * actually been *delivered*, "sent while you were away" and "already handled"
 * are indistinguishable.
 *
 * So every inbound message is written here before it is handed to the session,
 * and removed only once it has been. That ordering is what makes it durable:
 * a crash between receiving and delivering leaves the message queued rather
 * than lost, and the record of what has been delivered stops an
 * already-delivered message coming back on the next start.
 *
 * "Already delivered" is decided by EVENT ID, never by timestamp. It was a
 * timestamp once — anything at or below the watermark was treated as seen —
 * and that silently dropped live messages, because `origin_server_ts` is not
 * globally monotonic in arrival order:
 *
 *  - Across rooms. The startup catch-up replays the initial sync room by room,
 *    so a room replayed second contributes timestamps older than the one
 *    replayed first. Every message in it sat below the watermark the first room
 *    had just pushed up, and was discarded unread.
 *  - Within a room. An encrypted event whose megolm key has not arrived yet is
 *    re-dispatched later, once it decrypts — that is the whole point of the
 *    `MatrixEventEvent.Decrypted` listener in the bot, which exists so the
 *    first message after a key rotation is not lost. By then a newer message
 *    has advanced the watermark past it, so the queue threw away exactly the
 *    message that listener was written to rescue.
 *
 * The watermark still exists, because it has a second and legitimate job: it
 * is the floor for the next start's catch-up. It is no longer a filter.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { STATE_DIR, log } from './state.js';

const QUEUE_FILE = join(STATE_DIR, 'queue.json');
const WATERMARK_FILE = join(STATE_DIR, 'watermark.json');
const DELIVERED_FILE = join(STATE_DIR, 'delivered.json');

/** Keep the backlog to something a session can actually read on return. */
export const MAX_QUEUED = 50;
/** Older than this and the conversation has moved on without us. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How many delivered event ids to remember.
 *
 * This is what stops a re-answer, so it has to comfortably outlast one
 * catch-up: the bot asks for `initialSyncLimit` events per room, so the bound
 * that matters is that limit times the number of active rooms. Eviction is
 * oldest-first, which is the right way round — a catch-up re-offers the NEWEST
 * events per room, and those are the ids still held.
 *
 * Overflowing costs a duplicate message, not a lost one. That asymmetry is
 * deliberate: this file is the only thing standing between a lost megolm key
 * and a message nobody ever sees.
 */
export const MAX_DELIVERED_IDS = 1000;
/**
 * How far below the watermark the next start's catch-up reaches.
 *
 * The watermark is the newest delivered timestamp, but "newest" is per the
 * ordering above — so a message that arrived while away with a slightly older
 * timestamp (another room, a federated server running behind, an event that
 * decrypted late) sits below it and the bot would filter it out before the
 * queue ever saw it. Reaching back re-offers that window; the id record then
 * discards whatever has genuinely been handled.
 */
export const CATCH_UP_GRACE_MS = 10 * 60 * 1000;

export type QueuedMessage = {
  /** The Matrix event ID. Doubles as the dedupe key. */
  id: string;
  /** Event timestamp, milliseconds. Ordering and ageing key. */
  ts: number;
  content: string;
  meta: Record<string, string>;
};

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`${path} unreadable, starting fresh: ${err}`);
    }
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // Atomic: a reader never sees a half-written queue, and a crash mid-write
  // leaves the previous state intact rather than a truncated file.
  renameSync(tmp, path);
}

export function readQueue(): QueuedMessage[] {
  const queue = readJson<QueuedMessage[]>(QUEUE_FILE, []);
  return Array.isArray(queue) ? queue : [];
}

function writeQueue(queue: QueuedMessage[]): void {
  writeJson(QUEUE_FILE, queue);
}

/**
 * The timestamp of the newest message already delivered to a session.
 *
 * Everything at or below this has been seen; the catch-up on the next start
 * begins just above it.
 */
export function readWatermark(): number {
  const value = readJson<{ ts?: number }>(WATERMARK_FILE, {});
  return typeof value.ts === 'number' ? value.ts : 0;
}

export function writeWatermark(ts: number): void {
  if (ts <= readWatermark()) return;
  writeJson(WATERMARK_FILE, { ts });
}

/**
 * The floor for the next start's catch-up: the watermark, less a grace window.
 *
 * Zero means there is nothing delivered to measure "while away" against, and
 * the caller should start from now rather than dumping room history into a
 * fresh session.
 */
export function readCatchUpFloor(): number {
  const watermark = readWatermark();
  if (watermark === 0) return 0;

  // First boot after the upgrade: there is a watermark from the old scheme but
  // no record of which ids it stood for. Reaching back here would re-offer that
  // window with nothing able to recognise it, and the session would answer ten
  // minutes of conversation a second time. Hold the old floor for this one boot;
  // the record starts filling on the first delivery and the grace window applies
  // from the next.
  if (!existsSync(DELIVERED_FILE)) return watermark;

  return Math.max(1, watermark - CATCH_UP_GRACE_MS);
}

/** Event ids already handed to a session, newest last. */
export function readDelivered(): string[] {
  const ids = readJson<string[]>(DELIVERED_FILE, []);
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
}

function recordDelivered(id: string): void {
  const ids = readDelivered();
  if (ids.includes(id)) return;
  ids.push(id);
  writeJson(DELIVERED_FILE, ids.slice(-MAX_DELIVERED_IDS));
}

/**
 * Add a message, unless it is already queued or already delivered.
 *
 * Returns false when the message was a duplicate — worth knowing, because the
 * catch-up on startup re-offers everything the initial sync returns and most
 * of it will have been handled already.
 */
export function enqueue(message: QueuedMessage, now = Date.now()): boolean {
  const queue = readQueue();
  if (queue.some((entry) => entry.id === message.id)) return false;
  // By id, not by timestamp — see the note at the top of this file. A message
  // is old news because it has been handed over, not because something newer
  // happened to be processed first.
  if (readDelivered().includes(message.id)) return false;

  queue.push(message);
  queue.sort((a, b) => a.ts - b.ts);

  const fresh = queue.filter((entry) => now - entry.ts <= MAX_AGE_MS);
  const dropped = queue.length - fresh.length;
  // Keep the newest: on return you want the end of the conversation, not its
  // beginning. Say what was dropped rather than silently truncating.
  const bounded = fresh.slice(-MAX_QUEUED);
  const trimmed = fresh.length - bounded.length;
  if (dropped > 0) log(`dropped ${dropped} queued message(s) older than 7 days`);
  if (trimmed > 0) log(`dropped ${trimmed} queued message(s) over the ${MAX_QUEUED} cap`);

  writeQueue(bounded);
  return bounded.some((entry) => entry.id === message.id);
}

/** Remove a delivered message, record its id, and advance the watermark. */
export function markDelivered(id: string): void {
  const queue = readQueue();
  const delivered = queue.find((entry) => entry.id === id);
  writeQueue(queue.filter((entry) => entry.id !== id));
  // The id first: it is what stops a re-answer, and it must be on disk before
  // the watermark moves. Crashing between the two costs a duplicate; the other
  // order would cost the message.
  recordDelivered(id);
  if (delivered) writeWatermark(delivered.ts);
}

/**
 * Hand every queued message to `deliver`, oldest first, stopping at the first
 * failure.
 *
 * Stopping matters: delivering out of order would reorder someone's
 * conversation, and continuing past a failure would advance the watermark over
 * a message that never arrived.
 */
export async function flush(
  deliver: (message: QueuedMessage, index: number, total: number) => Promise<void>
): Promise<{ delivered: number; remaining: number }> {
  const queue = readQueue();
  let delivered = 0;
  for (const [index, message] of queue.entries()) {
    try {
      await deliver(message, index, queue.length);
    } catch (err) {
      log(`delivery stopped at queued message ${message.id}: ${err}`);
      break;
    }
    markDelivered(message.id);
    delivered += 1;
  }
  return { delivered, remaining: readQueue().length };
}

/** Path helpers, so tests and the docs agree on where this lives. */
export const QUEUE_PATH = QUEUE_FILE;
export const WATERMARK_PATH = WATERMARK_FILE;
export const DELIVERED_PATH = DELIVERED_FILE;
