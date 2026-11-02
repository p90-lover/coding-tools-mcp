import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptCompactionHandoffAccepted, ChatGptTurnSupersededError, ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { LauncherBrowserHelperClient, abortable, parseChatGptReplyRecoveryCheckpoint } from "../src/adapters/chatgpt-web/launcher-helper-client";
import type { BrowserTurn, ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import {
  expectedLauncherBrowserPartition,
  LAUNCHER_BROWSER_HOST_KIND,
  LAUNCHER_BROWSER_IDLE_URL,
} from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("connector verification receives the launcher's chat mode through the real helper process", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-helper-verify-mode-"));
  roots.push(root);
  const helper = join(root, "helper.ts");
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    // Report the resolved mode instead of driving a browser.
    ChatGptBrowserWorker.prototype.verifyConnector = async function() { return String(this.config.useSavedChats); };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const child = Bun.spawn([process.execPath, helper], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  let buffered = "";
  const nextMessage = async (): Promise<Record<string, unknown>> => {
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("helper exited");
      buffered += new TextDecoder().decode(value);
    }
    const [line, ...rest] = buffered.split("\n");
    buffered = rest.join("\n");
    return JSON.parse(line!) as Record<string, unknown>;
  };
  try {
    expect((await nextMessage()).type).toBe("ready");
    const verify = async (id: string, extra: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify({
        type: "verify", id, config: { appName: "Codex Native2", browserHostDescriptorPath: join(root, "launcher.json"), ...extra },
      })}\n`);
      child.stdin.flush();
      return nextMessage();
    };
    expect(await verify("verify-saved-off", { useSavedChats: false })).toMatchObject({ type: "result", text: "false" });
    expect(await verify("verify-saved-on", { useSavedChats: true })).toMatchObject({ type: "result", text: "true" });
    // An older launcher omits the field: the helper keeps the saved-chat default.
    expect(await verify("verify-saved-absent", {})).toMatchObject({ type: "result", text: "true" });
    expect(await verify("verify-saved-bad", { useSavedChats: "no" }))
      .toMatchObject({ type: "error", message: "Browser helper maintenance config is invalid" });
  } finally {
    child.kill();
    await child.exited;
  }
});

test.each(["success", "tools-success", "luna-success", "rich-success", "changed-rich", "changed-checkpoint", "changed-text", "second-crash", "cancelled", "no-checkpoint", "close-startup"])("accepted task reply recovery through real helper IPC: %s", async mode => {
  const root = mkdtempSync(join(tmpdir(), "codex-reply-recovery-"));
  roots.push(root);
  const helper = join(root, "helper.ts");
  const attempts = join(root, "attempts");
  const starts = join(root, "starts");
  const checkpoint = {
    conversationUrl: "https://chatgpt.com/c/current-task-1234",
    responseIdentity: "current-answer",
    initialTurnIdentities: ["old-user", "old-answer"],
    acceptedTurnIdentities: ["old-user", "old-answer", "current-user", "current-answer"],
    initialUserTurnCount: 1, acceptedUserTurnCount: 2,
    ...(mode === "tools-success" ? { toolBoundary: { revision: 3, text: "Before the tool result", sourceGenerationStarted: true } } : {}),
  };
  writeFileSync(helper, `
    import { appendFileSync, readFileSync } from "node:fs";
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    appendFileSync(${JSON.stringify(starts)}, "start\\n");
    if (${JSON.stringify(mode)} === "close-startup" && readFileSync(${JSON.stringify(starts)}, "utf8").trim().split("\\n").length > 1) {
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    ChatGptBrowserWorker.prototype.run = async turn => {
      appendFileSync(${JSON.stringify(attempts)}, "attempt\\n");
      const lunaCheckpoint = {
        checkpoint: { version: 1, objective: "Recover this task", state: ["Reply captured"], evidence: [], decisions: [], pending: [] },
        answerHash: "a".repeat(64),
      };
      const rich = { sourceUrl: "https://chatgpt.com/c/current-task-1234", items: [{ kind: "chart", label: "Current chart" }] };
      if (!turn.replyRecovery) {
        await turn.onPreparedSelected(false);
        await turn.prepare();
        await turn.onSendActivated();
        turn.onSubmitted();
        if (${JSON.stringify(mode)} !== "no-checkpoint") await turn.onReplyRecoveryCheckpoint(${JSON.stringify(checkpoint)});
        if (turn.completionFence) {
          const revision = await turn.completionFence.begin();
          if (!await turn.completionFence.commit(revision)) throw new Error("First completion fence failed");
        }
        turn.onTextDelta("Recovered ");
        if (turn.captureLunaCheckpoint) turn.onLunaCheckpoint(lunaCheckpoint);
        turn.onRichOutput?.(rich);
        setTimeout(() => process.exit(73), 50);
        return await new Promise(() => {});
      }
      if (JSON.stringify(turn.replyRecovery) !== JSON.stringify(${JSON.stringify(checkpoint)})) throw new Error("Wrong task recovery evidence");
      if (turn.captureLunaCheckpoint) turn.onLunaCheckpoint({
        ...lunaCheckpoint, answerHash: ${JSON.stringify(mode)} === "changed-checkpoint" ? "b".repeat(64) : lunaCheckpoint.answerHash,
      });
      turn.onRichOutput?.(${JSON.stringify(mode)} === "changed-rich"
        ? { ...rich, items: [{ kind: "chart", label: "Different chart" }] } : rich);
      if (turn.completionFence) {
        const revision = await turn.completionFence.begin();
        if (!await turn.completionFence.commit(revision)) throw new Error("Recovered completion fence failed");
      }
      if (${JSON.stringify(mode)} === "second-crash") process.exit(74);
      if (${JSON.stringify(mode)} === "changed-text") {
        turn.onTextDelta("Different answer");
        return "Different answer";
      }
      turn.onTextDelta("Reco");
      turn.onTextDelta("vered answer");
      return "Recovered answer";
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `);
  const releases: string[] = [];
  const control = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async request => {
      const body = await request.json() as { phase: string };
      releases.push(body.phase);
      return Response.json({ ok: true, cancelledByUser: false });
    },
  });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: { endpoint: `http://127.0.0.1:${control.port}`, token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: helper },
    partition: expectedLauncherBrowserPartition("production"), idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { ["launcher_surface_id_0123456789AB"]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  }));
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native2", browserHost: "launcher", browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper, storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"), turnTimeoutMs: 60_000, headed: true, autoApproveToolCalls: false,
    useSavedChats: true,
  });
  const controller = new AbortController();
  const deltas: string[] = [];
  const fences: string[] = [];
  const checkpoints: unknown[] = [];
  const richOutputs: unknown[] = [];
  try {
    const result = client.run({
      traceId: "recover-current-task", nativeThreadId: "native-task-1234", modelId: "gpt-5.6-sol",
      capabilities: { localToolsEnabled: mode === "tools-success", solAvailable: true, proAvailable: false },
      prepare: async () => ({ text: "Only this task", images: [], release() {} }),
      abortSignal: controller.signal,
      onSubmitted: () => { if (mode === "cancelled") controller.abort(); },
      onTextDelta: text => { deltas.push(text); },
      ...(mode.includes("rich") ? { onRichOutput: (output: unknown) => { richOutputs.push(output); } } : {}),
      ...(mode === "luna-success" || mode === "changed-checkpoint" ? {
        captureLunaCheckpoint: true, onLunaCheckpoint: (captured: unknown) => { checkpoints.push(captured); },
      } : {}),
      ...(mode === "tools-success" ? {
        externalProgress: new ChatGptExternalTurnProgress(),
        completionFence: {
          begin: async () => { fences.push("begin"); return 7; },
          commit: async (revision: number) => { fences.push("commit"); return revision === 7; },
        },
      } : {}),
    });
    void result.catch(() => {});
    if (mode === "close-startup") {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await Bun.file(starts).text().catch(() => "")).trim().split("\n").length < 2) await Bun.sleep(20);
      expect((await Bun.file(starts).text()).trim().split("\n")).toHaveLength(2);
      const closed = client.close();
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      await closed;
    } else if (mode === "success" || mode === "tools-success" || mode === "luna-success" || mode === "rich-success") {
      expect(await result).toBe("Recovered answer");
      expect(deltas.join("")).toBe("Recovered answer");
      expect(releases).toEqual([]);
      expect(fences).toEqual(mode === "tools-success" ? ["begin", "commit", "begin", "commit"] : []);
      expect(checkpoints).toHaveLength(mode === "luna-success" ? 1 : 0);
      expect(richOutputs).toHaveLength(mode === "rich-success" ? 1 : 0);
    } else if (mode === "changed-rich") {
      await expect(result).rejects.toThrow("changed its rich output");
      expect(richOutputs).toHaveLength(1);
      expect(deltas.join("")).toBe("Recovered ");
    } else if (mode === "changed-checkpoint") {
      await expect(result).rejects.toThrow("changed its context checkpoint");
      expect(checkpoints).toHaveLength(1);
    } else if (mode === "changed-text") {
      await expect(result).rejects.toThrow("changed text already delivered to Codex");
      expect(deltas.join("")).toBe("Recovered ");
    } else {
      await expect(result).rejects.toThrow("Launcher browser helper exited");
    }
    expect((await Bun.file(attempts).text()).trim().split("\n")).toHaveLength(
      mode === "cancelled" || mode === "no-checkpoint" || mode === "close-startup" ? 1 : 2,
    );
  } finally {
    await client.close();
    await control.stop(true);
  }
}, 30_000);

test("reply recovery checkpoints reject old replies, foreign URLs and malformed identities", () => {
  const checkpoint = {
    conversationUrl: "https://chatgpt.com/c/current-task-1234", responseIdentity: "new-answer",
    initialTurnIdentities: ["old-answer"], acceptedTurnIdentities: ["old-answer", "new-user", "new-answer"],
    initialUserTurnCount: 0, acceptedUserTurnCount: 1,
  };
  expect(parseChatGptReplyRecoveryCheckpoint(checkpoint)).toEqual(checkpoint);
  for (const changed of [
    { responseIdentity: "old-answer" }, { conversationUrl: "https://other.example/c/current-task-1234" },
    { acceptedTurnIdentities: ["new-user"] }, { initialTurnIdentities: ["old-answer", "old-answer"] },
    { toolBoundary: { revision: 0, text: "old boundary" } },
    { initialUserTurnCount: -1 }, { acceptedUserTurnCount: 0 }, { acceptedUserTurnCount: 2 },
    { toolBoundary: { revision: 1, text: "", sourceGenerationStarted: "yes" } },
  ]) expect(() => parseChatGptReplyRecoveryCheckpoint({ ...checkpoint, ...changed })).toThrow();
});

test("closing the client settles a helper readiness wait even before a turn is registered", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native2", browserHost: "launcher", browserHostDescriptorPath: "/unused/launcher.json",
    storageStatePath: "/unused/state.json", chromeExecutablePath: "/unused/chrome",
    turnTimeoutMs: 60_000, headed: true, autoApproveToolCalls: false, useSavedChats: true,
  });
  const internal = client as unknown as { ready?: Promise<void>; readyReject?: (error: Error) => void };
  const ready = new Promise<void>((_resolve, reject) => { internal.readyReject = reject; });
  internal.ready = ready;
  const settled = ready.then(() => "ready", error => error instanceof DOMException ? error.name : String(error));
  await client.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(await Promise.race([settled, new Promise(resolve => { timer = setTimeout(() => resolve("unsettled"), 100); })]))
      .toBe("AbortError");
  } finally { clearTimeout(timer); }
});

test("daemon streams browser lifecycle through the real helper process", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-client-"));
  roots.push(root);
  const helper = join(root, "helper.ts");
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    // Substitute only the browser. Both sides of the production IPC protocol run unchanged.
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      // The helper's own default is saved chats, so only a forwarded explicit choice is false.
      if (this.config.useSavedChats !== false) throw new Error("Saved chat preference lost in helper IPC");
      await turn.onPreparedSelected(false);
      const prepared = await turn.prepare();
      if (prepared.multipart.parts.length !== 3) throw new Error("Multipart context was lost");
      await turn.onMultipartStageAcknowledged?.(1);
      await turn.onMultipartStageAcknowledged?.(2);
      await turn.onSendActivated();
      turn.onSubmitted();
      turn.onReasoningSummary("Reading project");
      turn.onReasoningSummary(" files", true);
      turn.onTextDelta("done");
      turn.onRichOutput?.({
        sourceUrl: "https://chatgpt.com/c/helper-rich-test",
        items: [{ kind: "chart", label: "Revenue" }, { kind: "artifact", label: "Report" }],
      });
      if (turn.captureLunaCheckpoint) turn.onLunaCheckpoint({
        answerHash: "a".repeat(64),
        checkpoint: {
          version: 1,
          objective: "Finish the helper test.",
          state: ["The answer streamed."],
          evidence: ["The helper emitted a checkpoint event."],
          decisions: [],
          pending: [],
        },
      });
      return "done";
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const descriptorHelper = join(root, "descriptor-helper.cjs");
  writeFileSync(descriptorHelper, "process.exit(99);\n", { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: {
      endpoint: "http://127.0.0.1:39002",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: descriptorHelper },
    partition: expectedLauncherBrowserPartition("production"),
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { ["launcher_surface_id_0123456789AB"]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const config: ResolvedBrowserConfig = {
    appName: "Codex Native2",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useSavedChats: false,
  };
  const reasoning: Array<{ text: string; continuation: boolean }> = [];
  const deltas: string[] = [];
  const checkpoints: unknown[] = [];
  const richOutputs: unknown[] = [];
  const acknowledgedStages: number[] = [];
  let sendActivated = false;
  let submitted = false;
  let released = false;
  const client = new LauncherBrowserHelperClient(config);
  try {
    const result = await client.run({
      traceId: "abcdef123456",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
      prepare: async () => ({
        text: "inspect", images: [],
        multipart: { parts: ["part one", "part two", "part three"], commit: "inspect" },
        release: () => { released = true; },
      }),
      onMultipartStageAcknowledged: stage => { acknowledgedStages.push(stage); },
      onSendActivated: () => { sendActivated = true; },
      onSubmitted: () => { submitted = true; },
      onReasoningSummary: (text, continuation) => reasoning.push({ text, continuation: continuation === true }),
      onTextDelta: text => deltas.push(text),
      onRichOutput: output => richOutputs.push(output),
      captureLunaCheckpoint: true,
      onLunaCheckpoint: checkpoint => checkpoints.push(checkpoint),
    });
    expect(result).toBe("done");
    expect(reasoning).toEqual([
      { text: "Reading project", continuation: false },
      { text: " files", continuation: true },
    ]);
    expect(deltas).toEqual(["done"]);
    expect(richOutputs).toEqual([{
      sourceUrl: "https://chatgpt.com/c/helper-rich-test",
      items: [{ kind: "chart", label: "Revenue" }, { kind: "artifact", label: "Report" }],
    }]);
    expect(sendActivated).toBe(true);
    expect(submitted).toBe(true);
    expect(acknowledgedStages).toEqual([1, 2]);
    expect(checkpoints).toEqual([{
      answerHash: "a".repeat(64),
      checkpoint: {
        version: 1,
        objective: "Finish the helper test.",
        state: ["The answer streamed."],
        evidence: ["The helper emitted a checkpoint event."],
        decisions: [],
        pending: [],
      },
    }]);
    expect(released).toBe(true);
  } finally {
    await client.close();
  }
});

test("accepted compaction retires through the helper as completed without hiding cancellations or errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-helper-compaction-end-"));
  roots.push(root);
  const helper = join(root, "helper.ts");
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    const run = ChatGptBrowserWorker.prototype.run;
    ChatGptBrowserWorker.prototype.run = function(turn) {
      // Substitute the browser wait only. Actual worker catch/finally, IPC and launcher end run.
      this.runStage = async () => {
        const stopped = new Promise((resolve, reject) => {
          turn.abortSignal.addEventListener("abort", () => reject(
            turn.traceId === "compaction_real_failure"
              ? new Error("independent browser failure")
              : new DOMException("ChatGPT web turn aborted", "AbortError")
          ), { once: true });
        });
        turn.onSubmitted();
        return stopped;
      };
      return run.call(this, turn);
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const ended = new Map<string, Record<string, unknown>>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as Record<string, unknown>;
      if (body.phase === "start") return Response.json({
        ok: true, surfaceId: "launcher_surface_id_0123456789AB", reused: true, connectorBound: true,
      });
      if (body.phase === "end") ended.set(body.traceId as string, body);
      return Response.json({ ok: true, cancelledByUser: false });
    },
  });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, JSON.stringify({
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
    endpoint: `http://127.0.0.1:${server.port}`,
    control: { endpoint: `http://127.0.0.1:${server.port}`, token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: helper },
    partition: expectedLauncherBrowserPartition("production"), idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB", createdAt: new Date().toISOString(),
    surfaceTargets: { launcher_surface_id_0123456789AB: "native-owned-target" },
  }), { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native2", browserHost: "launcher", browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper, browserDiagnosticsPath: join(root, "diagnostics"),
    storageStatePath: join(root, "unused-state.json"), chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000, headed: true, autoApproveToolCalls: false, useSavedChats: true,
  });
  const logs: string[] = [];
  const logger = spyOn(console, "info").mockImplementation((...args) => { logs.push(args.join(" ")); });
  try {
    for (const [traceId, reason, status] of [
      ["compaction_accepted", new ChatGptCompactionHandoffAccepted(), "completed"],
      ["compaction_cancelled", new DOMException("user cancelled", "AbortError"), "aborted"],
      ["compaction_same_text", new DOMException("Structured compaction handoff accepted", "AbortError"), "aborted"],
      ["compaction_deadline", new Error("compaction deadline exceeded"), "aborted"],
      ["compaction_real_failure", new ChatGptCompactionHandoffAccepted(), "failed"],
      ["recovered_steering", new ChatGptTurnSupersededError(), "superseded"],
    ] as const) {
      const controller = new AbortController();
      let released = false;
      const prepare = async () => ({ text: "checkpoint instruction", images: [], release: () => { released = true; } });
      await expect(client.run({
        traceId, modelId: "gpt-5.6-sol", reasoning: "high",
        capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
        nativeConnector: true, conversationKey: "a".repeat(64), requireRetainedConversation: true,
        prepare, prepareResume: prepare, abortSignal: controller.signal,
        ...(traceId === "recovered_steering" ? {
          retainConversation: true,
          replyRecovery: {
            conversationUrl: "https://chatgpt.com/c/current-task-1234", responseIdentity: "current-answer",
            initialTurnIdentities: [], acceptedTurnIdentities: ["current-user", "current-answer"],
            initialUserTurnCount: 0, acceptedUserTurnCount: 1,
          },
          onPreparedSelected: () => { controller.abort(reason); },
        } : {}),
        onSubmitted: () => { controller.abort(reason); }, onTextDelta() {},
      })).rejects.toThrow(traceId === "compaction_real_failure"
        ? "independent browser failure"
        : traceId === "compaction_accepted" ? "Structured compaction handoff accepted"
          : traceId === "recovered_steering" ? /aborted/ : "ChatGPT web turn aborted");
      // Logical outcome is observed only after the real helper's launcher retirement handshake.
      expect(ended.get(traceId)?.status).toBe(status);
      expect(ended.get(traceId)?.retain).toBe(traceId === "recovered_steering" ? true : undefined);
      expect(released).toBeTrue();
    }
    await client.close();
    expect(logs.some(line => line.includes("compaction_accepted ended after accepted structured compaction handoff"))).toBeTrue();
    expect(logs.some(line => line.includes("compaction_accepted failed:"))).toBeFalse();
    for (const traceId of ["compaction_cancelled", "compaction_same_text", "compaction_deadline", "compaction_real_failure"]) {
      expect(logs.some(line => line.includes(`${traceId} failed:`))).toBeTrue();
    }
  } finally {
    await client.close();
    logger.mockRestore();
    await server.stop(true);
  }
});

test("launcher helper protocol preserves multipart context and the compaction flag", async () => {
  const sent: Record<string, unknown>[] = [];
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native2 DEV",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false, useSavedChats: true,
  });
  const internal = client as unknown as {
    pending: Map<string, { resolve(value: string): void }>;
    child?: unknown;
    ensureChild(): Promise<void>;
    send(message: Record<string, unknown>): Promise<void>;
    finish(id: string): void;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  internal.ensureChild = async () => {};
  internal.send = async message => {
    sent.push(message);
    if (typeof message.id !== "string") return;
    if (message.type === "run") {
      queueMicrotask(() => internal.handleLine(child, JSON.stringify({
        type: "event",
        id: message.id,
        event: "prepared_selected",
        reused: false,
      })));
    } else if (message.type === "prepared_selected_ack") {
      queueMicrotask(() => internal.handleLine(child, JSON.stringify({
        type: "result",
        id: message.id,
        text: "done",
      })));
    }
  };

  await expect(client.run({
    traceId: "multipart-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
    compaction: true,
    prepare: async () => ({
      text: "commit",
      images: [],
      multipart: { parts: ["{\"part\":1}", "{\"part\":2}", "{\"part\":3}"], commit: "commit" },
      trimmedCompactionMessages: 4,
      release() {},
    }),
    onTextDelta() {},
  })).resolves.toBe("done");

  expect(sent[0]).toMatchObject({
    type: "run",
    turn: {
      compaction: true,
    },
  });
  expect(sent[1]).toMatchObject({
    type: "prepared_selected_ack",
    prepared: {
        text: "commit",
        multipart: { parts: ["{\"part\":1}", "{\"part\":2}", "{\"part\":3}"], commit: "commit" },
        trimmedCompactionMessages: 4,
    },
  });
});

test("an abort dispatched during run submission cannot overtake the run frame", async () => {
  const controller = new AbortController();
  const messages: string[] = [];
  let released = false;
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false, useSavedChats: true,
  });
  const internal = client as unknown as {
    ensureChild(): Promise<void>;
    send(message: { type: string; id?: string }): Promise<void>;
    finishWithError(id: string, error: Error): void;
  };
  internal.ensureChild = async () => {};
  internal.send = async message => {
    messages.push(message.type);
    if (message.type === "run") controller.abort();
    if (message.type === "abort" && message.id) {
      queueMicrotask(() => internal.finishWithError(
        message.id!,
        new DOMException("ChatGPT web turn aborted", "AbortError"),
      ));
    }
  };

  await expect(client.run({
    traceId: "abort-order-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
    abortSignal: controller.signal,
    prepare: async () => ({
      text: "inspect",
      images: [],
      release: () => { released = true; },
    }),
    onTextDelta: () => {},
  })).rejects.toMatchObject({ name: "AbortError" });

  expect(messages).toEqual(["run", "abort"]);
  expect(released).toBe(false);
});

test("structured helper errors preserve the ChatGPT adapter failure contract", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false, useSavedChats: true,
  });
  const internal = client as unknown as {
    child?: unknown;
    pending: Map<string, {
      turn: BrowserTurn;
      resolve: (value: string) => void;
      reject: (error: Error) => void;
    }>;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  const result = new Promise<string>((resolveResult, rejectResult) => {
    internal.pending.set("rate-limit-123", {
      turn: {
        traceId: "rate-limit-123",
        modelId: "chatgpt-web/medium",
        capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
        prepare: async () => ({ text: "inspect", images: [], release() {} }),
        onTextDelta() {},
      },
      resolve: resolveResult,
      reject: rejectResult,
    });
  });

  internal.handleLine(child, JSON.stringify({
    type: "error",
    id: "rate-limit-123",
    name: "ChatGptWebAdapterError",
    message: "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  }));

  const error = await result.then(() => undefined, failure => failure);
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error).toMatchObject({
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
});


test("a turn cancelled while the app restarts leaves the shared wait at once; the wait goes on for the others", async () => {
  let finish!: (value: string) => void;
  const shared = new Promise<string>(resolveShared => { finish = resolveShared; });
  const cancelled = new AbortController();
  const leaving = abortable(shared, cancelled.signal);
  const staying = abortable(shared, new AbortController().signal);
  cancelled.abort();
  await expect(leaving).rejects.toThrow("aborted");
  finish("descriptor");
  expect(await staying).toBe("descriptor");
  expect(await abortable(Promise.resolve(1))).toBe(1);
  await expect(abortable(Promise.resolve(1), AbortSignal.abort())).rejects.toThrow("aborted");
});
