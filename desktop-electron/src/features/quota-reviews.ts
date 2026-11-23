import { getCodingToolsClient } from "../api/client";

// The app stores CPA review consent separately from the chat's chosen permission mode.
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

/**
 * Turns the switch on or off in main (the person's click: main takes it only from the focused window),
 * then publishes what main kept. Turned on, main reviews again at once every request it held for it.
 */
export function setQuotaReviews(on: boolean): Promise<boolean> {
  return getCodingToolsClient().apps
    .call({ moduleId: "agent-orchestrator", operation: "chat_model_judges", arguments: { meteredReviews: on } })
    .then((outer) => publishQuotaReviews(((outer as { result?: { meteredReviews?: unknown } }).result ?? outer as { meteredReviews?: unknown }).meteredReviews === true));
}

/** Calls `listener` whenever the switch changes in this window. Returns the unsubscribe. */
export function onQuotaReviews(listener: (on: boolean | null) => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  const changed = () => listener(known);
  window.addEventListener(CHANGED, changed);
  return () => window.removeEventListener(CHANGED, changed);
}
