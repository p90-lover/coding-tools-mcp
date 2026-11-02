import { expect, test } from "bun:test";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint, isWindowsPipeEndpoint } from "../src/config";

test("explicit browser-turn cancellation aborts and removes every registered session", async () => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  const replayable = sessions.getOrCreate("turn-a", () => ({
    mode: "read-only",
    browser: Promise.resolve("done"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));
  await replayable.browserOutcome;
  sessions.getOrCreate("turn-b", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  expect(sessions.activeCount()).toBe(1);
  expect(sessions.clear()).toBe(2);
  expect(cancelled).toBe(2);
  expect(sessions.activeCount()).toBe(0);
});

test("targeted tab cancellation settles one trace and keeps a terminal replay tombstone", async () => {
  const sessions = new ChatGptTurnSessions();
  let rejectTarget!: (error: Error) => void;
  let targetCancelled = 0;
  let otherCancelled = 0;
  const target = sessions.getOrCreate("target", () => ({
    mode: "read-only",
    browser: new Promise<string>((_resolve, reject) => { rejectTarget = reject; }),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {
      targetCancelled += 1;
      rejectTarget(new Error("browser tab closed by user"));
    },
  }), "trace_target");
  sessions.getOrCreate("other", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { otherCancelled += 1; },
  }), "trace_other");

  expect(await sessions.cancelTrace("trace_target")).toBe(1);
  expect(targetCancelled).toBe(1);
  expect(otherCancelled).toBe(0);
  expect(target.settledOutcome()).toMatchObject({ type: "error" });
  expect(sessions.activeCount()).toBe(1);
  expect(sessions.getOrCreate("target", () => {
    throw new Error("a cancelled continuation must not open a new browser tab");
  }, "trace_target")).toBe(target);
  expect(await sessions.cancelTrace("trace_target")).toBe(0);
  sessions.clear();
});

test("native interruption retires only the exact browser turn identity", async () => {
  const sessions = new ChatGptTurnSessions();
  const cancelled: string[] = [];
  const runtime = (name: string) => {
    let rejectBrowser!: (error: Error) => void;
    const browser = new Promise<string>((_resolve, reject) => { rejectBrowser = reject; });
    return {
      mode: "read-only" as const,
      browser,
      physicalSettlement: browser.then(() => undefined, () => undefined),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: (reason?: Error) => {
        cancelled.push(name);
        rejectBrowser(reason ?? new Error("cancelled"));
      },
    };
  };
  sessions.getOrCreate(
    "target",
    () => runtime("target"),
    "trace_target",
    "owner_target",
    "turn_shared",
    "thread_target",
  );
  sessions.getOrCreate(
    "other-thread",
    () => runtime("other-thread"),
    "trace_other",
    "owner_other",
    "turn_shared",
    "thread_other",
  );

  const cancellation = sessions.cancelNativeTurn(
    "thread_target",
    "turn_shared",
    new DOMException("Codex turn interrupted", "AbortError"),
  );
  expect(cancellation.cancelled).toBe(1);
  await cancellation.settlement;
  expect(cancelled).toEqual(["target"]);
  expect(sessions.find("target")).toBeUndefined();
  expect(sessions.find("other-thread")?.nativeThreadId).toBe("thread_other");
  expect(sessions.activeCount()).toBe(1);
  sessions.clear();
});

test("session cache expiry never cancels a still-active long browser turn", async () => {
  const sessions = new ChatGptTurnSessions(1);
  let cancelled = 0;
  const active = sessions.getOrCreate("long-turn", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  await Bun.sleep(5);
  expect(sessions.activeCount()).toBe(1);
  expect(sessions.getOrCreate("long-turn", () => {
    throw new Error("active session must be reused");
  })).toBe(active);
  expect(cancelled).toBe(0);
  sessions.clear();
});

test("five active turns coexist and a sixth fails closed", () => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  const runtime = () => ({
    mode: "read-only" as const,
    browser: new Promise<string>(() => {}),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  });

  const active = Array.from({ length: 5 }, (_unused, index) => (
    sessions.getOrCreate(`turn-${index + 1}`, runtime)
  ));
  expect(sessions.activeCount()).toBe(5);
  expect(cancelled).toBe(0);
  expect(() => sessions.getOrCreate("turn-6", runtime)).toThrow("at most 5 simultaneous browser turns");

  expect(sessions.getOrCreate("turn-3", () => {
    throw new Error("an in-flight turn must be reused");
  })).toBe(active[2]);
  expect(cancelled).toBe(0);
  sessions.clear();
  expect(cancelled).toBe(5);
});

test("settled replay sessions expire from their last use instead of their creation time", async () => {
  const sessions = new ChatGptTurnSessions(50);
  let starts = 0;
  const start = () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      browser: Promise.resolve("done"),
      physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => {},
    };
  };
  const first = sessions.getOrCreate("replay", start);
  await first.browserOutcome;
  await Bun.sleep(10);
  expect(sessions.getOrCreate("replay", start)).toBe(first);
  await Bun.sleep(70);
  expect(sessions.getOrCreate("replay", start)).not.toBe(first);
  expect(starts).toBe(2);
  sessions.clear();
});

test("turn broker creates its private runtime directory on a cold start", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 10_000);
    if (process.platform === "win32") {
      expect(isWindowsPipeEndpoint(socketPath)).toBe(true);
    } else {
      expect(existsSync(socketPath)).toBe(true);
      expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
    }
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker rejects a Unix socket path that leaves no room for sun_path's NUL terminator", async () => {
  if (process.platform === "win32") return;
  const socketPath = `/tmp/${"x".repeat(99)}`;
  expect(Buffer.byteLength(socketPath)).toBe(104);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    await expect(broker.listen()).rejects.toThrow("103-byte limit");
  } finally {
    await broker.close();
  }
});

test("turn broker tokens do not expire while their browser turn is still alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-unbounded-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
    await Bun.sleep(5);
    await expect(callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token }))
      .resolves.toMatchObject({ bindingId: expect.any(String) });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker revokes only channels owned by the closed browser trace", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-targeted-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };
    const target = await broker.register(environment, 60_000, "trace_target");
    const other = await broker.register(environment, 60_000, "trace_other");
    expect(broker.revokeTrace("trace_target")).toBe(1);
    await expect(callTurnBroker(socketPath, { method: "claim", token: target }))
      .rejects.toThrow("already finished");
    await expect(callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token: other }))
      .resolves.toMatchObject({ bindingId: expect.any(String) });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function unansweredBrokerEndpoint(name: string, onConnection: (socket: Socket) => void) {
  const root = mkdtempSync(join(tmpdir(), name));
  const socketPath = defaultBrokerEndpoint(root);
  if (!isWindowsPipeEndpoint(socketPath)) mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer(onConnection);
  return {
    socketPath,
    listen: () => new Promise<void>(ready => server.listen(socketPath, ready)),
    close: async () => {
      await new Promise<void>(done => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("turn broker binds once a previous owner releases its endpoint", async () => {
  const previous = unansweredBrokerEndpoint("cgw-broker-handover-", socket => socket.destroy());
  await previous.listen();
  const broker = TurnBroker.forSocket(previous.socketPath);
  try {
    if (process.platform === "win32") {
      // A pipe name stays taken while the previous runtime finishes its shutdown; the bind waits.
      const listening = broker.listen();
      await Bun.sleep(300);
      await previous.close();
      await listening;
    } else {
      // The socket probe refuses a live owner; a later attempt must not replay that refusal.
      await expect(broker.listen()).rejects.toThrow("already owned");
      await previous.close();
      await broker.listen();
    }
    await expect(callTurnBroker(previous.socketPath, { method: "claim", token: "turn_handover" }))
      .rejects.toThrow("turn token is invalid");
  } finally {
    await broker.close();
    if (!isWindowsPipeEndpoint(previous.socketPath)) {
      rmSync(dirname(dirname(previous.socketPath)), { recursive: true, force: true });
    }
  }
}, 15_000);

test("Windows broker restarts after an occupied pipe exhausts the retry window", async () => {
  if (process.platform !== "win32") return;
  const previous = unansweredBrokerEndpoint("cgw-broker-long-contention-", socket => socket.destroy());
  await previous.listen();
  const broker = TurnBroker.forSocket(previous.socketPath);
  let previousClosed = false;
  try {
    // A prolonged incumbent must not permanently cache a failed startup promise.
    await expect(broker.listen()).rejects.toThrow(/EADDRINUSE/i);
    await previous.close();
    previousClosed = true;
    await broker.listen();
    await expect(callTurnBroker(previous.socketPath, { method: "claim", token: "turn_after_retry" }))
      .rejects.toThrow("turn token is invalid");
  } finally {
    if (!previousClosed) await previous.close();
    await broker.close();
  }
}, 25_000);

test("closing a turn broker ends held connections and frees its endpoint for the next runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-held-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  // An MCP long poll: connected, request not yet answered.
  const held = createConnection(socketPath);
  await new Promise<void>(connected => held.once("connect", connected));
  held.on("error", () => {});
  held.write('{"id":"held"');
  await Bun.sleep(200);
  const successor = { close: async () => {} };
  try {
    const outcome = await Promise.race([
      broker.close().then(() => "closed"),
      Bun.sleep(3_000).then(() => "hung"),
    ]);
    expect(outcome).toBe("closed");
    const next = TurnBroker.forSocket(socketPath);
    successor.close = () => next.close();
    await next.listen();
  } finally {
    held.destroy();
    await successor.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("an unbounded broker call fails when the broker closes without answering", async () => {
  const broker = unansweredBrokerEndpoint("cgw-broker-closed-", socket => socket.on("data", () => socket.end()));
  await broker.listen();
  try {
    await expect(callTurnBroker(broker.socketPath, { method: "claim", token: "turn_closed" }, null))
      .rejects.toThrow("closed the connection");
  } finally {
    await broker.close();
  }
}, 10_000);

test("an unbounded broker call outlives the bounded default timeout", async () => {
  const accepted: Socket[] = [];
  const broker = unansweredBrokerEndpoint("cgw-broker-slow-", socket => { accepted.push(socket); });
  await broker.listen();
  try {
    const call = callTurnBroker(broker.socketPath, { method: "claim", token: "turn_unbounded" }, null);
    const outcome = await Promise.race([
      call.then(() => "settled", () => "settled"),
      Bun.sleep(5_300).then(() => "pending"),
    ]);
    expect(outcome).toBe("pending");
  } finally {
    for (const socket of accepted) socket.destroy();
    await broker.close();
  }
}, 15_000);

test("turn broker names the finished turn that owns a replayed handle", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 60_000, "turn-alpha");
    await expect(callTurnBroker(socketPath, { method: "claim", token: ` ${token}` }))
      .rejects.toThrow("turn token is invalid, expired, or revoked");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    broker.revoke(token);

    const rejection = async (request: Parameters<typeof callTurnBroker>[1]): Promise<string> => {
      try {
        await callTurnBroker(socketPath, request);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("turn broker accepted a handle it should have rejected");
    };

    const replayedBinding = await rejection({
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
    });
    expect(replayedBinding).toContain("turn-alpha");
    expect(replayedBinding).toContain("has already finished");
    expect(replayedBinding).not.toContain("codex_bind_turn");

    const replayedToken = await rejection({ method: "claim", token });
    expect(replayedToken).toContain("turn-alpha");
    expect(replayedToken).toContain("can no longer run");
    expect(replayedToken).not.toContain("current task context");

    const unknownBinding = await rejection({
      method: "invoke",
      bindingId: "binding_never-issued",
      wireName: "exec_command",
    });
    expect(unknownBinding).toBe("internal Codex turn binding is invalid or expired");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// Evaluate the actual class with fake fs/net so lifecycle interleavings need no real endpoint.
function processlessBroker(options: { windows?: boolean; stale?: boolean } = {}) {
  const source = readFileSync(join(import.meta.dir, "../src/adapters/chatgpt-web/turn-broker.ts"), "utf8");
  const tree = ts.createSourceFile("turn-broker.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const find = (predicate: (node: ts.Node) => boolean) => { let found: ts.Node | undefined;
    const visit = (node: ts.Node) => { if (!found && predicate(node)) found = node; ts.forEachChild(node, visit); }; visit(tree); expect(found).toBeDefined(); return found!; };
  const declarations = ["closeTurnBrokers", "opaqueId", "handleFingerprint", "errorOf", "retiredTurnLabel", "environmentIdentity", "ownerEnvironment", "assertSurfaceNonce", "TurnBroker"]
    .map(name => find(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name).getText(tree).replace(/^export\s+/, "")).join("\n");
  const constants = ["MAX_BROKER_LINE_CHARS", "MAX_RETIRED_TURN_HANDLES", "MAX_UNIX_SOCKET_PATH_BYTES", "WINDOWS_PIPE_LISTEN_RETRY_MS"]
    .map(name => `const ${name}=${(find(node => ts.isVariableDeclaration(node) && node.name.getText(tree) === name) as ts.VariableDeclaration).initializer!.getText(tree)};`).join("\n");
  const state = { socket: options.stale ? { dev: 1, ino: 1 } : undefined as { dev: number; ino: number } | undefined,
    failListen: undefined as Error | undefined, failStat: undefined as Error | undefined, closeError: undefined as Error | undefined, holdClose: false, holdReady: false };
  const unlinked: number[] = [], heldCloses: Array<() => void> = [], heldStarts: Array<() => void> = [], timers = new Map<number, () => void>();
  let nextInode = 1, nextTimer = 0, compactionStarts = 0;
  class FakeSocket extends EventEmitter {
    destroyed = false;
    setEncoding() { return this; }
    setTimeout() { return this; }
    destroy() { this.destroyed = true; queueMicrotask(() => this.emit("close")); return this; }
  }
  class FakeServer extends EventEmitter {
    listening = false;
    constructor(readonly onConnection: (socket: FakeSocket) => void) { super(); }
    listen(_endpoint: string, ready: () => void) {
      const error = state.failListen; state.failListen = undefined;
      if (error) queueMicrotask(() => this.emit("error", error));
      else { const started = () => { this.listening = true; state.socket = { dev: 1, ino: ++nextInode }; ready(); };
        if (state.holdReady) heldStarts.push(started); else queueMicrotask(started); }
      return this;
    }
    close(done: (error?: Error) => void) {
      this.listening = false;
      const error = state.closeError; state.closeError = undefined;
      if (state.holdClose) heldCloses.push(() => done(error)); else queueMicrotask(() => done(error));
      return this;
    }
  }
  const servers: FakeServer[] = [], probes: FakeSocket[] = [];
  const context: Record<string, any> = { createHash, randomBytes, dirname, isAbsolute, relative, resolve, Buffer, DOMException, AbortController, structuredClone,
    console: { info() {}, error() {} }, process: { getuid: () => 1000 }, isWindowsPipeEndpoint: () => options.windows === true,
    mkdirSync() {}, chmodSync() {}, existsSync: () => state.socket !== undefined,
    lstatSync: () => { const error = state.failStat; state.failStat = undefined; if (error) throw error;
      if (!state.socket) throw Object.assign(new Error("fake missing socket"), { code: "ENOENT" });
      return { ...state.socket, uid: 1000, mode: 0o600, isSocket: () => true }; },
    unlinkSync: () => { unlinked.push(state.socket!.ino); state.socket = undefined; },
    createConnection: () => { const probe = new FakeSocket(); probes.push(probe); return probe; },
    createServer: (onConnection: (socket: FakeSocket) => void) => { const server = new FakeServer(onConnection); servers.push(server); return server; },
    setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: (timer: number) => timers.delete(timer),
    CompactionTransactionStore: class { close() {} begin() { compactionStarts += 1; return { token: "fake-control", handoffId: "fake-handoff" }; } },
  };
  runInNewContext(ts.transpileModule("const brokers=new Map();\n" + constants + "\n" + declarations
    + "\nglobalThis.subject={TurnBroker,brokers,closeTurnBrokers};", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  const subject = context.subject as { TurnBroker: typeof TurnBroker; brokers: Map<string, TurnBroker>; closeTurnBrokers(): Promise<void> };
  const endpoint = options.windows ? "fake-pipe" : "/fake/turn-broker.sock";
  return { ...subject, endpoint, state, servers, probes, unlinked, heldCloses, heldStarts,
    create: () => subject.TurnBroker.forSocket(endpoint),
    identity: () => state.socket ? { ...state.socket } : undefined,
    channelCount: (broker: TurnBroker) => (broker as unknown as { channels: Map<string, unknown> }).channels.size,
    compactionCount: () => compactionStarts,
    fireTimer: () => { const [id, callback] = [...timers][0]!; timers.delete(id); callback(); },
    accept: () => { const socket = new FakeSocket(); servers.at(-1)!.onConnection(socket); return socket; } };
}

test("processless broker fences closed Unix probes before unlink or binding a replacement", async () => {
  for (const replace of [false, true]) {
    const fixture = processlessBroker({ stale: true }), broker = fixture.create();
    const starting = broker.listen().then(() => "ready", error => error.message);
    const probe = fixture.probes[0]!;
    await fixture.closeTurnBrokers();
    let replacement: TurnBroker | undefined;
    try {
      expect(fixture.state.socket?.ino).toBe(1); // An unbound broker never owned this old pathname.
      if (replace) { fixture.state.socket = undefined; replacement = fixture.create(); await replacement.listen(); }
      const ownedInode = fixture.state.socket?.ino, priorServers = fixture.servers.length;
      probe.emit("error", Object.assign(new Error("fake stale endpoint"), { code: "ECONNREFUSED" }));
      expect(await starting).toMatch(/closed while binding/);
      expect(fixture.servers).toHaveLength(priorServers);
      expect(fixture.state.socket?.ino).toBe(ownedInode);
      expect(fixture.unlinked).toEqual([]);
      if (replacement) expect(fixture.brokers.get(fixture.endpoint)).toBe(replacement);
    } finally { await broker.close(); if (replacement) await replacement.close(); }
  }
  const replaced = processlessBroker({ stale: true }), owner = replaced.create();
  const starting = owner.listen().then(() => "ready", error => error.message);
  replaced.state.socket = { dev: 3, ino: 901 }; // The registry is unchanged while another process replaces the pathname.
  replaced.probes[0]!.emit("error", Object.assign(new Error("fake old probe"), { code: "ECONNREFUSED" }));
  expect(await starting).toMatch(/replaced while checking/);
  expect(replaced.identity()).toEqual({ dev: 3, ino: 901 });
  expect(replaced.unlinked).toEqual([]); expect(replaced.servers).toEqual([]);
  await owner.close();
}, 15_000);

test("processless broker protects replacement paths across close waits and stale second close", async () => {
  const fixture = processlessBroker(), broker = fixture.create(); await broker.listen();
  fixture.state.holdClose = true;
  const closing = broker.close();
  fixture.state.socket = { dev: 2, ino: 900 }; // Another owner acquires the pathname while close is pending.
  fixture.heldCloses.shift()!(); await closing;
  expect(fixture.state.socket).toEqual({ dev: 2, ino: 900 });
  expect(fixture.unlinked).toEqual([]);
  fixture.state.holdClose = false; fixture.state.socket = undefined;
  const replacement = fixture.create(); await replacement.listen(); const ownedInode = fixture.identity()?.ino;
  try {
    await broker.close();
    expect(fixture.brokers.get(fixture.endpoint)).toBe(replacement);
    expect(fixture.identity()?.ino).toBe(ownedInode);
    expect(fixture.servers.at(-1)!.listening).toBe(true);
  } finally { await replacement.close(); }
}, 15_000);

test("processless broker preserves owned cleanup, startup errors and Windows retry guards", async () => {
  const normal = processlessBroker(), broker = normal.create(); await broker.listen();
  const token = await broker.register({ cwd: import.meta.dir, roots: [import.meta.dir], writableRoots: [import.meta.dir],
    sandboxPolicy: { type: "dangerFullAccess" }, tools: [] });
  expect(token).toMatch(/^turn_/); expect(normal.channelCount(broker)).toBe(1);
  expect(await broker.beginCompactionTransaction("healthy-trace", 1_000)).toEqual({ token: "fake-control", handoffId: "fake-handoff" });
  expect(normal.compactionCount()).toBe(1);
  const socket = normal.accept(), ownedInode = normal.state.socket!.ino;
  await broker.close();
  expect(normal.channelCount(broker)).toBe(0);
  expect(socket.destroyed).toBe(true); expect(normal.servers[0]!.listening).toBe(false);
  expect(normal.unlinked).toEqual([ownedInode]); expect(normal.state.socket).toBeUndefined();
  const failure = processlessBroker(), retry = failure.create();
  failure.state.failListen = Object.assign(new Error("fake bind denied"), { code: "EACCES" });
  await expect(retry.listen()).rejects.toThrow("fake bind denied");
  await retry.listen();
  failure.state.closeError = new Error("fake close error");
  await expect(retry.close()).rejects.toThrow("fake close error");
  expect(failure.servers.at(-1)!.listening).toBe(false);
  const unknown = processlessBroker(), unidentified = unknown.create();
  unknown.state.failStat = new Error("fake identity read failed");
  await expect(unidentified.listen()).rejects.toThrow("fake identity read failed");
  expect(unknown.servers[0]!.listening).toBe(false); expect(unknown.unlinked).toEqual([]);
  await unidentified.close();
  for (const operation of ["listen", "register", "compaction"] as const) {
    const admission = processlessBroker(), owner = admission.create(); admission.state.holdReady = true;
    const pending = (operation === "listen" ? owner.listen() : operation === "register" ? owner.register({
      cwd: import.meta.dir, roots: [import.meta.dir], writableRoots: [import.meta.dir], sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
    }) : owner.beginCompactionTransaction("fake-trace", 1_000)).then(() => "accepted", error => error.message);
    admission.heldStarts.shift()!();
    await owner.close();
    expect(await pending).toMatch(/closed while starting/);
    expect(admission.channelCount(owner)).toBe(0); expect(admission.brokers.has(admission.endpoint)).toBe(false);
    expect(admission.compactionCount()).toBe(0);
  }
  for (const cleanupFails of [false, true]) {
    const delayed = processlessBroker(), late = delayed.create(); delayed.state.holdReady = true;
    const starting = late.listen().then(() => "ready", error => error.message);
    await late.close();
    if (cleanupFails) delayed.state.closeError = new Error("fake late close failed");
    delayed.heldStarts.shift()!();
    expect(await starting).toMatch(cleanupFails ? /fake late close failed/ : /closed while binding/);
    expect(delayed.servers[0]!.listening).toBe(false); expect(delayed.unlinked).toEqual([]);
  }
  for (const closeDuringRetry of [false, true]) {
    const windows = processlessBroker({ windows: true }), pipe = windows.create();
    windows.state.failListen = Object.assign(new Error("fake busy pipe"), { code: "EADDRINUSE" });
    const starting = pipe.listen().then(() => "ready", error => error.message);
    await Promise.resolve();
    if (closeDuringRetry) await pipe.close();
    windows.fireTimer();
    expect(await starting).toMatch(closeDuringRetry ? /closed while binding/ : /^ready$/);
    expect(windows.servers).toHaveLength(closeDuringRetry ? 1 : 2);
    await pipe.close();
  }
}, 15_000);
