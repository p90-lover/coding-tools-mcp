import { useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";

/**
 * "Let the model judge" (chat_model_judges): what would wait for you, a request the command reviewer
 * hands on or a goal round that ended needing you or failed, is judged by the model instead, and it
 * may end a goal that cannot safely go on. The user: "if its waiting me to judge, add a setting that
 * allow the model to judge it … until end and it can safety kill the goal". The preference lives in
 * the app, so it holds for every chat and after a restart; shown where something waits on you.
 */
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
  return <label className={`cx-auto-retry cx-model-judges${compact ? " is-compact" : ""}`}
    title="Requests the reviewer would leave to you, and goal rounds that end needing you, are judged by the model. It may end a goal that cannot safely go on">
    <input type="checkbox" role="switch" checked={on === true} disabled={on === null} onChange={(event) => {
      const next = event.target.checked;
      setOn(next);
      call({ enabled: next }).then(setOn, () => setOn(!next));
    }} />
    <span className="cx-switch" aria-hidden="true" />
    <span>{compact ? "Model judges" : "Let the model judge"}</span>
  </label>;
}
