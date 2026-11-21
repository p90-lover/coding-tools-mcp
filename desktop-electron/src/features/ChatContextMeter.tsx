import { useEffect, useRef, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import { cpaProviderOf, providerName } from "./AgentOrchestratorRoleEditor";
import { FloatingLayer } from "./ChatMenu";
import { contextFraction, tokensShort } from "./ao-chat";
import { agoLabel, costLabel, isClineModel, readCpaUsage, servingAccounts, type CpaUsage, type CpaUsageAccount } from "./cpa-usage";
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
export type CpaQuotaAccount = {
  id: string; label: string; plan: string | null; disabled: boolean; paused: boolean;
  session: QuotaWindow | null; week: QuotaWindow | null; credits?: QuotaCredits | null; checkedAt: number | null; error: string | null;
};
type CpaQuota = { available: boolean; reason?: string; accounts?: CpaQuotaAccount[] };
const POLL_MS = 4_000;
const QUOTA_POLL_MS = 60_000;
const DETAIL_POLL_MS = 10_000;
const USAGE_RANGE = "7d";
const PANEL_WIDTH = 360;
const RING = 18;
const modelName = (model?: string) => model?.slice(model.lastIndexOf("/") + 1) ?? "";
const tone = (fraction: number | null) => fraction === null ? "unknown" : fraction >= 0.85 ? "high" : fraction >= 0.6 ? "mid" : "low";

export function resetLabel(at: number | null, now = Date.now()): string {
  if (!at || !Number.isFinite(at) || at <= now) return "";
  const when = new Date(at);
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === when.toDateString()
    ? `Resets ${time}` : `Resets ${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

function Bar({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, percent));
  return <div className={`cx-ctx-bar is-${tone(value / 100)}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
    <span style={{ width: `${value}%` }} />
  </div>;
}
function LimitRow({ name, used, resetsAt }: { name: string; used: number; resetsAt: number | null }) {
  const percent = Math.max(0, Math.min(100, Math.round(used)));
  const resets = resetLabel(resetsAt);
  return <div className="cx-ctx-limit" title={resets || undefined}>
    <div><span>{name}</span><b>{percent}% <em>used</em></b></div>
    <Bar percent={percent} label={`${name} quota used`} />
    {resets ? <small>{resets}</small> : null}
  </div>;
}

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

type PanelProps = {
  sessionId?: string; agentLabel?: string; model?: string; launchedWindow?: number; nextWindow?: number;
  snapshot: ChatContextSnapshot | null; detail: ContextBreakdown | null; quota: CpaQuota | null;
  cpaUsage: CpaUsage | null; daySpend: CpaUsage | null; monthSpend: CpaUsage | null;
  canCompact: boolean; compacting?: boolean; onCompact: () => void;
};

export function ContextPanelContent({ sessionId, agentLabel, model, launchedWindow, nextWindow, snapshot, detail, quota,
  cpaUsage, daySpend, monthSpend, canCompact, compacting, onCompact }: PanelProps) {
  const [accountId, setAccountId] = useState("");
  const usage = effectiveUsage(snapshot, launchedWindow);
  const scale = usage?.contextWindow ? Math.max(usage.contextWindow, usage.contextUsed ?? 0, detail?.used ?? 0) : null;
  const fraction = contextFraction(usage);
  const base = monthSpend?.available ? monthSpend : cpaUsage;
  const catalogProvider = cpaProviderOf(model)?.toLowerCase() ?? null;
  const serving = model?.startsWith("cpa/") && base?.available ? servingAccounts(base.accounts ?? [], model, catalogProvider) : [];
  const provider = catalogProvider ?? serving.find((account) => account.provider)?.provider ?? null;
  const codex = provider === "codex";
  const cline = isClineModel(provider);
  const accounts = codex && quota?.available ? quota.accounts ?? [] : [];
  const account = accounts.find((item) => item.id === accountId) ?? accounts.find((item) => !item.disabled && !item.error) ?? accounts[0];
  const limits = snapshot?.rateLimits;
  const limitRows = [
    { name: "5 hours", used: limits?.primaryUsedPercent, resets: limits?.primaryResetsInSeconds },
    { name: "Weekly", used: limits?.secondaryUsedPercent, resets: limits?.secondaryResetsInSeconds },
  ].filter((row) => typeof row.used === "number" && row.used >= 0);
  const plan = limitRows.length ? limits?.planLabel || snapshot?.planLabel : account?.plan || snapshot?.planLabel;
  const credits = (cpaUsage?.apiCredits ?? []).filter((item) => provider && [item.provider, item.service].some((name) => name.toLowerCase() === provider));
  const clineQuota = cpaUsage?.accounts?.find((item) => item.quota?.kind === "cline")?.quota;
  const keys = clineQuota?.kind === "cline" ? clineQuota.accounts : [];
  const compactedAt = snapshot?.compactedAt || detail?.compactedAt;
  const next = nextWindow && nextWindow !== usage?.contextWindow ? nextWindow : null;
  const busy = /busy|running|working/i.test(snapshot?.controller ?? "");
  const balance = account?.credits;
  const balanceAmount = balance?.unlimited ? "Unlimited" : balance?.balance !== null && balance?.balance !== undefined
    && Number.isFinite(Number(balance.balance)) ? Number(balance.balance).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "Unavailable";
  return <>
    <header className="cx-ctx-head">
      <div><strong>Context & usage</strong><small title={model}>{modelName(model) || agentLabel || "No model selected"}</small></div>
      {snapshot?.controller ? <span className={`cx-ctx-state is-${busy ? "busy" : "idle"}`} title={snapshot.controller}>{busy ? "Working" : "Idle"}</span> : null}
    </header>
    <section className="cx-ctx-provider" aria-label="Current provider usage">
      <div className="cx-ctx-provider-head"><strong>{provider ? providerName(provider) : agentLabel || "Current provider"}</strong>
        {plan ? <span className="cx-ctx-plan">{plan}</span> : null}</div>
      {!limitRows.length && accounts.length > 1 ? <select aria-label="Quota account" value={account?.id ?? ""} onChange={(event) => setAccountId(event.target.value)}>
        {accounts.map((item) => <option key={item.id} value={item.id}>{item.label}{item.disabled ? " · disabled" : item.paused ? " · at limit" : ""}</option>)}
      </select> : !limitRows.length && account ? <small className="cx-ctx-account-label">{account.label}</small> : null}
      {limitRows.length ? limitRows.map((row) => <LimitRow key={row.name} name={row.name} used={row.used!}
        resetsAt={row.resets && row.resets > 0 ? Date.now() + row.resets * 1000 : null} />) : codex ? <>
        {account?.session ? <LimitRow name="5 hours" used={account.session.usedPercent} resetsAt={account.session.resetsAt} /> : null}
        {account?.week ? <LimitRow name="Weekly" used={account.week.usedPercent} resetsAt={account.week.resetsAt} /> : null}
        {!account?.session && !account?.week ? <p className="cx-ctx-meta">{account?.error || quota?.reason || (quota ? "Quota not reported" : "Checking limits…")}</p> : null}
        {balance ? <div className="cx-ctx-balance"><span>Credits</span><b>{balanceAmount}</b>
          {balance.overageReached ? <small>Overage limit reached</small> : null}</div> : null}
      </> : cline ? <div className="cx-ctx-balance"><span>Keys ready</span><b>{keys.filter((key) => key.enabled && !["limited", "disabled", "signed-out", "error"].includes(key.state)).length} / {keys.length}</b>
        <small>Cline does not report a quota balance</small></div> : !limitRows.length ? <>
        {credits.length ? credits.map((item) => <div className="cx-ctx-balance" key={item.id} title={item.reason || (item.kind === "key-budget" ? "This key's remaining spending allowance, not account credits" : "Reported by the provider")}>
          <span>{item.kind === "key-budget" ? "Key budget" : "Credits"}{credits.length > 1 ? ` · ${item.label}` : ""}</span>
          <b>{item.balances.length ? item.balances.map((value) => `${Number(value.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${value.currency}`).join(" · ") : "Unavailable"}</b>
        </div>) : <div className="cx-ctx-balance" title="This provider has no supported balance endpoint available to this API key. Estimated spend is not a credit balance."><span>Credits</span><b className="is-muted">Not exposed</b></div>}
        {serving.length ? <div className="cx-ctx-inline" title="Estimated at API list prices, not a bill or credit balance"><span>Today · estimated spend</span><b>{spendTotal(daySpend, serving)}</b></div> : null}
      </> : null}
    </section>
    {usage ? <section className="cx-ctx-context" aria-label="Context window">
      <div className="cx-ctx-inline"><span>Context</span><b>{fraction === null ? tokensShort(usage.contextUsed) : `${Math.round(fraction * 100)}% used`}</b></div>
      {fraction !== null ? <Bar percent={fraction * 100} label="Context window used" /> : null}
      <small>{tokensShort(usage.contextUsed)}{usage.contextWindow ? ` / ${tokensShort(usage.contextWindow)} tokens` : " tokens"}</small>
      {next ? <small>Next run · {tokensShort(next)} tokens</small> : null}
      {usage.cost !== null ? <div className="cx-ctx-inline"><span>This chat</span><b>{usage.currency && usage.currency !== "USD" ? `${usage.cost.toFixed(2)} ${usage.currency}` : `$${usage.cost.toFixed(2)}`}</b></div> : null}
    </section> : <p className="cx-ctx-meta">{sessionId ? "Context not reported yet" : "No agent yet"}</p>}
    <details className="cx-ctx-details"><summary>Context details</summary>
      {snapshot?.carriedFrom ? <p className="cx-ctx-meta">Last reading from the previous session.</p> : null}
      {detail && scale ? <dl className="cx-ctx-spend" title={`Estimated from ${detail.counts.messages} messages and ${detail.counts.toolCalls} tool calls${detail.sinceCompaction ? " since compaction" : ""}`}>
        {detail.categories.map((part) => <span key={part.id} style={{ display: "contents" }}><dt>{part.label}</dt><dd>{tokensShort(part.tokens)}</dd></span>)}
        <dt>Free space</dt><dd>{tokensShort(Math.max(0, scale - detail.used))}</dd>
      </dl> : null}
      {usage ? <dl className="cx-ctx-spend"><dt>Input</dt><dd>{tokensShort(usage.inputTokens)}</dd><dt>Cached</dt><dd>{tokensShort(usage.cachedTokens)}</dd><dt>Output</dt><dd>{tokensShort(usage.outputTokens)}</dd></dl> : null}
      {snapshot?.mcpServers.length ? <><p className="cx-ctx-meta">Tool servers · {snapshot.mcpServers.length}</p>
        <ul className="cx-ctx-servers">{snapshot.mcpServers.map((server) => <li key={server.name} title={server.status}>{server.name}</li>)}</ul></> : null}
    </details>
    {serving.length ? <details className="cx-ctx-details"><summary>Provider spend <small>{serving.length} {serving.length === 1 ? "account" : "accounts"}</small></summary>
      <dl className="cx-ctx-spend"><dt>Today</dt><dd>{spendTotal(daySpend, serving)}</dd><dt>7 days</dt><dd>{spendTotal(cpaUsage, serving)}</dd><dt>30 days</dt><dd>{spendTotal(monthSpend, serving)}</dd></dl>
      <p className="cx-ctx-meta">Estimated at API prices; not remaining credits.</p>
      {serving.map((item) => <div className="cx-ctx-inline" key={item.id}><span title={item.label}>{item.label}</span><b>{costLabel(item.cost, item.costPartial)}</b></div>)}
    </details> : null}
    {keys.length ? <details className="cx-ctx-details"><summary>Key details</summary>{keys.map((key) => <div className="cx-ctx-inline" key={key.name}><span>{key.name}</span><b>{key.active ? "In use" : key.state}</b></div>)}</details> : null}
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
  const onCpaCodex = cpaProvider === "codex";
  const onCpaCline = isClineModel(cpaProvider);
  const onCpaOther = Boolean(model?.startsWith("cpa/")) && !onCpaCodex && !onCpaCline;
  const [open, setOpen] = useState<{ left: number; bottom: number } | null>(null);
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
    if (!onCpaCodex && !onCpaCline && !onCpaOther) return undefined;
    let live = true;
    const read = () => {
      if (!live || hidden()) return;
      if (onCpaCodex) void getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation: "cpa_quota", arguments: {} })
        .then((outer) => { if (live) setQuota((outer.result as CpaQuota | undefined) ?? null); }).catch(() => undefined);
      void readCpaUsage(USAGE_RANGE).then((next) => { if (live) setUsageReport(next); }).catch(() => undefined);
      if (onCpaOther) {
        void readCpaUsage("24h").then((next) => { if (live) setDaySpend(next); }).catch(() => undefined);
        void readCpaUsage("30d").then((next) => { if (live) setMonthSpend(next); }).catch(() => undefined);
      }
    };
    read();
    const timer = window.setInterval(read, QUOTA_POLL_MS);
    const target = button.current;
    target?.addEventListener("click", read);
    return () => { live = false; window.clearInterval(timer); target?.removeEventListener("click", read); };
  }, [onCpaCodex, onCpaCline, onCpaOther, model, hidden]);
  const [detail, setBreakdown] = useState<ContextBreakdown | null>(null);
  const isOpen = Boolean(open);
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
