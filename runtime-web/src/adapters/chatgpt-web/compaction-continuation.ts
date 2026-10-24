import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../config";
import { decodeCompactionSummary, isReadableCompactionSummaryText, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import type { ChatGptTurnIdentity, ChatGptTurnUserRevision } from "./environment";

interface CompletedCheckpoint {
  summaryHash: string;
  sourceHashes: ReadonlySet<string>;
}

// Evidence of a completed checkpoint, never authority inferred from summary-shaped text.
// Live servers persist these exact hashes so a new process can restore the recorded handoff.
const checkpoints = new Map<string, CompletedCheckpoint>();
const MAX_CHECKPOINTS = 256;
const HASH = /^[a-f0-9]{64}$/;
let checkpointPath: string | undefined;

/** Live servers opt into durable proof; direct in-process harnesses remain memory-only. */
export function configureCompactionContinuationStorage(directory: string): void {
  const path = join(directory, "compaction-continuations.json");
  if (checkpointPath === path) return;
  checkpointPath = path;
  checkpoints.clear();
  try {
    const snapshot = JSON.parse(readFileSync(path, "utf8"));
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.checkpoints)) return;
    for (const entry of snapshot.checkpoints.slice(-MAX_CHECKPOINTS)) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, checkpoint] = entry;
      if (typeof key !== "string" || !HASH.test(key)
        || !checkpoint || typeof checkpoint !== "object"
        || typeof checkpoint.summaryHash !== "string" || !HASH.test(checkpoint.summaryHash)
        || !Array.isArray(checkpoint.sourceHashes)
        || checkpoint.sourceHashes.some((hash: unknown) => typeof hash !== "string" || !HASH.test(hash))) continue;
      checkpoints.set(key, {
        summaryHash: checkpoint.summaryHash,
        sourceHashes: new Set(checkpoint.sourceHashes as string[]),
      });
    }
  } catch {
    // Missing/corrupt proof never authorizes a continuation.
  }
}

function persistCheckpoints(): void {
  if (!checkpointPath) return;
  try {
    atomicWriteFile(checkpointPath, JSON.stringify({
      version: 1,
      checkpoints: [...checkpoints].map(([key, checkpoint]) => [key, {
        summaryHash: checkpoint.summaryHash,
        sourceHashes: [...checkpoint.sourceHashes],
      }]),
    }));
  } catch {
    // Disk failure must not break an already valid in-process continuation.
  }
}

function scope(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): string | undefined {
  if (!identity.threadId || !identity.turnId) return undefined;
  return digest([identity.threadId, identity.turnId, parsed.modelId, parsed.options.reasoning]);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceDigest(source: ChatGptTurnUserRevision): string {
  return digest([source.turnId, source.content]);
}

export function rememberCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  sources: readonly ChatGptTurnUserRevision[],
  summary: string,
): void {
  const key = scope(parsed, identity);
  if (!key || !parsed._compactionRequest || !summary) return;
  checkpoints.delete(key);
  checkpoints.set(key, { summaryHash: digest(summary), sourceHashes: new Set(sources.map(sourceDigest)) });
  while (checkpoints.size > MAX_CHECKPOINTS) checkpoints.delete(checkpoints.keys().next().value!);
  persistCheckpoints();
}

export function isAcceptedCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): boolean {
  const key = scope(parsed, identity);
  const checkpoint = key ? checkpoints.get(key) : undefined;
  if (!key || !checkpoint || !checkpoint.sourceHashes.has(sourceDigest(source))) return false;
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) return false;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") continue;
    if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) {
      const summary = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
      return summary !== null && acceptsSummary(key, checkpoint, summary);
    }
    if (item.role !== "user") continue;
    const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
      ? item.content.map(part => part?.text ?? "").join("\n") : "";
    if (isReadableCompactionSummaryText(text)) {
      return acceptsSummary(key, checkpoint, text.slice(SUMMARY_PREFIX.length + 1));
    }
  }
  return false;
}

function acceptsSummary(key: string, checkpoint: CompletedCheckpoint, summary: string): boolean {
  if (digest(summary) !== checkpoint.summaryHash) return false;
  // A long-running continuation does not become invalid merely because time passed. Keep the
  // bounded registry ordered by actual use instead of expiring a still-active native turn.
  if ([...checkpoints.keys()].at(-1) !== key) {
    checkpoints.delete(key);
    checkpoints.set(key, checkpoint);
    persistCheckpoints();
  }
  return true;
}
