import { useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";

/**
 * "Let the model judge" (chat_model_judges): what would wait for you, a request the command reviewer
 * hands on or a goal round that ended needing you or failed, is judged by the model instead, and it
 * may end a goal that cannot safely go on. The user: "if its waiting me to judge, add a setting that
 * allow the model to judge it … until end and it can safety kill the goal". The preference lives in
 * the app, so it holds for every chat and after a restart; shown where something waits on you.
 */
const DETAIL = "Requests the reviewer would leave to you, and goal rounds that end needing you, are judged by the model. When Auto Review can't answer, the chat's own model judges, on that model's quota. It may end a goal that cannot safely go on";

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
