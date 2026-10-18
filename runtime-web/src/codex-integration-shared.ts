import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppConfig, SubagentProtocol } from "./config";
import { atomicWriteFile, expandUserPath, getConfigDir } from "./config";

export const MANAGED_COMMENT = "# Managed by codex-chatgpt-web; `codex-chatgpt-web uninstall` restores prior values.";
export const MANAGED_ROUTE_COMMENT =
  "# Managed by codex-chatgpt-web: Responses use the local bridge; Voice stays on ChatGPT.";
export const CODEX_REALTIME_WEBRTC_CALL_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const MANAGED_REMOTE_COMPACTION_LINE =
  "remote_compaction_v2 = false # Managed by codex-chatgpt-web: bounds retained Web image history.";
export const MANAGED_MULTI_AGENT_LINE =
  "multi_agent = true # Managed by codex-chatgpt-web: enables routed Web subagents.";
export const MANAGED_MULTI_AGENT_V2_LINE =
  "multi_agent_v2 = false # Managed by codex-chatgpt-web: keeps routed Web subagent payloads readable.";
export const MANAGED_MULTI_AGENT_V2_TABLE_LINE =
  "enabled = false # Managed by codex-chatgpt-web: keeps routed Web subagent payloads readable.";
export const MIN_COMPATIBILITY_V1_AGENT_DEPTH = 2;
export function managedAgentMaxDepthLine(value: number): string {
  return `max_depth = ${value} # Managed by codex-chatgpt-web: allows nested routed Web subagents in Compatibility V1.`;
}

export interface PreviousAssignment {
  present: boolean;
  rawLine?: string;
  value?: string;
  index?: number;
}
export type ManagedAssignmentKey = "openai_base_url" | "model_provider" | "model_catalog_json";

export interface PreviousFeatureAssignment extends PreviousAssignment {
  tablePresent: boolean;
  tableName?: "features" | "features.multi_agent_v2";
  inlineTable?: boolean;
  separatorInserted?: boolean;
}

export interface PreviousAgentAssignment extends PreviousAssignment {
  tablePresent: boolean;
  separatorInserted?: boolean;
}

export interface InstalledCodexInterruptHook {
  command: string;
  groupIndex: number;
  stateKey: string;
  trustedHash: string;
  fragment: string;
}

export interface CodexIntegrationJournal {
  version: 10;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
    experimental_realtime_webrtc_call_base_url: string;
    subagent_protocol: SubagentProtocol;
    agent_max_depth?: number;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  previousRealtimeWebrtcCallBaseUrl: PreviousAssignment;
  interruptHook: InstalledCodexInterruptHook;
  previousMultiAgent?: PreviousFeatureAssignment;
  previousMultiAgentV2?: PreviousFeatureAssignment;
  previousAgentMaxDepth?: PreviousAgentAssignment;
  format?: {
    lineEnding: "\n" | "\r\n" | "\r";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournalV9 {
  version: 9;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
    experimental_realtime_webrtc_call_base_url: string;
    subagent_protocol: SubagentProtocol;
    agent_max_depth?: number;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  previousRealtimeWebrtcCallBaseUrl: PreviousAssignment;
  previousMultiAgent?: PreviousFeatureAssignment;
  previousMultiAgentV2?: PreviousFeatureAssignment;
  previousAgentMaxDepth?: PreviousAgentAssignment;
  format?: {
    lineEnding: "\n" | "\r\n" | "\r";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournalV8 {
  version: 8;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
    subagent_protocol: SubagentProtocol;
    agent_max_depth?: number;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  previousMultiAgent?: PreviousFeatureAssignment;
  previousMultiAgentV2?: PreviousFeatureAssignment;
  previousAgentMaxDepth?: PreviousAgentAssignment;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournalV7 {
  version: 7;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournalV6 {
  version: 6;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
    remote_compaction_v2: false;
    multi_agent: true;
    multi_agent_v2: false;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  previousRemoteCompactionV2: PreviousFeatureAssignment;
  previousMultiAgent: PreviousFeatureAssignment;
  previousMultiAgentV2: PreviousFeatureAssignment;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournalV5 {
  version: 5;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
    remote_compaction_v2: false;
    multi_agent: true;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  previousRemoteCompactionV2: PreviousFeatureAssignment;
  previousMultiAgent: PreviousFeatureAssignment;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournalV4 {
  version: 4;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournalV3 {
  version: 3;
  configPath: string;
  installed: {
    openai_base_url: string;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournal {
  version: 2;
  configPath: string;
  catalogPath: string;
  catalogSha256: string;
  providerBlock: string;
  installed: {
    model_provider: string;
    model_catalog_json: string;
  };
  previous: {
    model_provider: PreviousAssignment;
    model_catalog_json: PreviousAssignment;
  };
}

export type ManagedRouteJournal =
  | CodexIntegrationJournal
  | LegacyCodexIntegrationJournalV9
  | LegacyCodexIntegrationJournalV8
  | LegacyCodexIntegrationJournalV7
  | LegacyCodexIntegrationJournalV6
  | LegacyCodexIntegrationJournalV5
  | LegacyCodexIntegrationJournalV4
  | LegacyCodexIntegrationJournalV3;
export type AnyCodexIntegrationJournal = ManagedRouteJournal | LegacyCodexIntegrationJournal;

export interface FileSnapshot {
  path: string;
  exists: boolean;
  data?: Buffer;
  symlink?: { link: string; target: string; mode: number };
}

export interface InstallCodexIntegrationOptions {
  replaceExistingRoute?: boolean;
}

export interface UninstallCodexIntegrationResult {
  changed: boolean;
}

export interface SetCodexIntegrationActiveResult {
  changed: boolean;
  active: boolean;
}

export interface CodexModelContextOverride {
  contextWindow: number;
}

export function getCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return resolve(expandUserPath(configured || join(homedir(), ".codex")));
}

export function getCodexConfigPath(): string {
  return join(getCodexHome(), "config.toml");
}

export function getCodexModelsCachePath(): string {
  return join(getCodexHome(), "models_cache.json");
}

export function getCodexJournalPath(): string {
  return join(getConfigDir(), "codex", "integration-journal.json");
}

export function getCodexJournalRecoveryPath(): string {
  return join(getConfigDir(), "codex", "integration-journal.recovery.json");
}

export function routeUrl(config: AppConfig): string {
  return `http://${config.host}:${config.port}/v1`;
}

/** The Responses route of a bridge on its default port (any codex-chatgpt-web install, this one or an earlier one). */
export const DEFAULT_BRIDGE_ROUTE_URL = "http://127.0.0.1:17841/v1";
export const MANAGED_REALTIME_ROUTE_LINE =
  `experimental_realtime_webrtc_call_base_url = ${JSON.stringify(CODEX_REALTIME_WEBRTC_CALL_BASE_URL)}`;

function loopbackRouteIdentity(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return undefined; }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) return undefined;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return undefined;
  if (url.pathname.replace(/\/+$/, "") !== "/v1") return undefined;
  return `loopback:${url.port || "80"}/v1`;
}

/**
 * Whether a Codex `openai_base_url` points at a codex-chatgpt-web bridge: the default bridge port
 * or one of `bridgeRoutes` (the route an install wrote). Such a value is never the user's own
 * route, so it is never "restored": restoring it would leave Codex on a bridge being removed.
 */
export function isBridgeRouteUrl(value: string | undefined, bridgeRoutes: readonly string[] = []): boolean {
  if (typeof value !== "string") return false;
  const identity = loopbackRouteIdentity(value);
  return identity !== undefined
    && [DEFAULT_BRIDGE_ROUTE_URL, ...bridgeRoutes].some(route => loopbackRouteIdentity(route) === identity);
}

/**
 * The prior route this integration may put back. A prior value that was itself a bridge route
 * (left by an earlier install whose journal is gone, or another codex-chatgpt-web home) is
 * treated as absent, and so is the Voice line that bridge wrote beside it.
 */
export function restorablePreviousRoute(
  previous: PreviousAssignment,
  previousRealtime: PreviousAssignment | undefined,
  bridgeRoutes: readonly string[],
): { route: PreviousAssignment; realtime: PreviousAssignment | undefined } {
  if (!previous.present || !isBridgeRouteUrl(previous.value, bridgeRoutes)) {
    return { route: previous, realtime: previousRealtime };
  }
  return {
    route: { present: false },
    realtime: previousRealtime?.present && previousRealtime.rawLine === MANAGED_REALTIME_ROUTE_LINE
      ? { present: false }
      : previousRealtime,
  };
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function snapshotFile(path: string, options?: { followSymlink?: boolean }): FileSnapshot {
  if (options?.followSymlink) {
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (stat?.isSymbolicLink()) {
      const link = readlinkSync(path);
      const target = realpathSync(path);
      const targetStat = lstatSync(target);
      if (!targetStat.isFile()) throw new Error(`Codex config symlink target is not a regular file: ${path}`);
      return { path, exists: true, data: readFileSync(target), symlink: { link, target, mode: targetStat.mode & 0o777 } };
    }
  }
  return existsSync(path)
    ? { path, exists: true, data: readFileSync(path) }
    : { path, exists: false };
}

/** Write the snapshotted config target, never replace its symbolic link or follow a new target. */
export function writeFileSnapshot(snapshot: FileSnapshot, data: string | Uint8Array): void {
  const symlink = snapshot.symlink;
  if (!symlink) {
    atomicWriteFile(snapshot.path, data);
    return;
  }
  if (!lstatSync(snapshot.path).isSymbolicLink()
    || readlinkSync(snapshot.path) !== symlink.link
    || realpathSync(snapshot.path) !== symlink.target) {
    throw new Error(`Codex config symlink changed during the operation: ${snapshot.path}`);
  }
  atomicWriteFile(symlink.target, data, { mode: symlink.mode, protectDirectory: false });
}

export function restoreFileSnapshot(snapshot: FileSnapshot): void {
  if (snapshot.exists) {
    if (!snapshot.data) throw new Error(`File snapshot is missing data: ${snapshot.path}`);
    writeFileSnapshot(snapshot, snapshot.data);
  } else {
    rmSync(snapshot.path, { force: true });
  }
}

export function writeFilesWithCompensation(
  writes: Array<{ path: string; data: string | Uint8Array; followSymlink?: boolean }>,
  removals: string[] = [],
): void {
  const paths = [...new Set([...writes.map(write => write.path), ...removals])];
  const snapshots = new Map(paths.map(path => [path, snapshotFile(path, {
    followSymlink: writes.some(write => write.path === path && write.followSymlink === true),
  })]));
  try {
    for (const write of writes) writeFileSnapshot(snapshots.get(write.path)!, write.data);
    for (const removal of removals) rmSync(removal, { force: true });
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [...snapshots.values()].reverse()) {
      try {
        restoreFileSnapshot(snapshot);
      } catch (rollbackError) {
        rollbackFailures.push(`${snapshot.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(
      rollbackFailures.length > 0
        ? `${primary}; Codex integration rollback also failed: ${rollbackFailures.join("; ")}`
        : primary,
    );
  }
}

export function serializeJournal(journal: AnyCodexIntegrationJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

export function writeIntegrationState(
  journal: AnyCodexIntegrationJournal,
  configWrite?: { path: string; data: string },
  removals: string[] = [],
): void {
  const data = serializeJournal(journal);
  // The recovery copy records intent and the primary copy records commit. If the process stops
  // between those writes, the physical config unambiguously selects the completed state.
  writeFilesWithCompensation([
    { path: getCodexJournalRecoveryPath(), data },
    ...(configWrite ? [{ ...configWrite, followSymlink: true }] : []),
    { path: getCodexJournalPath(), data },
  ], removals);
}
