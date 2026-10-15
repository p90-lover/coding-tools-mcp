import { useEffect, useRef, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import { cpaProviderOf } from "./AgentOrchestratorRoleEditor";
import { FloatingLayer } from "./ChatMenu";
import { contextFraction, tokensShort } from "./ao-chat";

// The composer's context meter, as Claude Code shows one: a ring filling as the chat's agent
// session uses its context window, and on click what AO knows about it. That is the agent's own
// report (ACP usage updates, Codex token usage): context used of the window, the conversation's
// token spend, the account's rate limits, its tool servers and the last compaction. No agent
// reports a per-category split, so the open panel estimates one from the chat's history and
// draws it as Claude Code's /context does (a grid of the window, one cell per 1%). A model CPA
// serves from its Codex accounts shows each account's 5-hour and weekly limits instead (CPA
// Helper's quota, through the cpa_quota operation), worded as Claude Code words plan limits.

type Usage = {
  contextUsed: number | null; contextWindow: number | null;
  inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null; totalTokens: number | null;
  cost: number | null; currency: string | null;
};
type RateLimits = {
  primaryUsedPercent: number | null; secondaryUsedPercent: number | null;
  primaryResetsInSeconds: number | null; secondaryResetsInSeconds: number | null; planLabel: string | null;
};
/** The open panel's estimated split of the context (ao-context-breakdown.cjs). */
export type ContextBreakdown = {
  used: number; window: number | null; free: number | null;
  categories: { id: string; label: string; tokens: number }[];
  counts: { messages: number; toolCalls: number }; sinceCompaction: boolean; complete: boolean;
};
export type ChatContextSnapshot = {
  controller: string | null; usage: Usage | null; rateLimits: RateLimits | null; compactedAt: string | null;
  planLabel: string | null; mcpServers: { name: string; status: string }[]; breakdown?: ContextBreakdown | null;
};

/** One quota window of a CPA Codex account (cpa-quota.cjs): percent used and when it resets (ms). */
type QuotaWindow = { usedPercent: number; resetsAt: number | null; windowSeconds: number | null };
export type CpaQuotaAccount = {
  id: string; label: string; plan: string | null; disabled: boolean; paused: boolean;
  session: QuotaWindow | null; week: QuotaWindow | null; checkedAt: number | null; error: string | null;
};
type CpaQuota = { available: boolean; reason?: string; accounts?: CpaQuotaAccount[] };

const POLL_MS = 4_000;
const QUOTA_POLL_MS = 60_000;
const DETAIL_POLL_MS = 10_000;
/** Matches .cx-context-panel's width in codex-chat.css. */
const PANEL_WIDTH = 380;
const RING = 18;

/** "Resets 7:05 PM" today, else "Resets Oct 21, 10:00 AM", as Claude Code words plan limits. */
export function resetLabel(at: number | null, now = Date.now()): string {
  if (!at || !Number.isFinite(at) || at <= now) return "";
  const when = new Date(at);
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === when.toDateString()
    ? `Resets ${time}` : `Resets ${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** "checked 3 min ago" for a quota CPA Helper read earlier. */
function checkedLabel(at: number | null, now = Date.now()): string {
  if (!at) return "not checked yet";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1 ? "checked just now" : minutes < 60 ? `checked ${minutes} min ago` : `checked ${Math.round(minutes / 60)} h ago`;
}

const tone = (fraction: number | null) => (fraction === null ? "unknown" : fraction >= 0.85 ? "high" : fraction >= 0.6 ? "mid" : "low");

/** A plan usage limit as Claude Code shows one: its name, a bar, "N% used" and when it resets. */
function LimitRow({ name, used, resetsAt }: { name: string; used: number; resetsAt: number | null }) {
  const percent = Math.max(0, Math.min(100, Math.round(used)));
  const resets = resetLabel(resetsAt);
  return <div className="cx-context-limit">
    <div><span>{name}</span><b>{percent}% used</b></div>
    <div className={`cx-context-bar is-${tone(percent / 100)}`}><span style={{ width: `${percent}%` }} /></div>
    {resets ? <small>{resets}</small> : null}
  </div>;
}

const GRID_CELLS = 100;

/** Claude Code's /context grid: one cell per 1% of the window, in category order, each category
 * that holds anything getting at least one cell; the rest is free space. */
export function contextGrid(categories: { id: string; tokens: number }[], window: number): string[] {
  const cells: string[] = [];
  let total = 0;
  for (const category of categories) {
    if (category.tokens <= 0) continue;
    total += category.tokens;
    const end = Math.min(GRID_CELLS, Math.max(cells.length + 1, Math.round((total / window) * GRID_CELLS)));
    while (cells.length < end) cells.push(category.id);
  }
  while (cells.length < GRID_CELLS) cells.push("free");
  return cells;
}

const share = (tokens: number, window: number | null) => (window ? ` (${((tokens / window) * 100).toFixed(1)}%)` : "");

/** The panel's top half, laid out as Claude Code's /context: the grid, and beside it the model,
 * the total and each category's tokens. */
function ContextUsage({ breakdown, model }: { breakdown: ContextBreakdown; model?: string }) {
  const { window, used, free } = breakdown;
  // An agent can report more in use than its window; shares and the grid then measure against
  // the larger figure so they never pass 100%, and the total reads full, as contextFraction does.
  const scale = window ? Math.max(window, used) : null;
  const fraction = contextFraction({ contextUsed: used, contextWindow: window });
  const rows = [...breakdown.categories.filter((category) => category.tokens > 0),
    ...(free !== null ? [{ id: "free", label: "Free space", tokens: free }] : [])];
  return <div className="cx-context-usage">
    {scale ? <div className="cx-context-grid" aria-hidden="true">
      {contextGrid(breakdown.categories, scale).map((id, index) => <span key={index} className={`is-${id}`} />)}
    </div> : null}
    <div className="cx-context-legend">
      <p>{model ? <><b>{model}</b> · </> : null}{tokensShort(used)}{window ? `/${tokensShort(window)}` : ""} tokens{fraction !== null ? ` (${Math.round(fraction * 100)}%)` : ""}</p>
      <ul>{rows.map((row) => <li key={row.id}><i className={`is-${row.id}`} aria-hidden="true" />
        <span>{row.label}:</span> <b>{tokensShort(row.tokens)}</b>{share(row.tokens, scale)}</li>)}</ul>
    </div>
  </div>;
}

export function ChatContextMeter({ sessionId, agentLabel, model, canCompact, onCompact }: {
  sessionId?: string;
  agentLabel?: string;
  /** The session's route model; a "cpa/…" model served by CPA's Codex accounts shows their limits. */
  model?: string;
  canCompact: boolean;
  onCompact: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ChatContextSnapshot | null>(null);
  const [quota, setQuota] = useState<CpaQuota | null>(null);
  const onCpaCodex = cpaProviderOf(model)?.toLowerCase() === "codex";
  const [open, setOpen] = useState<{ left: number; bottom: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSnapshot(null);
    if (!sessionId) return undefined;
    let live = true;
    const read = () => void getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation: "chat_context", arguments: { sessionIds: [sessionId] } })
      .then((outer) => {
        const sessions = (outer.result as { sessions?: Record<string, ChatContextSnapshot> } | undefined)?.sessions;
        if (live) setSnapshot(sessions?.[sessionId] ?? null);
      })
      .catch(() => undefined);
    read();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") read(); }, POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [sessionId]);

  // CPA's Codex accounts' limits change slowly and CPA Helper caches them: read once a minute while
  // the window is visible, and again when the panel opens.
  useEffect(() => {
    setQuota(null);
    if (!onCpaCodex) return undefined;
    let live = true;
    const read = () => void getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation: "cpa_quota", arguments: {} })
      .then((outer) => { if (live) setQuota((outer.result as CpaQuota | undefined) ?? null); })
      .catch(() => undefined);
    read();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") read(); }, QUOTA_POLL_MS);
    const onOpen = () => read();
    button.current?.addEventListener("click", onOpen);
    const target = button.current;
    return () => { live = false; window.clearInterval(timer); target?.removeEventListener("click", onOpen); };
  }, [onCpaCodex]);

  // The category split reads the chat's history, so only while the panel is open.
  const [breakdown, setBreakdown] = useState<ContextBreakdown | null>(null);
  const isOpen = Boolean(open);
  useEffect(() => {
    setBreakdown(null);
    if (!isOpen || !sessionId) return undefined;
    let live = true;
    // Each read can page through thousands of timeline entries: one at a time, and none while hidden.
    let pending = false;
    const read = () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      void getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation: "chat_context", arguments: { sessionIds: [sessionId], detail: true } })
        .then((outer) => {
          const session = (outer.result as { sessions?: Record<string, ChatContextSnapshot> } | undefined)?.sessions?.[sessionId];
          if (live) setBreakdown(session?.breakdown ?? null);
        })
        .catch(() => undefined)
        .finally(() => { pending = false; });
    };
    read();
    const timer = window.setInterval(read, DETAIL_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [isOpen, sessionId]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (panel.current?.contains(target) || button.current?.contains(target))) return;
      setOpen(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", escape); };
  }, [open]);

  const usage = snapshot?.usage ?? null;
  const fraction = contextFraction(usage);
  const radius = (RING - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const label = !sessionId ? "No agent has started in this chat yet"
    : !usage ? "The agent has not reported its context yet"
      : fraction === null ? `${tokensShort(usage.contextUsed)} tokens in context`
        : `Context ${tokensShort(usage.contextUsed)} / ${tokensShort(usage.contextWindow)} (${Math.round(fraction * 100)}%)`;
  const limits = snapshot?.rateLimits ?? null;
  const readAt = Date.now();
  const limitRows = limits ? [
    { name: "Current session", used: limits.primaryUsedPercent, resets: limits.primaryResetsInSeconds },
    { name: "Current week", used: limits.secondaryUsedPercent, resets: limits.secondaryResetsInSeconds },
  ].filter((row) => row.used !== null && row.used >= 0)
    .map((row) => ({ name: row.name, used: row.used ?? 0, resetsAt: row.resets && row.resets > 0 ? readAt + row.resets * 1000 : null })) : [];
  // The agent's own report wins; a CPA Codex model without one shows CPA's accounts instead.
  const cpaAccounts = !limitRows.length && onCpaCodex && quota?.available ? quota.accounts ?? [] : [];

  return <>
    <button ref={button} type="button" className={`cx-icon-button cx-context-meter is-${tone(fraction)}`} aria-label={label} title={label}
      aria-haspopup="dialog" aria-expanded={Boolean(open)}
      onClick={() => {
        const box = button.current?.getBoundingClientRect();
        if (!box) return;
        setOpen((current) => (current ? null : { left: Math.max(8, Math.min(box.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8)), bottom: window.innerHeight - box.top + 8 }));
      }}>
      <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} aria-hidden="true">
        <circle className="cx-context-track" cx={RING / 2} cy={RING / 2} r={radius} fill="none" strokeWidth="2.2" />
        {fraction !== null ? <circle className="cx-context-fill" cx={RING / 2} cy={RING / 2} r={radius} fill="none" strokeWidth="2.2" strokeLinecap="round"
          strokeDasharray={`${circumference * fraction} ${circumference}`} transform={`rotate(-90 ${RING / 2} ${RING / 2})`} /> : null}
      </svg>
    </button>
    {open ? <FloatingLayer className="cx-context-panel" role="dialog" style={{ left: open.left, bottom: open.bottom }}>
      <div ref={panel} aria-label="Context window">
        <div className="cx-context-head">
          <strong>Context Usage</strong>
          {!breakdown ? <span>{usage ? fraction === null ? `${tokensShort(usage.contextUsed)} tokens` : `${tokensShort(usage.contextUsed)} / ${tokensShort(usage.contextWindow)} (${Math.round(fraction * 100)}%)` : "—"}</span> : null}
        </div>
        {breakdown ? <ContextUsage breakdown={breakdown} model={model} />
          : fraction !== null ? <div className={`cx-context-bar is-${tone(fraction)}`}><span style={{ width: `${Math.round(fraction * 100)}%` }} /></div> : null}
        {agentLabel ? <p className="cx-context-note">{agentLabel}{snapshot?.controller ? ` · ${snapshot.controller}` : ""}</p> : null}
        {!sessionId ? <p className="cx-context-note">No agent has started in this chat yet; the meter fills once one answers.</p>
          : !usage ? <p className="cx-context-note">The agent has not reported its context yet. It does after its first reply.</p> : <>
            {breakdown ? null : fraction !== null ? <p className="cx-context-note">{tokensShort(Math.max(0, (usage.contextWindow ?? 0) - (usage.contextUsed ?? 0)))} free</p>
              : <p className="cx-context-note">This agent does not say how large its window is, so there is no percentage.</p>}
            <p className="cx-context-label">This conversation's tokens</p>
            <dl className="cx-context-rows">
              <dt>Input</dt><dd>{tokensShort(usage.inputTokens)}</dd>
              <dt>Output</dt><dd>{tokensShort(usage.outputTokens)}</dd>
              <dt>Cached</dt><dd>{tokensShort(usage.cachedTokens)}</dd>
              <dt>Total</dt><dd>{tokensShort(usage.totalTokens)}</dd>
              {usage.cost !== null ? <><dt>Cost</dt><dd>{usage.currency && usage.currency !== "USD" ? `${usage.cost.toFixed(2)} ${usage.currency}` : `$${usage.cost.toFixed(2)}`}</dd></> : null}
            </dl>
          </>}
        {limitRows.length ? <>
          <p className="cx-context-label">Plan usage limits{limits?.planLabel || snapshot?.planLabel ? ` · ${limits?.planLabel || snapshot?.planLabel}` : ""}</p>
          {limitRows.map((row) => <LimitRow key={row.name} name={row.name} used={row.used} resetsAt={row.resetsAt} />)}
        </> : null}
        {cpaAccounts.length ? <>
          <p className="cx-context-label">Plan usage limits · CPA Codex accounts ({cpaAccounts.length})</p>
          {cpaAccounts.map((account) => <section key={account.id || account.label} className={`cx-context-account${account.disabled || account.paused ? " is-resting" : ""}`}>
            <div className="cx-context-account-head">
              <span title={account.label}>{account.label}</span>
              <small>{[account.plan ? account.plan[0].toUpperCase() + account.plan.slice(1) : "",
                account.disabled ? "disabled" : account.paused ? "paused at its limit" : "", checkedLabel(account.checkedAt)].filter(Boolean).join(" · ")}</small>
            </div>
            {account.session ? <LimitRow name="Current session (5 h)" used={account.session.usedPercent} resetsAt={account.session.resetsAt} /> : null}
            {account.week ? <LimitRow name="Current week" used={account.week.usedPercent} resetsAt={account.week.resetsAt} /> : null}
            {!account.session && !account.week ? <p className="cx-context-note">{account.error || "CPA Helper has not checked this account's limits yet."}</p> : null}
          </section>)}
        </> : onCpaCodex && !limitRows.length && quota && !quota.available ? <>
          <p className="cx-context-label">Plan usage limits</p>
          <p className="cx-context-note">{quota.reason || "CPA's account limits are unavailable."}</p>
        </> : null}
        {snapshot?.mcpServers.length ? <>
          <p className="cx-context-label">Tool servers ({snapshot.mcpServers.length})</p>
          <ul className="cx-context-servers">{snapshot.mcpServers.map((server) => <li key={server.name}>
            <span className={`cx-context-dot is-${/^(ready|connected|running|ok)$/i.test(server.status) ? "ok" : /fail|error/i.test(server.status) ? "failed" : "other"}`} aria-hidden="true" />
            {server.name}<small>{server.status}</small></li>)}</ul>
        </> : null}
        <div className="cx-context-foot">
          <span>{snapshot?.compactedAt ? `Compacted ${new Date(snapshot.compactedAt).toLocaleString()}` : "Not compacted yet"}</span>
          <button type="button" disabled={!canCompact} title={canCompact ? "Summarize the history to free context (/compact)" : "Compact works once the chat is not running"}
            onClick={() => { setOpen(null); onCompact(); }}>Compact session</button>
        </div>
        <p className="cx-context-note is-quiet">{breakdown
          ? `The agent reports only its total; the split is estimated from ${breakdown.counts.messages} messages and ${breakdown.counts.toolCalls} tool calls${breakdown.sinceCompaction ? " since the last compaction" : ""}${breakdown.complete ? "" : " (the most recent ones)"}, and the rest is its system prompt, tool definitions and memory files.`
          : "The agent reports totals only, not a split by system prompt, tools and messages."}</p>
      </div>
    </FloatingLayer> : null}
  </>;
}
