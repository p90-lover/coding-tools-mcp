"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createProviderNetworkStore } = require("../electron/provider-network.cjs");
const { createManagedComponentController } = require("../electron/managed-components.cjs");

function fixture(t, kind) {
  const scratch = path.resolve(__dirname, "../../aiTemp/tmp");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "secret-recovery-"));
  const controllers = [];
  t.after(async () => {
    for (const controller of controllers) controller.dispose();
    await new Promise(setImmediate);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const keyPath = path.join(root, kind === "provider" ? "provider-network.key" : "managed-components.key");
  const statePath = path.join(root, kind === "provider" ? "provider-network.json" : "managed-components.secrets.json");
  const open = () => {
    if (kind === "provider") return createProviderNetworkStore({ filePath: statePath, keyPath, safeStorage: null });
    const controller = createManagedComponentController({ dataRoot: root, safeStorage: null, env: {}, resolveRuntimeExecutable: () => process.execPath });
    controllers.push(controller);
    return controller;
  };
  const save = store => kind === "provider"
    ? store.saveProxyProfile({ id: "fixture", name: "Fixture", endpoint: { protocol: "http", host: "proxy.example.test", port: 8080 }, username: "fixture", password: "fixture" })
    : store.runtimeSecrets("cpa");
  const read = store => kind === "provider" ? store.proxySecret("fixture") : store.runtimeSecrets("cpa");
  return { root, keyPath, statePath, open, save, read };
}

for (const kind of ["provider", "managed"]) {
  if (kind === "managed") test(`${kind} legacy credentials without a container version survive a read and save roundtrip`, t => {
    const f = fixture(t, kind), first = f.open();
    f.save(first);
    const expected = f.read(first), legacy = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
    delete legacy.version;
    fs.writeFileSync(f.statePath, JSON.stringify(legacy));
    fs.rmSync(`${f.statePath}.bak`, { force: true });
    const reopened = f.open();
    assert.ok(JSON.stringify(f.read(reopened)) === JSON.stringify(expected));
    reopened.setComponentCredential("cpa", "managementKey", expected.managementKey);
    assert.equal(JSON.parse(fs.readFileSync(f.statePath, "utf8")).version, 1);
    assert.ok(JSON.stringify(f.read(f.open())) === JSON.stringify(expected));
  });

  test(`${kind} future credential container is preserved and cannot be overwritten`, t => {
    const f = fixture(t, kind), first = f.open();
    f.save(first);
    const future = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
    future.version = 999;
    fs.writeFileSync(f.statePath, JSON.stringify(future));
    fs.rmSync(`${f.statePath}.bak`, { force: true });
    const reopened = f.open();
    assert.throws(() => f.save(reopened), /settings|credential|key/i);
    assert.equal(JSON.parse(fs.readFileSync(f.statePath, "utf8")).version, 999);
  });

  test(`${kind} fallback key survives a transient read and recovers without rotating credentials`, t => {
    const f = fixture(t, kind), first = f.open();
    f.save(first);
    const expected = f.read(first), key = fs.readFileSync(f.keyPath), state = fs.readFileSync(f.statePath);
    const reopened = f.open(), readFile = fs.readFileSync;
    let injected = false;
    fs.readFileSync = function (file, ...args) {
      if (!injected && String(file) === f.keyPath) {
        injected = true;
        throw Object.assign(new Error("fixture disk read unavailable"), { code: "EIO" });
      }
      return readFile.call(this, file, ...args);
    };
    try { try { f.read(reopened); } catch {} } finally { fs.readFileSync = readFile; }
    assert.ok(injected);
    assert.ok(fs.readFileSync(f.keyPath).equals(key), "a read cannot replace the encryption key");
    assert.ok(fs.readFileSync(f.statePath).equals(state), "a failed read cannot rotate CPA or proxy credentials");
    assert.ok(JSON.stringify(f.read(reopened)) === JSON.stringify(expected), "the same instance recovers when reads work again");
  });

  test(`${kind} missing or damaged fallback key refuses writes while preserving existing envelopes`, async t => {
    for (const damage of ["missing", "invalid"]) await t.test(damage, t => {
      const f = fixture(t, kind), first = f.open();
      f.save(first);
      const expected = f.read(first), key = fs.readFileSync(f.keyPath), state = fs.readFileSync(f.statePath);
      fs.rmSync(`${f.keyPath}.bak`, { force: true });
      if (damage === "missing") fs.rmSync(f.keyPath);
      else fs.writeFileSync(f.keyPath, "torn");
      const reopened = f.open();
      if (kind === "managed") {
        assert.doesNotThrow(() => reopened.snapshot(), "status remains available when a credential is not");
        assert.match(reopened.project("cpa").error, /credential|key/i);
        assert.throws(() => f.read(reopened), /credential|key/i);
      } else assert.equal(f.read(reopened), null);
      assert.throws(() => f.save(reopened), /credential|key/i);
      assert.ok(fs.readFileSync(f.statePath).equals(state));
      if (damage === "missing") assert.equal(fs.existsSync(f.keyPath), false, "no replacement key is created");
      else assert.equal(fs.readFileSync(f.keyPath, "utf8"), "torn", "unreadable bytes stay in place for recovery");
      fs.writeFileSync(f.keyPath, key);
      assert.ok(JSON.stringify(f.read(reopened)) === JSON.stringify(expected));
    });
  });

  test(`${kind} failed first fallback-key save is retried before its key is cached`, t => {
    const f = fixture(t, kind), store = f.open(), rename = fs.renameSync;
    let injected = false;
    fs.renameSync = function (source, destination) {
      if (!injected && String(destination) === f.keyPath) {
        injected = true;
        throw Object.assign(new Error("fixture key write failed"), { code: "EIO" });
      }
      return rename.call(this, source, destination);
    };
    try { assert.throws(() => f.save(store), /fixture key write failed/); }
    finally { fs.renameSync = rename; }
    assert.ok(injected);
    f.save(store);
    assert.ok(fs.existsSync(f.keyPath));
    assert.ok(JSON.stringify(f.read(f.open())) === JSON.stringify(f.read(store)), "persisted envelopes use the successfully saved key");
  });
}

test("managed secrets-container read failure never replaces existing CPA credentials", t => {
  const f = fixture(t, "managed"), first = f.open();
  f.save(first);
  const expected = f.read(first), state = fs.readFileSync(f.statePath), readFile = fs.readFileSync;
  fs.rmSync(`${f.statePath}.bak`, { force: true });
  let injected = false, reopened;
  fs.readFileSync = function (file, ...args) {
    if (!injected && String(file) === f.statePath) {
      injected = true;
      throw Object.assign(new Error("fixture secrets read unavailable"), { code: "EIO" });
    }
    return readFile.call(this, file, ...args);
  };
  try { reopened = f.open(); } finally { fs.readFileSync = readFile; }
  assert.ok(JSON.stringify(f.read(reopened)) === JSON.stringify(expected));
  assert.ok(fs.readFileSync(f.statePath).equals(state));
  fs.writeFileSync(f.statePath, "torn");
  fs.rmSync(`${f.statePath}.bak`, { force: true });
  const damaged = f.open();
  assert.doesNotThrow(() => damaged.snapshot());
  assert.match(damaged.project("cpa").error, /credential/i);
  assert.throws(() => f.read(damaged), /credential/i);
  assert.equal(fs.readFileSync(f.statePath, "utf8"), "torn");
});

test("managed unreadable secrets remain guarded when a retry temporarily reports missing", t => {
  const f = fixture(t, "managed"), first = f.open();
  f.save(first);
  const expected = f.read(first), state = fs.readFileSync(f.statePath), readFile = fs.readFileSync;
  fs.rmSync(`${f.statePath}.bak`, { force: true });
  let reads = 0, reopened;
  fs.readFileSync = function (file, ...args) {
    if (String(file) === f.statePath) {
      throw Object.assign(new Error("fixture secrets lookup unavailable"), { code: ++reads === 1 ? "EIO" : "ENOENT" });
    }
    return readFile.call(this, file, ...args);
  };
  try {
    reopened = f.open();
    assert.throws(() => f.read(reopened), /credential/i);
  } finally { fs.readFileSync = readFile; }
  assert.ok(fs.readFileSync(f.statePath).equals(state));
  assert.ok(JSON.stringify(f.read(reopened)) === JSON.stringify(expected));
});

test("provider settings read failure preserves every envelope until recovery and retry", t => {
  const f = fixture(t, "provider"), first = f.open();
  f.save(first);
  first.saveDecodoSettings({ username: "fixture", password: "fixture" });
  const expected = f.read(first), state = fs.readFileSync(f.statePath), readFile = fs.readFileSync;
  fs.rmSync(`${f.statePath}.bak`, { force: true });
  let injected = false, reopened;
  fs.readFileSync = function (file, ...args) {
    if (!injected && String(file) === f.statePath) {
      injected = true;
      throw Object.assign(new Error("fixture provider settings read unavailable"), { code: "EIO" });
    }
    return readFile.call(this, file, ...args);
  };
  try { reopened = f.open(); } finally { fs.readFileSync = readFile; }
  const newProfile = { id: "new", name: "New route", endpoint: { protocol: "http", host: "proxy.example.test", port: 8081 } };
  assert.throws(() => reopened.saveProxyProfile(newProfile), /settings|retry/i);
  assert.ok(fs.readFileSync(f.statePath).equals(state), "no original profile or envelope was replaced");
  assert.ok(JSON.stringify(f.read(reopened)) === JSON.stringify(expected));
  assert.equal(reopened.decodoSettings().password, "fixture");
  reopened.saveProxyProfile(newProfile);
  assert.equal(reopened.snapshot().proxyProfiles.length, 2, "retry applies to the recovered store");
  fs.writeFileSync(f.statePath, "torn");
  fs.rmSync(`${f.statePath}.bak`, { force: true });
  const damaged = f.open();
  assert.doesNotThrow(() => damaged.snapshot());
  assert.throws(() => damaged.saveProxyProfile(newProfile), /settings/i);
  assert.equal(fs.readFileSync(f.statePath, "utf8"), "torn");
});
