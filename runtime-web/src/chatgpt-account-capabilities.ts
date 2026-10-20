import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "./config";

/**
 * What ChatGPT's effort slider offered the account the last time a browser page showed it.
 * Setup's solAvailable/proAvailable go stale when a plan changes or ChatGPT reshuffles tiers;
 * every Sol turn opens this slider anyway, so its ticks are read in passing and kept here.
 */
export interface ChatGptEffortSnapshot {
  /** One entry per slider position, by index: Instant, Medium, High, Extra High, Pro. */
  ticks: Array<{ locked: boolean }>;
}

export interface ChatGptCapabilityCache extends ChatGptEffortSnapshot {
  detectedAt: string;
  extraHighAvailable: boolean;
  proAvailable: boolean;
}

/** A day: long enough to cover idle periods, short enough that a lapsed plan is noticed. */
export const CHATGPT_CAPABILITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Rewrite unchanged ticks only after half the TTL, so a busy day does not rewrite the file per turn
// and a daily user never lets it expire.
const CHATGPT_CAPABILITY_CACHE_REFRESH_MS = CHATGPT_CAPABILITY_CACHE_TTL_MS / 2;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_EFFORT_TICKS = 5;

export function chatGptCapabilityCachePath(home = getConfigDir()): string {
  return join(home, "runtime", "chatgpt-account-capabilities.json");
}

/**
 * Turn the ticks' data-locked values into a snapshot. Only an exact, complete reading counts:
 * one "true"/"false" per position of the slider's ARIA range, at most five positions.
 */
export function parseChatGptEffortTicks(
  locks: ReadonlyArray<string | null>,
  optionCount: number,
): ChatGptEffortSnapshot | undefined {
  if (!Number.isInteger(optionCount) || optionCount < 1 || optionCount > MAX_EFFORT_TICKS) return undefined;
  if (locks.length !== optionCount || locks.some(lock => lock !== "true" && lock !== "false")) return undefined;
  return { ticks: locks.map(lock => ({ locked: lock === "true" })) };
}

/** Availability by slider index; absent and locked positions are both unavailable. */
export function chatGptEffortTierAvailability(snapshot: ChatGptEffortSnapshot): boolean[] {
  return Array.from({ length: MAX_EFFORT_TICKS }, (_unused, index) => snapshot.ticks[index]?.locked === false);
}

function validCache(value: unknown): ChatGptCapabilityCache | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.detectedAt !== "string" || !Number.isFinite(Date.parse(raw.detectedAt))) return undefined;
  if (!Array.isArray(raw.ticks)) return undefined;
  const snapshot = parseChatGptEffortTicks(
    raw.ticks.map(tick => tick && typeof tick === "object" && typeof (tick as { locked?: unknown }).locked === "boolean"
      ? String((tick as { locked: boolean }).locked) : null),
    raw.ticks.length,
  );
  if (!snapshot) return undefined;
  const available = chatGptEffortTierAvailability(snapshot);
  return { detectedAt: raw.detectedAt, ...snapshot, extraHighAvailable: available[3]!, proAvailable: available[4]! };
}

function readCache(path: string): ChatGptCapabilityCache | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return validCache(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // A torn or hand-edited file only loses the hint; callers fall back to the setup booleans.
    return undefined;
  }
}

function age(cache: ChatGptCapabilityCache, now: number): number {
  return now - Date.parse(cache.detectedAt);
}

/** The cached snapshot when it is fresh (and not from the future), else undefined. */
export function readFreshChatGptCapabilityCache(
  now = Date.now(),
  path = chatGptCapabilityCachePath(),
): ChatGptCapabilityCache | undefined {
  const cache = readCache(path);
  if (!cache) return undefined;
  const elapsed = age(cache, now);
  return elapsed >= -CLOCK_SKEW_MS && elapsed <= CHATGPT_CAPABILITY_CACHE_TTL_MS ? cache : undefined;
}

/** Fresh per-index tier availability for the model list, or undefined to keep the static list. */
export function freshChatGptEffortTiers(
  now = Date.now(),
  path = chatGptCapabilityCachePath(),
): boolean[] | undefined {
  const cache = readFreshChatGptCapabilityCache(now, path);
  return cache ? chatGptEffortTierAvailability(cache) : undefined;
}

/**
 * Record a passive reading. Writes only when the ticks changed or the stored one is old, so the
 * per-turn call is a file read. Returns whether it wrote.
 */
export function recordChatGptEffortSnapshot(
  snapshot: ChatGptEffortSnapshot,
  now = Date.now(),
  path = chatGptCapabilityCachePath(),
): boolean {
  const existing = readCache(path);
  if (existing
    && JSON.stringify(existing.ticks) === JSON.stringify(snapshot.ticks)
    && age(existing, now) >= -CLOCK_SKEW_MS
    && age(existing, now) < CHATGPT_CAPABILITY_CACHE_REFRESH_MS) {
    return false;
  }
  const available = chatGptEffortTierAvailability(snapshot);
  const cache: ChatGptCapabilityCache = {
    detectedAt: new Date(now).toISOString(),
    ticks: snapshot.ticks.map(tick => ({ locked: tick.locked })),
    extraHighAvailable: available[3]!,
    proAvailable: available[4]!,
  };
  atomicWriteFile(path, `${JSON.stringify(cache, null, 2)}\n`);
  return true;
}
