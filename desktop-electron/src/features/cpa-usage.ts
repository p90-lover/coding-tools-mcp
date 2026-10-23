import { getCodingToolsClient } from "../api/client";

// What the cpa_usage operation (electron/cpa-usage.cjs) returns: each CPA account's tokens,
// requests and estimated cost over a range, with its quota where one is known. Shared by the CPA
// accounts view (CpaUsagePanel) and the chat's context meter.

export type CpaUsageRange = "24h" | "7d" | "30d" | "all";
/** Where a cost came from: CPA Helper's price book, the built-in list-price table, or both. */
export type CpaCostSource = "cpa-helper" | "estimate" | "mixed" | null;

type QuotaWindow = { usedPercent: number; resetsAt: number | null; windowSeconds: number | null };
export type CpaCodexQuota = {
  kind: "codex"; plan: string | null; paused: boolean;
  session: QuotaWindow | null; week: QuotaWindow | null; checkedAt: number | null; error: string | null;
};
export type ClineKeyState = "ok" | "limited" | "signed-out" | "error" | "unused" | "disabled";
export type CpaClineQuota = {
  kind: "cline"; reported: false; mode: "single" | "roundrobin";
  accounts: { name: string; enabled: boolean; active: boolean; requests: number; lastUsedAt: number | null; lastError: string | null; state: ClineKeyState }[];
};
export type CpaUsageCounts = {
  requests: number; failed: number; inputTokens: number; outputTokens: number; cachedTokens: number; reasoningTokens: number; totalTokens: number;
};
export type CpaUsageModel = CpaUsageCounts & {
  model: string; provider: string | null; cost: number | null; costSource: CpaCostSource; costPartial: boolean; priceLabel: string | null;
};
export type CpaUsageAccount = CpaUsageCounts & {
  id: string; label: string; provider: string | null; disabled: boolean;
  cost: number | null; costSource: CpaCostSource; costPartial: boolean;
  models: CpaUsageModel[]; quota: CpaCodexQuota | CpaClineQuota | null;
};
export type CpaUsage = {
  available: boolean; reason?: string; range?: CpaUsageRange; from?: number | null; refreshedAt?: number;
  accounts?: CpaUsageAccount[]; totals?: CpaUsageCounts & { cost: number | null; costSource: CpaCostSource; costPartial: boolean };
  models?: CpaUsageModel[];
};

/** Reads the usage once; the main process caches it for 20 s, so callers may poll freely. */
export async function readCpaUsage(range: CpaUsageRange): Promise<CpaUsage | null> {
  const outer = await getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation: "cpa_usage", arguments: { range } });
  return (outer.result as CpaUsage | undefined) ?? null;
}

/** "~$1.23" for an estimate; "+" when some tokens had no price; "—" when none was known. */
export function costLabel(cost: number | null | undefined, partial = false): string {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return "—";
  const amount = cost === 0 ? "$0.00" : cost < 0.01 ? "<$0.01" : `~$${cost >= 1000 ? Math.round(cost).toLocaleString() : cost.toFixed(2)}`;
  return partial ? `${amount}+` : amount;
}

/** Says where a cost came from, for its tooltip. */
export function costSourceLabel(source: CpaCostSource, partial: boolean, zh: boolean): string {
  const from = source === "cpa-helper" ? (zh ? "CPA Helper 價目表" : "CPA Helper's price book")
    : source === "estimate" ? (zh ? "內建公開價目表估算" : "the built-in list-price table")
      : source === "mixed" ? (zh ? "CPA Helper 價目表與內建價目表" : "CPA Helper's price book and the built-in list-price table")
        : (zh ? "無價格" : "no price");
  const rest = partial ? (zh ? "；部分模型沒有價格，未計入。" : " Models with no price aren't counted.") : "";
  return zh ? `估算成本（API 牌價，訂閱帳戶不按 token 計費），來源：${from}${rest}` : `Estimated at API prices, from ${from}. Subscriptions aren't billed per token.${rest}`;
}

/** "3 min ago" / "3 分鐘前" for a past time. */
export function agoLabel(at: number | null, zh: boolean, now = Date.now()): string {
  if (!at) return zh ? "從未" : "never";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return zh ? "剛剛" : "just now";
  if (minutes < 60) return zh ? `${minutes} 分鐘前` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return zh ? `${hours} 小時前` : `${hours} h ago`;
  return zh ? `${Math.round(hours / 24)} 天前` : `${Math.round(hours / 24)} d ago`;
}

/** A Cline Pass key's state in words. */
export function clineStateLabel(state: ClineKeyState, zh: boolean): string {
  switch (state) {
    case "ok": return zh ? "正常" : "working";
    case "limited": return zh ? "已達限額（429）" : "at limit (429)";
    case "signed-out": return zh ? "金鑰無效" : "key rejected";
    case "error": return zh ? "最後一次失敗" : "last request failed";
    case "unused": return zh ? "尚未使用" : "not used yet";
    default: return zh ? "已停用" : "disabled";
  }
}

export const isClineModel = (provider: string | null | undefined) => /^cline(-pass)?$/i.test(provider ?? "");
