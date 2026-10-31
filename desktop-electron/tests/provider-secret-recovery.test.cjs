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

test("provider partial credential merges reject an unreadable key cycle before changing saved envelopes", async t => {
  const endpoint = { protocol: "http", host: "proxy.example.test", port: 8080 };
  const profile = { id: "fixture", name: "Fixture", endpoint };
  const account = { id: "fixture-account", providerId: "fixture-provider", label: "Fixture", auth: "api_key", status: "connected" };
  const secret = { apiKey: "fixture-key", refreshToken: "fixture-refresh", cpaAuthName: "fixture.json" };
  const cases = [
    { name: "partial proxy login", seed: store => store.saveProxyProfile({ ...profile, username: "fixture", password: "fixture-password" }),
      change: store => store.saveProxyProfile({ ...profile, name: "Renamed", username: "updated-user" }),
      read: store => store.proxySecret(profile.id), expected: before => ({ ...before, username: "updated-user" }) },
    { name: "partial account credential", seed: store => store.saveAccount({ ...account, secret }),
      change: store => store.saveAccount({ ...account, secret: { apiKey: "updated-key" } }),
      read: store => store.accountSecret(account.id), expected: before => ({ ...before, apiKey: "updated-key" }) },
    { name: "account session binding", seed: store => store.saveAccount({ ...account, secret }),
      change: store => store.mergeAccountSecret(account.id, { cpaAuthName: "updated.json" }),
      read: store => store.accountSecret(account.id), expected: before => ({ ...before, cpaAuthName: "updated.json" }) },
  ];
  for (const entry of cases) await t.test(entry.name, t => {
    const f = fixture(t, "provider"), first = f.open();
    entry.seed(first);
    const expected = entry.read(first), state = fs.readFileSync(f.statePath), backup = fs.readFileSync(`${f.statePath}.bak`), key = fs.readFileSync(f.keyPath);
    const reopened = f.open(), readFile = fs.readFileSync, failures = new Set([f.keyPath, `${f.keyPath}.bak`]);
    fs.readFileSync = function (file, ...args) {
      if (failures.delete(String(file))) throw Object.assign(new Error("fixture key read unavailable"), { code: "EIO" });
      return readFile.call(this, file, ...args);
    };
    try {
      assert.throws(() => entry.change(reopened), /credential|key/i);
      assert.doesNotThrow(() => reopened.snapshot());
    } finally { fs.readFileSync = readFile; }
    assert.equal(failures.size, 0, "both copies failed in one read cycle");
    assert.ok(fs.readFileSync(f.keyPath).equals(key));
    assert.ok(fs.readFileSync(f.statePath).equals(state), "a failed merge cannot replace original state or envelopes");
    assert.ok(fs.readFileSync(`${f.statePath}.bak`).equals(backup));
    assert.ok(JSON.stringify(entry.read(reopened)) === JSON.stringify(expected), "normal reads recover every original credential field");
    entry.change(reopened);
    assert.ok(JSON.stringify(entry.read(f.open())) === JSON.stringify(entry.expected(expected)), "retry preserves fields outside the requested change");
  });
});

test("authoritative credential replacements and explicit clears do not need the previous plaintext", async t => {
  const profile = { id: "fixture", name: "Fixture", endpoint: { protocol: "http", host: "proxy.example.test", port: 8080 }, sourceKey: "fixture-source" };
  const cases = [
    { name: "source proxy replacement", seed: store => store.syncSourceProfiles("nova", [{ ...profile, username: "fixture", password: "fixture-password" }]),
      change: store => store.syncSourceProfiles("nova", [{ ...profile, username: "updated-user", password: "updated-password" }]),
      read: store => store.proxySecret(profile.id), expected: { username: "updated-user", password: "updated-password" } },
    { name: "Decodo password clear", seed: store => store.saveDecodoSettings({ username: "fixture", password: "fixture-password" }),
      change: store => store.saveDecodoSettings({ username: "updated-user", password: "" }),
      read: store => ({ password: store.decodoSettings().password }), expected: { password: "" } },
  ];
  for (const entry of cases) await t.test(entry.name, t => {
    const f = fixture(t, "provider"), first = f.open();
    entry.seed(first);
    const key = fs.readFileSync(f.keyPath), reopened = f.open(), readFile = fs.readFileSync, failures = new Set([f.keyPath, `${f.keyPath}.bak`]);
    fs.readFileSync = function (file, ...args) {
      if (failures.delete(String(file))) throw Object.assign(new Error("fixture key read unavailable"), { code: "EIO" });
      return readFile.call(this, file, ...args);
    };
    try { assert.doesNotThrow(() => entry.change(reopened)); }
    finally { fs.readFileSync = readFile; }
    assert.ok(fs.readFileSync(f.keyPath).equals(key));
    assert.ok(JSON.stringify(entry.read(f.open())) === JSON.stringify(entry.expected));
  });
});

test("provider metadata-only edits preserve credentials without reading the fallback key", t => {
  const f = fixture(t, "provider"), first = f.open();
  const profile = { id: "fixture", name: "Fixture", endpoint: { protocol: "http", host: "proxy.example.test", port: 8080 } };
  const account = { id: "fixture-account", providerId: "fixture-provider", label: "Fixture", auth: "api_key", status: "connected" };
  first.saveProxyProfile({ ...profile, username: "fixture", password: "fixture-password" });
  first.saveAccount({ ...account, secret: { apiKey: "fixture-key" } });
  first.saveDecodoSettings({ username: "fixture", password: "fixture-password" });
  const saved = JSON.parse(fs.readFileSync(f.statePath, "utf8")).secrets, reopened = f.open(), readFile = fs.readFileSync;
  let keyReads = 0;
  fs.readFileSync = function (file, ...args) {
    if ([f.keyPath, `${f.keyPath}.bak`].includes(String(file))) {
      keyReads += 1;
      throw Object.assign(new Error("fixture key read unavailable"), { code: "EIO" });
    }
    return readFile.call(this, file, ...args);
  };
  try {
    assert.doesNotThrow(() => reopened.saveProxyProfile({ ...profile, name: "Renamed" }));
    assert.doesNotThrow(() => reopened.saveAccount({ ...account, label: "Renamed" }));
    assert.doesNotThrow(() => reopened.saveDecodoSettings({ username: "renamed-user" }));
  } finally { fs.readFileSync = readFile; }
  assert.equal(keyReads, 0);
  assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(f.statePath, "utf8")).secrets) === JSON.stringify(saved));
  assert.ok(reopened.accountSecret(account.id).apiKey === "fixture-key");
  assert.ok(reopened.proxySecret(profile.id).password === "fixture-password");
  assert.ok(reopened.decodoSettings().password === "fixture-password");
});

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
