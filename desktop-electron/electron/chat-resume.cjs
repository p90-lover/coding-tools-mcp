"use strict";

// How a chat that no loop of this app session drives picks up after an app restart: the main
// process's copy of the chat view's restartResume (src/features/ao-chat.ts), so chats resume when
// the app starts, in every project, with the window in the background. Before, only the chat view
// resumed them: only in the project open on screen, and only once the window had focus.
// tests/chat-resume.test.cjs checks both copies decide alike.

/** The error the main process gives a card whose turn ended only because the app restarted. */
const RESTART_INTERRUPTED = /process ended before it finished \(the app restarted\)/;
/** Only work going on within this long resumes; an older run was abandoned, not interrupted. */
const RESTART_RESUME_WINDOW_MS = 24 * 60 * 60_000;
const RESTART_ATTEMPT_LIMIT = 8;
const AUTO_RETRY_ATTEMPT_LIMIT = 8;
const NEEDS_PERSON = /auth_unavailable|invalid[_ -]?auth|account[^\n]*(?:exhaust|unavail)|pool[^\n]*exhaust|sign[- ]?in|reauth|HTTP (?:401|403)|insufficient_quota|usage_limit_reached|quota[^\n]{0,40}(?:exceed|exhaust|reached|used up)|(?:exceed|reach|hit)(?:ed)? your[^\n]{0,40}(?:quota|limit)|API Error: (?:400|404|422)\b/i;

/** The newest time any card of the run started, current receipts and earlier attempts alike (0: none). */
function newestStart(mission) {
  let newest = 0;
  for (const node of mission.nodes ?? []) {
    newest = Math.max(newest, Number(node.receipt?.started_at_ms) || 0);
    for (const entry of node.history ?? []) newest = Math.max(newest, Number(entry?.started_at_ms) || 0);
  }
  return newest;
}

/**
 * "retry": a step ended only because the app restarted mid-turn (or, with "Retry automatically" on,
 * a single chat's failed step nothing retried). "continue": work is left, a card still running on
 * an agent host that outlived the app or cards that never started. Null: it waits for the person.
 */
function restartResume(mission, now = Date.now(), { autoRetry = false } = {}) {
  if (!mission || mission.cancelled || mission.paused) return null;
  const nodes = mission.nodes ?? [];
  const newest = newestStart(mission);
  if (newest && now - newest > RESTART_RESUME_WINDOW_MS) return null;
  const restarted = nodes.filter(node => ["held", "failed"].includes(node.state) && RESTART_INTERRUPTED.test(String(node.receipt?.error || "")));
  const autoRetried = autoRetry && mission.execution_mode === "single" ? nodes.filter(node => node.state === "held"
    && !restarted.includes(node) && !NEEDS_PERSON.test(String(node.receipt?.error || ""))) : [];
  if (nodes.some(node => node.state === "reserved"
    || (node.state === "held" && !restarted.includes(node) && !autoRetried.includes(node)))) return null;
  if (restarted.length || autoRetried.length) {
    return restarted.every(node => (node.history?.length ?? 0) < RESTART_ATTEMPT_LIMIT)
      && autoRetried.every(node => (node.history?.length ?? 0) < AUTO_RETRY_ATTEMPT_LIMIT) ? "retry" : null;
  }
  return nodes.some(node => ["running", "pending"].includes(node.state)) ? "continue" : null;
}

module.exports = { RESTART_INTERRUPTED, RESTART_RESUME_WINDOW_MS, restartResume };
