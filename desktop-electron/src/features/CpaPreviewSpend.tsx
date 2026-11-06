import { useEffect, useState } from "react";
import { costLabel, costSourceLabel, readCpaUsage, type CpaUsage, type CpaUsageRange } from "./cpa-usage";
import { useSurfaceHidden } from "./page-visibility";

/** The embedded preview keeps money visible even when its plugin shows only token/session totals. */
export function CpaPreviewSpend({ active, zh = false }: { active: boolean; zh?: boolean }) {
  const hidden = useSurfaceHidden();
  const [range, setRange] = useState<CpaUsageRange>("7d");
  const [usage, setUsage] = useState<CpaUsage | null>(null);
  useEffect(() => {
    setUsage(null);
    if (!active) return;
    let live = true;
    const read = async () => {
      if (hidden()) return;
      const value = await readCpaUsage(range).catch(() => null);
      if (live) setUsage(value ?? { available: false });
    };
    void read();
    const timer = window.setInterval(() => void read(), 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [active, range, hidden]);
  const totals = usage?.available ? usage.totals : undefined;
  const amount = totals && totals.cost !== null && Number.isFinite(totals.cost) ? costLabel(totals.cost, totals.costPartial)
    : !active ? zh ? "離線" : "Offline" : !usage ? zh ? "讀取中…" : "Loading…" : zh ? "價格不可用" : "Cost unavailable";
  return <div className="original-ui-spend" aria-label={zh ? "CPA 使用成本" : "CPA usage cost"}>
    <label>{zh ? "API 估算成本" : "API-price estimate"} <select value={range} aria-label={zh ? "成本期間" : "Cost period"}
      onChange={(event) => setRange(event.target.value as CpaUsageRange)}>
      <option value="24h">{zh ? "24 小時" : "24 hours"}</option><option value="7d">{zh ? "7 天" : "7 days"}</option>
      <option value="30d">{zh ? "30 天" : "30 days"}</option>
    </select></label>
    <strong title={costSourceLabel(totals?.costSource ?? null, totals?.costPartial ?? false, zh)}>{amount}</strong>
    <span>{zh ? "不是訂閱費用或剩餘額度" : "Not subscription charges or remaining credit"}</span>
  </div>;
}
