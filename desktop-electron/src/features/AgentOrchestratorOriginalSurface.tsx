import { useEffect, useRef, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import type { JsonObject } from "../api/contracts";
import "./original-ui.css";
import "./agent-orchestrator-original.css";

async function callUpstream(operation: string, args: JsonObject = {}) {
  const response = await getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation, arguments: args });
  const result = response.result as Record<string, unknown>;
  if (!response.ok || result?.ok === false) throw new Error(String(result?.error || result?.reason || "Agent Orchestrator is unavailable"));
  return result;
}

const STATE_LABEL: Record<string, string> = { ready: "Connected", starting: "Starting", stopping: "Stopping", stopped: "Stopped", error: "Not connected" };

/**
 * Hosts the source-built AO renderer in a native view sized to this element.
 * `hostbar={false}` is used inside Runtime, whose own toolbar already switches views.
 */
export type AoTerminalView = { handle: string; generation: string; title: string };

export function AgentOrchestratorOriginalSurface({ openMissions, projectBoard = false, workspaceId, hostbar = true, terminal }: {
  openMissions: () => void; projectBoard?: boolean; workspaceId?: string; hostbar?: boolean;
  /** Show one AO terminal (e.g. the Antigravity CLI) instead of the AO app. */
  terminal?: AoTerminalView;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [state, setState] = useState("starting");
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let disposed = false;
    let ready = false;
    let animation = 0;
    const bounds = () => {
      const rectangle = panel.current!.getBoundingClientRect();
      return { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height };
    };
    const resize = () => {
      cancelAnimationFrame(animation);
      animation = requestAnimationFrame(() => {
        if (ready && !disposed) void callUpstream("upstream_bounds", { bounds: bounds() }).catch(() => undefined);
      });
    };
    setError(""); setState("starting");
    void callUpstream("upstream_show", { bounds: bounds(), projectBoard, ...(workspaceId ? { workspaceId } : {}),
      ...(terminal ? { terminal: { handle: terminal.handle, generation: terminal.generation, title: terminal.title } } : {}) }).then(() => {
      if (disposed) return;
      ready = true; setState("ready"); resize();
    }).catch((cause) => { if (!disposed) { setState("error"); setError(String(cause.message || cause)); } });
    const observer = new ResizeObserver(resize);
    observer.observe(panel.current!);
    window.addEventListener("resize", resize);
    const timer = setInterval(() => {
      if (ready) void callUpstream("upstream_status").then((result) => {
        if (!disposed) setState(String(result.state));
      }).catch((cause) => {
        if (disposed) return;
        ready = false;
        setState("error"); setError(String(cause.message || cause));
        void callUpstream("upstream_hide").catch(() => undefined);
      });
    }, 5000);
    return () => {
      disposed = true; clearInterval(timer); cancelAnimationFrame(animation);
      observer.disconnect(); window.removeEventListener("resize", resize);
      void callUpstream("upstream_hide").catch(() => undefined);
    };
  }, [generation, projectBoard, workspaceId, terminal?.handle, terminal?.generation, terminal?.title]);

  const reconnect = () => setGeneration((value) => value + 1);
  return (
    <section className={`original-ui-surface ao-original${hostbar ? "" : " is-embedded"}`} aria-label={projectBoard ? "Agent Orchestrator project board" : "Original Agent Orchestrator"}>
      {hostbar ? <header className="original-ui-hostbar ao-hostbar">
        <strong>Agent Orchestrator</strong>
        <span className={`ao-status-dot status-${state}`} role="status" title={error || STATE_LABEL[state] || state}>{STATE_LABEL[state] || state}</span>
        <div className="original-ui-hostbar-actions">
          <button type="button" onClick={openMissions} title="Open the mission canvas">{projectBoard ? "Canvas" : "Missions"}</button>
          <button type="button" className="ao-icon-button" aria-label="Reconnect panel" title="Reconnect panel" onClick={reconnect} disabled={state === "starting"}>↻</button>
          <button type="button" className="ao-icon-button" aria-label="Stop runtime" title="Stop runtime" disabled={state !== "ready"} onClick={() => {
            void callUpstream("upstream_stop").then((result) => { if (!result.cancelled) setState("stopped"); }).catch((cause) => setError(cause.message));
          }}>■</button>
        </div>
      </header> : null}
      <div ref={panel} className="ao-original-viewport">
        {state !== "ready" ? <div className="original-ui-frame-empty" role="status">
          <strong>{state === "starting" ? "Opening Agent Orchestrator…" : STATE_LABEL[state] || state}</strong>
          {error ? <p>{error}</p> : null}
          {state === "error" || state === "stopped" ? <button type="button" onClick={reconnect}>Try again</button> : null}
        </div> : null}
      </div>
    </section>
  );
}
