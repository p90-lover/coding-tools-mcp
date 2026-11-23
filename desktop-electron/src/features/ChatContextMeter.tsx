import { useEffect, useRef, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import { cpaProviderOf, providerName } from "./AgentOrchestratorRoleEditor";
import { FloatingLayer } from "./ChatMenu";
import { contextFraction, tokensShort } from "./ao-chat";
import { agoLabel, costLabel, isClineModel, readCpaUsage, servingAccounts, type ClineKeyState, type CpaUsage, type CpaUsageAccount } from "./cpa-usage";
import { useSurfaceHidden } from "./page-visibility";

type Usage = {
  contextUsed: number | null; contextWindow: number | null;
  inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null; totalTokens: number | null;
  cost: number | null; currency: string | null;
};
type RateLimits = {
  primaryUsedPercent: number | null; secondaryUsedPercent: number | null;
  primaryResetsInSeconds: number | null; secondaryResetsInSeconds: number | null; planLabel: string | null;
};
export type ContextBreakdown = {
  used: number; window: number | null; free: number | null;
  categories: { id: string; label: string; tokens: number }[];
  counts: { messages: number; toolCalls: number }; sinceCompaction: boolean; complete: boolean;
  compactedAt?: string | null;
};
export type ChatContextSnapshot = {
  controller: string | null; usage: Usage | null; rateLimits: RateLimits | null; compactedAt: string | null;
  planLabel: string | null; mcpServers: { name: string; status: string }[]; breakdown?: ContextBreakdown | null;
  launchedWindow?: number | null; carriedFrom?: string;
};
export function currentContext(sessions: Record<string, ChatContextSnapshot> | undefined, sessionId: string,
  previousSessionIds: readonly string[] = []): ChatContextSnapshot | undefined {
  const own = sessions?.[sessionId];
  if (!own || own.usage) return own;
  const earlier = previousSessionIds.map((id) => [id, sessions?.[id]] as const).find(([, snapshot]) => snapshot?.usage);
  return earlier ? { ...own, usage: earlier[1]!.usage, carriedFrom: earlier[0] } : own;
}

type QuotaWindow = { usedPercent: number; resetsAt: number | null; windowSeconds: number | null };
type QuotaCredits = { balance: string | null; hasCredits: boolean; unlimited: boolean; overageReached: boolean };
/** Whether CPA can route to an account now (electron/cpa-quota.cjs). */
export type CpaAccountState = "ready" | "limited" | "disabled" | "signed-out" | "error";
export type CpaQuotaAccount = {
  id: string; provider?: string; label: string; plan: string | null; state?: CpaAccountState; disabled: boolean; paused: boolean;
  resumesAt?: number | null; session: QuotaWindow | null; week: QuotaWindow | null; credits?: QuotaCredits | null;
  checkedAt: number | null; error: string | null;
};
type CpaQuota = { available: boolean; reason?: string; accounts?: CpaQuotaAccount[] };
const POLL_MS = 4_000;
const QUOTA_POLL_MS = 30_000;
const DETAIL_POLL_MS = 10_000;
const USAGE_RANGE = "7d";
const PANEL_WIDTH = 340;
const RING = 18;
const MAX_CHIPS = 6;
const modelName = (model?: string) => model?.slice(model.lastIndexOf("/") + 1) ?? "";
const tone = (fraction: number | null) => fraction === null ? "unknown" : fraction >= 0.85 ? "high" : fraction >= 0.6 ? "mid" : "low";

/** The sign-in accounts with plan limits behind a CPA provider: CPA lists Codex models as OpenAI's and Claude's as Anthropic's. */
const PLAN_PROVIDERS: Record<string, "codex" | "claude"> = { codex: "codex", openai: "codex", claude: "claude", anthropic: "claude" };
export const planProviderOf = (provider: string | null | undefined) => PLAN_PROVIDERS[provider?.toLowerCase() ?? ""] ?? null;
export const accountState = (account: CpaQuotaAccount): CpaAccountState => account.state
  ?? (account.disabled ? "disabled" : account.error ? "error" : account.paused ? "limited" : "ready");
const STATE_TEXT: Record<CpaAccountState, string> = { ready: "Ready", limited: "At limit", disabled: "Disabled", "signed-out": "Signed out", error: "Unavailable" };
const KEY_STATE: Record<ClineKeyState, CpaAccountState> = { ok: "ready", unused: "ready", limited: "limited", disabled: "disabled", "signed-out": "signed-out", error: "error" };

export function resetLabel(at: number | null, now = Date.now()): string {
  if (!at || !Number.isFinite(at) || at <= now) return "";
  const when = new Date(at);
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === when.toDateString()
    ? `Resets ${time}` : `Resets ${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** "45m", "2h 15m", "Fri 9 AM" or "Oct 21": when a limit resets, short enough to sit beside its meter. */
export function resetShort(at: number | null, now = Date.now()): string {
  if (!at || !Number.isFinite(at) || at <= now) return "";
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes / 60}h`;
  const when = new Date(at);
  return minutes < 6 * 24 * 60
    ? `${when.toLocaleDateString(undefined, { weekday: "short" })} ${when.toLocaleTimeString(undefined, { hour: "numeric" })}`
    : when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Bar({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, percent));
  return <div className={`cx-ctx-bar is-${tone(value / 100)}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
    <span style={{ width: `${value}%` }} />
  </div>;
}
/** One limit on one line: name, bar, percent used and when it resets (the full time on hover). */
function Limit({ name, short, used, resetsAt, now }: { name: string; short: string; used: number; resetsAt: number | null; now: number }) {
  const percent = Math.max(0, Math.min(100, Math.round(used)));
  return <div className="cx-ctx-limit" title={resetLabel(resetsAt, now) || undefined}>
    <span>{short}</span>
    <Bar percent={percent} label={`${name} quota used`} />
    <b>{percent}%</b>
    <small>{resetShort(resetsAt, now)}</small>
  </div>;
}

type Chip = { id: string; label: string; state: CpaAccountState; title: string };
/** The routing pool: a dot per account or key in its state; picking an account shows its limits. */
function Chips({ label, chips, selected, onSelect }: { label: string; chips: Chip[]; selected?: string; onSelect?: (id: string) => void }) {
  const shown = chips.slice(0, MAX_CHIPS);
  const rest = chips.slice(MAX_CHIPS);
  return <div className="cx-ctx-chips" role="group" aria-label={label}>
    {shown.map((chip) => onSelect
      ? <button key={chip.id} type="button" className={`is-${chip.state}`} aria-pressed={chip.id === selected} title={chip.title}
        onClick={() => onSelect(chip.id)}><i />{chip.label}</button>
      : <span key={chip.id} className={`is-${chip.state}`} title={chip.title}><i />{chip.label}</span>)}
    {rest.length ? <span className="is-more" title={rest.map((chip) => chip.title).join("\n")}>+{rest.length}</span> : null}
  </div>;
}
const shortName = (label: string) => (label.includes("@") ? label.slice(0, label.indexOf("@")) : label) || label;

export function contextGrid(categories: { id: string; tokens: number }[], window: number): string[] {
  const cells: string[] = [];
  let total = 0;
  for (const category of categories) {
    if (category.tokens <= 0) continue;
    total += category.tokens;
    const end = Math.min(100, Math.max(cells.length + 1, Math.round((total / window) * 100)));
    while (cells.length < end) cells.push(category.id);
  }
  while (cells.length < 100) cells.push("free");
  return cells;
}

function spendTotal(report: CpaUsage | null | undefined, accounts: CpaUsageAccount[]): string {
  if (!report?.available) return "—";
  const ids = new Set(accounts.map((account) => account.id));
  const rows = (report.accounts ?? []).filter((account) => ids.has(account.id) && account.requests > 0);
  if (!rows.length) return "$0.00";
  const priced = rows.filter((account) => account.cost !== null);
  return costLabel(priced.length ? priced.reduce((sum, account) => sum + account.cost!, 0) : null,
    priced.length < rows.length || rows.some((account) => account.costPartial));
}

function effectiveUsage(snapshot: ChatContextSnapshot | null, launchedWindow?: number) {
  const launched = snapshot?.launchedWindow || launchedWindow || null;
  const reported = snapshot?.usage ?? null;
  return reported && launched && reported.contextWindow !== launched ? { ...reported, contextWindow: launched } : reported;
}

const amount = (value: string) => Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });

type PanelProps = {
  sessionId?: string; agentLabel?: string; model?: string; launchedWindow?: number; nextWindow?: number;
  snapshot: ChatContextSnapshot | null; detail: ContextBreakdown | null; quota: CpaQuota | null;
  cpaUsage: CpaUsage | null; daySpend: CpaUsage | null; monthSpend: CpaUsage | null;
  canCompact: boolean; compacting?: boolean; onCompact: () => void; now?: number;
};

export function ContextPanelContent({ sessionId, agentLabel, model, launchedWindow, nextWindow, snapshot, detail, quota,
  cpaUsage, daySpend, monthSpend, canCompact, compacting, onCompact, now = Date.now() }: PanelProps) {
  const [accountId, setAccountId] = useState("");
  const usage = effectiveUsage(snapshot, launchedWindow);
  const scale = usage?.contextWindow ? Math.max(usage.contextWindow, usage.contextUsed ?? 0, detail?.used ?? 0) : null;
  const fraction = contextFraction(usage);
  const base = monthSpend?.available ? monthSpend : cpaUsage;
  const catalogProvider = cpaProviderOf(model)?.toLowerCase() ?? null;
  const serving = model?.startsWith("cpa/") && base?.available ? servingAccounts(base.accounts ?? [], model, catalogProvider) : [];
  const provider = catalogProvider ?? serving.find((account) => account.provider)?.provider ?? null;
  const planProvider = planProviderOf(provider);
  const cline = isClineModel(provider);
  const accounts = planProvider && quota?.available ? (quota.accounts ?? []).filter((item) => (item.provider ?? "codex") === planProvider) : [];
  const ready = accounts.filter((item) => accountState(item) === "ready");
  const account = accounts.find((item) => item.id === accountId) ?? ready[0] ?? accounts[0];
  // The harness's own reading (Codex's app-server reports the limits of the account it signed in with).
  const limits = snapshot?.rateLimits;
  const reported = [
    { name: "5 hours", short: "5h", used: limits?.primaryUsedPercent, resets: limits?.primaryResetsInSeconds },
    { name: "Weekly", short: "Week", used: limits?.secondaryUsedPercent, resets: limits?.secondaryResetsInSeconds },
  ].filter((row) => typeof row.used === "number" && row.used >= 0);
  const planView = reported.length > 0 || (planProvider !== null && (!quota || !quota.available || accounts.length > 0));
  const plan = reported.length ? limits?.planLabel || snapshot?.planLabel : account?.plan || snapshot?.planLabel;
  const name = planView && planProvider && accounts.length ? providerName(planProvider) : provider ? providerName(provider) : agentLabel || "Provider";
  const credits = (cpaUsage?.apiCredits ?? []).filter((item) => provider && [item.provider, item.service].some((value) => value.toLowerCase() === provider));
  const clineQuota = cpaUsage?.accounts?.find((item) => item.quota?.kind === "cline")?.quota;
  const keys = clineQuota?.kind === "cline" ? clineQuota.accounts : [];
  const compactedAt = snapshot?.compactedAt || detail?.compactedAt;
  const next = nextWindow && nextWindow !== usage?.contextWindow ? nextWindow : null;
  const busy = /busy|running|working/i.test(snapshot?.controller ?? "");
  const balance = account?.credits;
  const soonest = Math.min(...accounts.filter((item) => accountState(item) === "limited" && item.resumesAt).map((item) => item.resumesAt!));
  const accountChips: Chip[] = accounts.map((item) => {
    const state = accountState(item);
    const back = state === "limited" && item.resumesAt ? resetLabel(item.resumesAt, now).replace(/^Resets/, "Back") : "";
    return { id: item.id, label: shortName(item.label), state, title: [item.label, item.plan, back || STATE_TEXT[state], item.error].filter(Boolean).join(" · ") };
  });
  // The pool is what CPA can route to: a switched-off account or key keeps its chip but isn't counted.
  const enabled = accounts.filter((item) => accountState(item) !== "disabled").length;
  const enabledKeys = keys.filter((key) => key.enabled && key.state !== "disabled");
  const pool = cline ? (enabledKeys.length ? `${enabledKeys.filter((key) => KEY_STATE[key.state] === "ready").length}/${enabledKeys.length} keys ready` : null)
    : !reported.length && enabled > 1 ? `${ready.length}/${enabled} ready` : null;
  const showDetails = Boolean(usage || (detail && scale) || serving.length || snapshot?.mcpServers.length || next || snapshot?.carriedFrom);
  return <>
    <header className="cx-ctx-head">
      <strong title={model}>{modelName(model) || agentLabel || "No model selected"}</strong>
      {snapshot?.controller ? <span className={`cx-ctx-state is-${busy ? "busy" : "idle"}`} title={snapshot.controller}>{busy ? "Working" : "Idle"}</span> : null}
    </header>
    {model?.startsWith("cpa/") || reported.length ? <section className="cx-ctx-provider" aria-label="Current provider usage">
      <div className="cx-ctx-provider-head">
        <strong>{name}</strong>
        {plan ? <span className="cx-ctx-plan">{plan}</span> : null}
        {pool ? <small className={`cx-ctx-pool${!cline && !ready.length ? " is-out" : ""}`} title="Accounts CPA can route this model's requests to now">{pool}</small> : null}
      </div>
      {planView ? <>
        {reported.length ? reported.map((row) => <Limit key={row.name} name={row.name} short={row.short} used={row.used!} now={now}
          resetsAt={row.resets && row.resets > 0 ? now + row.resets * 1000 : null} />) : <>
          {account?.session ? <Limit name="5 hours" short="5h" used={account.session.usedPercent} resetsAt={account.session.resetsAt} now={now} /> : null}
          {account?.week ? <Limit name="Weekly" short="Week" used={account.week.usedPercent} resetsAt={account.week.resetsAt} now={now} /> : null}
          {!account?.session && !account?.week ? <p className="cx-ctx-meta">{!quota ? "Checking limits…" : !quota.available ? quota.reason || "Limits unavailable"
            : account?.error || "Limits show after this account's next reply"}</p> : null}
          {accounts.length && !ready.length ? <p className="cx-ctx-meta is-warn">{Number.isFinite(soonest)
            ? `All accounts at limit · first back in ${resetShort(soonest, now)}` : "No account can take requests"}</p> : null}
          {balance && (balance.unlimited || balance.balance !== null) ? <div className="cx-ctx-row" title={balance.overageReached ? "Overage limit reached" : "Pays for requests once a limit is full"}>
            <span>Credits</span><b>{balance.unlimited ? "Unlimited" : amount(balance.balance!)}</b></div> : null}
          {accountChips.length ? <Chips label="Quota account" chips={accountChips} selected={account?.id} onSelect={setAccountId} /> : null}
        </>}
      </> : cline ? (keys.length ? <Chips label="Cline keys" chips={keys.map((key) => ({ id: key.name, label: key.name, state: key.enabled ? KEY_STATE[key.state] : "disabled",
        title: `${key.name} · ${key.active ? "In use" : key.state}${key.lastError ? ` · ${key.lastError}` : ""}` }))} />
        : <p className="cx-ctx-meta">Cline reports no quota</p>) : <>
        {credits.length ? credits.map((item) => <div className="cx-ctx-row" key={item.id} title={item.reason || (item.kind === "key-budget" ? "This key's remaining spending allowance, not account credits" : "Reported by the provider")}>
          <span>{item.kind === "key-budget" ? "Key budget" : "Credits"}{credits.length > 1 ? ` · ${item.label}` : ""}</span>
          <b>{item.balances.length ? item.balances.map((value) => `${Number(value.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${value.currency}`).join(" · ") : "Unavailable"}</b>
        </div>) : <div className="cx-ctx-row" title="This provider has no balance endpoint this API key can read. Estimated spend is not a credit balance."><span>Credits</span><b className="is-muted">Not exposed</b></div>}
        {serving.length ? <div className="cx-ctx-row" title="Estimated at API list prices, not a bill or credit balance"><span>Today · est.</span><b>{spendTotal(daySpend, serving)}</b></div> : null}
      </>}
    </section> : null}
    {usage ? <section className="cx-ctx-context" aria-label="Context window">
      <div className="cx-ctx-row"><span>Context</span><b>{fraction === null ? tokensShort(usage.contextUsed) : `${Math.round(fraction * 100)}% used`}</b></div>
      {fraction !== null ? <Bar percent={fraction * 100} label="Context window used" /> : null}
      <div className="cx-ctx-sub"><span>{tokensShort(usage.contextUsed)}{usage.contextWindow ? ` / ${tokensShort(usage.contextWindow)}` : ""} tokens</span>
        {usage.cost !== null ? <span title="This chat's cost as the agent reported it">{usage.currency && usage.currency !== "USD" ? `${usage.cost.toFixed(2)} ${usage.currency}` : `$${usage.cost.toFixed(2)}`}</span> : null}</div>
    </section> : <p className="cx-ctx-meta">{sessionId ? "Context not reported yet" : "No agent yet"}</p>}
    {showDetails ? <details className="cx-ctx-details"><summary>Details</summary>
      {snapshot?.carriedFrom ? <p className="cx-ctx-meta">Last reading from the previous session.</p> : null}
      {detail && scale ? <ul className="cx-ctx-cc-rows" title={`Estimated from ${detail.counts.messages} messages and ${detail.counts.toolCalls} tool calls${detail.sinceCompaction ? " since compaction" : ""}`}>
        {[...detail.categories.filter((part) => part.tokens > 0), { id: "free", label: "Free", tokens: Math.max(0, scale - detail.used) }].map((part) =>
          <li key={part.id}><i className={`is-${part.id}`} /><span>{part.label}</span><b>{tokensShort(part.tokens)}</b><em>{Math.round((part.tokens / scale) * 100)}%</em></li>)}
      </ul> : null}
      {usage ? <dl className="cx-ctx-spend"><dt>Input</dt><dd>{tokensShort(usage.inputTokens)}</dd><dt>Cached</dt><dd>{tokensShort(usage.cachedTokens)}</dd><dt>Output</dt><dd>{tokensShort(usage.outputTokens)}</dd>
        {next ? <><dt>Next run window</dt><dd>{tokensShort(next)}</dd></> : null}</dl> : null}
      {serving.length ? <dl className="cx-ctx-spend" title="Estimated at API list prices; not remaining credits">
        <dt>Spend today</dt><dd>{spendTotal(daySpend, serving)}</dd><dt>7 days</dt><dd>{spendTotal(cpaUsage, serving)}</dd><dt>30 days</dt><dd>{spendTotal(monthSpend, serving)}</dd></dl> : null}
      {snapshot?.mcpServers.length ? <ul className="cx-ctx-servers" aria-label="Tool servers">{snapshot.mcpServers.map((server) => <li key={server.name} title={server.status}>{server.name}</li>)}</ul> : null}
    </details> : null}
    <footer className="cx-ctx-foot"><span title={compactedAt ? new Date(compactedAt).toLocaleString() : undefined}>{compactedAt ? `Compacted ${agoLabel(Date.parse(compactedAt), false)}` : "Not compacted"}</span>
      <button type="button" disabled={!canCompact || compacting} onClick={onCompact}>{compacting ? "Compacting…" : "Compact"}</button></footer>
  </>;
}

export function ChatContextMeter({ sessionId, previousSessionIds, agentLabel, model, launchedWindow, nextWindow, canCompact, compacting = false, onCompact, onFraction }: {
  sessionId?: string; previousSessionIds?: string[]; agentLabel?: string; model?: string; launchedWindow?: number; nextWindow?: number;
  canCompact: boolean; compacting?: boolean; onCompact: () => void; onFraction?: (fraction: number | null) => void;
}) {
  const hidden = useSurfaceHidden();
  const [snapshot, setSnapshot] = useState<ChatContextSnapshot | null>(null);
  const [quota, setQuota] = useState<CpaQuota | null>(null);
  const [cpaUsage, setUsageReport] = useState<CpaUsage | null>(null);
  const [daySpend, setDaySpend] = useState<CpaUsage | null>(null);
  const [monthSpend, setMonthSpend] = useState<CpaUsage | null>(null);
  const cpaProvider = cpaProviderOf(model)?.toLowerCase() ?? null;
  const onCpa = Boolean(model?.startsWith("cpa/"));
  const onCpaPlan = onCpa && planProviderOf(cpaProvider) !== null;
  const onCpaCline = isClineModel(cpaProvider);
  const onCpaOther = onCpa && !onCpaPlan && !onCpaCline;
  const [open, setOpen] = useState<{ left: number; bottom: number } | null>(null);
  const isOpen = Boolean(open);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const earlierKey = (previousSessionIds ?? []).slice(0, 3).join(",");
  useEffect(() => {
    setSnapshot(null);
    if (!sessionId) return undefined;
    let live = true;
    const earlier = earlierKey ? earlierKey.split(",") : [];
    const read = () => {
      if (!live || hidden()) return;
      void getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation: "chat_context", arguments: { sessionIds: [sessionId, ...earlier] } })
        .then((outer) => {
          const sessions = (outer.result as { sessions?: Record<string, ChatContextSnapshot> } | undefined)?.sessions;
          const next = currentContext(sessions, sessionId, earlier);
          if (live && next) setSnapshot(next);
        }).catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [sessionId, earlierKey, hidden]);
  useEffect(() => {
    setQuota(null);
    setUsageReport(null);
    setDaySpend(null);
    setMonthSpend(null);
  }, [model]);
  // Limits, credits and spend only matter while the panel is open: a closed meter asks CPA nothing.
  useEffect(() => {
    if (!isOpen || (!onCpaPlan && !onCpaCline && !onCpaOther)) return undefined;
    let live = true;
    const read = () => {
      if (!live || hidden()) return;
      if (onCpaPlan) void getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation: "cpa_quota", arguments: {} })
        .then((outer) => { if (live) setQuota((outer.result as CpaQuota | undefined) ?? null); }).catch(() => undefined);
      void readCpaUsage(USAGE_RANGE).then((next) => { if (live) setUsageReport(next); }).catch(() => undefined);
      if (onCpaOther) {
        void readCpaUsage("24h").then((next) => { if (live) setDaySpend(next); }).catch(() => undefined);
        void readCpaUsage("30d").then((next) => { if (live) setMonthSpend(next); }).catch(() => undefined);
      }
    };
    read();
    const timer = window.setInterval(read, QUOTA_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [isOpen, onCpaPlan, onCpaCline, onCpaOther, model, hidden]);
  const [detail, setBreakdown] = useState<ContextBreakdown | null>(null);
  useEffect(() => { setBreakdown(null); }, [sessionId]);
  useEffect(() => {
    if (!isOpen || !sessionId) return undefined;
    let live = true;
    let pending = false;
    const read = () => {
      if (!live || pending || hidden()) return;
      pending = true;
      void getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation: "chat_context", arguments: { sessionIds: [sessionId], detail: true } })
        .then((outer) => {
          const session = (outer.result as { sessions?: Record<string, ChatContextSnapshot> } | undefined)?.sessions?.[sessionId];
          if (live && session?.breakdown) setBreakdown(session.breakdown);
        }).catch(() => undefined).finally(() => { pending = false; });
    };
    read();
    const timer = window.setInterval(read, DETAIL_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [isOpen, sessionId, hidden]);
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
  const usage = effectiveUsage(snapshot, launchedWindow);
  const fraction = contextFraction(usage);
  useEffect(() => { onFraction?.(fraction); }, [fraction, onFraction]);
  const radius = (RING - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const label = compacting ? "Compacting context…" : !sessionId ? "No agent yet" : !usage ? "Context not reported yet"
    : fraction === null ? `${tokensShort(usage.contextUsed)} tokens in context`
      : `Context ${tokensShort(usage.contextUsed)} / ${tokensShort(usage.contextWindow)} · ${Math.round(fraction * 100)}%`;
  return <>
    <button ref={button} type="button" className={`cx-icon-button cx-context-meter is-${tone(fraction)}`} aria-label={label} title={label}
      aria-haspopup="dialog" aria-expanded={Boolean(open)} aria-busy={compacting} onClick={() => {
        const box = button.current?.getBoundingClientRect();
        if (!box) return;
        const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
        setOpen((current) => current ? null : { left: Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8)), bottom: window.innerHeight - box.top + 8 });
      }}>
      <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} aria-hidden="true">
        <circle className="cx-context-track" cx={RING / 2} cy={RING / 2} r={radius} fill="none" strokeWidth="2.2" />
        {fraction !== null ? <circle className="cx-context-fill" cx={RING / 2} cy={RING / 2} r={radius} fill="none" strokeWidth="2.2" strokeLinecap="round"
          strokeDasharray={`${circumference * fraction} ${circumference}`} transform={`rotate(-90 ${RING / 2} ${RING / 2})`} /> : null}
      </svg>
    </button>
    {open ? <FloatingLayer className="cx-context-panel" role="dialog" style={{ left: open.left, bottom: open.bottom }}>
      <div ref={panel} aria-label="Context and provider usage"><ContextPanelContent sessionId={sessionId} agentLabel={agentLabel} model={model}
        launchedWindow={launchedWindow} nextWindow={nextWindow} snapshot={snapshot} detail={detail} quota={quota} cpaUsage={cpaUsage}
        daySpend={daySpend} monthSpend={monthSpend} canCompact={canCompact} compacting={compacting} onCompact={() => { setOpen(null); onCompact(); }} /></div>
    </FloatingLayer> : null}
  </>;
}
