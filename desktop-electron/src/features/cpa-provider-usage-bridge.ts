import type { CpaUsage, CpaUsageRange } from "./cpa-usage";

const RANGES = new Set<CpaUsageRange>(["24h", "7d", "30d", "all"]);

// Explicit projection: auth IDs, quota errors and future backend fields never cross the frame boundary.
function publicQuota(quota: NonNullable<CpaUsage["accounts"]>[number]["quota"]) {
  if (quota?.kind === "codex") {
    const window = (value: typeof quota.session) => value ? { usedPercent: value.usedPercent,
      resetsAt: value.resetsAt, windowSeconds: value.windowSeconds } : null;
    return { kind: "codex", paused: quota.paused, session: window(quota.session), week: window(quota.week),
      checkedAt: quota.checkedAt, error: quota.error ? "Quota refresh unavailable" : null };
  }
  if (quota?.kind === "cline") return { kind: "cline", reported: false, accounts: quota.accounts.map((a) => ({
    enabled: a.enabled, active: a.active, state: a.state, requests: a.requests,
  })) };
  return null;
}

function publicUsage(usage: CpaUsage | null) {
  const counts = (row: NonNullable<CpaUsage["totals"]>) => ({ requests: row.requests, failed: row.failed,
    inputTokens: row.inputTokens, outputTokens: row.outputTokens, totalTokens: row.totalTokens,
    cachedTokens: row.cachedTokens, reasoningTokens: row.reasoningTokens, cost: row.cost,
    costSource: row.costSource, costPartial: row.costPartial });
  if (!usage?.available) return { available: false, reason: "Usage history is temporarily unavailable" };
  return { available: true, range: usage.range, from: usage.from, refreshedAt: usage.refreshedAt,
    totals: usage.totals ? counts(usage.totals) : null,
    accounts: (usage.accounts ?? []).map((a) => ({ ...counts(a), label: a.label, provider: a.provider,
      disabled: a.disabled, quota: publicQuota(a.quota),
      models: a.models.map((m) => ({ ...counts(m), model: m.model, provider: m.provider })) })) };
}

/** Only the embedded CPA frame (including its plugin frames) may read sanitized usage. */
export function attachCpaProviderUsageBridge({
  host, frame, origin, read,
}: {
  host: Pick<Window, "addEventListener" | "removeEventListener">;
  frame: () => Window | null;
  origin: string;
  read: (range: CpaUsageRange) => Promise<CpaUsage | null>;
}): () => void {
  let disposed = false;
  const pending = new Set<string>();
  const onMessage = async (event: MessageEvent) => {
    const request = event.data;
    if (event.origin !== origin || request?.type !== "cpm:usage:read" || typeof request.id !== "string"
      || request.id.length > 80 || !RANGES.has(request.range) || !event.source) return;
    const source = event.source as Window;
    let ancestor = source;
    const embedded = frame();
    if (!embedded) return;
    let trusted = false;
    try {
      for (let depth = 0; depth < 8; depth++) {
        if (ancestor === embedded) { trusted = true; break; }
        if (ancestor.parent === ancestor) break;
        ancestor = ancestor.parent;
      }
    } catch { return; }
    if (!trusted || pending.has(request.id) || pending.size >= 4) return;
    pending.add(request.id);
    try {
      const usage = await read(request.range);
      if (!disposed) source.postMessage({ type: "cpm:usage:result", id: request.id, usage: publicUsage(usage) }, origin);
    } catch {
      // Do not forward backend errors: they can include credential-bearing URLs.
      if (!disposed) source.postMessage({ type: "cpm:usage:result", id: request.id,
        usage: { available: false, reason: "Usage history is temporarily unavailable" } }, origin);
    } finally { pending.delete(request.id); }
  };
  host.addEventListener("message", onMessage);
  return () => { disposed = true; host.removeEventListener("message", onMessage); };
}
