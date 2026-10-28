import { useEffect, useRef, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import { cpaStatusWord, dshDuration, isDeepSeekModel, tokensShort, type CpaRefusal } from "./ao-chat";

// The line under the chat box, as DeepSeek Harness shows one: the chat's rounds, then the latest
// turn's model requests through CPA (chat_turn_stats, read from CPA Helper's request log): how many
// (steps), time spent in the model, average time to first token and output speed, cache hits and
// tokens. A model that does not go through CPA shows the rounds only.

type TurnStats = {
  available: boolean; steps?: number; failed?: number; latencyMs?: number; ttftMs?: number | null; tokensPerSecond?: number | null;
  cacheHit?: number | null; inputTokens?: number; outputTokens?: number;
  /** The failed requests in a row since the model last answered (null: it answered last). */
  refusal?: CpaRefusal | null;
  /** When the newest counted request was logged (Unix ms). */
  lastAt?: number | null;
};

const POLL_MS = 3_000;

// Whole seconds are rounded before they are split: 179.6 s read "2m 60s".
const seconds = (ms: number) => {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
};

/** Ended turns' numbers, which no longer change: read once per chat window, not on every mount. */
const ENDED_STATS = new Map<string, TurnStats>();

/**
 * The foot of a turn that ended, as Codex closes one: how long it worked ("Worked for 3m 2s") and
 * that turn's own model requests through CPA (steps, time in the model, speed, tokens), where the
 * line under the chat box only ever shows the latest turn's. Read once it scrolls into view.
 * `to`: when the turn ended, or else when the next one started (cards saved before their end time
 * was kept); without either the requests are not counted, since the log runs on into later work.
 * `showTime`: false where the turn's own header already says how long it ran (DeepSeek's).
 */
export function TurnFoot({ from, endedAt, to, models, status, showTime = true }: {
  from?: number; endedAt?: number; to?: number; models?: string[]; status: string; showTime?: boolean;
}) {
  const key = models?.length && from && to ? `${models.join("|")}:${from}:${to}` : "";
  const [stats, setStats] = useState<TurnStats | null>(() => (key ? ENDED_STATS.get(key) ?? null : null));
  const [seen, setSeen] = useState(false);
  const foot = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (!key || stats || seen) return undefined;
    const node = foot.current;
    if (!node || typeof IntersectionObserver === "undefined") { setSeen(true); return undefined; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setSeen(true); });
    observer.observe(node);
    return () => observer.disconnect();
  }, [key, stats, seen]);
  useEffect(() => {
    if (!key || !seen || stats) return undefined;
    let live = true;
    const [model, ...rest] = models!;
    void getCodingToolsClient().apps.call({ moduleId: "agent-orchestrator", operation: "chat_turn_stats", arguments: { model, models: rest, from: from!, to: to! } })
      .then((outer) => {
        const value = outer.result as TurnStats | undefined;
        if (!value?.available) return;
        // Read too soon after the turn ended, the helper may not have logged its last request yet.
        if (Date.now() - to! > 30_000) ENDED_STATS.set(key, value);
        if (live) setStats(value);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [key, seen, stats]);
  // How long it worked: its kept end, or else its last model request when the next turn bounds it.
  const end = endedAt ?? (stats?.lastAt && to ? stats.lastAt : undefined);
  const worked = showTime && from && end && end > from ? `${status === "stopped" ? "Stopped after" : "Worked for"} ${dshDuration(end - from)}` : "";
  const has = stats?.available && stats.steps;
  const parts: { key: string; text: string; title: string }[] = [];
  if (worked) parts.push({ key: "time", text: worked, title: `Started ${new Date(from!).toLocaleString()} · ended ${new Date(end!).toLocaleString()}` });
  if (has) {
    parts.push({ key: "steps", text: `${stats.steps} ${stats.steps === 1 ? "step" : "steps"}${stats.failed ? ` · ${stats.failed} failed` : ""}`, title: "Model requests this turn, retries included" });
    parts.push({ key: "llm", text: `LLM ${seconds(stats.latencyMs ?? 0)}`,
      title: [stats.ttftMs ? `First token ${seconds(stats.ttftMs)}` : "", stats.tokensPerSecond ? `${stats.tokensPerSecond} tok/s` : ""].filter(Boolean).join(" · ") || "Time waiting on the model" });
    parts.push({ key: "tokens", text: `in ${tokensShort(stats.inputTokens)} · out ${tokensShort(stats.outputTokens)}`,
      title: stats.cacheHit !== null && stats.cacheHit !== undefined ? `Cache hit ${Math.round(stats.cacheHit * 100)}%` : "Tokens this turn" });
  }
  // Kept in the page while empty, so the observer has something to watch.
  if (!parts.length) return key ? <p ref={foot} className="cx-turn-foot is-empty" aria-hidden="true" /> : null;
  return <p ref={foot} className="cx-turn-foot" aria-label="This turn">
    {parts.map((part) => <span key={part.key} title={part.title}>{part.text}</span>)}
  </p>;
}

export function ChatTurnStats({ model, models = [], from, rounds, running, onRefusal }: {
  /** The chat agent's route model; only "cpa/…" models have request stats. */
  model?: string;
  /** Every "cpa/…" model the counted turns ran on (chatStatsSpan): a failed attempt on another one too. */
  models?: string[];
  /** When the earliest counted turn started (Unix ms). */
  from?: number;
  rounds: number;
  running: boolean;
  /** Told the running turn's CPA refusals as they are read, so the turn's status line can say why it is quiet. */
  onRefusal?: (refusal: CpaRefusal | null) => void;
}) {
  const [stats, setStats] = useState<TurnStats | null>(null);
  const refusal = running && stats?.available ? stats.refusal ?? null : null;
  const refusalKey = refusal ? `${refusal.streak}:${refusal.status}:${refusal.lastAt}` : "";
  useEffect(() => { onRefusal?.(refusal); }, [refusalKey, onRefusal]);
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
  // CPA refusing the model, right where the request numbers are: "6 refused · rate limited (429)".
  const refused = refusal && refusal.streak >= 2 ? <span key="refusal" className="is-warn"
    title={`The last ${refusal.streak} requests to this model through CPA failed${refusal.since ? ` since ${new Date(refusal.since).toLocaleTimeString()}` : ""}`}>
    {refusal.streak} refused · {cpaStatusWord(refusal.status)}</span> : null;
  // A DeepSeek model's chat shows DeepSeek Harness's two pills: "4 turns 17 steps · 38 tok/s" and
  // "123K tok · Cache hit 97%"; the time and per-direction numbers are on hover.
  if (isDeepSeekModel(model)) {
    const pills: { key: string; text: string; title: string }[] = [{ key: "pace",
      text: `${rounds} ${rounds === 1 ? "turn" : "turns"}${has ? ` ${stats.steps} ${stats.steps === 1 ? "step" : "steps"}${stats.tokensPerSecond ? ` · ${stats.tokensPerSecond} tok/s` : ""}` : ""}`,
      title: has ? `LLM time ${seconds(stats.latencyMs ?? 0)}${stats.ttftMs ? ` · first token ${seconds(stats.ttftMs)}` : ""}${stats.failed ? ` · ${stats.failed} failed` : ""}` : "Messages in this chat" }];
    if (has) {
      pills.push({ key: "tokens", text: `${tokensShort((stats.inputTokens ?? 0) + (stats.outputTokens ?? 0))} tok${stats.cacheHit !== null && stats.cacheHit !== undefined ? ` · Cache hit ${Math.round(stats.cacheHit * 100)}%` : ""}`,
        title: `In ${tokensShort(stats.inputTokens)} · out ${tokensShort(stats.outputTokens)}` });
    }
    return <p className={`cx-turn-stats is-dsh${running ? " is-running" : ""}`} aria-label="Latest turn">
      {pills.map((pill) => <span key={pill.key} title={pill.title}>{pill.text}</span>)}{refused}
    </p>;
  }
  const parts: { key: string; text: string; title: string }[] = [
    { key: "rounds", text: `${rounds} ${rounds === 1 ? "round" : "rounds"}${has ? ` · ${stats.steps} ${stats.steps === 1 ? "step" : "steps"}` : ""}`,
      title: has ? `Messages in this chat · model requests this turn, retries included${stats.failed ? ` · ${stats.failed} failed` : ""}` : "Messages in this chat" },
  ];
  if (has) {
    parts.push({ key: "llm", text: `LLM ${seconds(stats.latencyMs ?? 0)}`, title: "Time waiting on the model this turn" });
    if (stats.ttftMs || stats.tokensPerSecond) {
      parts.push({ key: "speed", text: [stats.ttftMs ? `first token ${seconds(stats.ttftMs)}` : "", stats.tokensPerSecond ? `${stats.tokensPerSecond} tok/s` : ""].filter(Boolean).join(" · "),
        title: "Average time to first token · output speed" });
    }
    if (stats.cacheHit !== null && stats.cacheHit !== undefined) {
      parts.push({ key: "cache", text: `cache ${Math.round(stats.cacheHit * 100)}%`, title: "Input tokens served from the prompt cache" });
    }
    parts.push({ key: "tokens", text: `in ${tokensShort(stats.inputTokens)} · out ${tokensShort(stats.outputTokens)}`, title: "Tokens used this turn, retries included" });
  }
  return <p className={`cx-turn-stats${running ? " is-running" : ""}`} aria-label="Latest turn">
    {parts.map((part) => <span key={part.key} title={part.title}>{part.text}</span>)}{refused}
  </p>;
}
