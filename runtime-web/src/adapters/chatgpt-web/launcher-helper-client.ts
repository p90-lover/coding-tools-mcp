import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { notifyLauncherTurn, waitForLauncherBrowserHostDescriptor, type LauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import { ChatGptCompactionHandoffAccepted, ChatGptTurnSupersededError, ChatGptWebAdapterError } from "./adapter-error";
import type { CompiledChatGptWebPrompt } from "./prompt";
import type { BrowserTurn, ResolvedBrowserConfig } from "./browser-worker";
import { normalizeChatGptRichOutput, type ChatGptRichOutput } from "./rich-output";
import {
  parseChatGptLunaCheckpoint,
  type ChatGptLunaCheckpoint,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";

interface PendingTurn {
  turn: BrowserTurn;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  abortListener?: () => void;
  sent?: boolean;
  prepared?: CompiledChatGptWebPrompt & { release: () => void };
  localFailure?: Error;
  progressForwarding?: AbortController;
  acknowledgedMultipartStage?: number;
  submitted?: boolean;
  replyRecovery?: ChatGptReplyRecoveryCheckpoint;
  emittedText?: string;
  lunaCheckpoint?: CapturedChatGptLunaCheckpoint;
  richOutput?: ChatGptRichOutput;
}

export interface ChatGptReplyRecoveryCheckpoint {
  conversationUrl: string;
  responseIdentity: string;
  initialTurnIdentities: string[];
  acceptedTurnIdentities: string[];
  initialUserTurnCount: number;
  acceptedUserTurnCount: number;
  toolBoundary?: { revision: number; text: string; sourceGenerationStarted?: boolean };
}

export function parseChatGptReplyRecoveryCheckpoint(value: unknown): ChatGptReplyRecoveryCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ChatGPT reply recovery checkpoint is invalid");
  }
  const checkpoint = value as Record<string, unknown>;
  const toolBoundary = checkpoint.toolBoundary as Record<string, unknown> | undefined;
  const identity = (item: unknown): item is string => typeof item === "string"
    && item.trim().length > 0 && item.length <= 512;
  const identities = (items: unknown): items is string[] => Array.isArray(items)
    && items.length <= 10_000 && items.every(identity) && new Set(items).size === items.length;
  if (typeof checkpoint.conversationUrl !== "string"
    || !/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]{8,}$/.test(checkpoint.conversationUrl)
    || !identity(checkpoint.responseIdentity)
    || !identities(checkpoint.initialTurnIdentities)
    || !identities(checkpoint.acceptedTurnIdentities)
    || !Number.isSafeInteger(checkpoint.initialUserTurnCount) || (checkpoint.initialUserTurnCount as number) < 0
    || !Number.isSafeInteger(checkpoint.acceptedUserTurnCount)
    || checkpoint.acceptedUserTurnCount !== (checkpoint.initialUserTurnCount as number) + 1
    || checkpoint.initialTurnIdentities.includes(checkpoint.responseIdentity)
    || !checkpoint.acceptedTurnIdentities.includes(checkpoint.responseIdentity)
    || (toolBoundary !== undefined && (!toolBoundary || typeof toolBoundary !== "object" || Array.isArray(toolBoundary)
      || !Number.isSafeInteger(toolBoundary.revision) || (toolBoundary.revision as number) <= 0
      || typeof toolBoundary.text !== "string"
      || (toolBoundary.sourceGenerationStarted !== undefined && typeof toolBoundary.sourceGenerationStarted !== "boolean")))) {
    throw new Error("ChatGPT reply recovery checkpoint does not identify an accepted task reply");
  }
  return {
    conversationUrl: checkpoint.conversationUrl,
    responseIdentity: checkpoint.responseIdentity,
    initialTurnIdentities: [...checkpoint.initialTurnIdentities],
    acceptedTurnIdentities: [...checkpoint.acceptedTurnIdentities],
    initialUserTurnCount: checkpoint.initialUserTurnCount as number,
    acceptedUserTurnCount: checkpoint.acceptedUserTurnCount as number,
    ...(toolBoundary ? { toolBoundary: {
      revision: toolBoundary.revision as number, text: toolBoundary.text as string,
      ...(toolBoundary.sourceGenerationStarted === true ? { sourceGenerationStarted: true } : {}),
    } } : {}),
  };
}

type HelperMessage =
  | { type: "ready"; features?: string[] }
  | { type: "event"; id: string; event: "heartbeat" | "send_activated" | "submitted" | "reasoning" | "commentary" | "text"; text?: string; continuation?: boolean }
  | { type: "event"; id: string; event: "tool_batch_observed"; revision: number }
  | { type: "event"; id: string; event: "multipart_stage_acknowledged"; stageIndex: number }
  | { type: "event"; id: string; event: "completion_fence_begin"; requestId: number }
  | { type: "event"; id: string; event: "completion_fence_commit"; requestId: number; revision: number }
  | { type: "event"; id: string; event: "prepared_selected"; reused: boolean }
  | { type: "event"; id: string; event: "reply_recovery"; checkpoint: ChatGptReplyRecoveryCheckpoint }
  | { type: "event"; id: string; event: "luna_checkpoint"; checkpoint: ChatGptLunaCheckpoint; answerHash: string }
  | { type: "event"; id: string; event: "rich_output"; output: ChatGptRichOutput }
  | { type: "result"; id: string; text: string }
  | {
      type: "error";
      id: string;
      name?: string;
      message: string;
      status?: number;
      errorType?: string;
      code?: string;
      retryable?: boolean;
    };

function parseHelperMessage(line: string): HelperMessage {
  const value = JSON.parse(line) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Launcher browser helper message is not an object");
  }
  const message = value as Record<string, unknown>;
  if (message.type === "ready") {
    const features = message.features;
    if (features !== undefined
      && (!Array.isArray(features) || features.some(feature => typeof feature !== "string"))) {
      throw new Error("Launcher browser helper advertised invalid features");
    }
    return { type: "ready", ...(features ? { features: features as string[] } : {}) };
  }
  if (typeof message.id !== "string" || !message.id) {
    throw new Error("Launcher browser helper message has no turn identity");
  }
  if (message.type === "event") {
    const event = message.event;
    if (event === "rich_output") {
      const output = normalizeChatGptRichOutput(message.output);
      if (!output) throw new Error("Launcher browser helper rich output is invalid");
      return { type: "event", id: message.id, event, output };
    }
    if (event === "reply_recovery") {
      return { type: "event", id: message.id, event, checkpoint: parseChatGptReplyRecoveryCheckpoint(message.checkpoint) };
    }
    if (event === "multipart_stage_acknowledged") {
      if (!Number.isSafeInteger(message.stageIndex) || (message.stageIndex as number) <= 0) {
        throw new Error("Launcher browser helper multipart stage index is invalid");
      }
      return { type: "event", id: message.id, event, stageIndex: message.stageIndex as number };
    }
    if (event === "tool_batch_observed") {
      if (!Number.isSafeInteger(message.revision) || (message.revision as number) <= 0) {
        throw new Error("Launcher browser helper tool-boundary revision is invalid");
      }
      return { type: "event", id: message.id, event, revision: message.revision as number };
    }
    if (event === "completion_fence_begin") {
      if (!Number.isSafeInteger(message.requestId) || (message.requestId as number) <= 0) {
        throw new Error("Launcher browser helper completion fence request id is invalid");
      }
      return { type: "event", id: message.id, event, requestId: message.requestId as number };
    }
    if (event === "completion_fence_commit") {
      if (!Number.isSafeInteger(message.requestId) || (message.requestId as number) <= 0
        || !Number.isSafeInteger(message.revision) || (message.revision as number) < 0) {
        throw new Error("Launcher browser helper completion fence revision is invalid");
      }
      return {
        type: "event",
        id: message.id,
        event,
        requestId: message.requestId as number,
        revision: message.revision as number,
      };
    }
    if (event === "luna_checkpoint") {
      if (typeof message.answerHash !== "string" || !/^[a-f0-9]{64}$/.test(message.answerHash)) {
        throw new Error("Launcher browser helper Luna checkpoint answer hash is invalid");
      }
      return {
        type: "event",
        id: message.id,
        event,
        checkpoint: parseChatGptLunaCheckpoint(message.checkpoint),
        answerHash: message.answerHash,
      };
    }
    const text = message.text;
    const continuation = message.continuation;
    if (event === "prepared_selected") {
      if (typeof message.reused !== "boolean") {
        throw new Error("Launcher browser helper prompt selection is invalid");
      }
      return { type: "event", id: message.id, event, reused: message.reused };
    }
    if (!["heartbeat", "send_activated", "submitted", "reasoning", "commentary", "text"].includes(String(event))) {
      throw new Error("Launcher browser helper emitted an unknown event");
    }
    if (text !== undefined && typeof text !== "string") {
      throw new Error("Launcher browser helper event text is invalid");
    }
    if (continuation !== undefined && typeof continuation !== "boolean") {
      throw new Error("Launcher browser helper continuation flag is invalid");
    }
    return {
      type: "event",
      id: message.id,
      event: event as "heartbeat" | "send_activated" | "submitted" | "reasoning" | "commentary" | "text",
      ...(text !== undefined ? { text: text as string } : {}),
      ...(continuation !== undefined ? { continuation: continuation as boolean } : {}),
    };
  }
  if (message.type === "result") {
    const text = message.text;
    if (typeof text !== "string") {
      throw new Error("Launcher browser helper result text is invalid");
    }
    return { type: "result", id: message.id, text };
  }
  if (message.type === "error") {
    const errorMessage = message.message;
    const errorName = message.name;
    const status = message.status;
    const errorType = message.errorType;
    const code = message.code;
    const retryable = message.retryable;
    const structured = status !== undefined
      || errorType !== undefined
      || code !== undefined
      || retryable !== undefined;
    if (typeof errorMessage !== "string"
      || (errorName !== undefined && typeof errorName !== "string")
      || (structured && (
        !Number.isInteger(status)
        || (status as number) < 400
        || (status as number) > 599
        || typeof errorType !== "string"
        || !errorType
        || typeof code !== "string"
        || !code
        || typeof retryable !== "boolean"
      ))) {
      throw new Error("Launcher browser helper error payload is invalid");
    }
    return {
      type: "error",
      id: message.id,
      message: errorMessage,
      ...(errorName !== undefined ? { name: errorName as string } : {}),
      ...(structured ? {
        status: status as number,
        errorType: errorType as string,
        code: code as string,
        retryable: retryable as boolean,
      } : {}),
    };
  }
  throw new Error("Launcher browser helper emitted an unknown message type");
}

/** `promise`, or an AbortError as soon as `signal` aborts (the promise itself goes on). */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
  return new Promise<T>((resolveValue, rejectValue) => {
    const onAbort = () => rejectValue(new DOMException("ChatGPT web turn aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolveValue(value); },
      error => { signal.removeEventListener("abort", onAbort); rejectValue(error); },
    );
  });
}

export class LauncherBrowserHelperClient {
  private readonly closing = new AbortController();
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  // Turns that arrive while the app restarts share one wait for its new descriptor.
  private descriptorWait?: Promise<LauncherBrowserHostDescriptor>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly pending = new Map<string, PendingTurn>();
  private helperFeatures = new Set<string>();

  constructor(private readonly config: ResolvedBrowserConfig) {}

  /**
   * The helper that shipped with this daemon, when one sits beside its own entrypoint.
   *
   * The launcher advertises the helper inside its application bundle while the daemon runs from a
   * versioned runtime directory, so the two sides update independently and can disagree about the
   * protocol. Preferring the sibling keeps daemon and helper on the same build by construction;
   * anything else — a source checkout, an unbundled entrypoint — falls back to the advertised path.
   */
  private bundledHelperScript(): string | undefined {
    const entrypoint = process.argv[1];
    // Only the packaged runtime layout is claimed: the bundle builder emits cli.js and
    // browser-helper.cjs into one directory. Matching on that entrypoint name keeps a source
    // checkout, or any other launch shape, on the launcher-advertised helper rather than adopting
    // an unrelated sibling that merely shares a filename.
    if (typeof entrypoint !== "string" || basename(entrypoint) !== "cli.js") return undefined;
    const sibling = join(dirname(entrypoint), "browser-helper.cjs");
    return existsSync(sibling) ? sibling : undefined;
  }

  async run(turn: BrowserTurn): Promise<string> {
    const signal = turn.abortSignal ? AbortSignal.any([turn.abortSignal, this.closing.signal]) : this.closing.signal;
    if (signal.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    await abortable(this.ensureChild(signal), signal);
    if (signal.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (turn.replyRecovery && !this.helperFeatures.has("reply-recovery")) {
      throw new Error("Launcher browser helper does not support task reply recovery");
    }
    if (turn.onMultipartStageAcknowledged && !this.helperFeatures.has("multipart-stage-ack")) {
      throw new Error(
        "Launcher browser helper does not support multipart acknowledgement forwarding; update or restart the launcher",
      );
    }
    if (turn.externalProgress && !this.helperFeatures.has("tool-boundary-ack")) {
      throw new Error(
        "Launcher browser helper does not support causal Codex tool-boundary acknowledgement; update or restart the launcher",
      );
    }
    if (turn.externalProgress && !this.helperFeatures.has("completion-fence")) {
      throw new Error(
        "Launcher browser helper does not support the MCP completion fence; update or restart the launcher",
      );
    }
    return await new Promise<string>((resolveResult, rejectResult) => {
        if (this.pending.has(turn.traceId)) {
          rejectResult(new Error(`Duplicate launcher browser turn: ${turn.traceId}`));
          return;
        }
        const pending: PendingTurn = { turn, resolve: resolveResult, reject: rejectResult, submitted: turn.replyRecovery !== undefined };
        this.pending.set(turn.traceId, pending);
        if (turn.abortSignal) {
          const abortListener = () => {
            if (!pending.sent) {
              this.finishWithError(
                turn.traceId,
                new DOMException("ChatGPT web turn aborted", "AbortError"),
              );
              return;
            }
            void this.send({
              type: "abort",
              id: turn.traceId,
              ...(turn.abortSignal?.reason instanceof ChatGptCompactionHandoffAccepted
                ? { reason: "compaction_handoff_accepted" }
                : turn.abortSignal?.reason instanceof ChatGptTurnSupersededError
                  ? { reason: "steering_superseded" }
                : {}),
            }).catch(error => {
              this.finishWithError(
                turn.traceId,
                error instanceof Error ? error : new Error(String(error)),
              );
            });
          };
          pending.abortListener = abortListener;
          turn.abortSignal.addEventListener("abort", abortListener, { once: true });
          if (turn.abortSignal.aborted) {
            abortListener();
            return;
          }
        }
        // Setting this before the synchronous write call makes an abort either prevent dispatch or
        // queue an `abort` after the `run` frame; it can never overtake the run frame in the pipe.
        pending.sent = true;
        const progressForwarding = new AbortController();
        pending.progressForwarding = progressForwarding;
        void this.send({
          type: "run",
          id: turn.traceId,
          config: {
            appName: this.config.appName,
            browserHostDescriptorPath: this.config.browserHostDescriptorPath!,
            browserDiagnosticsPath: this.config.browserDiagnosticsPath,
            turnTimeoutMs: this.config.turnTimeoutMs,
            autoApproveToolCalls: this.config.autoApproveToolCalls,
            useSavedChats: this.config.useSavedChats,
          },
          turn: {
            traceId: turn.traceId,
            modelId: turn.modelId,
            ...(turn.nativeThreadId ? { nativeThreadId: turn.nativeThreadId } : {}),
            reasoning: turn.reasoning,
            capabilities: turn.capabilities,
            ...(turn.nativeConnector ? { nativeConnector: true } : {}),
            ...(turn.prepareResume ? { resumeAvailable: true } : {}),
            ...(turn.retainConversation ? { retainConversation: true } : {}),
            ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
            ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
            ...(turn.compaction ? { compaction: true } : {}),
            ...(turn.captureLunaCheckpoint ? { captureLunaCheckpoint: true } : {}),
            ...(turn.onRichOutput && this.helperFeatures.has("rich-output") ? { captureRichOutput: true } : {}),
            ...(turn.externalProgress ? { externalProgress: true } : {}),
            ...(turn.replyRecovery ? { replyRecovery: turn.replyRecovery } : {}),
            ...(this.helperFeatures.has("reply-recovery") ? { replyRecoveryEnabled: true } : {}),
          },
        })
          // Only mirror once the run frame is on the wire, so the helper never sees progress for a
          // turn it has not been told about and cannot accumulate state for unknown ids.
          .then(() => {
            if (!progressForwarding.signal.aborted) this.forwardProgress(turn, progressForwarding.signal);
          })
          .catch(error => this.finishWithError(turn.traceId, error instanceof Error ? error : new Error(String(error))));
      });
  }

  async close(): Promise<void> {
    const error = new DOMException("Launcher browser helper is closing", "AbortError");
    this.closing.abort(error);
    this.readyReject?.(error);
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const id of [...this.pending.keys()]) {
      this.finishWithError(id, error);
    }
    if (!child) return;
    await this.sendTo(child, { type: "shutdown" }).catch(() => {});
    await this.terminateChild(child, 2_000);
  }

  private childAlive(): boolean {
    return Boolean(this.child
      && !this.child.killed
      && this.child.exitCode === null
      && this.child.signalCode === null
      && this.ready);
  }

  private async ensureChild(signal?: AbortSignal): Promise<void> {
    if (this.childAlive()) return this.ready;
    // While the app restarts (an update installs) its descriptor is gone for a while: wait for it.
    this.descriptorWait ??= waitForLauncherBrowserHostDescriptor(this.config.browserHostDescriptorPath!, { signal: this.closing.signal })
      .finally(() => { this.descriptorWait = undefined; });
    // A turn cancelled meanwhile leaves at once; the shared wait goes on for the others.
    const descriptor = await abortable(this.descriptorWait, signal);
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    // Another turn waiting on the same descriptor may have started the helper already.
    if (this.childAlive()) return this.ready;
    const child = spawn(
      descriptor.helper.executable,
      [this.config.browserHelperScriptPath ?? this.bundledHelperScript() ?? descriptor.helper.script],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
    });
    const output = createInterface({ input: child.stdout });
    output.on("line", line => this.handleLine(child, line));
    const errors = createInterface({ input: child.stderr });
    errors.on("line", line => console.info(`[chatgpt-web-helper] ${line}`));
    const failChild = (error: Error) => {
      const owned = this.child === child;
      this.handleExit(child, error);
      if (owned && Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null) {
        void this.terminateChild(child, 0).catch(cleanupError => {
          console.error(
            `[chatgpt-web-helper] process-error cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        });
      }
    };
    child.once("error", failChild);
    child.stdin.once("error", error => failChild(new Error(
      `Launcher browser helper input failed: ${error instanceof Error ? error.message : String(error)}`,
    )));
    child.once("exit", (code, signal) => this.handleExit(child, new Error(
      `Launcher browser helper exited ${signal ? `from signal ${signal}` : `with status ${code ?? 1}`}`,
    )));
    const timer = setTimeout(() => {
      if (this.child === child) this.readyReject?.(new Error("Launcher browser helper did not become ready"));
    }, 15_000);
    try {
      await this.ready;
    } catch (error) {
      if (this.child === child) {
        this.child = undefined;
        this.ready = undefined;
        this.readyResolve = undefined;
        this.readyReject = undefined;
      }
      try {
        await this.terminateChild(child, 500);
      } catch (cleanupError) {
        const primary = error instanceof Error ? error.message : String(error);
        const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`${primary}; launcher browser helper cleanup failed: ${cleanup}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) return;
    let message: HelperMessage;
    try { message = parseHelperMessage(line); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.handleExit(child, new Error(`Launcher browser helper emitted invalid protocol data: ${detail}`));
      void this.terminateChild(child, 0).catch(error => {
        console.error(`[chatgpt-web-helper] invalid-protocol cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    if (message.type === "ready") {
      // Optional frames are sent only when the helper advertises support for them.
      this.helperFeatures = new Set(message.features ?? []);
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "event") {
      if (message.event === "heartbeat") pending.turn.onHeartbeat?.();
      else if (message.event === "tool_batch_observed") {
        const progress = pending.turn.externalProgress;
        if (!progress) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper observed a tool boundary for a turn without progress transport"),
            pending,
          );
          return;
        }
        void progress.acknowledgeToolBatch(message.revision).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "completion_fence_begin") {
        const fence = pending.turn.completionFence;
        if (!fence) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper requested a completion fence for an unfenced turn"),
            pending,
          );
          return;
        }
        void fence.begin().then(revision => {
          if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
          return this.send({
            type: "completion_fence_begin_ack",
            id: message.id,
            requestId: message.requestId,
            revision: revision ?? null,
          });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "completion_fence_commit") {
        const fence = pending.turn.completionFence;
        if (!fence) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper requested a completion fence for an unfenced turn"),
            pending,
          );
          return;
        }
        void fence.commit(message.revision).then(committed => {
          if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
          return this.send({
            type: "completion_fence_commit_ack",
            id: message.id,
            requestId: message.requestId,
            committed,
          });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "send_activated") {
        void Promise.resolve().then(() => pending.turn.onSendActivated?.()).then(() => {
          if (this.pending.get(message.id) !== pending) return;
          return this.send({ type: "send_activation_ack", id: message.id });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "submitted") {
        pending.submitted = true;
        pending.turn.onSubmitted?.();
      }
      else if (message.event === "reply_recovery") {
        if (!pending.submitted) {
          this.abortWithLocalFailure(message.id, new Error("ChatGPT reply recovery preceded submission evidence"), pending);
          return;
        }
        pending.replyRecovery = message.checkpoint;
      }
      else if (message.event === "multipart_stage_acknowledged") {
        const multipart = pending.prepared?.multipart;
        if (!multipart
          || message.stageIndex >= multipart.parts.length
          || message.stageIndex !== (pending.acknowledgedMultipartStage ?? 0) + 1) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper acknowledged an unexpected multipart stage"),
            pending,
          );
          return;
        }
        pending.acknowledgedMultipartStage = message.stageIndex;
        void Promise.resolve().then(() => pending.turn.onMultipartStageAcknowledged?.(message.stageIndex))
          .catch(error => this.abortWithLocalFailure(
            message.id,
            error instanceof Error ? error : new Error(String(error)),
            pending,
          ));
      }
      else if (message.event === "prepared_selected") {
        const prepare = message.reused ? pending.turn.prepareResume : pending.turn.prepare;
        void Promise.resolve().then(() => prepare?.()).then(prepared => {
          if (!prepared) throw new Error("Launcher browser helper selected an unavailable continuation prompt");
          if (this.pending.get(message.id) !== pending) {
            prepared.release();
            return;
          }
          pending.prepared = prepared;
          return Promise.resolve(pending.turn.onPreparedSelected?.(message.reused)).then(() => {
            if (this.pending.get(message.id) !== pending) return;
            return this.send({
              type: "prepared_selected_ack",
              id: message.id,
              prepared: {
                text: prepared.text,
                images: prepared.images,
                ...(prepared.multipart ? { multipart: prepared.multipart } : {}),
                ...(prepared.trimmedCompactionMessages !== undefined
                  ? { trimmedCompactionMessages: prepared.trimmedCompactionMessages }
                  : {}),
              } satisfies CompiledChatGptWebPrompt,
            });
          });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "luna_checkpoint") {
        if (!pending.turn.captureLunaCheckpoint || !pending.turn.onLunaCheckpoint) {
          this.finishWithError(message.id, new Error("Launcher browser helper emitted an unexpected Luna checkpoint"));
          return;
        }
        try {
          const captured = { checkpoint: message.checkpoint, answerHash: message.answerHash };
          pending.turn.onLunaCheckpoint(captured);
          pending.lunaCheckpoint = captured;
        } catch (error) {
          this.abortWithLocalFailure(message.id, error instanceof Error ? error : new Error(String(error)), pending);
        }
      }
      else if (message.event === "rich_output" && !pending.localFailure && !pending.turn.abortSignal?.aborted) {
        try {
          pending.turn.onRichOutput?.(message.output);
          pending.richOutput = message.output;
        } catch (error) {
          this.abortWithLocalFailure(message.id, error instanceof Error ? error : new Error(String(error)), pending);
        }
      }
      else if (message.event === "reasoning" && message.text) {
        pending.turn.onReasoningSummary?.(message.text, message.continuation === true);
      }
      else if (message.event === "commentary" && message.text) pending.turn.onCommentary?.(message.text, message.continuation === true);
      else if (message.event === "text" && message.text && !pending.localFailure && !pending.turn.abortSignal?.aborted) {
        try {
          pending.turn.onTextDelta(message.text);
          pending.emittedText = (pending.emittedText ?? "") + message.text;
        } catch (error) {
          this.abortWithLocalFailure(message.id, error instanceof Error ? error : new Error(String(error)), pending);
        }
      }
      return;
    }
    if (message.type === "result") {
      this.finish(message.id);
      if (pending.localFailure) pending.reject(pending.localFailure);
      else pending.resolve(message.text);
    } else if (message.type === "error") {
      const error = message.status !== undefined
        ? new ChatGptWebAdapterError(message.message, {
          status: message.status,
          errorType: message.errorType!,
          code: message.code!,
          retryable: message.retryable!,
        })
        : message.name === "AbortError"
          ? new DOMException(message.message, "AbortError")
          : new Error(message.message);
      this.finish(message.id);
      pending.reject(pending.localFailure ?? error);
    }
  }

  private abortWithLocalFailure(id: string, error: Error, pending: PendingTurn): void {
    if (this.pending.get(id) !== pending || pending.localFailure) return;
    pending.localFailure = error;
    void this.send({ type: "abort", id }).catch(sendError => {
      if (this.pending.get(id) !== pending) return;
      this.finishWithError(
        id,
        new AggregateError(
          [error, sendError instanceof Error ? sendError : new Error(String(sendError))],
          "Launcher browser helper could not abort after a local protocol failure",
        ),
      );
    });
  }

  /**
   * Mirrors daemon-recorded MCP progress into the helper process for the life of the turn.
   *
   * The browser worker runs out of process, so without this the worker sees no external progress
   * and cancels turns whose tool calls are still completing.
   */
  private forwardProgress(turn: BrowserTurn, stop: AbortSignal): void {
    const progress = turn.externalProgress;
    if (!progress) return;
    if (!this.helperFeatures.has("progress")) {
      console.warn(
        `[chatgpt-web] browser turn ${turn.traceId} runs without an MCP progress mirror:`
        + " the launcher browser helper predates the progress frame",
      );
      return;
    }
    void (async () => {
      let revision = 0;
      while (!stop.aborted) {
        const snapshot = await progress.waitForChange(revision, stop);
        revision = snapshot.revision;
        if (stop.aborted) return;
        await this.send({ type: "progress", id: turn.traceId, snapshot });
      }
    })().catch(error => {
      // Ending, aborting, or losing the helper stops the mirror by design and is not a fault.
      // Anything else leaves the worker on DOM-only health without saying so, which is exactly the
      // silent degradation this transport exists to remove, so it is surfaced rather than dropped.
      if (stop.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      console.warn(
        `[chatgpt-web] browser turn ${turn.traceId} lost its MCP progress mirror:`
        + ` ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private finish(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.abortListener && pending.turn.abortSignal) {
      pending.turn.abortSignal.removeEventListener("abort", pending.abortListener);
    }
    pending.progressForwarding?.abort();
    pending.progressForwarding = undefined;
    pending.prepared?.release();
    pending.prepared = undefined;
    this.pending.delete(id);
  }

  private finishWithError(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.finish(id);
    pending.reject(error);
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.readyReject?.(error);
    this.readyReject = undefined;
    this.readyResolve = undefined;
    this.ready = undefined;
    this.child = undefined;
    for (const id of [...this.pending.keys()]) {
      const pending = this.pending.get(id);
      if (!pending) continue;
      if (pending.submitted && pending.replyRecovery && !pending.turn.replyRecovery && !pending.turn.compaction
        && !pending.localFailure && !pending.turn.abortSignal?.aborted
        && (typeof child.exitCode === "number" || typeof child.signalCode === "string")) {
        const checkpoint = pending.replyRecovery;
        const prefix = pending.emittedText ?? "";
        let replayed = "";
        let delivered = prefix.length;
        this.finish(id);
        void (async () => {
          pending.turn.onCommentary?.("Recovering this task's interrupted WebGPT reply.");
          const answer = await this.run({
            ...pending.turn,
            replyRecovery: checkpoint,
            onReasoningSummary: undefined,
            onCommentary: undefined,
            ...(pending.richOutput && pending.turn.onRichOutput ? {
              onRichOutput: (output: ChatGptRichOutput) => {
                if (JSON.stringify(output) !== JSON.stringify(pending.richOutput)) {
                  throw new Error("Recovered ChatGPT reply changed its rich output");
                }
              },
            } : {}),
            ...(pending.lunaCheckpoint ? {
              onLunaCheckpoint: (captured: CapturedChatGptLunaCheckpoint) => {
                if (JSON.stringify(captured) !== JSON.stringify(pending.lunaCheckpoint)) {
                  throw new Error("Recovered ChatGPT reply changed its context checkpoint");
                }
              },
            } : {}),
            onTextDelta: delta => {
              replayed += delta;
              const shared = Math.min(prefix.length, replayed.length);
              if (replayed.slice(0, shared) !== prefix.slice(0, shared)) {
                throw new Error("Recovered ChatGPT reply changed text already delivered to Codex");
              }
              if (replayed.length > delivered) {
                pending.turn.onTextDelta(replayed.slice(delivered));
                delivered = replayed.length;
              }
            },
          });
          if (answer !== replayed || !answer.startsWith(prefix)) {
            throw new Error("Recovered ChatGPT reply did not reproduce the delivered Codex response");
          }
          return answer;
        })().then(pending.resolve, async recoveryError => {
          // Startup can fail before the replacement helper claims the lease. Release only the
          // original owner; a newer owner or user-closed tab must never be touched here.
          await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
            phase: "end", traceId: id, helperPid: child.pid!,
            status: this.closing.signal.aborted || pending.turn.abortSignal?.aborted ? "aborted" : "failed",
            message: "WebGPT task reply recovery failed",
          }).catch(() => {});
          pending.reject(recoveryError instanceof Error ? recoveryError : new Error(String(recoveryError)));
        });
        continue;
      }
      void notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "end",
        traceId: id,
        helperPid: child.pid!,
        status: "failed",
        message: "Launcher browser helper exited before completing the turn",
      }).then(
        () => this.finishWithError(id, pending.localFailure ?? error),
        controlError => this.finishWithError(
          id,
          new AggregateError(
            [pending.localFailure ?? error, controlError instanceof Error ? controlError : new Error(String(controlError))],
            `Launcher browser helper exited and failed to release turn ${id}`,
          ),
        ),
      );
    }
  }

  private async waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>(resolveExit => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("close", onExit);
        resolveExit(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
      child.once("close", onExit);
    });
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams, gracefulTimeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    if (await this.waitForExit(child, gracefulTimeoutMs)) return;
    if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) {
      throw new Error("Launcher browser helper refused termination");
    }
    if (await this.waitForExit(child, 2_000)) return;
    if (!child.kill("SIGKILL") && child.exitCode === null && child.signalCode === null) {
      throw new Error("Launcher browser helper refused forced termination");
    }
    if (!await this.waitForExit(child, 2_000)) {
      throw new Error("Launcher browser helper did not exit after forced termination");
    }
  }

  private send(message: unknown): Promise<void> {
    const child = this.child;
    if (!child
      || child.killed
      || child.exitCode !== null
      || child.signalCode !== null) {
      return Promise.reject(new Error("Launcher browser helper is not running"));
    }
    return this.sendTo(child, message);
  }

  private async sendTo(child: ChildProcessWithoutNullStreams, message: unknown): Promise<void> {
    const encoded = `${JSON.stringify(message)}\n`;
    if (child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error("Launcher browser helper input is closed");
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.write(encoded, error => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });
  }
}
