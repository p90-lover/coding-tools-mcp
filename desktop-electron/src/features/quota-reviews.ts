import { getCodingToolsClient } from "../api/client";

/**
 * "Allow quota-based reviews" (chat_model_judges' meteredReviews), kept by the app in main. While it
 * is off, this app's reviews stop before any model call (quotaReviewBlocked in
 * agent-orchestrator-workflow): "Approve for me" can't answer for you and every request waits. The
 * user saw that as Auto Review turning itself off, with the permission chip still saying "Active
 * now". Settings > Chat publishes the switch here, so an open chat's chip follows it at once.
 */
const CHANGED = "coding-tools:quota-reviews-changed";
let known: boolean | null = null;

/** The switch as main last reported it, or null before the first read. */
export function knownQuotaReviews(): boolean | null { return known; }

/** Records what main kept and tells open chats in this window. */
export function publishQuotaReviews(on: boolean): boolean {
  if (known === on) return on;
  known = on;
  try { window.dispatchEvent(new Event(CHANGED)); } catch { /* no window (tests) */ }
  return on;
}

/** Reads the switch from main (one bridge call, no change) and publishes it. */
export function refreshQuotaReviews(): Promise<boolean> {
  return getCodingToolsClient().apps
    .call({ moduleId: "agent-orchestrator", operation: "chat_model_judges", arguments: {} })
    .then((outer) => publishQuotaReviews(((outer as { result?: { meteredReviews?: unknown } }).result ?? outer as { meteredReviews?: unknown }).meteredReviews === true));
}

/** Calls `listener` whenever the switch changes in this window. Returns the unsubscribe. */
export function onQuotaReviews(listener: (on: boolean | null) => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  const changed = () => listener(known);
  window.addEventListener(CHANGED, changed);
  return () => window.removeEventListener(CHANGED, changed);
}
