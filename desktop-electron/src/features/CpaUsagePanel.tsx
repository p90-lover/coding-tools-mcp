import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { Language } from "../types";
import { tokensShort } from "./ao-chat";
import {
  agoLabel, clineStateLabel, costLabel, costSourceLabel, readCpaUsage,
  type CpaClineQuota, type CpaCodexQuota, type CpaUsage, type CpaUsageAccount, type CpaUsageRange,
} from "./cpa-usage";
import { pageHidden } from "./page-visibility";

// The CPA view's account usage strip, above CPA's own panel (an iframe the app cannot add to):
// each account's tokens, requests, estimated cost and quota, from cpa_usage. It refreshes when it
// comes into view and once a minute while it stays visible and open, never while hidden in a kept-
// alive pane or a minimized window, since each refresh asks CPA Helper for several groupings.

const REFRESH_MS = 60_000;
const OPEN_KEY = "coding-tools:cpa-usage:open";
const RANGE_KEY = "coding-tools:cpa-usage:range";
const RANGES: { id: CpaUsageRange; en: string; zh: string }[] = [
  { id: "24h", en: "24 h", zh: "24 小時" }, { id: "7d", en: "7 days", zh: "7 天" },
  { id: "30d", en: "30 days", zh: "30 天" }, { id: "all", en: "All", zh: "全部" },
];

const savedRange = (): CpaUsageRange => {
  try { const value = localStorage.getItem(RANGE_KEY); if (RANGES.some((range) => range.id === value)) return value as CpaUsageRange; } catch { /* default */ }
  return "30d";
};
const savedOpen = (): boolean => {
  try { return localStorage.getItem(OPEN_KEY) !== "closed"; } catch { return true; }
};

const tone = (percent: number) => (percent >= 85 ? "high" : percent >= 60 ? "mid" : "low");

function CodexQuota({ quota, zh }: { quota: CpaCodexQuota; zh: boolean }) {
  const windows = [
    { name: zh ? "5 小時" : "5 h", window: quota.session },
    { name: zh ? "本週" : "Week", window: quota.week },
  ].filter((row) => row.window);
  return <div className="cpa-usage-quota">
    {windows.map((row) => {
      const percent = Math.max(0, Math.min(100, Math.round(row.window!.usedPercent)));
      return <span key={row.name} className={`cpa-usage-meter is-${tone(percent)}`} title={row.window!.resetsAt ? `${zh ? "重置於" : "Resets"} ${new Date(row.window!.resetsAt).toLocaleString()}` : undefined}>
        <small>{row.name}</small><i><b style={{ width: `${percent}%` }} /></i><small>{percent}%</small>
      </span>;
    })}
    {quota.paused ? <small className="cpa-usage-warn">{zh ? "已達限額，暫停中" : "paused at limit"}</small> : null}
    {!windows.length ? <small className={quota.error ? "cpa-usage-warn" : undefined}>{quota.error || (zh ? "CPA Helper 尚未檢查此帳戶的限額" : "Limits not checked yet")}</small> : null}
    {quota.checkedAt ? <small className="cpa-usage-muted">{zh ? "檢查於" : "checked"} {agoLabel(quota.checkedAt, zh)}</small> : null}
  </div>;
}

function ClineQuota({ quota, zh }: { quota: CpaClineQuota; zh: boolean }) {
  return <div className="cpa-usage-quota">
    <small className="cpa-usage-muted" title={zh
      ? "Cline 不提供 Cline Pass 金鑰的剩餘額度，切換器也不記錄；這裡列出每個金鑰的請求數、最後使用時間與最後錯誤（429 表示已達限額）。"
      : "Cline doesn't report remaining quota. Each key shows its requests, last use and last error. A 429 means it hit its limit."}>
      {zh ? "Cline 未提供剩餘額度" : "Quota not reported by Cline"} · {quota.mode === "roundrobin" ? (zh ? "輪詢" : "round-robin") : (zh ? "單一金鑰" : "single key")}
    </small>
    {quota.accounts.length ? <ul className="cpa-usage-keys">
      {quota.accounts.map((key) => <li key={key.name} className={`is-${key.state}`} title={key.lastError ?? undefined}>
        <span>{key.name}{key.active ? <em>{zh ? "使用中" : "in use"}</em> : null}</span>
        <small>{clineStateLabel(key.state, zh)} · {key.requests.toLocaleString()} {zh ? "次請求" : "req"} · {agoLabel(key.lastUsedAt, zh)}</small>
      </li>)}
    </ul> : <small className="cpa-usage-muted">{zh ? "切換器中尚無 Cline Pass 金鑰" : "No Cline Pass keys in the switcher yet"}</small>}
  </div>;
}

function QuotaCell({ account, zh }: { account: CpaUsageAccount; zh: boolean }) {
  if (account.quota?.kind === "codex") return <CodexQuota quota={account.quota} zh={zh} />;
  if (account.quota?.kind === "cline") return <ClineQuota quota={account.quota} zh={zh} />;
  return <span className="cpa-usage-muted" title={zh ? "CPA 未回報此帳戶的額度" : "CPA reports no quota for this account"}>—</span>;
}

export function CpaUsagePanel({ language }: { language: Language }) {
  const zh = language === "zh-TW" || language === "zh-CN";
  const [open, setOpen] = useState(savedOpen);
  const [range, setRange] = useState<CpaUsageRange>(savedRange);
  const [usage, setUsage] = useState<CpaUsage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const root = useRef<HTMLElement>(null);
  const lastRead = useRef(0);
  const inFlight = useRef<CpaUsageRange | null>(null);
  const currentRange = useRef(range);
  currentRange.current = range;

  const read = useCallback(async (force = false) => {
    // A kept-alive pane stays mounted while another surface shows: skip it then, and when hidden.
    if (inFlight.current === range || pageHidden() || !root.current?.offsetParent) return;
    if (!force && Date.now() - lastRead.current < REFRESH_MS - 1_000) return;
    inFlight.current = range;
    setBusy(true);
    try {
      const next = await readCpaUsage(range);
      // A reading for a period the user has since left is dropped.
      if (currentRange.current !== range) return;
      lastRead.current = Date.now();
      setUsage(next);
      setError("");
    } catch (cause) {
      if (currentRange.current === range) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (inFlight.current === range) inFlight.current = null;
      setBusy(false);
    }
  }, [range]);

  useEffect(() => {
    if (!open) return undefined;
    void read(true);
    const timer = window.setInterval(() => void read(), REFRESH_MS);
    // Coming back into view (another surface was showing, or the window was restored) refreshes
    // a stale reading at once instead of on the next tick.
    const observer = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void read(); }) : null;
    if (root.current) observer?.observe(root.current);
    const onVisible = () => { if (!pageHidden()) void read(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); observer?.disconnect(); document.removeEventListener("visibilitychange", onVisible); };
  }, [open, read]);

  const toggle = () => setOpen((value) => {
    try { localStorage.setItem(OPEN_KEY, value ? "closed" : "open"); } catch { /* this session only */ }
    return !value;
  });
  const choose = (next: CpaUsageRange) => {
    try { localStorage.setItem(RANGE_KEY, next); } catch { /* this session only */ }
    setRange(next);
  };
  const flip = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const accounts = usage?.available ? usage.accounts ?? [] : [];
  const totals = usage?.available ? usage.totals : undefined;
  const refreshed = usage?.refreshedAt ? new Date(usage.refreshedAt).toLocaleTimeString() : null;

  return <section ref={root} className={`cpa-usage${open ? " is-open" : ""}`} aria-label={zh ? "CPA 帳戶用量" : "CPA account usage"}>
    <header className="cpa-usage-head">
      <button type="button" className="cpa-usage-toggle" aria-expanded={open} onClick={toggle}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <strong>{zh ? "帳戶用量" : "Account usage"}</strong>
        {totals && !open ? <small>{tokensShort(totals.totalTokens)} tokens · {costLabel(totals.cost, totals.costPartial)}</small> : null}
      </button>
      {open ? <>
        <div className="cpa-usage-ranges" role="group" aria-label={zh ? "期間" : "Period"}>
          {RANGES.map((option) => <button key={option.id} type="button" className={option.id === range ? "is-active" : undefined}
            aria-pressed={option.id === range} onClick={() => choose(option.id)}>{zh ? option.zh : option.en}</button>)}
        </div>
        <span className="cpa-usage-muted">
          {refreshed ? `${zh ? "更新於" : "Updated"} ${refreshed}` : zh ? "尚未讀取" : "Not read yet"} · {zh ? "每 60 秒自動重新整理" : "auto-refreshes every 60 s"}
        </span>
        <button type="button" className="cpa-usage-refresh" disabled={busy} onClick={() => void read(true)}>
          {busy ? "…" : zh ? "重新整理" : "Refresh"}
        </button>
      </> : null}
    </header>
    {open ? <div className="cpa-usage-body">
      {error ? <p className="cpa-usage-note is-error">{error}</p> : null}
      {usage && !usage.available ? <p className="cpa-usage-note">{usage.reason || (zh ? "無法讀取 CPA 用量。" : "Couldn't read CPA usage.")}</p> : null}
      {usage?.available ? <div className="cpa-usage-scroll">
        <table className="cpa-usage-table">
          <thead><tr>
            <th scope="col">{zh ? "帳戶" : "Account"}</th>
            <th scope="col" className="is-num">{zh ? "請求" : "Requests"}</th>
            <th scope="col" className="is-num">{zh ? "輸入" : "Input"}</th>
            <th scope="col" className="is-num">{zh ? "輸出" : "Output"}</th>
            <th scope="col" className="is-num">{zh ? "總計" : "Total"}</th>
            <th scope="col" className="is-num" title={costSourceLabel("mixed", false, zh)}>{zh ? "估算成本" : "Est. cost"}</th>
            <th scope="col">{zh ? "額度" : "Quota"}</th>
          </tr></thead>
          <tbody>
            {accounts.map((account) => {
              const showModels = expanded.has(account.id) && account.models.length > 0;
              return <Fragment key={account.id}>
                <tr className={account.disabled ? "is-resting" : undefined}>
                  <th scope="row">
                    {account.models.length ? <button type="button" className="cpa-usage-expand" aria-expanded={showModels}
                      title={zh ? "依模型顯示" : "Show by model"} onClick={() => flip(account.id)}>{showModels ? "▾" : "▸"}</button> : <span className="cpa-usage-expand" />}
                    <span className="cpa-usage-label" title={account.label}>{account.label}</span>
                    {account.provider ? <small className="cpa-usage-tag">{account.provider}</small> : null}
                    {account.disabled ? <small className="cpa-usage-tag is-off">{zh ? "已停用" : "disabled"}</small> : null}
                  </th>
                  <td className="is-num" title={account.failed ? `${account.failed} ${zh ? "次失敗" : "failed"}` : undefined}>{account.requests.toLocaleString()}</td>
                  <td className="is-num" title={account.cachedTokens ? `${tokensShort(account.cachedTokens)} ${zh ? "快取" : "cached"}` : undefined}>{tokensShort(account.inputTokens)}</td>
                  <td className="is-num">{tokensShort(account.outputTokens)}</td>
                  <td className="is-num">{tokensShort(account.totalTokens)}</td>
                  <td className="is-num" title={account.requests ? costSourceLabel(account.costSource, account.costPartial, zh) : undefined}>
                    {account.requests ? costLabel(account.cost, account.costPartial) : "—"}
                  </td>
                  <td><QuotaCell account={account} zh={zh} /></td>
                </tr>
                {showModels ? account.models.map((model) => <tr key={`${account.id}:${model.model}`} className="cpa-usage-model">
                  <th scope="row"><span className="cpa-usage-expand" /><span className="cpa-usage-label" title={model.model}>{model.model}</span></th>
                  <td className="is-num">{model.requests.toLocaleString()}</td>
                  <td className="is-num">{tokensShort(model.inputTokens)}</td>
                  <td className="is-num">{tokensShort(model.outputTokens)}</td>
                  <td className="is-num">{tokensShort(model.totalTokens)}</td>
                  <td className="is-num" title={model.priceLabel ? `${costSourceLabel(model.costSource, model.costPartial, zh)} (${model.priceLabel})` : costSourceLabel(model.costSource, model.costPartial, zh)}>
                    {costLabel(model.cost, model.costPartial)}
                  </td>
                  <td />
                </tr>) : null}
              </Fragment>;
            })}
            {!accounts.length ? <tr><td colSpan={7} className="cpa-usage-muted">{zh ? "CPA 中沒有帳戶。" : "CPA has no accounts."}</td></tr> : null}
          </tbody>
          {totals ? <tfoot><tr>
            <th scope="row">{zh ? "總計" : "Total"}</th>
            <td className="is-num">{totals.requests.toLocaleString()}</td>
            <td className="is-num">{tokensShort(totals.inputTokens)}</td>
            <td className="is-num">{tokensShort(totals.outputTokens)}</td>
            <td className="is-num">{tokensShort(totals.totalTokens)}</td>
            <td className="is-num" title={costSourceLabel(totals.costSource, totals.costPartial, zh)}>{totals.requests ? costLabel(totals.cost, totals.costPartial) : "—"}</td>
            <td />
          </tr></tfoot> : null}
        </table>
      </div> : null}
      {usage?.available ? <p className="cpa-usage-note is-quiet">{zh
        ? "token 與請求數取自 CPA Helper 的用量紀錄（保留 90 天）。成本為估算：CPA Helper 價目表有價格時採用，否則使用內建 API 牌價（electron/cpa-model-prices.cjs）；訂閱帳戶並不按 token 計費。「+」表示部分模型沒有價格。"
        : "Tokens and requests come from CPA Helper's usage log, kept 90 days. Costs are estimated at API prices from CPA Helper's price book or the built-in list. Subscriptions aren't billed per token. \"+\" means some models had no price."}</p> : null}
    </div> : null}
  </section>;
}
