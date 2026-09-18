"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createManagedExternalServicesController,
} = require("../../desktop-electron/electron/managed-external-services.cjs");

const runId = String(process.env.GITHUB_RUN_ID || process.pid);
const root = path.resolve(__dirname, "live-smoke", runId);
const evidenceRoot = path.resolve(__dirname, "evidence");
const dataRoot = path.join(root, "managed-data");
const diagnostics = [];
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });

function redact(value) {
  return String(value || "")
    .replace(/(?:Bearer\s+)?[A-Za-z0-9+/_=-]{32,}/gu, "[REDACTED]")
    .slice(-4_000);
}

function record(level, event, detail) {
  const entry = {
    level,
    event: String(event || ""),
    detail: redact(typeof detail === "string" ? detail : JSON.stringify(detail || {})),
  };
  diagnostics.push(entry);
  if (diagnostics.length > 200) diagnostics.shift();
  if (entry.event.includes("cpa")) {
    process.stderr.write(`[${entry.level}] ${entry.event} ${entry.detail}\n`);
  }
}

function collectRuntimeLogs() {
  const values = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      } else if (entry.isFile() && /\.log$/iu.test(entry.name)) {
        values.push({
          path: path.relative(root, target).replaceAll("\\", "/"),
          tail: redact(fs.readFileSync(target, "utf8")),
        });
      }
    }
  };
  visit(root);
  return values.slice(-20);
}

const controller = createManagedExternalServicesController({
  dataRoot,
  filePath: path.join(root, "external-services.json"),
  keyPath: path.join(root, "external-services.key"),
  safeStorage: { isEncryptionAvailable: () => false },
  env: { ...process.env },
  resolveRuntimeExecutable: () => process.execPath,
  logger: {
    debug: (event, detail) => record("debug", event, detail),
    info: (event, detail) => record("info", event, detail),
    warn: (event, detail) => record("warn", event, detail),
    error: (event, detail) => record("error", event, detail),
  },
});

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForReady(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await controller.inspect("cpa");
    if (latest.status === "ready") return latest;
    await sleep(500);
  }
  const failure = {
    schemaVersion: 1,
    sourceSha: process.env.GITHUB_SHA || null,
    latest,
    diagnostics,
    runtimeLogs: collectRuntimeLogs(),
  };
  fs.writeFileSync(
    path.join(evidenceRoot, "live-smoke-failure.json"),
    `${JSON.stringify(failure, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  throw new Error(`Managed CPA did not become ready: ${latest?.error || latest?.status || "unknown"}`);
}

async function main() {
  let installed = false;
  try {
    const service = await controller.installManagedComponent("cpa");
    installed = true;
    assert.equal(service.id, "cpa");
    assert.equal(service.managedInstall.state, "installed");
    assert.equal(service.managedInstall.version, "7.3.7");

    const ready = await waitForReady();
    assert.equal(ready.status, "ready");
    assert.equal(ready.owned, true);
    assert.ok(Number.isInteger(ready.pid) && ready.pid > 0);

    const connection = controller.cpaConnection();
    assert.ok(connection);
    assert.equal(connection.baseUrl, "http://127.0.0.1:8317");
    assert.ok(connection.managementKey.length >= 32);
    assert.ok(connection.proxyApiKey.length >= 32);
    assert.notEqual(connection.managementKey, connection.proxyApiKey);

    const modelsResponse = await fetch(new URL("/v1/models", `${connection.baseUrl}/`), {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${connection.proxyApiKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(modelsResponse.status, 200);
    const body = await modelsResponse.json();
    assert.ok(body && typeof body === "object");

    const snapshot = controller.snapshot();
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(connection.managementKey), false);
    assert.equal(serialized.includes(connection.proxyApiKey), false);

    const evidence = {
      schemaVersion: 1,
      sourceSha: process.env.GITHUB_SHA || null,
      component: "cpa",
      version: service.managedInstall.version,
      endpoint: ready.endpoint,
      status: ready.status,
      owned: ready.owned,
      pidObserved: true,
      modelsStatus: modelsResponse.status,
      managementCredentialPresent: true,
      proxyCredentialPresent: true,
      snapshotSecretFree: true,
      noDeletePolicy: true,
    };
    fs.writeFileSync(
      path.join(evidenceRoot, "live-smoke.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    process.stdout.write("RC9_MANAGED_CPA_LIVE_SMOKE_OK\n");
  } finally {
    if (installed) {
      try { await controller.stop("cpa"); } catch {}
    }
    controller.dispose();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
