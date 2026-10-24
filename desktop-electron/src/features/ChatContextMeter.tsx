import { useEffect, useRef, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import { cpaProviderOf } from "./AgentOrchestratorRoleEditor";
import { FloatingLayer } from "./ChatMenu";
import { contextFraction, tokensShort } from "./ao-chat";
import { agoLabel, clineStateLabel, costLabel, costSourceLabel, isClineModel, readCpaUsage, type CpaUsage, type CpaUsageAccount } from "./cpa-usage";

// The composer's context meter, as Claude Code shows one: a ring filling as the chat's agent
// session uses its context window, and on click what AO knows about it. That is the agent's own
// report (ACP usage updates, Codex token usage): context used of the window, the conversation's
// token spend, the account's rate limits, its tool servers and the last compaction. No agent
// reports a per-category split, so the open panel estimates one from the chat's history and
// draws it as Claude Code's /context does (a grid of the window, one cell per 1%). A model CPA
// serves from its Codex accounts shows each account's 5-hour and weekly limits instead (CPA
// Helper's quota, through the cpa_quota operation), worded as Claude Code words plan limits, and
// each account's tokens and estimated cost over the last 7 days (cpa_usage). A Cline Pass model
// shows the switcher's keys instead: Cline reports no quota for them, only whether a key is at
// its limit, so that is what the meter can say.

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
  /** When the agent last compacted on its own, from its history (AO's compactedAt covers only /compact). */
  compactedAt?: string | null;
};
export type ChatContextSnapshot = {
  controller: string | null; usage: Usage | null; rateLimits: RateLimits | null; compactedAt: string | null;
  planLabel: string | null; mcpServers: { name: string; status: string }[]; breakdown?: ContextBreakdown | null;
  /** The window the session was launched with, as this app run recorded it (a blank card's full limit included). */
  launchedWindow?: number | null;
  /** The session the shown usage came from when it is not this one (see previousSessionIds). */
  carriedFrom?: string;
};

/**
 * The reading to show for `sessionId`: its own, or, while it has reported no usage yet, the newest
 * of the chat's earlier sessions that has. A chat resumed after a restart runs in a new session of
 * the same conversation, and Claude Code over ACP reports usage only when a model request ends, so
 * the meter read "Waiting for the agent's first reply" for a whole half-hour first request.
 */
export function currentContext(sessions: Record<string, ChatContextSnapshot> | undefined, sessionId: string,
  previousSessionIds: readonly string[] = []): ChatContextSnapshot | undefined {
  const own = sessions?.[sessionId];
  if (!own || own.usage) return own;
  const earlier = previousSessionIds.map((id) => [id, sessions?.[id]] as const).find(([, snapshot]) => snapshot?.usage);
  return earlier ? { ...own, usage: earlier[1]!.usage, carriedFrom: earlier[0] } : own;
}

/** One quota window of a CPA Codex account (cpa-quota.cjs): percent used and when it resets (ms). */
type QuotaWindow = { usedPercent: number; resetsAt: number | null; windowSeconds: number | null };
/** The account's credits, which pay for every request once a window is full (balance as sent). */
type QuotaCredits = { balance: string | null; hasCredits: boolean; unlimited: boolean; overageReached: boolean };
export type CpaQuotaAccount = {
  id: string; label: string; plan: string | null; disabled: boolean; paused: boolean;
  session: QuotaWindow | null; week: QuotaWindow | null; credits?: QuotaCredits | null; checkedAt: number | null; error: string | null;
};

/** "Credits 51,187.97", and whether requests are drawing on them now (a window is full). */
function CreditsLine({ account }: { account: CpaQuotaAccount }) {
  const credits = account.credits;
  if (!credits) return null;
  const full = [account.session, account.week].some((window) => (window?.usedPercent ?? 0) >= 100);
  const amount = credits.unlimited ? "unlimited" : credits.balance === null ? "unknown"
    : Number(credits.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const state = credits.overageReached ? "overage limit reached" : !credits.unlimited && !credits.hasCredits ? "none left"
    : full ? "in use: limit reached" : "";
  return <p className="cx-ctx-meta" title={credits.balance ?? undefined}>Credits {amount}{state ? ` · ${state}` : ""}</p>;
}
type CpaQuota = { available: boolean; reason?: string; accounts?: CpaQuotaAccount[] };

const POLL_MS = 4_000;
const QUOTA_POLL_MS = 60_000;
/** The meter's usage period: a week, as the weekly limit beside it. */
const USAGE_RANGE = "7d";
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

/** "deepseek-v4.1-flash" from "cpa/cline-pass/deepseek-v4.1-flash". */
const modelName = (model?: string) => (model ? model.slice(model.lastIndexOf("/") + 1) : "");

const tone = (fraction: number | null) => (fraction === null ? "unknown" : fraction >= 0.85 ? "high" : fraction >= 0.6 ? "mid" : "low");

/** "7 days · 1.2M tokens · 42 requests · ~$3.10" for one CPA account; the in/out split is on hover. */
function UsageLine({ account }: { account: CpaUsageAccount | undefined }) {
  if (!account) return null;
  if (!account.requests) return <p className="cx-ctx-meta">7 days · no requests</p>;
  return <p className="cx-ctx-meta" title={`In ${tokensShort(account.inputTokens)} · out ${tokensShort(account.outputTokens)}\n${costSourceLabel(account.costSource, account.costPartial, false)}`}>
    7 days · {tokensShort(account.totalTokens)} tokens · {account.requests.toLocaleString()} requests · {costLabel(account.cost, account.costPartial)}
  </p>;
}

/** A bar that grows in when the panel opens and follows each new reading after. */
function Bar({ percent, level }: { percent: number; level: string }) {
  return <div className={`cx-ctx-bar is-${level}`}><span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>;
}

/** A plan usage limit: its name, the share used and a bar; when it resets is on the right. */
function LimitRow({ name, used, resetsAt }: { name: string; used: number; resetsAt: number | null }) {
  const percent = Math.max(0, Math.min(100, Math.round(used)));
  const resets = resetLabel(resetsAt);
  return <div className="cx-ctx-limit" title={resets || undefined}>
    <div><span>{name}</span><b>{percent}%</b></div>
    <Bar percent={percent} level={tone(percent / 100)} />
    {resets ? <small>{resets.replace(/^Resets/, "resets")}</small> : null}
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

type Segment = { id: string; label: string; tokens: number };

/** Claude Code's order and names for the parts of the window it lists. */
const CC_ROWS: { id: string; label: string }[] = [
  { id: "messages", label: "Messages" }, { id: "tools", label: "Tool calls & results" },
  { id: "system", label: "System prompt & tools" }, { id: "used", label: "In use" },
];
const share = (tokens: number, scale: number) => `${((tokens / scale) * 100).toFixed(1)}%`;

/**
 * The window as Claude Code's Context card draws it: "53% used" over "526.6k / 1M", one thin bar
 * of the parts, then a row per part (a colored square, its name, its tokens and share), free space
 * last. Pointing at a row lifts its segment.
 */
function ContextRows({ segments, scale, used, estimated }: { segments: Segment[]; scale: number; used: number; estimated: string | null }) {
  const [focus, setFocus] = useState("");
  const parts = CC_ROWS.map((row) => ({ ...row, tokens: segments.find((segment) => segment.id === row.id)?.tokens ?? 0 }))
    .filter((part) => part.tokens > 0);
  const free = Math.max(0, scale - parts.reduce((sum, part) => sum + part.tokens, 0));
  return <div className={`cx-ctx-cc${focus ? " has-focus" : ""}`} onPointerLeave={() => setFocus("")}>
    <div className="cx-ctx-cc-head"><b>{Math.round((used / scale) * 100)}% used</b><span>{tokensShort(used)} / {tokensShort(scale)}</span></div>
    <div className="cx-ctx-cc-bar" role="img" aria-label={[...parts, { id: "free", label: "Free space", tokens: free }].map((part) => `${part.label} ${tokensShort(part.tokens)}`).join(", ")}>
      {parts.map((part) => <span key={part.id} className={`is-${part.id}${focus === part.id ? " is-focus" : ""}`} style={{ flexBasis: `${(part.tokens / scale) * 100}%` }} />)}
    </div>
    <ul className="cx-ctx-cc-rows">
      {[...parts, { id: "free", label: "Free space", tokens: free }].map((part) => <li key={part.id} className={focus === part.id ? "is-focus" : undefined}
        onPointerEnter={() => setFocus(part.id)} title={part.id !== "free" && estimated ? estimated : undefined}>
        <i className={`is-${part.id}`} aria-hidden="true" /><span>{part.label}</span><b>{tokensShort(part.tokens)}</b><em>{share(part.tokens, scale)}</em>
      </li>)}
    </ul>
  </div>;
}


export function ChatContextMeter({ sessionId, previousSessionIds, agentLabel, model, launchedWindow, nextWindow, canCompact, onCompact, onFraction }: {
  sessionId?: string;
  /** The chat's earlier sessions, newest first: their last reading stands in until this one reports. */
  previousSessionIds?: string[];
  agentLabel?: string;
  /** The session's route model; a "cpa/…" model served by CPA's Codex accounts shows their limits. */
  model?: string;
  /** The window the session was launched with (its card's context_window), when one was set. */
  launchedWindow?: number;
  /** The window the composer will launch the next run with, when one is set. */
  nextWindow?: number;
  canCompact: boolean;
  onCompact: () => void;
  /** The share of the window in use as the ring shows it, for the chat's pet (null when unknown). */
  onFraction?: (fraction: number | null) => void;
}) {
  const [snapshot, setSnapshot] = useState<ChatContextSnapshot | null>(null);
  const [quota, setQuota] = useState<CpaQuota | null>(null);
  const [cpaUsage, setUsageReport] = useState<CpaUsage | null>(null);
  const cpaProvider = cpaProviderOf(model)?.toLowerCase() ?? null;
  const onCpaCodex = cpaProvider === "codex";
  const onCpaCline = isClineModel(cpaProvider);
  const [open, setOpen] = useState<{ left: number; bottom: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const earlierKey = (previousSessionIds ?? []).slice(0, 3).join(",");
  useEffect(() => {
    setSnapshot(null);
    if (!sessionId) return undefined;
    let live = true;
    const earlier = earlierKey ? earlierKey.split(",") : [];
    const read = () => void getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation: "chat_context", arguments: { sessionIds: [sessionId, ...earlier] } })
      .then((outer) => {
        const sessions = (outer.result as { sessions?: Record<string, ChatContextSnapshot> } | undefined)?.sessions;
        // A reply without this session is a read that failed (AO busy or restarting, a timeout),
        // not a session with no context: the last reading stays instead of the meter emptying.
        const next = currentContext(sessions, sessionId, earlier);
        if (live && next) setSnapshot(next);
      })
      .catch(() => undefined);
    read();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") read(); }, POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [sessionId, earlierKey]);

  // CPA's Codex accounts' limits change slowly and CPA Helper caches them: read once a minute while
  // the window is visible, and again when the panel opens. Their token use and cost come along.
  useEffect(() => {
    setQuota(null);
    setUsageReport(null);
    if (!onCpaCodex && !onCpaCline) return undefined;
    let live = true;
    const read = () => {
      if (onCpaCodex) {
        void getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation: "cpa_quota", arguments: {} })
          .then((outer) => { if (live) setQuota((outer.result as CpaQuota | undefined) ?? null); })
          .catch(() => undefined);
      }
      void readCpaUsage(USAGE_RANGE).then((next) => { if (live) setUsageReport(next); }).catch(() => undefined);
    };
    read();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") read(); }, QUOTA_POLL_MS);
    const onOpen = () => read();
    button.current?.addEventListener("click", onOpen);
    const target = button.current;
    return () => { live = false; window.clearInterval(timer); target?.removeEventListener("click", onOpen); };
  }, [onCpaCodex, onCpaCline]);

  // The category split reads the chat's history, so only while the panel is open. The last split
  // stays across openings and failed reads: clearing it on every open showed only "Used" until a
  // read landed, and for good when one failed.
  const [detail, setBreakdown] = useState<ContextBreakdown | null>(null);
  const isOpen = Boolean(open);
  useEffect(() => { setBreakdown(null); }, [sessionId]);
  useEffect(() => {
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
          if (live && session?.breakdown) setBreakdown(session.breakdown);
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

  // The agent reports the window it assumes for the model (Claude Code over ACP says 200K for an
  // unknown model), but a session launched with a window runs with that one: show it.
  const reported = snapshot?.usage ?? null;
  // What the app recorded at launch (a blank card's full limit too) wins over the card's setting.
  const launched = snapshot?.launchedWindow || launchedWindow || null;
  const overridden = Boolean(reported && launched && reported.contextWindow !== launched);
  const usage = reported && overridden ? { ...reported, contextWindow: launched! } : reported;
  const breakdown = detail && overridden && detail.window !== launched
    ? { ...detail, window: launched!, free: Math.max(0, launched! - detail.used) } : detail;
  // A window changed in the model menu applies from the next run; say so at once.
  const pendingWindow = nextWindow && nextWindow !== (usage?.contextWindow ?? launched) ? nextWindow : null;
  const fraction = contextFraction(usage);
  useEffect(() => { onFraction?.(fraction); }, [fraction, onFraction]);
  const radius = (RING - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const label = !sessionId ? "No agent yet"
    : !usage ? "Context not reported yet"
      : fraction === null ? `${tokensShort(usage.contextUsed)} tokens in context`
        : `Context ${tokensShort(usage.contextUsed)} / ${tokensShort(usage.contextWindow)} · ${Math.round(fraction * 100)}%`;
  const limits = snapshot?.rateLimits ?? null;
  const readAt = Date.now();
  const limitRows = limits ? [
    { name: "Current session", used: limits.primaryUsedPercent, resets: limits.primaryResetsInSeconds },
    { name: "Current week", used: limits.secondaryUsedPercent, resets: limits.secondaryResetsInSeconds },
  ].filter((row) => row.used !== null && row.used >= 0)
    .map((row) => ({ name: row.name, used: row.used ?? 0, resetsAt: row.resets && row.resets > 0 ? readAt + row.resets * 1000 : null })) : [];
  // The agent's own report wins; a CPA Codex model without one shows CPA's accounts instead.
  const cpaAccounts = !limitRows.length && onCpaCodex && quota?.available ? quota.accounts ?? [] : [];
  const usageById = new Map((cpaUsage?.available ? cpaUsage.accounts ?? [] : []).map((account) => [account.id, account]));
  // Cline Pass: CPA's one bridge account, whose quota lists the switcher's keys.
  const clineBridge = !limitRows.length && onCpaCline
    ? (cpaUsage?.accounts ?? []).find((account) => account.quota?.kind === "cline") : undefined;
  const clineKeys = clineBridge?.quota?.kind === "cline" ? clineBridge.quota : null;

  // An agent can report more in use than its window; the bar then measures against the larger figure.
  const scale = usage?.contextWindow ? Math.max(usage.contextWindow, breakdown?.used ?? 0, usage.contextUsed ?? 0) : null;
  // AO's own record of a /compact, else the agent's own compaction found in the history (breakdown).
  const compactedAt = snapshot?.compactedAt || breakdown?.compactedAt || null;
  const estimated = breakdown ?`Estimated from ${breakdown.counts.messages} ${breakdown.complete ? "" : "recent "}messages and ${breakdown.counts.toolCalls} tool calls${breakdown.sinceCompaction ? " since the last compaction" : ""}. The agent reports only the total.` : null;

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
        <header className="cx-ctx-head">
          <div>
            <strong>Context</strong>
            {agentLabel ? <small title={[agentLabel, snapshot?.controller].filter(Boolean).join(" · ")}>{modelName(model) || agentLabel}</small> : null}
          </div>
          {/* The agent's own controller word ("Busy", "Ready") reads as plain Working or Idle; the word is on hover. */}
          {snapshot?.controller ? (() => {
            const busy = /busy|running|working/i.test(snapshot.controller);
            return <span className={`cx-ctx-state is-${busy ? "busy" : "idle"}`} title={snapshot.controller}>{busy ? "Working" : "Idle"}</span>;
          })() : null}
        </header>
        {!sessionId || !usage ? <p className="cx-ctx-empty">{!sessionId ? "No agent yet" : "Waiting for the agent's first reply"}</p> : <>
          {scale ? <ContextRows scale={scale} used={usage.contextUsed ?? 0} estimated={estimated}
            segments={breakdown ? breakdown.categories.map((category) => ({ id: category.id, label: category.label, tokens: category.tokens }))
              : [{ id: "used", label: "In use", tokens: usage.contextUsed ?? 0 }]} />
            : <div className="cx-ctx-cc-head"><b>{tokensShort(usage.contextUsed)}</b><span>tokens in context</span></div>}
          {snapshot?.carriedFrom ? <p className="cx-ctx-meta" title={snapshot.carriedFrom}>From the previous session. This one reports after its first reply.</p> : null}
          {scale && !breakdown && !snapshot?.carriedFrom ? <p className="cx-ctx-meta">Reading the breakdown…</p> : null}
          {pendingWindow ? <p className="cx-ctx-meta"><span className="is-pending">Next run {tokensShort(pendingWindow)}</span></p> : null}
          {/* The conversation's spend as a short list, the cached share beside the input it saved:
              five equal tiles left each number too narrow to read. */}
          <dl className="cx-ctx-spend">
            <dt>Input</dt>
            <dd title={usage.totalTokens !== null ? `Total ${tokensShort(usage.totalTokens)} tokens` : undefined}>{tokensShort(usage.inputTokens)}
              {usage.cachedTokens ? <small> · {tokensShort(usage.cachedTokens)} cached</small> : null}</dd>
            <dt>Output</dt><dd>{tokensShort(usage.outputTokens)}</dd>
            {usage.cost !== null ? <><dt>Cost so far</dt>
              <dd className="is-cost">{usage.currency && usage.currency !== "USD" ? `${usage.cost.toFixed(2)} ${usage.currency}` : `$${usage.cost.toFixed(2)}`}</dd></> : null}
          </dl>
        </>}
        {limitRows.length ? <section className="cx-ctx-section">
          <h4>Limits{limits?.planLabel || snapshot?.planLabel ? <small>{limits?.planLabel || snapshot?.planLabel}</small> : null}</h4>
          {limitRows.map((row) => <LimitRow key={row.name} name={row.name.replace("Current ", "")} used={row.used} resetsAt={row.resetsAt} />)}
        </section> : null}
        {cpaAccounts.length ? <section className="cx-ctx-section">
          <h4>Codex accounts<small>{cpaAccounts.length}</small></h4>
          {cpaAccounts.map((account) => <div key={account.id || account.label} className={`cx-ctx-account${account.disabled || account.paused ? " is-resting" : ""}`}>
            <div className="cx-ctx-account-head">
              <span title={account.label}>{account.label}</span>
              <small title={checkedLabel(account.checkedAt)}>{[account.plan ? account.plan[0].toUpperCase() + account.plan.slice(1) : "",
                account.disabled ? "disabled" : account.paused ? "at limit" : ""].filter(Boolean).join(" · ")}</small>
            </div>
            {account.session ? <LimitRow name="5 hours" used={account.session.usedPercent} resetsAt={account.session.resetsAt} /> : null}
            {account.week ? <LimitRow name="Week" used={account.week.usedPercent} resetsAt={account.week.resetsAt} /> : null}
            {!account.session && !account.week ? <p className="cx-ctx-meta">{account.error || "Not checked yet"}</p> : null}
            <CreditsLine account={account} />
            <UsageLine account={usageById.get(account.id)} />
          </div>)}
        </section> : onCpaCodex && !limitRows.length && quota && !quota.available ? <section className="cx-ctx-section">
          <h4>Limits</h4><p className="cx-ctx-meta">{quota.reason || "CPA's account limits are unavailable."}</p>
        </section> : null}
        {onCpaCline && !limitRows.length && cpaUsage ? <section className="cx-ctx-section">
          <h4 title="Cline reports no quota. Each key shows whether it hit its limit">Cline Pass
            {clineKeys?.accounts.length ? <small>{clineKeys.accounts.length} {clineKeys.accounts.length === 1 ? "key" : "keys"}{clineKeys.accounts.length > 1 ? ` · ${clineKeys.mode === "roundrobin" ? "round-robin" : "single key"}` : ""}</small> : null}</h4>
          {!cpaUsage.available ? <p className="cx-ctx-meta">{cpaUsage.reason || "CPA's account usage is unavailable."}</p> : <>
            {(clineKeys?.accounts ?? []).map((key) => <div key={key.name} className={`cx-ctx-key${key.state === "disabled" || key.state === "limited" ? " is-resting" : ""}`} title={key.lastError ?? undefined}>
              <i className={`cx-ctx-dot is-${key.state === "limited" || key.state === "disabled" ? "failed" : key.active ? "ok" : "other"}`} aria-hidden="true" />
              <span>{key.name}</span>
              {key.active ? <em>in use</em> : null}
              <small>{key.requests.toLocaleString()} req · {agoLabel(key.lastUsedAt, false)}</small>
            </div>)}
            {!clineKeys ? <p className="cx-ctx-meta">The switcher didn't answer through CPA.</p> : null}
            {clineKeys && !clineKeys.accounts.length ? <p className="cx-ctx-meta">No keys yet. Add one in CPA › Plugins › Cline Pass.</p> : null}
            <UsageLine account={clineBridge} />
          </>}
        </section> : null}
        {snapshot?.mcpServers.length ? <section className="cx-ctx-section">
          <h4>Tool servers<small>{snapshot.mcpServers.length}</small></h4>
          <ul className="cx-ctx-servers">{snapshot.mcpServers.map((server) => <li key={server.name} title={server.status}>
            <i className={`cx-ctx-dot is-${/^(ready|connected|running|ok)$/i.test(server.status) ? "ok" : /fail|error/i.test(server.status) ? "failed" : "other"}`} aria-hidden="true" />
            {server.name}</li>)}</ul>
        </section> : null}
        <footer className="cx-ctx-foot">
          <span title={compactedAt ? new Date(compactedAt).toLocaleString() : undefined}>{compactedAt ? `Compacted ${agoLabel(Date.parse(compactedAt), false)}` : "Never compacted"}
            {overridden ? <span title={`The agent's own report says ${tokensShort(reported?.contextWindow ?? null)}`}> · launched at {tokensShort(launched!)}</span> : null}</span>
          <button type="button" disabled={!canCompact} title={canCompact ? "Summarize history to free context" : "Available when the chat isn't running"}
            onClick={() => { setOpen(null); onCompact(); }}>Compact session</button>
        </footer>
      </div>
    </FloatingLayer> : null}
  </>;
}
