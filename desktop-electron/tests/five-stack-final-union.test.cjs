"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

function sourceBetween(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(first, -1, `missing start anchor: ${start}`);
  assert.notEqual(last, -1, `missing end anchor: ${end}`);
  return source.slice(first, last);
}

test("the five-stack registry explicitly identifies Codex Router, CPA, CommandCode, Paseo, and Anneal", () => {
  const stack = JSON.parse(read("vendor/upstream/five-stack.json"));
  assert.deepEqual(
    stack.integrations.map((entry) => entry.id),
    ["codex-router", "cpa-provider-hub", "commandcode-proxy", "paseo", "anneal"],
  );
  const cpa = stack.integrations.find((entry) => entry.id === "cpa-provider-hub");
  assert.match(`${cpa?.name ?? ""} ${cpa?.healthContract ?? ""}`, /CPA|CLIProxyAPI/i);
});

test("browser-backed Codex accounts use the live BrowserHost and fail closed when login is incomplete", () => {
  const bootstrap = read("electron/provider-bootstrap.cjs");
  const main = read("electron/main.cjs");

  assert.match(bootstrap, /setProviderBrowserHostResolver/);
  assert.doesNotMatch(bootstrap, /getBrowserHost:\s*\(\)\s*=>\s*null/);
  assert.match(bootstrap, /syncBrowserProviderAccount/);
  assert.match(bootstrap, /Browser provider login is unavailable/);
  assert.match(bootstrap, /authenticated\s*!==\s*true/);
  assert.match(main, /setProviderBrowserHostResolver\(\(\)\s*=>\s*browserHost\)/);
});

test("provider account secrets never become Paseo or Anneal control-plane credentials", () => {
  const main = read("electron/main.cjs");
  const handler = sourceBetween(
    main,
    'handle("coding-tools:execution:provider"',
    'handle("coding-tools:execution:update"',
  );

  assert.doesNotMatch(handler, /accountSecret\s*\(/);
  assert.doesNotMatch(handler, /storedProviderCredential/);
  assert.match(handler, /credential:\s*input\.controlCredential\s*\?\?\s*""/);
});

test("execution IPC accepts a separate bounded control-plane credential", async () => {
  const { invokeContract } = require("../electron/ipc-schema.cjs");
  let received = null;
  const ipcRenderer = {
    async invoke(channel, payload) {
      assert.equal(channel, "coding-tools:execution:provider");
      received = payload;
      return {};
    },
  };
  const input = {
    workspaceId: "workspace-1",
    operation: "configure",
    expectedRevision: 0,
    bindingId: null,
    providerAccountId: "commandcode-main",
    allowProviderFallback: false,
    controlCredential: "orchestrator-control-token",
    settings: {
      id: "paseo-commandcode-main",
      engine: "paseo",
      endpoint: "ws://127.0.0.1:6767/ws",
      provider: "commandcode-proxy",
      model: "model-1",
      mode: "default",
      projectId: null,
      repoId: null,
      assigneeId: null,
      maxDurationMin: 120,
      allowCodex: false,
      confirmExternalExecution: true,
    },
    confirm: true,
  };

  await invokeContract(ipcRenderer, "execution.provider", input);
  assert.equal(received.controlCredential, "orchestrator-control-token");

  await assert.rejects(
    () => invokeContract(ipcRenderer, "execution.provider", {
      ...input,
      controlCredential: "x".repeat(4097),
    }),
    /IPC_REQUEST_SCHEMA_INVALID/,
  );
});

test("Provider Hub keeps provider credentials separate from the Paseo or Anneal control credential", () => {
  const surface = read("src/features/ProviderHubSaasSurface.tsx");
  const contracts = read("src/api/contracts.ts");

  assert.match(surface, /const \[controlCredential, setControlCredential\] = useState\(""\)/);
  assert.match(surface, /controlCredential,/);
  assert.match(surface, /Paseo \/ Anneal control credential/);
  assert.match(surface, /Paseo／Anneal 控制憑證/);
  assert.match(contracts, /readonly controlCredential\?: string/);
});
