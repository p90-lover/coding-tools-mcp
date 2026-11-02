import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig, getConfigDir, type AppConfig } from "../src/config";
import { HttpTurnCounter, responseRequest } from "../src/server";
import type { CodexProviderConfig } from "../src/types";
import { join } from "node:path";

const endpoint = "http://127.0.0.1:17841/v1/responses";
const header = { thread_id: "01a06c66-0000-7ae1-9108-69b5f70e0671", turn_id: "01a06c66-0000-7ae1-9108-69b5f70e0672" };

function send(metadata: unknown, bodyMetadata?: unknown, stream = false, options: {
  model?: string;
  config?: AppConfig;
  adapter?: (provider: CodexProviderConfig) => ProviderAdapter;
} = {}) {
  const requestBody: Record<string, unknown> = {
    model: options.model ?? "chatgpt-web/high", stream,
    input: [{ type: "message", role: "user", id: "msg_continue",
      content: [{ type: "input_text", text: "Continue this restored Codex task" }] }],
  };
  if (bodyMetadata !== undefined) requestBody.client_metadata = {
    "x-codex-turn-metadata": JSON.stringify(bodyMetadata),
  };
  const seen: unknown[] = [];
  const bound: unknown[] = [];
  const routed: Array<string | undefined> = [];
  const adapter = (): ProviderAdapter => ({ name: "header-identity-regression", async runTurn(parsed, _incoming, emit) {
    seen.push(extractChatGptTurnIdentity(parsed));
    routed.push(parsed.options.reasoning);
    emit({ type: "text_delta", text: "Part one. ", phase: "final_answer" });
    emit({ type: "text_delta", text: "Part two.", phase: "final_answer" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } });
  return { seen, bound, routed, response: responseRequest(new Request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify(metadata) },
    body: JSON.stringify(requestBody),
  }), options.config ?? defaultConfig("full"), options.adapter ?? adapter, { rememberState: false, onTurnIdentity: value => bound.push(value) }) };
}

test("a restored WebGPT turn recovers its identity from the header and keeps the full answer", async () => {
  const { response, seen, bound } = send(header);
  const result = await response;
  expect(result.status).toBe(200);
  expect(seen).toEqual([{ threadId: header.thread_id, turnId: header.turn_id }]);
  expect(bound.length).toBeGreaterThan(0);
  for (const identity of bound) expect(identity).toEqual({ threadId: header.thread_id, turnId: header.turn_id });
  const answer = await result.json() as { output: Array<{ type: string; content?: Array<{ text?: string }> }> };
  expect(JSON.stringify(answer.output)).toContain("Part one. Part two.");
});

test("partial saved metadata is filled by the matching native header", async () => {
  const { response, seen, bound } = send(header, { thread_id: header.thread_id });
  expect((await response).status).toBe(200);
  expect(seen).toEqual([{ threadId: header.thread_id, turnId: header.turn_id }]);
  expect(bound.length).toBeGreaterThan(0);
  for (const identity of bound) expect(identity).toEqual({ threadId: header.thread_id, turnId: header.turn_id });
});

test("conflicting or malformed metadata cannot silently rebind a saved Codex task", async () => {
  const conflict = send(header, { thread_id: "another-task", turn_id: header.turn_id });
  const response = await conflict.response;
  expect(response.status).toBe(400);
  expect(conflict.seen).toHaveLength(0);
  expect(conflict.bound).toHaveLength(0);
  expect(await response.text()).toContain("Conflicting Codex turn metadata");
  const malformed = send(["not", "metadata"]);
  expect((await malformed.response).status).toBe(400);
  expect(malformed.seen).toHaveLength(0);
});

test("streaming a restored WebGPT reply preserves both answer fragments", async () => {
  const { response, seen } = send(header, undefined, true);
  const result = await response;
  expect(result.status).toBe(200);
  const events = await result.text();
  expect(events).toContain("Part one. ");
  expect(events).toContain("Part two.");
  expect(seen).toHaveLength(1);
});

test.each([["extra-high", "xhigh"], ["pro", "max"], ["high", "high"]])(
  "native launcher %s keeps the thread account's exact %s effort through routing, adapter and prompt", async (slug, effort) => {
    const config = defaultConfig("browser-only");
    config.browserHost = "launcher";
    config.browserHostDescriptorPath = join(getConfigDir(), `mixed-account-${slug}.json`);
    config.proAvailable = false; // The currently selected Personal account A is not this thread's Business account B.
    const accounts = new Map([[header.thread_id, "business-b"]]);
    const routed: Array<string | undefined> = [];
    const observed: Array<{ account: string | undefined; effort: string }> = [];
    let worker: ChatGptBrowserWorker | undefined;
    let originalRun: ChatGptBrowserWorker["run"] | undefined;
    const result = send(header, undefined, false, {
      model: `chatgpt-web/${slug}`, config,
      adapter: provider => {
        worker = ChatGptBrowserWorker.forProvider(provider);
        originalRun = worker.run;
        worker.run = async (turn: BrowserTurn) => {
          const mode = resolveChatGptWebModelMode(turn.modelId, turn.reasoning, turn.capabilities);
          const prepared = await turn.prepare(); // Real prompt compilation must accept the same routed mode.
          prepared.release();
          observed.push({ account: accounts.get(turn.nativeThreadId ?? ""), effort: mode.effort });
          turn.onTextDelta(`Thread account used ${mode.effort}`);
          return `Thread account used ${mode.effort}`;
        };
        const adapter = createChatGptWebAdapter(provider);
        return { ...adapter, async runTurn(parsed, incoming, emit) {
          routed.push(parsed.options.reasoning);
          await adapter.runTurn!(parsed, incoming, emit);
        } };
      },
    });
    try {
      const response = await result.response;
      const body = await response.text();
      expect(routed).toEqual([effort]);
      expect(response.status).toBe(200);
      expect(observed).toEqual([{ account: "business-b", effort }]);
      expect(body).toContain(`Thread account used ${effort}`);
      expect(result.bound.length).toBeGreaterThan(0);
      for (const identity of result.bound) expect(identity).toEqual({ threadId: header.thread_id, turnId: header.turn_id });
      expect(config.proAvailable).toBeFalse();
    } finally {
      if (worker && originalRun) worker.run = originalRun;
      chatGptTurnSessions.clear();
    }
  },
);

test.each([{}, { thread_id: "dev_thread_example", turn_id: "dev_turn_example" }, { thread_id: 42, turn_id: header.turn_id }])(
  "absent or non-native identity retains legacy account routing (%j)", async metadata => {
    const config = defaultConfig("browser-only");
    config.browserHost = "launcher";
    config.browserHostDescriptorPath = join(getConfigDir(), "legacy-account.json");
    const result = send(metadata, undefined, false, { model: "chatgpt-web/extra-high", config });
    expect((await result.response).status).toBe(200);
    expect(result.routed).toEqual(["high"]);
  },
);

test("native identity cannot enable unknown model routes or malformed metadata", async () => {
  const config = defaultConfig("browser-only");
  config.browserHost = "launcher";
  config.browserHostDescriptorPath = join(getConfigDir(), "invalid-account.json");
  for (const [metadata, model] of [[header, "chatgpt-web/unknown"], [[header], "chatgpt-web/pro"]] as const) {
    const result = send(metadata, undefined, false, { model, config });
    expect((await result.response).status).toBe(400);
    expect(result.seen).toEqual([]);
  }
});

test("a launcher thread missing turn identity preserves its requested effort then fails ownership validation", async () => {
  const config = defaultConfig("browser-only");
  config.browserHost = "launcher";
  config.browserHostDescriptorPath = join(getConfigDir(), "missing-turn-account.json");
  let worker: ChatGptBrowserWorker | undefined;
  let originalRun: ChatGptBrowserWorker["run"] | undefined;
  let workerCalls = 0;
  const routed: Array<string | undefined> = [];
  const result = send({ thread_id: header.thread_id }, undefined, false, {
    model: "chatgpt-web/pro", config,
    adapter: provider => {
      worker = ChatGptBrowserWorker.forProvider(provider);
      originalRun = worker.run;
      worker.run = async () => { workerCalls++; throw new Error("A missing native turn must not start a browser"); };
      const adapter = createChatGptWebAdapter(provider);
      return { ...adapter, async runTurn(parsed, incoming, emit) {
        routed.push(parsed.options.reasoning);
        await adapter.runTurn!(parsed, incoming, emit);
      } };
    },
  });
  try {
    const response = await result.response;
    expect(routed).toEqual(["max"]);
    const body = await response.json() as { status: string; error?: { message?: string } };
    expect(body.status).toBe("failed");
    expect(body.error?.message).toContain("requires native Codex turn_id metadata");
    expect(workerCalls).toBe(0);
    expect(result.bound).toEqual([]);
  } finally {
    if (worker && originalRun) worker.run = originalRun;
    chatGptTurnSessions.clear();
  }
});

test("HTTP identity registration permits identical callbacks but rejects a changed native owner", async () => {
  const turns = new HttpTurnCounter();
  const identity = { threadId: header.thread_id, turnId: header.turn_id };
  await expect(turns.track(async (_signal, bind) => {
    bind(identity);
    bind(identity);
    bind({ ...identity, turnId: "01a06c66-0000-7ae1-9108-69b5f70e0673" });
    return new Response("A changed owner must not be accepted");
  })).rejects.toThrow("cannot change its native Codex turn identity");
  expect(turns.count()).toBe(0);
});
