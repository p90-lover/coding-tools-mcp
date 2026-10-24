import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const homes: string[] = [];
const temporaryRoot = resolve(import.meta.dir, "..", "..", "aiTemp");
const sourceRoot = resolve(import.meta.dir, "..", "src");
const checkpointName = "compaction-continuations.json";
const sourceText = "Finish the original task without repeating completed tools.";
const summaryText = "Existing tools completed; continue the same native task.";

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function temporaryHome(): string {
  mkdirSync(temporaryRoot, { recursive: true });
  const home = mkdtempSync(join(temporaryRoot, "compaction-restart-"));
  homes.push(home);
  return home;
}

function runProcess(home: string, operation: Record<string, unknown>): {
  status: number; calls: number; continuation?: Record<string, unknown>; beforeRestart?: number;
} {
  const imports = {
    server: pathToFileURL(join(sourceRoot, "server.ts")).href,
    config: pathToFileURL(join(sourceRoot, "config.ts")).href,
    environment: pathToFileURL(join(sourceRoot, "adapters", "chatgpt-web", "environment.ts")).href,
    compaction: pathToFileURL(join(sourceRoot, "responses", "compaction.ts")).href,
  };
  const script = [
    "const paths = " + JSON.stringify(imports) + ";",
    "const operation = " + JSON.stringify(operation) + ";",
    "const { startServer, compactRequest, responseRequest } = await import(paths.server);",
    "const { defaultConfig } = await import(paths.config);",
    "const { extractChatGptTurnUserRevision } = await import(paths.environment);",
    "const { encodeCompactionSummary } = await import(paths.compaction);",
    'const config = { ...defaultConfig("browser-only"), port: 0, host: "127.0.0.1" };',
    "const listener = operation.startServer === false ? undefined : startServer(config);",
    "let calls = 0;",
    "const source = { type: 'message', role: 'user', id: 'msg_restart_source', content: [{ type: 'input_text', text: " + JSON.stringify(sourceText) + " }], internal_chat_message_metadata_passthrough: { turn_id: 'turn_before_restart' } };",
    "const metadata = { thread_id: operation.thread ?? 'thread_restart_checkpoint', turn_id: 'turn_restart_checkpoint' };",
    "const original = { model: 'chatgpt-web/high', stream: false, input: [source], client_metadata: { 'x-codex-turn-metadata': JSON.stringify(metadata) } };",
    "const factory = () => ({ name: 'restart-fixture', async runTurn(parsed, _request, emit) {",
    "  calls++; if (!parsed._compactionRequest) { if (JSON.stringify(extractChatGptTurnUserRevision(parsed)) !== JSON.stringify(source.content)) throw Error('Native task revision changed'); }",
    "  emit({type:'text_delta', text:" + JSON.stringify(summaryText) + ", phase:'final_answer'});",
    "  emit({type:'done', stopReason:'stop', endTurn:true});",
    "} });",
    "const request = body => new Request('http://127.0.0.1/v1/responses', { method:'POST', body:JSON.stringify(body) });",
    "try {",
    "  if (operation.phase === 'write') {",
    "    const result = operation.format === 'v1' ? await compactRequest(request(original), config, factory) : await responseRequest(request({...original, input:[source, {type:'compaction_trigger'}]}), config, factory, {rememberState:false});",
    "    const compacted = await result.json();",
    "    if (result.status !== 200) throw Error(JSON.stringify(compacted));",
    "    const continuation = {...original, input: operation.format === 'v1' ? compacted.output : [source, ...compacted.output]};",
    "    const before = await responseRequest(request(continuation), config, factory, {rememberState:false});",
    "    console.log(JSON.stringify({status:result.status, calls, beforeRestart:before.status, continuation}));",
    "  } else {",
    "    const body = operation.continuation;",
    "    if (operation.variant === 'thread') body.client_metadata['x-codex-turn-metadata'] = JSON.stringify({...metadata, thread_id:'another_thread'});",
    "    if (operation.variant === 'turn') body.client_metadata['x-codex-turn-metadata'] = JSON.stringify({...metadata, turn_id:'another_turn'});",
    "    if (operation.variant === 'model') body.model = 'chatgpt-web/medium';",
    "    if (operation.variant === 'source') body.input = body.input.map(item => item.id === source.id ? {...source, content:[{type:'input_text',text:'A different task'}]} : item);",
    "    if (operation.variant === 'summary') body.input = [source, {type:'compaction',encrypted_content:encodeCompactionSummary('Unrecognized checkpoint')}];",
    "    if (operation.variant === 'aborted') body.input.push({type:'message',role:'user',content:[{type:'input_text',text:'<turn_aborted>The user interrupted this turn.</turn_aborted>'}],internal_chat_message_metadata_passthrough:source.internal_chat_message_metadata_passthrough});",
    "    const result = await responseRequest(request(body), config, factory, {rememberState:false});",
    "    const response = await result.json();",
    "    console.log(JSON.stringify({status:result.status, calls, error:response.error?.message}));",
    "  }",
    "} finally { await listener?.stop(true); }",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--eval", script], {
    encoding: "utf8", timeout: 15_000, windowsHide: true,
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home },
  });
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

for (const format of ["v1", "v2"]) {
  test(format + " compacted chats resume after a fresh server process", () => {
    const home = temporaryHome();
    const written = runProcess(home, { phase: "write", format });
    expect(written.status).toBe(200);
    expect(written.beforeRestart).toBe(200);
    const resumed = runProcess(home, { phase: "read", continuation: written.continuation });
    expect(resumed).toMatchObject({ status: 200, calls: 1 });
  }, 30_000);
}

test("restart recovery preserves exact checkpoint bindings and interrupted-turn rejection", () => {
  const home = temporaryHome();
  const written = runProcess(home, { phase: "write", format: "v2" });
  for (const variant of ["thread", "turn", "model", "source", "summary", "aborted"]) {
    expect(runProcess(home, { phase: "read", continuation: written.continuation, variant }))
      .toMatchObject({ status: 400, calls: 0 });
  }
  expect(runProcess(temporaryHome(), { phase: "read", continuation: written.continuation }))
    .toMatchObject({ status: 400, calls: 0 });
}, 120_000);

test("the durable ledger contains hashes only and corrupt files fail closed", () => {
  const home = temporaryHome();
  const written = runProcess(home, { phase: "write", format: "v1" });
  const path = join(home, checkpointName);
  const snapshot = readFileSync(path, "utf8");
  for (const value of [sourceText, summaryText, "thread_restart_checkpoint", "turn_restart_checkpoint"]) {
    expect(snapshot).not.toContain(value);
  }
  expect(JSON.parse(snapshot).checkpoints).toHaveLength(1);
  writeFileSync(path, "{invalid json");
  expect(runProcess(home, { phase: "read", continuation: written.continuation }))
    .toMatchObject({ status: 400, calls: 0 });
}, 45_000);

test("in-process harnesses retain memory-only checkpoints without starting storage", () => {
  const home = temporaryHome();
  const written = runProcess(home, { phase: "write", format: "v2", startServer: false });
  expect(written.beforeRestart).toBe(200);
  expect(existsSync(join(home, checkpointName))).toBe(false);
}, 30_000);

test("a recently used checkpoint survives restart and bounded-ledger eviction", () => {
  const home = temporaryHome();
  const written = runProcess(home, { phase: "write", format: "v2" });
  const path = join(home, checkpointName);
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  const original = snapshot.checkpoints[0];
  snapshot.checkpoints = [original, ...Array.from({ length: 255 }, (_, index) => [
    createHash("sha256").update("unused-checkpoint-" + index).digest("hex"), original[1],
  ])];
  writeFileSync(path, JSON.stringify(snapshot));
  expect(runProcess(home, { phase: "read", continuation: written.continuation }))
    .toMatchObject({ status: 200, calls: 1 });
  runProcess(home, { phase: "write", format: "v2", thread: "new_checkpoint_thread" });
  expect(runProcess(home, { phase: "read", continuation: written.continuation }))
    .toMatchObject({ status: 200, calls: 1 });
  expect(JSON.parse(readFileSync(path, "utf8")).checkpoints).toHaveLength(256);
}, 90_000);
