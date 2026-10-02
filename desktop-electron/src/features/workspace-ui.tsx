import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getCodingToolsClient } from "../api/client";
import type { WorkspaceSummary } from "../api/contracts";
import "./workspace-ui.css";

// Shared building blocks for the Workspace, Workspace Authentication and Native Codex pages.

export type Tone = "ok" | "warn" | "error" | "idle" | "busy";

export const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Every local workspace, paged in full; `loaded` stays false until the first list arrives. */
export function useWorkspaces(setError: (error: string | null) => void) {
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items: WorkspaceSummary[] = [];
      let cursor: number | null = 0;
      while (cursor !== null) {
        const page = await getCodingToolsClient().workspaces.list({ cursor, limit: 100 });
        items.push(...page.items);
        cursor = page.nextCursor;
      }
      setWorkspaces(items);
      setLoaded(true);
      return items;
    } catch (cause) {
      setError(errorText(cause));
      return null;
    } finally {
      setLoading(false);
    }
  }, [setError]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { workspaces, loaded, loading, refresh };
}

export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return <span className={`wsx-pill is-${tone}`} title={title}><span className="wsx-dot" aria-hidden="true" />{children}</span>;
}

export function Card({ title, aside, children, className = "" }: {
  title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`wsx-card ${className}`.trim()}>
      <header className="wsx-card-head"><h2>{title}</h2>{aside ? <div className="wsx-card-aside">{aside}</div> : null}</header>
      {children}
    </section>
  );
}

/** A message shown next to the control that caused it, optionally with one follow-up action. */
export function Notice({ tone = "ok", children, action }: { tone?: "ok" | "warn"; children: ReactNode; action?: ReactNode }) {
  return <div className={`wsx-notice is-${tone}`} role="status"><span>{children}</span>{action}</div>;
}

export function Segmented<T extends string>({ value, options, onChange, disabled, label }: {
  value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void; disabled?: boolean; label: string;
}) {
  return (
    <div className="wsx-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value}
          className={value === option.value ? "is-active" : ""} disabled={disabled} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`wsx-field${wide ? " is-wide" : ""}`}>
      <span className="wsx-field-label">{label}</span>
      {children}
      {hint ? <span className="wsx-field-hint">{hint}</span> : null}
    </label>
  );
}

export function WorkspacePicker({ workspaces, value, onChange, disabled, label }: {
  workspaces: readonly WorkspaceSummary[]; value: string; onChange: (id: string) => void; disabled?: boolean; label: string;
}) {
  return (
    <select className="wsx-select" aria-label={label} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>
      {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
    </select>
  );
}
