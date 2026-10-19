import { useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import { tokensShort } from "./ao-chat";

// The line under the chat box, as DeepSeek Harness shows one: the chat's rounds, then the latest
// turn's model requests through CPA (chat_turn_stats, read from CPA Helper's request log): how many
// (steps), time spent in the model, average time to first token and output speed, cache hits and
// tokens. A model that does not go through CPA shows the rounds only.

type TurnStats = {
  available: boolean; steps?: number; failed?: number; latencyMs?: number; ttftMs?: number | null; tokensPerSecond?: number | null;
  cacheHit?: number | null; inputTokens?: number; outputTokens?: number;
};

const POLL_MS = 3_000;

const seconds = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

export function ChatTurnStats({ model, models = [], from, rounds, running }: {
  /** The chat agent's route model; only "cpa/…" models have request stats. */
  model?: string;
  /** Every "cpa/…" model the counted turns ran on (chatStatsSpan): a failed attempt on another one too. */
  models?: string[];
  /** When the earliest counted turn started (Unix ms). */
  from?: number;
  rounds: number;
  running: boolean;
}) {
  const [stats, setStats] = useState<TurnStats | null>(null);
  const counted = [...new Set([model, ...models].filter((value): value is string => Boolean(value?.startsWith("cpa/"))))];
  const key = counted.join("|");
  // A new turn (or model) starts blank; the turn ending keeps its numbers while the last read settles them.
  useEffect(() => { setStats(null); }, [key, from]);
  useEffect(() => {
    if (!key || !from) return undefined;
    let live = true;
    const [first, ...rest] = key.split("|");
    const read = () => void getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation: "chat_turn_stats", arguments: { model: first, models: rest, from } })
      .then((outer) => { if (live) setStats((outer.result as TurnStats | undefined) ?? null); })
      .catch(() => undefined);
    read();
    // While the turn runs the numbers move; once it ends one more read settles them.
    const timer = running ? window.setInterval(() => { if (document.visibilityState === "visible") read(); }, POLL_MS) : undefined;
    return () => { live = false; if (timer) window.clearInterval(timer); };
  }, [key, from, running]);

  if (!rounds) return null;
  const has = stats?.available && stats.steps;
  const parts: { key: string; text: string; title: string }[] = [
    { key: "rounds", text: `${rounds} ${rounds === 1 ? "round" : "rounds"}${has ? ` · ${stats.steps} ${stats.steps === 1 ? "step" : "steps"}` : ""}`,
      title: has ? `Messages in this chat · model requests in the latest turn and any failed or stopped attempts before it${stats.failed ? ` (${stats.failed} failed)` : ""}` : "Messages in this chat" },
  ];
  if (has) {
    parts.push({ key: "llm", text: `LLM ${seconds(stats.latencyMs ?? 0)}`, title: "Time spent waiting on the model in the latest turn, failed or stopped attempts before it included" });
    if (stats.ttftMs || stats.tokensPerSecond) {
      parts.push({ key: "speed", text: [stats.ttftMs ? `first token ${seconds(stats.ttftMs)}` : "", stats.tokensPerSecond ? `${stats.tokensPerSecond} tok/s` : ""].filter(Boolean).join(" · "),
        title: "Average time to the first token, and output speed once it streams" });
    }
    if (stats.cacheHit !== null && stats.cacheHit !== undefined) {
      parts.push({ key: "cache", text: `cache ${Math.round(stats.cacheHit * 100)}%`, title: "Share of input tokens served from the provider's prompt cache" });
    }
    parts.push({ key: "tokens", text: `in ${tokensShort(stats.inputTokens)} · out ${tokensShort(stats.outputTokens)}`, title: "Tokens in the latest turn's model requests, failed or stopped attempts before it included" });
  }
  return <p className={`cx-turn-stats${running ? " is-running" : ""}`} aria-label="Latest turn">
    {parts.map((part) => <span key={part.key} title={part.title}>{part.text}</span>)}
  </p>;
}
