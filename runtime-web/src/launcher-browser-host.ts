import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { expandUserPath } from "./config";
import { processRunning } from "./process";

export const LAUNCHER_BROWSER_HOST_KIND = "codex-web-gpt-launcher";
export const LAUNCHER_BROWSER_IDLE_URL = "data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Chtml%3E%3Chead%3E%3Cmeta%20charset%3D%22utf-8%22%3E%3Ctitle%3ECodex%20Web%20GPT%3C%2Ftitle%3E%3C%2Fhead%3E%3Cbody%3E%3C%2Fbody%3E%3C%2Fhtml%3E#codex-web-gpt-browser-host";
export const LAUNCHER_BROWSER_PARTITION_PRODUCTION = "persist:coding-tools-chatgpt";
export const LAUNCHER_BROWSER_PARTITION_DEVELOPMENT = "persist:coding-tools-dev-chatgpt";
export type LauncherBrowserHostProfile = "production" | "development";

export function expectedLauncherBrowserPartition(profile: LauncherBrowserHostProfile): string {
  return profile === "development"
    ? LAUNCHER_BROWSER_PARTITION_DEVELOPMENT
    : LAUNCHER_BROWSER_PARTITION_PRODUCTION;
}

export class LauncherBrowserTurnCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherBrowserTurnCancelledError";
  }
}

export class LauncherRetainedConversationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherRetainedConversationUnavailableError";
  }
}

export class LauncherManualTurnTimedOutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherManualTurnTimedOutError";
  }
}

export class LauncherManualTurnFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherManualTurnFailedError";
  }
}

export interface LauncherBrowserHostDescriptor {
  version: 3;
  kind: typeof LAUNCHER_BROWSER_HOST_KIND;
  profile: LauncherBrowserHostProfile;
  pid: number;
  endpoint: string;
  control: {
    endpoint: string;
    token: string;
  };
  helper: {
    executable: string;
    script: string;
  };
  partition: string;
  idleUrl: string;
  surfaceId: string;
  surfaceTargets: Record<string, string>;
  createdAt: string;
}

export interface LauncherBrowserConnection {
  descriptor: LauncherBrowserHostDescriptor;
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

function assertLoopbackEndpoint(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`);
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${label} is not a valid URL`); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error(`${label} must use http://127.0.0.1`);
  }
  if (!parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must contain only a loopback host and explicit port`);
  }
  return parsed.origin;
}

function assertDescriptorShape(value: unknown): LauncherBrowserHostDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Launcher browser descriptor is not an object");
  }
  const descriptor = value as Partial<LauncherBrowserHostDescriptor>;
  if (descriptor.version !== 3 || descriptor.kind !== LAUNCHER_BROWSER_HOST_KIND) {
    throw new Error("Launcher browser descriptor has an unsupported identity or version; restart the updated launcher");
  }
  if (descriptor.profile !== "production" && descriptor.profile !== "development") {
    throw new Error("Launcher browser descriptor has an invalid profile");
  }
  if (!Number.isInteger(descriptor.pid) || descriptor.pid! < 1) {
    throw new Error("Launcher browser descriptor has an invalid pid");
  }
  const endpoint = assertLoopbackEndpoint(descriptor.endpoint, "Launcher CDP endpoint");
  if (!descriptor.control || typeof descriptor.control !== "object") {
    throw new Error("Launcher browser descriptor is missing its control channel");
  }
  const controlEndpoint = assertLoopbackEndpoint(descriptor.control.endpoint, "Launcher control endpoint");
  if (typeof descriptor.control.token !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(descriptor.control.token)) {
    throw new Error("Launcher browser descriptor has an invalid control token");
  }
  if (!descriptor.helper || typeof descriptor.helper !== "object") {
    throw new Error("Launcher browser descriptor is missing its Node helper command");
  }
  const helperExecutable = typeof descriptor.helper.executable === "string" ? resolve(descriptor.helper.executable) : "";
  const helperScript = typeof descriptor.helper.script === "string" ? resolve(descriptor.helper.script) : "";
  if (!helperExecutable || !existsSync(helperExecutable)) {
    throw new Error("Launcher browser descriptor helper executable does not exist");
  }
  if (!helperScript || !existsSync(helperScript)) {
    throw new Error("Launcher browser descriptor helper script does not exist");
  }
  const expectedPartition = expectedLauncherBrowserPartition(descriptor.profile);
  if (descriptor.partition !== expectedPartition) {
    throw new Error("Launcher browser descriptor identifies an unexpected browser partition");
  }
  if (descriptor.idleUrl !== LAUNCHER_BROWSER_IDLE_URL) {
    throw new Error("Launcher browser descriptor identifies an unexpected idle surface");
  }
  if (typeof descriptor.surfaceId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(descriptor.surfaceId)) {
    throw new Error("Launcher browser descriptor has an invalid owned surface id");
  }
  const targets = descriptor.surfaceTargets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)
    || Object.entries(targets).some(([surface, target]) => !/^[A-Za-z0-9_-]{32}$/.test(surface)
      || typeof target !== "string" || !target.trim())
    || new Set(Object.values(targets)).size !== Object.keys(targets).length) {
    throw new Error("Launcher browser descriptor has invalid or duplicated surface targets");
  }
  if (typeof descriptor.createdAt !== "string" || Number.isNaN(Date.parse(descriptor.createdAt))) {
    throw new Error("Launcher browser descriptor has an invalid creation time");
  }
  return {
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: descriptor.profile,
    pid: descriptor.pid!,
    endpoint,
    control: { endpoint: controlEndpoint, token: descriptor.control.token },
    helper: { executable: helperExecutable, script: helperScript },
    partition: descriptor.partition,
    idleUrl: descriptor.idleUrl,
    surfaceId: descriptor.surfaceId,
    surfaceTargets: targets,
    createdAt: descriptor.createdAt,
  };
}

export function readLauncherBrowserHostDescriptor(configuredPath: string): LauncherBrowserHostDescriptor {
  const path = resolve(expandUserPath(configuredPath));
  if (!existsSync(path)) throw new Error(`Launcher browser host is unavailable: descriptor is missing at ${path}`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Launcher browser descriptor is not a regular file: ${path}`);
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) throw new Error(`Launcher browser descriptor has unsafe permissions: ${path}`);
    const getuid = process.getuid;
    if (typeof getuid === "function" && stat.uid !== getuid()) {
      throw new Error(`Launcher browser descriptor is not owned by the current user: ${path}`);
    }
  }
  let decoded: unknown;
  try { decoded = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    throw new Error(`Launcher browser descriptor is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const descriptor = assertDescriptorShape(decoded);
  if (!processRunning(descriptor.pid)) {
    throw new Error(`Launcher browser host process is not running (pid ${descriptor.pid})`);
  }
  return descriptor;
}

/** How long a turn waits for the app to come back when it is gone without saying why (a crash). */
export const LAUNCHER_RESTART_WAIT_MS = 120_000;
/** The longest a restart the app announced (its marker's `until`) keeps a turn waiting. */
export const LAUNCHER_ANNOUNCED_RESTART_MAX_MS = 15 * 60_000;
/** The longest its `holdUntil` (newer apps: an update can take more than 15 minutes) keeps one waiting. */
export const LAUNCHER_ANNOUNCED_HOLD_MAX_MS = 30 * 60_000;

/**
 * When an announced restart should be over (ms since the epoch), or null. The app writes
 * `launcher-browser.restarting.json` next to its descriptor when it quits leaving this bridge
 * running (an update install takes minutes), and the new app removes it. A marker that is
 * unreadable, expired, or claims more than LAUNCHER_ANNOUNCED_RESTART_MAX_MS is ignored.
 */
export function launcherRestartAnnouncedUntil(configuredPath: string, now = Date.now()): number | null {
  return launcherRestartAnnounced(configuredPath, now)?.until ?? null;
}

/**
 * An announced restart: when it should be over, and the pid of the app that announced it (the one
 * shutting down), or null when there is no valid marker. See launcherRestartAnnouncedUntil.
 */
export function launcherRestartAnnounced(configuredPath: string, now = Date.now()): { until: number; pid: number | null } | null {
  const markerPath = join(dirname(resolve(expandUserPath(configuredPath))), "launcher-browser.restarting.json");
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { version?: unknown; pid?: unknown; createdAt?: unknown; until?: unknown; holdUntil?: unknown };
    if (marker.version !== 1 || typeof marker.until !== "string" || typeof marker.createdAt !== "string") return null;
    const created = Date.parse(marker.createdAt);
    if (!Number.isFinite(created)) return null;
    // Each end counts only within its own limit; the later valid one wins.
    const within = (value: unknown, max: number) => {
      const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
      return Number.isFinite(at) && at > now && at - created <= max && at - now <= max ? at : null;
    };
    const ends = [within(marker.until, LAUNCHER_ANNOUNCED_RESTART_MAX_MS), within(marker.holdUntil, LAUNCHER_ANNOUNCED_HOLD_MAX_MS)]
      .filter((value): value is number => value !== null);
    if (!ends.length) return null;
    const pid = typeof marker.pid === "number" && Number.isSafeInteger(marker.pid) && marker.pid > 0 ? marker.pid : null;
    return { until: Math.max(...ends), pid };
  } catch {
    return null;
  }
}

/**
 * The descriptor, waiting while the app restarts. The app removes its descriptor when it quits and
 * writes a new one once its browser is up again, so for the length of an update a turn would find
 * it missing (or naming the old, exited process) and fail at once; it waits for the new one
 * instead, up to `timeoutMs`. Any other problem with the descriptor fails at once.
 *
 * `missingIsRestart: false` waits only when the evidence says the app is coming back: a descriptor
 * left by an app that exited without removing it (a crash) or an announced restart. A descriptor
 * removed by a clean quit with nothing announced then fails at once.
 */
export async function waitForLauncherBrowserHostDescriptor(
  configuredPath: string,
  {
    timeoutMs = LAUNCHER_RESTART_WAIT_MS,
    intervalMs = 500,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>(resolveSleep => setTimeout(resolveSleep, ms)),
    signal,
    missingIsRestart = true,
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
    missingIsRestart?: boolean;
  } = {},
): Promise<LauncherBrowserHostDescriptor> {
  const started = now();
  const deadline = started + timeoutMs;
  for (;;) {
    try {
      const descriptor = readLauncherBrowserHostDescriptor(configuredPath);
      // The quitting app announces the restart first and removes its descriptor only at the end of
      // shutdown: a descriptor of the app that announced it names a browser about to close, so the
      // turn waits for the new app's instead of attaching to it.
      const announced = timeoutMs > 0 ? launcherRestartAnnounced(configuredPath, now()) : null;
      if (!announced || announced.pid === null || announced.pid !== descriptor.pid) return descriptor;
      if (signal?.aborted || now() >= Math.max(deadline, announced.until)) {
        throw new Error(`Launcher browser host is restarting (pid ${descriptor.pid} is shutting down; waited ${Math.round((now() - started) / 1000)} s for Coding Tools to start again)`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Launcher browser host is restarting")) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const crashed = /host process is not running/.test(message);
      const missing = /descriptor is missing/.test(message);
      // An announced restart (an update installing) keeps the turn waiting until it should be over.
      const announced = (crashed || missing) && timeoutMs > 0 ? launcherRestartAnnouncedUntil(configuredPath, now()) : null;
      const restarting = crashed || (missing && (missingIsRestart || announced !== null));
      if (!restarting || signal?.aborted || now() >= Math.max(deadline, announced ?? 0)) {
        if (restarting && !signal?.aborted && timeoutMs > 0) {
          throw new Error(`${message} (waited ${Math.round((now() - started) / 1000)} s for Coding Tools to start again)`);
        }
        throw error;
      }
    }
    await sleep(intervalMs);
  }
}

async function assertCdpReady(descriptor: LauncherBrowserHostDescriptor, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${descriptor.endpoint}/json/version`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.webSocketDebuggerUrl !== "string" || !body.webSocketDebuggerUrl.startsWith("ws://127.0.0.1:")) {
      throw new Error("CDP metadata did not expose a loopback WebSocket endpoint");
    }
  } catch (error) {
    throw new Error(`Launcher browser CDP endpoint is not ready: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectLauncherBrowserHostLiveness(
  descriptorPath: string,
  options: {
    expectedProfile?: LauncherBrowserHostProfile;
    timeoutMs?: number;
  } = {},
): Promise<LauncherBrowserHostDescriptor> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  if (options.expectedProfile && descriptor.profile !== options.expectedProfile) {
    throw new Error(
      `Launcher browser belongs to ${descriptor.profile}, but ${options.expectedProfile} was required`,
    );
  }
  await assertCdpReady(descriptor, options.timeoutMs ?? 5_000);
  return descriptor;
}

export async function selectLauncherPage(
  browser: Browser,
  descriptor: LauncherBrowserHostDescriptor,
  timeoutMs: number,
  surfaceId = descriptor.surfaceId,
  abortSignal?: AbortSignal,
): Promise<{ context: BrowserContext; page: Page }> {
  if (abortSignal?.aborted) {
    throw new DOMException("Launcher browser connection aborted", "AbortError");
  }
  const targetId = descriptor.surfaceTargets[surfaceId];
  if (!targetId) throw new Error("Launcher browser surface is no longer registered with its native target");
  const deadline = Date.now() + timeoutMs;
  do {
    if (abortSignal?.aborted) {
      throw new DOMException("Launcher browser connection aborted", "AbortError");
    }
    const candidates = browser.contexts().flatMap(context => context.pages().map(page => ({ context, page })));
    // Target metadata belongs to the browser process. Evaluating every page here makes an
    // unrelated busy/paused renderer block acquisition of an already-responsive owned page.
    const inspected = await Promise.all(candidates.map(async candidate => {
      const session = await candidate.context.newCDPSession(candidate.page).catch(() => undefined);
      if (!session) return { ...candidate, targetId: undefined };
      try {
        const { targetInfo } = await session.send("Target.getTargetInfo");
        return { ...candidate, targetId: targetInfo.targetId };
      } catch {
        return { ...candidate, targetId: undefined };
      } finally {
        await session.detach().catch(() => {});
      }
    }));
    const owned = inspected.filter(candidate => candidate.targetId === targetId);
    if (owned.length === 1) {
      return { context: owned[0].context, page: owned[0].page };
    }
    if (owned.length > 1) {
      throw new Error(`Launcher browser host exposed ${owned.length} surfaces with the same ownership id`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Launcher browser host did not expose its owned browser surface");
}

export async function connectLauncherBrowserHost(
  descriptorPath: string,
  timeoutMs = 20_000,
  surfaceId?: string,
  abortSignal?: AbortSignal,
): Promise<LauncherBrowserConnection> {
  if (abortSignal?.aborted) {
    throw new DOMException("Launcher browser connection aborted", "AbortError");
  }
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  await assertCdpReady(descriptor, Math.min(timeoutMs, 5_000));
  let browser: Browser;
  try {
    // Electron owns these live pages. Attaching another worker must not reset their focus or media settings.
    browser = await chromium.connectOverCDP(descriptor.endpoint, { timeout: timeoutMs, noDefaults: true });
  } catch (error) {
    throw new Error(`Could not connect Playwright to the launcher browser: ${error instanceof Error ? error.message : String(error)}`);
  }
  const closeOnAbort = () => { void browser.close().catch(() => {}); };
  abortSignal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    if (abortSignal?.aborted) {
      throw new DOMException("Launcher browser connection aborted", "AbortError");
    }
    const { context, page } = await selectLauncherPage(
      browser,
      descriptor,
      timeoutMs,
      surfaceId,
      abortSignal,
    );
    // Hidden Electron tabs need focus emulation for keyboard controls. Scope it to the leased
    // page; keep the session attached until browser.close() releases this worker's connection.
    const ownedPageSession = await context.newCDPSession(page);
    await ownedPageSession.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    return { descriptor, browser, context, page };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  } finally {
    abortSignal?.removeEventListener("abort", closeOnAbort);
  }
}

export async function inspectLauncherBrowserHost(
  descriptorPath: string,
  options: {
    detectCapabilities?: boolean;
    expectedProfile?: LauncherBrowserHostProfile;
    timeoutMs?: number;
  } = {},
): Promise<{ solAvailable?: boolean; proAvailable?: boolean; url: string }> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  if (options.expectedProfile && descriptor.profile !== options.expectedProfile) {
    throw new Error(
      `Launcher browser belongs to ${descriptor.profile}, but ${options.expectedProfile} was required`,
    );
  }
  const timeoutMs = options.timeoutMs ?? (options.detectCapabilities
    ? LAUNCHER_CAPABILITY_INSPECTION_TIMEOUT_MS
    : LAUNCHER_SESSION_INSPECTION_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/session/inspect`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ detectCapabilities: options.detectCapabilities === true }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
    if (body.authenticated !== true || body.temporary !== true || typeof body.url !== "string") {
      throw new Error("Launcher returned invalid ChatGPT session evidence");
    }
    if (options.detectCapabilities
      && (typeof body.solAvailable !== "boolean" || typeof body.proAvailable !== "boolean")) {
      throw new Error("Launcher did not return complete ChatGPT account capability evidence");
    }
    if (options.detectCapabilities && body.proAvailable === true && body.solAvailable !== true) {
      throw new Error("Launcher returned contradictory ChatGPT account capability evidence");
    }
    return {
      url: body.url,
      ...(options.detectCapabilities ? {
        solAvailable: body.solAvailable as boolean,
        proAvailable: body.proAvailable as boolean,
      } : {}),
    };
  } catch (error) {
    const detail = timedOut
      ? `session inspection timed out after ${timeoutMs}ms`
      : error instanceof Error ? error.message : String(error);
    throw new Error(`Launcher ChatGPT session could not be verified: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

export const LAUNCHER_SESSION_INSPECTION_TIMEOUT_MS = 30_000;
export const LAUNCHER_CAPABILITY_INSPECTION_TIMEOUT_MS = 120_000;

export type LauncherTurnActivity =
  | {
      phase: "start";
      traceId: string;
      helperPid: number;
      nativeThreadId?: string;
      conversationKey?: string;
      connectorIdentity?: string;
      requireRetainedConversation?: boolean;
    }
  | {
      phase: "heartbeat";
      traceId: string;
      helperPid: number;
      /** Re-establish the launcher's hidden viewport after the caller closes its CDP session. */
      refreshViewport?: boolean;
    }
  | {
      phase: "end";
      traceId: string;
      helperPid: number;
      status: "completed" | "failed" | "aborted" | "superseded";
      message?: string;
      retain?: boolean;
      connectorBound?: boolean;
    };

/**
 * A start opens the turn's tab and loads ChatGPT in it, with 10, 30 and 60 s load windows inside a
 * 120 s budget (the launcher's TURN_TAB_BOOTSTRAP_TIMEOUT_MS). Giving up after 5 s failed every turn
 * on a busy machine, WebGPT compaction handoffs included, while the tab went on loading.
 */
export const LAUNCHER_TURN_START_TIMEOUT_MS = 125_000;
// Four beats inside the launcher's 60 s lease, so three in a row can fail before a turn is reaped.
export const LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS = 15_000;
export const LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS = 5_000;
export const LAUNCHER_TURN_END_TIMEOUT_MS = 15_000;

export interface LauncherManualTurnOwner {
  traceId: string;
  helperPid: number;
}

export interface LauncherManualTurnStart extends LauncherManualTurnOwner {
  prompt: string;
  /** Used only when the exact retained ChatGPT conversation already owns the accumulated history. */
  resumePrompt?: string;
  conversationKey?: string;
  /** Gives a manual context handoff enough time without widening ordinary Zero Risk turns. */
  compaction?: true;
}

export interface LauncherManualTurnLease {
  tabId: string;
  reused: boolean;
  deadlineAt: string | null;
  state: "awaiting-user" | "sent" | "running" | "completed";
}

export interface LauncherManualTurnEnd extends LauncherManualTurnOwner {
  status: "completed" | "failed" | "aborted";
  retain?: boolean;
}

export interface LauncherManualTurnTerminal {
  status: "cancelled" | "failed";
}

export const LAUNCHER_MANUAL_TURN_START_TIMEOUT_MS = 10_000;
export const LAUNCHER_MANUAL_SENT_REQUEST_TIMEOUT_MS = 40_000;
export const LAUNCHER_MANUAL_TURN_END_TIMEOUT_MS = 15_000;

async function launcherManualRequest(
  descriptor: LauncherBrowserHostDescriptor,
  action: "start" | "wait-sent" | "wait-terminal" | "started" | "end" | "cancel",
  body: LauncherManualTurnStart | LauncherManualTurnOwner | LauncherManualTurnEnd,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  abortSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/manual/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const decoded = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { response, body: decoded };
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", abort);
  }
}

async function reconcileLauncherManualMutation(
  descriptor: LauncherBrowserHostDescriptor,
  action: "start" | "started" | "end",
  body: LauncherManualTurnStart | LauncherManualTurnOwner | LauncherManualTurnEnd,
  timeoutMs: number,
  validAcknowledgement: (body: Record<string, unknown>) => boolean,
  invalidAcknowledgementMessage: string,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  let ambiguousError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await launcherManualRequest(descriptor, action, body, timeoutMs);
      if (!result.response.ok || validAcknowledgement(result.body)) return result;
      ambiguousError = new LauncherManualTurnFailedError(invalidAcknowledgementMessage);
    } catch (error) {
      ambiguousError = error;
    }
  }
  // These mutations are keyed by the exact turn owner and are idempotent in the launcher.
  // The second identical request reconciles one missing or incomplete local acknowledgement.
  throw ambiguousError;
}

function isLauncherManualTurnLease(body: Record<string, unknown>): boolean {
  return body.ok === true
    && typeof body.tabId === "string"
    && body.tabId.length > 0
    && typeof body.reused === "boolean"
    && (body.deadlineAt === null
      || (typeof body.deadlineAt === "string" && !Number.isNaN(Date.parse(body.deadlineAt))))
    && ["awaiting-user", "sent", "running", "completed"].includes(String(body.state));
}

function throwManualControlError(response: Response, body: Record<string, unknown>): never {
  const message = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
  if (body.code === "turn_cancelled") throw new LauncherBrowserTurnCancelledError(message);
  if (body.code === "manual_turn_timed_out") throw new LauncherManualTurnTimedOutError(message);
  throw new LauncherManualTurnFailedError(message);
}

export async function startLauncherManualTurn(
  descriptorPath: string,
  activity: LauncherManualTurnStart,
  timeoutMs = LAUNCHER_MANUAL_TURN_START_TIMEOUT_MS,
): Promise<LauncherManualTurnLease> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const { response, body } = await reconcileLauncherManualMutation(
    descriptor,
    "start",
    activity,
    timeoutMs,
    isLauncherManualTurnLease,
    "Launcher returned an invalid manual turn lease",
  );
  if (!response.ok) throwManualControlError(response, body);
  return {
    tabId: body.tabId as string,
    reused: body.reused as boolean,
    deadlineAt: body.deadlineAt as string | null,
    state: body.state as LauncherManualTurnLease["state"],
  };
}

export async function waitForLauncherManualSent(
  descriptorPath: string,
  owner: LauncherManualTurnOwner,
  options: { abortSignal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ sentAt: string | null }> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const timeoutMs = options.timeoutMs ?? LAUNCHER_MANUAL_SENT_REQUEST_TIMEOUT_MS;
  for (;;) {
    if (options.abortSignal?.aborted) throw new DOMException("Manual Sent wait aborted", "AbortError");
    const { response, body } = await launcherManualRequest(
      descriptor,
      "wait-sent",
      owner,
      timeoutMs,
      options.abortSignal,
    );
    if (response.status === 202 && body.status === "pending") continue;
    if (!response.ok) throwManualControlError(response, body);
    if (body.status !== "sent"
      || (body.sentAt !== null && (typeof body.sentAt !== "string" || Number.isNaN(Date.parse(body.sentAt))))) {
      throw new LauncherManualTurnFailedError("Launcher returned invalid manual Sent confirmation");
    }
    return { sentAt: body.sentAt as string | null };
  }
}

export async function markLauncherManualTurnStarted(
  descriptorPath: string,
  owner: LauncherManualTurnOwner,
  timeoutMs = LAUNCHER_MANUAL_TURN_END_TIMEOUT_MS,
): Promise<void> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const { response, body } = await reconcileLauncherManualMutation(
    descriptor,
    "started",
    owner,
    timeoutMs,
    body => body.ok === true,
    "Launcher returned an invalid manual started acknowledgement",
  );
  if (!response.ok) throwManualControlError(response, body);
}

export async function waitForLauncherManualTerminal(
  descriptorPath: string,
  owner: LauncherManualTurnOwner,
  options: { abortSignal?: AbortSignal; timeoutMs?: number } = {},
): Promise<LauncherManualTurnTerminal> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const timeoutMs = options.timeoutMs ?? LAUNCHER_MANUAL_SENT_REQUEST_TIMEOUT_MS;
  for (;;) {
    if (options.abortSignal?.aborted) throw new DOMException("Manual terminal wait aborted", "AbortError");
    const { response, body } = await launcherManualRequest(
      descriptor,
      "wait-terminal",
      owner,
      timeoutMs,
      options.abortSignal,
    );
    if (response.status === 202 && body.status === "pending") continue;
    if (!response.ok) throwManualControlError(response, body);
    if (body.status !== "cancelled" && body.status !== "failed") {
      throw new LauncherManualTurnFailedError("Launcher returned an invalid manual terminal signal");
    }
    return { status: body.status };
  }
}

export async function endLauncherManualTurn(
  descriptorPath: string,
  activity: LauncherManualTurnEnd,
  timeoutMs = LAUNCHER_MANUAL_TURN_END_TIMEOUT_MS,
): Promise<{ cancelledByUser: boolean }> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const { response, body } = await reconcileLauncherManualMutation(
    descriptor,
    "end",
    activity,
    timeoutMs,
    body => body.ok === true && typeof body.cancelledByUser === "boolean",
    "Launcher returned an invalid manual turn release result",
  );
  if (!response.ok) throwManualControlError(response, body);
  return { cancelledByUser: body.cancelledByUser as boolean };
}

export async function cancelLauncherManualTurn(
  descriptorPath: string,
  owner: LauncherManualTurnOwner,
  timeoutMs = LAUNCHER_MANUAL_TURN_END_TIMEOUT_MS,
): Promise<void> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const { response, body } = await launcherManualRequest(descriptor, "cancel", owner, timeoutMs);
  if (!response.ok) throwManualControlError(response, body);
}

export async function notifyLauncherTurn(
  descriptorPath: string,
  activity: LauncherTurnActivity,
  timeoutMs = activity.phase === "end"
    ? LAUNCHER_TURN_END_TIMEOUT_MS
    : activity.phase === "heartbeat"
      ? LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS
      : LAUNCHER_TURN_START_TIMEOUT_MS,
  /** The turn's own abort: a cancelled turn stops waiting for its start at once. */
  signal?: AbortSignal,
): Promise<{
  surfaceId?: string;
  reused?: boolean;
  connectorBound?: boolean;
  cancelledByUser?: boolean;
  conversationUrl?: string;
}> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/turn/${activity.phase}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(activity),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (response.status === 409 && body.code === "turn_cancelled") {
        throw new LauncherBrowserTurnCancelledError(
          typeof body.error === "string" ? body.error : `Browser turn ${activity.traceId} was cancelled by the user`,
        );
      }
      if (response.status === 409 && body.code === "retained_conversation_unavailable") {
        throw new LauncherRetainedConversationUnavailableError(
          typeof body.error === "string" ? body.error : "The retained ChatGPT conversation is no longer available",
        );
      }
      const detail = typeof body.error === "string" ? body.error : "";
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    // Only return canonical ChatGPT conversation links to the Codex context.
    const conversationUrl = typeof body.conversationUrl === "string"
      && /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]{8,}$/.test(body.conversationUrl)
      ? body.conversationUrl : undefined;
    if (activity.phase === "start") {
      if (typeof body.surfaceId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(body.surfaceId)) {
        throw new Error("Launcher browser control channel returned an invalid turn surface id");
      }
      if (typeof body.reused !== "boolean") {
        throw new Error("Launcher browser control channel returned an invalid reuse state");
      }
      if (typeof body.connectorBound !== "boolean") {
        throw new Error("Launcher browser control channel returned an invalid connector state");
      }
      return {
        surfaceId: body.surfaceId,
        reused: body.reused,
        connectorBound: body.connectorBound,
        ...(conversationUrl ? { conversationUrl } : {}),
      };
    }
    if (activity.phase === "end") {
      if (typeof body.cancelledByUser !== "boolean") {
        throw new Error("Launcher browser control channel returned an invalid turn release result");
      }
      return { cancelledByUser: body.cancelledByUser, ...(conversationUrl ? { conversationUrl } : {}) };
    }
    return {};
  } catch (error) {
    if (error instanceof LauncherBrowserTurnCancelledError
      || error instanceof LauncherRetainedConversationUnavailableError) throw error;
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    throw new Error(`Launcher browser control channel failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

export async function releaseLauncherRetainedConversation(
  descriptorPath: string,
  conversationKey: string,
  timeoutMs = LAUNCHER_TURN_END_TIMEOUT_MS,
): Promise<number> {
  if (!/^[a-f0-9]{64}$/.test(conversationKey)) {
    throw new Error("Launcher retained conversation key is invalid");
  }
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/turn/release`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ conversationKey }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || !Number.isSafeInteger(body.released) || Number(body.released) < 0) {
      const detail = typeof body.error === "string" ? `: ${body.error}` : "";
      throw new Error(`HTTP ${response.status}${detail}`);
    }
    return Number(body.released);
  } catch (error) {
    throw new Error(`Launcher retained conversation release failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}
