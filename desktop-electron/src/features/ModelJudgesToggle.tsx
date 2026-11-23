import { useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import { knownQuotaReviews, onQuotaReviews, refreshQuotaReviews, setQuotaReviews } from "./quota-reviews";

const QUOTA_DETAIL = "Reviews by a CPA model use your accounts' quota (Native Guardian uses a little too). While this is off, a request Guardian can't decide, or that needs a CPA review, waits for you even with Let the model judge on. Turned on, those waiting requests are reviewed at once. The same switch is in Settings > Chat";

/**
 * "Allow quota-based reviews", on a request that waits on it. Live 2026-11-23: with Let the model judge
 * on and this off, cards read "Quota-based reviews are off" or "Native Guardian could not decide" and
 * waited, while the only switch on them was the judge's, which was already on.
 */
export function QuotaReviewsToggle() {
  const [on, setOn] = useState<boolean | null>(() => knownQuotaReviews());
  useEffect(() => {
    let live = true;
    const unsubscribe = onQuotaReviews((value) => { if (live) setOn(value); });
    refreshQuotaReviews().then((value) => { if (live) setOn(value); }, () => { /* keeps the last known */ });
    return () => { live = false; unsubscribe(); };
  }, []);
  const flip = (next: boolean) => {
    setOn(next);
    setQuotaReviews(next).then(setOn, () => setOn(!next));
  };
  return <label className="cx-auto-retry cx-model-judges cx-quota-reviews" title={QUOTA_DETAIL}>
    <input type="checkbox" role="switch" checked={on === true} disabled={on === null} onChange={(event) => flip(event.target.checked)} />
    <span className="cx-switch" aria-hidden="true" />
    <span>Allow quota-based reviews</span>
  </label>;
}

/**
 * "Let the model judge" (chat_model_judges): what would wait for you, a request the command reviewer
 * hands on or a goal round that ended needing you or failed, is judged by the model instead, and it
 * may end a goal that cannot safely go on. The user: "if its waiting me to judge, add a setting that
 * allow the model to judge it … until end and it can safety kill the goal". The preference lives in
 * the app, so it holds for every chat and after a restart; shown where something waits on you.
 */
const DETAIL = "In Approve for me, eligible requests are answered without a manual approval prompt. Guardian is tried first for supported shell commands. Model fallback uses quota only when Allow quota-based reviews is also on. Unsafe requests are not approved, and requests that require you still wait for you. The judge may also end a goal that cannot safely go on";

/** Lucide's scale, the mark of the goal bar's Model judges toggle. */
function JudgeGlyph() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" /><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
    <path d="M7 21h10" /><path d="M12 3v18" /><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
  </svg>;
}

export function ModelJudgesToggle({ compact = false }: { compact?: boolean }) {
  const [on, setOn] = useState<boolean | null>(null);
  const call = (args: { enabled: boolean } | Record<string, never>) => getCodingToolsClient().apps
    .call({ moduleId: "agent-orchestrator", operation: "chat_model_judges", arguments: args })
    .then((outer) => Boolean(((outer as { result?: { modelJudges?: boolean } }).result ?? outer as { modelJudges?: boolean }).modelJudges));
  useEffect(() => {
    let live = true;
    call({}).then((value) => { if (live) setOn(value); }, () => { if (live) setOn(false); });
    return () => { live = false; };
  }, []);
  const flip = (next: boolean) => {
    setOn(next);
    call({ enabled: next }).then(setOn, () => setOn(!next));
  };
  // On the goal bar it is one of its icon buttons, pressed while on; hovering says what it does.
  if (compact) {
    return <button type="button" className="cx-goal-icon cx-model-judges-toggle" aria-pressed={on === true} aria-label="Model judges"
      disabled={on === null} title={`Model judges: ${on ? "on" : "off"}\n\n${DETAIL}.\n\nClick to turn it ${on ? "off" : "on"}`}
      onClick={() => flip(!on)}><JudgeGlyph /></button>;
  }
  return <label className="cx-auto-retry cx-model-judges" title={DETAIL}>
    <input type="checkbox" role="switch" checked={on === true} disabled={on === null} onChange={(event) => flip(event.target.checked)} />
    <span className="cx-switch" aria-hidden="true" />
    <span>Let the model judge</span>
  </label>;
}
