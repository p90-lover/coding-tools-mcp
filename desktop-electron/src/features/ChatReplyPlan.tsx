import type { ReactNode } from "react";
import type { ChatStyle, PlanStep, ReplyPlan } from "./chat-reply-plan";

/**
 * A reply's steps in the chat style picked from the header menu (chat-reply-plan): Codex's plan
 * card, Copilot's step timeline, a focus line, or Windsurf's action chips. Transcript draws nothing
 * here; its work rows are the steps.
 */

const STATE_LABEL: Record<PlanStep["state"], string> = { done: "Done", running: "Running", pending: "To do", failed: "Failed" };

function StepMark({ state }: { state: PlanStep["state"] }) {
  return <span className={`cx-rplan-mark is-${state}`} role="img" aria-label={STATE_LABEL[state]}>
    {state === "done" ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
      : state === "failed" ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        : null}
  </span>;
}

/** "3 of 5 steps" for the agent's own list, "4 steps" for one read from its work. */
function planCount(plan: ReplyPlan): string {
  const total = plan.steps.length;
  return plan.source === "agent" ? `${plan.done} of ${total} done` : `${total} ${total === 1 ? "step" : "steps"}`;
}

export function ReplyPlanView({ plan, style, live }: { plan: ReplyPlan; style: ChatStyle; live: boolean }) {
  if (style === "transcript" || !plan.steps.length) return null;
  const current = plan.steps.find((step) => step.state === "running") ?? plan.steps.find((step) => step.state === "pending");
  if (style === "focus") {
    // One line: where the turn is now, or what it came to. The work stays behind Show work.
    const index = current ? plan.steps.indexOf(current) : -1;
    return <p className={`cx-rplan-focus${live ? " is-live" : ""}`} role={live ? "status" : undefined}>
      {current ? <><span className="cx-rplan-focus-at">Step {index + 1} of {plan.steps.length}</span> · {current.title}</>
        : <>{planCount(plan)} · {plan.steps.reduce((sum, step) => sum + step.actions.reduce((n, action) => n + action.count, 0), 0)} tool calls</>}
      {live && plan.steps.length > 1 ? <span className="cx-rplan-bar" aria-hidden="true"><span style={{ width: `${Math.round(100 * plan.done / plan.steps.length)}%` }} /></span> : null}
    </p>;
  }
  return <section className={`cx-rplan is-${style}`} aria-label="Plan">
    <header className="cx-rplan-head">
      <span className="cx-rplan-title">{plan.source === "agent" ? "Plan" : "Steps"}</span>
      <span className="cx-rplan-count">{planCount(plan)}</span>
    </header>
    <ol className="cx-rplan-steps">
      {plan.steps.map((step, index) => <li key={step.key} className={`cx-rplan-step is-${step.state}`} aria-current={step === current ? "step" : undefined}>
        <StepMark state={step.state} />
        <div className="cx-rplan-body">
          <span className="cx-rplan-step-title">{style === "timeline" ? <span className="cx-rplan-num">{index + 1}.</span> : null}{step.title}</span>
          {style === "cascade" && step.actions.length ? <span className="cx-rplan-chips">
            {step.actions.map((action) => <span key={action.activity} className={`cx-rplan-chip is-${action.activity}`}>{action.words}</span>)}
          </span> : null}
          {style !== "cascade" && step.finish ? <span className={`cx-rplan-finish${step.state === "failed" ? " is-failed" : ""}`}>{step.finish}</span>
            : style === "cascade" && step.state === "failed" && step.finish ? <span className="cx-rplan-finish is-failed">{step.finish}</span> : null}
        </div>
      </li>)}
    </ol>
  </section>;
}

/** Where a goal's new round starts: its number and why the last round did not meet the goal. */
export function RoundDivider({ round, reason, stamp }: { round: number; reason: string; stamp?: ReactNode }) {
  return <div className="cx-round" role="separator" aria-label={`Round ${round}`}>
    <span className="cx-round-line" aria-hidden="true" />
    <div className="cx-round-body">
      <span className="cx-round-title">Round {round} · goal not met yet</span>
      <span className="cx-round-reason" title={reason}>{reason}</span>
    </div>
    {stamp}
  </div>;
}

/** Earlier goal rounds folded into one row, opened in place. */
export function FoldedRounds({ first, last, open, onToggle }: { first: number; last: number; open: boolean; onToggle: () => void }) {
  return <button type="button" className="cx-round-fold" aria-expanded={open} onClick={onToggle}>
    {open ? `Fold rounds ${first}–${last}` : `Rounds ${first}–${last} · ${last - first + 1} earlier rounds`}
  </button>;
}
