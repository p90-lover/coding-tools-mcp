import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Surface } from "../types";
import "./app-flow.css";

// Runtime > App layout > How it works: the path one message takes through Coding Tools, drawn
// as steps joined by what each one hands to the next. It plays once when the tab opens (a
// highlight walks the steps and a dot carries each hand-off), and again on Replay; hovering or
// focusing a step replays only its own hand-off. Nothing loops: an animation that never ends keeps
// the compositor drawing every frame (seen 2026-11-11, an opacity pulse held the GPU process at
// ~15% CPU), and the person games on this machine. Reduced motion shows the same flow, still.

export interface AppFlowStep {
  id: string;
  title: string;
  /** What happens at this step, in one sentence. */
  does: string;
  /** The app's own pages this step is, which the person can open. */
  pointsTo: { label: string; surface: Surface }[];
  /** What the step passes to the next one (the last passes back to the first). */
  handsOff: string;
}

export const APP_FLOW: readonly AppFlowStep[] = [
  {
    id: "you",
    title: "You",
    does: "Type a message, a /goal or a /schedule in a chat, and pick its model and permissions.",
    pointsTo: [{ label: "Chat", surface: "agent-orchestrator" }],
    handsOff: "Your message and the chat's settings",
  },
  {
    id: "chat",
    title: "Chat & workflow",
    does: "Saves the turn, queues it behind a running one, and decides whether one agent or a team takes it.",
    pointsTo: [
      { label: "Chat", surface: "agent-orchestrator" },
      { label: "Orchestrator Team", surface: "agent-orchestrator-teams" },
    ],
    handsOff: "A run: one card per agent, with its route",
  },
  {
    id: "orchestrator",
    title: "Agent Orchestrator",
    does: "Starts each card's agent (Claude Code, Codex and others) in its own workspace and keeps its session.",
    pointsTo: [{ label: "Subagents", surface: "subagents" }],
    handsOff: "The prompt, inside a live agent session",
  },
  {
    id: "models",
    title: "Models",
    does: "The agent thinks through its model, reached through CPA with your provider accounts and quotas.",
    pointsTo: [
      { label: "Providers", surface: "providers" },
      { label: "CPA", surface: "cpa" },
    ],
    handsOff: "Replies and the tool calls the model wants",
  },
  {
    id: "tools",
    title: "Tools",
    does: "Tool calls run on this computer: files and commands, the browser, computer use and MCP servers.",
    pointsTo: [
      { label: "MCP", surface: "mcp" },
      { label: "Computer use", surface: "computer-use" },
      { label: "Plugins", surface: "plugins" },
    ],
    handsOff: "Each command or action that needs a yes",
  },
  {
    id: "review",
    title: "Approvals",
    does: "Approve for me and the reviewers answer routine requests; only what needs you reaches you.",
    pointsTo: [{ label: "Chat", surface: "agent-orchestrator" }],
    handsOff: "Allow or deny, with the reason",
  },
  {
    id: "result",
    title: "Back in the chat",
    does: "The reply, changed files and terminal output stream into the chat; a goal checks the result and starts its next round.",
    pointsTo: [{ label: "Chat", surface: "agent-orchestrator" }],
    handsOff: "The answer, and the next round if a goal is not met yet",
  },
];

/** How long one step stays lit while the flow plays. */
export const APP_FLOW_STEP_MS = 900;

/** Whether the person asked for less motion (no window: tests and server rendering read as yes). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window === "undefined" || typeof window.matchMedia !== "function"
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

export function AppFlow({
  active,
  canOpen,
  onOpen,
  steps = APP_FLOW,
}: {
  active: boolean;
  canOpen: (surface: string) => boolean;
  onOpen: (surface: Surface) => void;
  steps?: readonly AppFlowStep[];
}) {
  // The step lit by the play-through (-1: not playing), and the one whose details are shown.
  const [playing, setPlaying] = useState(-1);
  const [selected, setSelected] = useState(0);
  const [round, setRound] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Plays only while the page is shown and the window visible, and once per Replay.
    if (!active || prefersReducedMotion() || (typeof document !== "undefined" && document.hidden)) return undefined;
    let index = 0;
    const next = () => {
      setPlaying(index);
      setSelected(index);
      index += 1;
      timer.current = index < steps.length ? setTimeout(next, APP_FLOW_STEP_MS) : setTimeout(() => setPlaying(-1), APP_FLOW_STEP_MS);
    };
    next();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setPlaying(-1);
    };
  }, [active, round, steps.length]);

  const current = steps[selected] ?? steps[0];
  return (
    <section className="app-flow" aria-label="How Coding Tools works">
      <div className="app-flow-head">
        <p>Follow one message from you to the answer. Each arrow says what that step hands to the next.</p>
        <button type="button" className="button-secondary" onClick={() => setRound((value) => value + 1)} disabled={playing >= 0}>
          {playing >= 0 ? "Playing…" : "Replay"}
        </button>
      </div>
      <ol className={`app-flow-steps${playing >= 0 ? " is-playing" : ""}`}>
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          const state = index === playing ? " is-current" : playing > index ? " is-done" : "";
          return (
            <li key={step.id} className={`app-flow-step${state}${index === selected ? " is-selected" : ""}`}
              style={{ "--app-flow-index": index } as CSSProperties}>
              <button
                type="button"
                className="app-flow-card"
                aria-current={index === playing ? "step" : undefined}
                aria-pressed={index === selected}
                onClick={() => setSelected(index)}
              >
                <span className="app-flow-number" aria-hidden="true">{index + 1}</span>
                <strong>{step.title}</strong>
                <span className="app-flow-does">{step.does}</span>
              </button>
              <div className={`app-flow-handoff${last ? " is-return" : ""}${index === playing ? " is-sending" : ""}`}>
                <span className="app-flow-track" aria-hidden="true"><span className="app-flow-packet" /></span>
                <span className="app-flow-label">
                  {last ? "Back to you: " : "Hands off: "}
                  {step.handsOff}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="app-flow-detail" aria-live="polite">
        <strong>{current.title}</strong>
        <p>{current.does}</p>
        <div className="app-flow-links">
          <span>Points to</span>
          {current.pointsTo.map((target) => (
            <button key={target.surface + target.label} type="button" className="button-secondary"
              disabled={!canOpen(target.surface)} onClick={() => onOpen(target.surface)}>
              {target.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
