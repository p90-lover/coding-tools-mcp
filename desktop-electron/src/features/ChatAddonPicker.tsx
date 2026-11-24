import type { ReactNode } from "react";

export const CHAT_PANEL_TITLES = {
  overview: "Overview", preview: "Preview", terminal: "Terminal", changes: "Changes",
  files: "Files", subagents: "Subagents", plan: "Plan", new: "Add-ons",
} as const;
export type WorkbenchTab = keyof typeof CHAT_PANEL_TITLES;

const PANEL_GROUPS = [
  { label: "Conversation", panels: [
    { id: "overview", blurb: "Context, tasks and usage" },
    { id: "plan", blurb: "Read the plan and tasks" },
    { id: "subagents", blurb: "The helpers it started and their work" },
  ] },
  { label: "Workspace", panels: [
    { id: "preview", blurb: "The chat's browser" },
    { id: "terminal", blurb: "Commands and a shell" },
    { id: "changes", blurb: "Its worktree's diff" },
    { id: "files", blurb: "Browse its worktree" },
  ] },
] as const satisfies ReadonlyArray<{ label: string; panels: ReadonlyArray<{ id: Exclude<WorkbenchTab, "new">; blurb: string }> }>;

export function ChatAddonPicker({ hasSession, hasPlan, onOpen, recents }: {
  hasSession: boolean;
  hasPlan: boolean;
  onOpen: (tab: WorkbenchTab) => void;
  recents?: ReactNode;
}) {
  return <div className="cx-newtab" aria-label="Chat add-ons">
    {PANEL_GROUPS.map(({ label, panels }) => {
      const available = panels.filter(({ id }) => id === "plan" ? hasPlan : hasSession);
      return available.length ? <section key={label} aria-label={label}>
        <p className="cx-newtab-label">{label}</p>
        <div className="cx-newtab-tools">
          {available.map(({ id, blurb }) => <button key={id} type="button" onClick={() => onOpen(id)}>
            <span>{CHAT_PANEL_TITLES[id]}</span><small>{blurb}</small>
          </button>)}
        </div>
      </section> : null;
    })}
    {!hasSession && !hasPlan ? <p className="cx-workbench-empty">Add-ons will be available once this chat has an agent.</p> : null}
    {recents}
  </div>;
}
