"use strict";

// The SSH hosts store (electron/ssh-connections.cjs): what it accepts as a host, the exact ssh
// command lines it builds, how a host key becomes trusted, and that nothing but the app window
// reaches it. No test here starts ssh or touches the network or the real profile: the program
// runner and the clock are injected, and every file lives in a scratch folder.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ssh = require("../electron/ssh-connections.cjs");
const { BACKEND_MODULES } = require("../electron/backend-bundle.cjs");
const { createCodingToolsAppsMcp, PERSON_ONLY_MODULES } = require("../electron/coding-tools-apps-mcp.cjs");
const { invokeContract } = require("../electron/ipc-schema.cjs");
const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");

const electronRoot = path.join(__dirname, "..", "electron");
// SSH_CONNECTIONS_TEST_DIR names another place for the scratch files; by default they sit under the
// repository's aiTemp folder, as the other tests' do.
const scratch = path.join(process.env.SSH_CONNECTIONS_TEST_DIR || path.resolve(__dirname, "../../aiTemp"), `ssh-connections-${process.pid}`);
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const PROGRAM = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
const CLIENT = { version: "OpenSSH_for_Windows_9.5p2", major: 9, minor: 5 };
// Every operation but list changes something: the list, a trusted key, or a live SSH session
// (terminal_open and terminal_close, milestone 2).
const WRITE_OPERATIONS = ["add", "update", "remove", "fetch_key", "confirm_key", "terminal_open", "terminal_close"];

/** A well-formed ssh-ed25519 public key blob (base64), different for each seed. Not a real server's key. */
function keyBlob(seed, type = "ssh-ed25519") {
  const name = Buffer.from(type, "latin1");
  const key = crypto.createHash("sha256").update(`test key ${seed}`).digest();
  const length = (value) => { const size = Buffer.alloc(4); size.writeUInt32BE(value); return size; };
  return Buffer.concat([length(name.length), name, length(key.length), key]).toString("base64");
}

/** The fingerprint worked out here, not by the module under test. */
function fingerprint(blob) {
  return `SHA256:${crypto.createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

function fakeClock(start = Date.UTC(2026, 10, 26, 12, 0, 0)) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; }, iso: () => new Date(at).toISOString() };
}

/** The throwaway known-hosts file a probe command line names. */
function probeFileIn(argv) {
  const option = argv.find((value) => value.startsWith("UserKnownHostsFile="));
  assert.ok(option, "the probe names a known-hosts file");
  const value = option.slice("UserKnownHostsFile=".length);
  assert.match(value, /^"[^"]+"$/, "the path sits in double quotes inside the option value");
  return value.slice(1, -1);
}

const DENIED = { code: 255, stdout: "", stderr: "deploy@example.com: Permission denied (publickey,password).\r\n" };

/**
 * A stand-in for ssh. `-V` answers as the 9.5p2 client does; each probe takes the next step of the
 * script: `write` is what the server "presented" (left in the throwaway file), `result` what ssh
 * returned, or a function for anything else.
 */
function fakeSsh(script = []) {
  const calls = [];
  const steps = [...script];
  async function run(executable, argv, options) {
    calls.push({ executable, argv: [...argv], options });
    if (argv.length === 1 && argv[0] === "-V") return { code: 0, stdout: "", stderr: "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2\r\n" };
    const step = steps.shift();
    if (!step) throw new Error("the test's ssh has no answer left");
    const target = probeFileIn(argv);
    if (typeof step === "function") return step({ argv, target, options });
    if (step.write !== undefined) fs.writeFileSync(target, step.write);
    return step.result ?? DENIED;
  }
  return { run, calls, answer: (...more) => steps.push(...more), probes: () => calls.filter((call) => call.argv[0] !== "-V") };
}

/** A probe that waits: `started` resolves once ssh was started, `finish()` lets it leave `line` and exit. */
function heldProbe(line) {
  let begin;
  let end;
  const started = new Promise((resolve) => { begin = resolve; });
  const held = new Promise((resolve) => { end = resolve; });
  const step = async ({ target }) => {
    begin();
    await held;
    fs.writeFileSync(target, line);
    return DENIED;
  };
  return { step, started, finish: () => end() };
}

let stores = 0;
/** A store on its own scratch folder; the folder's name has a space, as the real profile's does. */
function makeStore({ script = [], root = null, clock = fakeClock(), ...options } = {}) {
  const folder = root ?? path.join(scratch, `store ${++stores}`, "user data", "integrations");
  fs.mkdirSync(folder, { recursive: true });
  const fake = fakeSsh(script);
  const logs = [];
  const logger = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (...args) => logs.push([level, ...args])]));
  const files = {
    file: path.join(folder, "ssh-hosts.json"),
    knownHostsFile: path.join(folder, "ssh-known-hosts"),
    probeDir: path.join(folder, "ssh-probe"),
  };
  const store = ssh.createSshConnections({
    ...files, run: fake.run, now: clock.now, logger, fileExists: async () => true, program: PROGRAM,
    // No flush to disk per save here: these tests make a few hundred saves on a slow shared disk.
    environment: () => ({ SystemRoot: "C:\\Windows" }), durable: false, ...options,
  });
  return { store, fake, logs, clock, root: folder, ...files };
}

const HOST = { label: "Build server", host: "example.com", port: 22, user: "deploy" };
const serverShows = (blob, name = "example.com", type = "ssh-ed25519") => ({ write: `${name} ${type} ${blob}\n` });
const pinnedLines = (file) => fs.readFileSync(file, "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
const readStore = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Adds a host, fetches `blob` as its key and confirms it. */
async function pinnedHost(context, blob, fields = HOST) {
  const added = await context.store.add(fields);
  assert.equal(added.ok, true, added.error);
  context.fake.answer(serverShows(blob, ssh.knownHostsName(added.host.host, added.host.port)));
  const fetched = await context.store.fetchKey({ id: added.host.id });
  assert.equal(fetched.ok, true, fetched.error);
  const confirmed = await context.store.confirmKey({ id: added.host.id, fingerprint: fetched.host.candidate.fingerprint });
  assert.equal(confirmed.ok, true, confirmed.error);
  return confirmed.host;
}

// ---------------------------------------------------------------------------------------------
// Validation

test("hosts: a host name or an IP address is accepted and stored lower-case", () => {
  for (const [input, stored] of [
    ["example.com", "example.com"],
    ["EXAMPLE.Com", "example.com"],
    ["a", "a"],
    ["srv-01.internal", "srv-01.internal"],
    ["a-b.c-d.example", "a-b.c-d.example"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["3com.example", "3com.example"],
    ["192.0.2.10", "192.0.2.10"],
    ["2001:db8::1", "2001:db8::1"],
    ["2001:DB8::A", "2001:db8::a"],
    ["::1", "::1"],
    // In the short form ssh writes before it looks up or saves a key (ssh -G on the target machine).
    ["2001:0db8::1", "2001:db8::1"],
    ["2001:db8:0:0:0:0:0:1", "2001:db8::1"],
    ["2001:db8::0:1", "2001:db8::1"],
    ["::0001", "::1"],
    ["2001:DB8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    ["2001:0:0:1:0:0:0:1", "2001:0:0:1::1"],
    ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
    ["64:ff9b::c000:201", "64:ff9b::c000:201"],
    ["::ffff", "::ffff"],
    [`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`, `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`],
  ]) {
    assert.deepEqual(ssh.validateHost(input), { ok: true, value: stored }, input);
  }
});

test("hosts: everything else is refused, and the error says what is wrong with the host", () => {
  const accented = `ex${String.fromCharCode(0xe4)}mple.com`;
  const rejected = [
    ["", /enter a host name or an IP address/],
    [undefined, /enter a host name or an IP address/],
    [42, /enter a host name or an IP address/],
    [["example.com"], /enter a host name or an IP address/],
    ["ssh://example.com", /not an ssh:\/\/ address/],
    ["ssh://deploy@example.com:2222", /not an ssh:\/\/ address/],
    ["deploy@example.com", /The user has its own field/],
    ["deploy@example.com:2222", /The user has its own field/],
    ["example.com:2222", /The port has its own field/],
    ["-oProxyCommand=calc.exe", /cannot start with a hyphen/],
    ["-example.com", /cannot start with a hyphen/],
    ["example .com", /spaces, tabs or line breaks/],
    [" example.com", /spaces, tabs or line breaks/],
    ["example.com ", /spaces, tabs or line breaks/],
    ["example.com\n", /spaces, tabs or line breaks/],
    ["exa\tmple.com", /spaces, tabs or line breaks/],
    ["example.com\x00", /spaces, tabs or line breaks/],
    [`example.com${String.fromCharCode(0xa0)}`, /spaces, tabs or line breaks/],
    [accented, /plain ASCII letters and digits/],
    ["under_score.example.com", /"_" is not allowed in a host name/],
    ["exa\"mple.com", /A double quote is not allowed/],
    ["exa'mple.com", /A single quote is not allowed/],
    ["exa`id`.com", /A backtick is not allowed/],
    [".example.com", /starts and ends with a letter or a digit/],
    ["example.com.", /starts and ends with a letter or a digit/],
    ["example-", /starts and ends with a letter or a digit/],
    ["a..b", /two dots in a row/],
    [`${"a".repeat(64)}.com`, /at most 63 characters/],
    ["a".repeat(254), /at most 253 characters/],
    ["[2001:db8::1]", /without square brackets/],
    ["[2001:db8::1]:2222", /without square brackets/],
    ["fe80::1%eth0", /zone .* is not supported/],
    ["2001:db8::zz", /not a valid IPv6 address/],
    ["::ffff:192.0.2.1", /not a valid IPv6 address/],
    // ssh writes these with an IPv4 address inside ("::ffff:192.0.2.1"): no hex-only name matches its key.
    ["::ffff:c000:201", /has an IPv4 address inside it/],
    ["0:0:0:0:0:ffff:c000:201", /has an IPv4 address inside it/],
    ["::c000:201", /has an IPv4 address inside it/],
    ["::1:0", /has an IPv4 address inside it/],
    ["::ffff:0:c000:201", /has an IPv4 address inside it/],
    ["fe80::5efe:c000:201", /has an IPv4 address inside it/],
    ["fe80::200:5efe:c000:201", /has an IPv4 address inside it/],
    ["1:2:3", /not a valid IPv6 address/],
    [":::", /not a valid IPv6 address/],
    ["192.168.1", /looks like an IP address but is not a valid one/],
    ["256.1.1.1", /looks like an IP address but is not a valid one/],
    ["1.2.3.4.5", /looks like an IP address but is not a valid one/],
    ["010.1.1.1", /looks like an IP address but is not a valid one/],
    ["127.1", /looks like an IP address but is not a valid one/],
    ["2130706433", /looks like an IP address but is not a valid one/],
    ["0x7f000001", /looks like an IP address but is not a valid one/],
    ["0x7f.1", /looks like an IP address but is not a valid one/],
    ["host.123", /looks like an IP address but is not a valid one/],
  ];
  // Each character the contract names is refused wherever it sits.
  for (const character of "%$\\;&<>|(){}`@/,\"'") rejected.push([`exa${character}mple.com`, /^Host: /]);
  for (const [input, reason] of rejected) {
    const result = ssh.validateHost(input);
    assert.equal(result.ok, false, `${JSON.stringify(input)} must be refused`);
    assert.match(result.error, /^Host: /, JSON.stringify(input));
    assert.match(result.error, reason, JSON.stringify(input));
  }
});

test("users: accepted and refused names, each refusal naming the field and the rule", () => {
  for (const user of ["deploy", "root", "_svc", "a.b-c_d", "user1", "9lives", "Admin", "a".repeat(32)]) {
    assert.deepEqual(ssh.validateUser(user), { ok: true, value: user }, user);
  }
  for (const [input, reason] of [
    ["", /enter the user name you sign in with/],
    [undefined, /enter the user name you sign in with/],
    [7, /enter the user name you sign in with/],
    ["a".repeat(33), /at most 32 characters/],
    // The client on the target machine accepts a user name with a space; the app does not.
    ["de ploy", /cannot contain spaces, tabs or line breaks/],
    ["deploy\n", /cannot contain spaces, tabs or line breaks/],
    ["deploy@example.com", /without @ and the host/],
    ["DOMAIN\\pat", /Windows domain logins/],
    ["-oProxyCommand=calc.exe", /cannot start with a hyphen/],
    ["deploy;id", /letters, digits, dots, underscores and hyphens only/],
    [".hidden", /starting with a letter, a digit or an underscore/],
    ["a$b", /letters, digits, dots, underscores and hyphens only/],
    ["a/b", /letters, digits, dots, underscores and hyphens only/],
    [`d${String.fromCharCode(0xe9)}ploy`, /letters, digits, dots, underscores and hyphens only/],
  ]) {
    const result = ssh.validateUser(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.match(result.error, /^User: /, JSON.stringify(input));
    assert.match(result.error, reason, JSON.stringify(input));
  }
});

test("ports: digits only from 1 to 65535, and nothing given means 22", () => {
  for (const [input, port] of [[undefined, 22], [null, 22], ["", 22], [22, 22], ["22", 22], ["2222", 2222], [1, 1], ["65535", 65535], [65535, 65535]]) {
    assert.deepEqual(ssh.validatePort(input), { ok: true, value: port }, JSON.stringify(input));
  }
  for (const [input, reason] of [
    [0, /from 1 to 65535/], ["0", /from 1 to 65535/], [65536, /from 1 to 65535/], ["65536", /from 1 to 65535/], ["99999", /from 1 to 65535/],
    [-1, /digits only/], ["22 ", /digits only/], [" 22", /digits only/], ["+22", /digits only/], ["0x16", /digits only/],
    [22.5, /digits only/], ["22.0", /digits only/], ["ssh", /digits only/], ["22;id", /digits only/], ["123456", /digits only/],
    [true, /digits only/], [[22], /digits only/], [{}, /digits only/], [Number.NaN, /digits only/], [Infinity, /digits only/],
    [String.fromCharCode(0xff12, 0xff12), /digits only/],
  ]) {
    const result = ssh.validatePort(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.match(result.error, /^Port: /, JSON.stringify(input));
    assert.match(result.error, reason, JSON.stringify(input));
  }
});

test("identity files: an absolute path only, with no quotes, control characters or ssh expansions", () => {
  for (const [input, platform, stored] of [
    [undefined, "win32", null], [null, "win32", null], ["", "linux", null],
    ["C:\\Keys\\id_ed25519", "win32", "C:\\Keys\\id_ed25519"],
    ["C:\\Key Folder\\id_ed25519", "win32", "C:\\Key Folder\\id_ed25519"],
    ["d:/keys/id_ed25519", "win32", "d:\\keys\\id_ed25519"],
    ["C:\\Keys\\old\\..\\id_ed25519", "win32", "C:\\Keys\\id_ed25519"],
    ["/home/pat/.ssh/id_ed25519", "linux", "/home/pat/.ssh/id_ed25519"],
    ["/Users/pat/keys/../id_rsa", "darwin", "/Users/pat/id_rsa"],
  ]) {
    assert.deepEqual(ssh.validateIdentityFile(input, { platform }), { ok: true, value: stored }, `${platform} ${JSON.stringify(input)}`);
  }
  for (const [input, platform, reason] of [
    [42, "win32", /choose the private key file by its full path/],
    ["id_ed25519", "win32", /starting with a drive letter/],
    ["keys\\id_ed25519", "win32", /starting with a drive letter/],
    ["C:id_ed25519", "win32", /starting with a drive letter/],
    ["~\\.ssh\\id_ed25519", "win32", /starting with a drive letter/],
    ["\\\\server\\share\\id_ed25519", "win32", /starting with a drive letter/],
    ["/home/pat/.ssh/id_ed25519", "win32", /starting with a drive letter/],
    ["keys/id_ed25519", "linux", /starting with \//],
    ["~/.ssh/id_ed25519", "linux", /starting with \//],
    ["C:\\Keys\\id_ed25519", "linux", /starting with \//],
    ["C:\\Keys\\\"id\"", "win32", /cannot contain double quotes/],
    ["C:\\Keys\\id\ned25519", "win32", /line breaks or control characters/],
    ["/home/pat/id\x00", "linux", /line breaks or control characters/],
    ["C:\\Users\\%USERNAME%\\id_ed25519", "win32", /cannot contain % or \$\{/],
    ["/home/${USER}/id_ed25519", "linux", /cannot contain % or \$\{/],
    ["C:\\Keys\\id_ed25519.pub", "win32", /not the \.pub file/],
    // The .pub file once the path is normalised, or once Windows drops trailing dots and spaces.
    ["C:\\Keys\\id_ed25519.pub\\.", "win32", /not the \.pub file/],
    ["C:\\Keys\\id_ed25519.pub\\x\\..", "win32", /not the \.pub file/],
    ["C:\\Keys\\id_ed25519.pub.", "win32", /not the \.pub file/],
    ["C:\\Keys\\id_ed25519.pub ", "win32", /not the \.pub file/],
    ["C:\\Keys\\id_ed25519.pub. .", "win32", /not the \.pub file/],
    ["/home/pat/.ssh/id_ed25519.pub/.", "linux", /not the \.pub file/],
    [`C:\\${"k".repeat(1024)}`, "win32", /too long/],
  ]) {
    const result = ssh.validateIdentityFile(input, { platform });
    assert.equal(result.ok, false, `${platform} ${JSON.stringify(input)}`);
    assert.match(result.error, /^Key file: /, JSON.stringify(input));
    assert.match(result.error, reason, JSON.stringify(input));
  }
});

test("a key file's path is judged as it is kept: what is accepted passes the same check again", async () => {
  for (const [input, platform] of [
    ["C:\\Keys\\id_ed25519", "win32"], ["d:/keys/id_ed25519", "win32"], ["C:\\Keys\\old\\..\\id_ed25519", "win32"],
    ["C:\\Keys\\id_ed25519.pub2", "win32"], ["C:\\Keys\\.\\id_rsa", "win32"], ["/Users/pat/keys/../id_rsa", "darwin"], ["/home/pat/./id", "linux"],
  ]) {
    const kept = ssh.validateIdentityFile(input, { platform });
    assert.equal(kept.ok, true, `${platform} ${JSON.stringify(input)}`);
    assert.deepEqual(ssh.validateIdentityFile(kept.value, { platform }), kept, `${JSON.stringify(input)} is kept as a path that passes again`);
  }
  // A path that turned into the .pub file once kept was accepted, then dropped with its host at the
  // next start and erased by the save after it (review, 2026-11-27).
  const context = makeStore();
  const pub = path.join(context.root, "keys", "id_ed25519.pub");
  for (const identityFile of [`${pub}\\.`, `${pub}\\x\\..`]) {
    const refused = await context.store.add({ ...HOST, identityFile });
    assert.deepEqual([refused.ok, refused.code], [false, "invalid"], identityFile);
    assert.match(refused.error, /^Key file: choose the private key, not the \.pub file/);
  }
  const added = await context.store.add({ ...HOST, identityFile: `${path.join(context.root, "keys", "id_ed25519")}\\.` });
  assert.equal(added.ok, true, added.error);
  await context.store.dispose();
  const restarted = makeStore({ root: context.root });
  assert.deepEqual((await restarted.store.list()).hosts, [added.host], "the host is still there after a restart");
});

test("a new host is three separate fields and takes no extra arguments", () => {
  assert.deepEqual(ssh.validateNewHost({ label: "  Build server ", host: "Example.COM", user: "deploy" }, { platform: "win32" }), {
    ok: true, value: { label: "Build server", host: "example.com", port: 22, user: "deploy", identityFile: null, production: false },
  });
  assert.deepEqual(ssh.validateNewHost({ ...HOST, port: "2222", identityFile: "C:\\Keys\\id_ed25519", production: true }, { platform: "win32" }).value, {
    label: "Build server", host: "example.com", port: 2222, user: "deploy", identityFile: "C:\\Keys\\id_ed25519", production: true,
  });
  for (const [input, reason] of [
    [null, /Enter the host's name, host, port and user/],
    ["deploy@example.com", /Enter the host's name, host, port and user/],
    [{ ...HOST, extraArgs: "-A" }, /take no extra options or arguments/],
    [{ ...HOST, jumpHost: "bastion.example.com" }, /take no extra options or arguments/],
    [{ ...HOST, label: "" }, /^Name: enter a name/],
    [{ ...HOST, label: "x".repeat(61) }, /^Name: use at most 60 characters/],
    [{ ...HOST, label: "two\nlines" }, /^Name: a name cannot contain line breaks/],
    [{ ...HOST, host: "deploy@example.com" }, /^Host: /],
    [{ ...HOST, port: "22;id" }, /^Port: /],
    [{ ...HOST, user: "de ploy" }, /^User: /],
    [{ ...HOST, identityFile: "id_ed25519" }, /^Key file: /],
    [{ ...HOST, production: "yes" }, /^Production: choose on or off/],
  ]) {
    const result = ssh.validateNewHost(input, { platform: "win32" });
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.match(result.error, reason, JSON.stringify(input));
  }
});

// ---------------------------------------------------------------------------------------------
// Command lines

const LOCKED = [
  "-o", "UpdateHostKeys=no",
  "-o", "VerifyHostKeyDNS=no",
  "-o", "ForwardAgent=no",
  "-o", "ForwardX11=no",
  "-o", "ForwardX11Trusted=no",
  "-o", "ClearAllForwardings=yes",
  "-o", "Tunnel=no",
  "-o", "PermitLocalCommand=no",
  "-o", "ProxyCommand=none",
  "-o", "ControlMaster=no",
  "-o", "ControlPath=none",
  "-o", "Compression=no",
  "-o", "IdentityAgent=none",
  "-o", "AddKeysToAgent=no",
];

test("the key probe's command line, with the throwaway file quoted inside its option and -- before the host", () => {
  const argv = ssh.probeArgv({
    host: "example.com", port: 22, user: "deploy", client: CLIENT, platform: "win32",
    knownHostsFile: "G:\\AppData\\Coding Tools\\integrations\\ssh-probe\\p-Ab12Cd\\known_hosts",
  });
  assert.deepEqual(argv, [
    "-F", "none",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "UserKnownHostsFile=\"G:/AppData/Coding Tools/integrations/ssh-probe/p-Ab12Cd/known_hosts\"",
    "-o", "GlobalKnownHostsFile=none",
    ...LOCKED,
    "-o", "BatchMode=yes",
    "-o", "PubkeyAuthentication=no",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "ConnectTimeout=8",
    "-o", "ConnectionAttempts=1",
    "-T", "-n", "-p", "22", "-l", "deploy", "--", "example.com",
  ]);
  assert.equal(argv.at(-2), "--");
  assert.equal(argv.at(-1), "example.com", "nothing follows the host");
});

test("the terminal's command line for a pinned host, with and without a key file", () => {
  const pinned = {
    host: "example.com", port: 2222, user: "deploy", state: "pinned", client: CLIENT, platform: "win32",
    knownHostsFile: "G:\\AppData\\Coding Tools\\integrations\\ssh-known-hosts",
  };
  const interactive = [
    "-o", "EscapeChar=none",
    "-o", "EnableEscapeCommandline=no",
    "-o", "ConnectTimeout=15",
    "-o", "ConnectionAttempts=1",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "BatchMode=no",
  ];
  const head = [
    "-F", "none",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UserKnownHostsFile=\"G:/AppData/Coding Tools/integrations/ssh-known-hosts\"",
    "-o", "GlobalKnownHostsFile=none",
    ...LOCKED,
    ...interactive,
  ];
  assert.deepEqual(ssh.terminalArgv(pinned), [...head, "-t", "-p", "2222", "-l", "deploy", "--", "example.com"]);
  assert.deepEqual(ssh.terminalArgv({ ...pinned, identityFile: "C:\\Key Folder\\id_ed25519" }), [
    ...head,
    "-o", "IdentitiesOnly=yes",
    "-i", "C:\\Key Folder\\id_ed25519",
    "-t", "-p", "2222", "-l", "deploy", "--", "example.com",
  ]);
  const ipv6 = ssh.terminalArgv({ ...pinned, host: "2001:db8::1", port: 22 });
  assert.deepEqual(ipv6.slice(-7), ["-t", "-p", "22", "-l", "deploy", "--", "2001:db8::1"]);
});

test("an older client is not given an option it does not know, and a too old one is not used", () => {
  const fields = { host: "example.com", port: 22, user: "deploy", platform: "win32", knownHostsFile: "G:\\Data\\x" };
  // An unknown -o is fatal ("Bad configuration option"): Windows 10 still ships OpenSSH 8.1.
  const old = ssh.probeArgv({ ...fields, client: { major: 8, minor: 1 } });
  assert.ok(old.includes("ChallengeResponseAuthentication=no"));
  assert.equal(old.includes("KbdInteractiveAuthentication=no"), false);
  assert.ok(ssh.probeArgv({ ...fields, client: { major: 8, minor: 7 } }).includes("KbdInteractiveAuthentication=no"));
  // Before 8.5 the client also checked the address unless told not to: the probe's line would name
  // "host,address", and a terminal would add the address to the pinned file.
  assert.deepEqual(old.slice(0, 10), [
    "-F", "none", "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=\"G:/Data/x\"", "-o", "GlobalKnownHostsFile=none", "-o", "CheckHostIP=no",
  ]);
  assert.ok(ssh.terminalArgv({ ...fields, state: "pinned", client: { major: 8, minor: 4 } }).includes("CheckHostIP=no"));
  for (const client of [{ major: 8, minor: 5 }, CLIENT, null]) {
    assert.equal(ssh.probeArgv({ ...fields, client }).includes("CheckHostIP=no"), false);
    assert.equal(ssh.terminalArgv({ ...fields, state: "pinned", client }).includes("CheckHostIP=no"), false);
  }
  assert.equal(ssh.terminalArgv({ ...fields, state: "pinned", client: { major: 9, minor: 1 } }).includes("EnableEscapeCommandline=no"), false);
  assert.ok(ssh.terminalArgv({ ...fields, state: "pinned", client: { major: 9, minor: 2 } }).includes("EnableEscapeCommandline=no"));
  assert.ok(ssh.terminalArgv({ ...fields, state: "pinned", client: { major: 10, minor: 0 } }).includes("EnableEscapeCommandline=no"));
  assert.throws(() => ssh.probeArgv({ ...fields, client: { major: 7, minor: 5 } }), /OpenSSH is too old/);
  assert.deepEqual(ssh.parseClientVersion("OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2\r\n"), CLIENT);
  assert.deepEqual(ssh.parseClientVersion("OpenSSH_8.9p1 Ubuntu-3ubuntu0.10, OpenSSL 3.0.2 15 Mar 2022"), { version: "OpenSSH_8.9p1", major: 8, minor: 9 });
  assert.equal(ssh.parseClientVersion("'ssh' is not recognized"), null);
});

test("the builders check every value again and never emit one that is not a validated field", () => {
  const good = { host: "example.com", port: 22, user: "deploy", platform: "win32", knownHostsFile: "G:\\Data\\x", client: CLIENT };
  for (const [change, reason] of [
    [{ host: "-oProxyCommand=calc.exe" }, /^SshHostsError: Host: /],
    [{ host: "example.com;id" }, /^SshHostsError: Host: /],
    [{ host: "Example.com" }, /lower-case host name/],
    [{ user: "de ploy" }, /^SshHostsError: User: /],
    [{ user: "-l" }, /^SshHostsError: User: /],
    [{ port: 70000 }, /^SshHostsError: Port: /],
    [{ port: "22 -oProxyCommand=x" }, /^SshHostsError: Port: /],
    [{ knownHostsFile: "G:\\Da\"ta\\x" }, /data folder has a name ssh cannot be given/],
    [{ knownHostsFile: "relative\\x" }, /data folder has a name ssh cannot be given/],
    [{ knownHostsFile: "G:\\${HOME}\\x" }, /data folder has a name ssh cannot be given/],
  ]) {
    assert.throws(() => ssh.probeArgv({ ...good, ...change }), reason, JSON.stringify(change));
    assert.throws(() => ssh.terminalArgv({ ...good, state: "pinned", ...change }), reason, JSON.stringify(change));
  }
  // A terminal is only ever built for a pinned host.
  for (const state of ["draft", "changed", undefined]) {
    assert.throws(() => ssh.terminalArgv({ ...good, state }), /Confirm this host's key before opening a terminal/);
  }
  assert.throws(() => ssh.terminalArgv({ ...good, state: "pinned", identityFile: "id_ed25519" }), /^SshHostsError: Key file: /);
  // A percent sign in the path would be read as a token: it is doubled, so ssh sees the path as it is.
  assert.ok(ssh.probeArgv({ ...good, knownHostsFile: "G:\\Data 100%\\x" }).includes("UserKnownHostsFile=\"G:/Data 100%%/x\""));
});

test("ssh is named by absolute path and its child sees none of the app's environment", () => {
  assert.equal(ssh.sshProgram({ platform: "win32", env: { SystemRoot: "C:\\Windows" } }), PROGRAM);
  assert.equal(ssh.sshProgram({ platform: "win32", env: { SYSTEMROOT: "D:\\WinNT" } }), "D:\\WinNT\\System32\\OpenSSH\\ssh.exe");
  assert.equal(ssh.sshProgram({ platform: "win32", env: { SystemRoot: "D:\\WinNT\\" } }), "D:\\WinNT\\System32\\OpenSSH\\ssh.exe");
  assert.equal(ssh.sshProgram({ platform: "win32", env: { SystemRoot: "..\\planted" } }), PROGRAM, "a root that is not a drive path is not used");
  assert.equal(ssh.sshProgram({ platform: "win32", env: {} }), PROGRAM);
  // %SystemRoot% only, and only a plain folder path: windir is a per-user variable (`setx windir`),
  // and a root that walks elsewhere or is a drive's top folder could hold a planted ssh.exe.
  for (const env of [
    { windir: "D:\\WinNT" },
    { SystemRoot: "not a path", windir: "G:\\aiTemp\\planted" },
    { SystemRoot: "C:\\Windows\\..\\Users\\Public" },
    { SystemRoot: "C:\\Windows\\.\\..\\planted" },
    { SystemRoot: "C:\\" },
    { SystemRoot: "C:\\\\planted" },
    { SystemRoot: "C:\\Windows/../planted" },
    { SystemRoot: "C:\\Windows..." },
    { SystemRoot: "C:\\Windows \\x" },
  ]) {
    assert.equal(ssh.sshProgram({ platform: "win32", env }), PROGRAM, JSON.stringify(env));
  }
  assert.equal(ssh.sshProgram({ platform: "linux", env: {} }), "/usr/bin/ssh");
  assert.deepEqual(ssh.childEnvironment({
    SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\pat", TEMP: "C:\\Temp", PATH: "C:\\planted;C:\\Windows",
    SSH_ASKPASS: "C:\\planted\\askpass.exe", SSH_ASKPASS_REQUIRE: "force", SSH_AUTH_SOCK: "\\\\.\\pipe\\agent", DISPLAY: ":0",
    CODING_TOOLS_CPA_KEY: "not-for-ssh", HTTPS_PROXY: "http://127.0.0.1:1", GIT_SSH_COMMAND: "calc.exe",
  }), { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\pat", TEMP: "C:\\Temp" });
});

test("fingerprints, known-hosts names and lines", () => {
  // A public server's published key and fingerprint (github.com, Ed25519): the same pair the probe
  // was checked against on the target machine.
  assert.equal(
    ssh.fingerprintOf("AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"),
    "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
  );
  const blob = keyBlob("a");
  assert.equal(ssh.fingerprintOf(blob), fingerprint(blob));
  assert.doesNotMatch(ssh.fingerprintOf(blob), /=$/, "the padding is removed");
  for (const bad of ["", "not base64!", `${blob}=`, blob.slice(0, -1), ` ${blob}`, null, 7]) {
    assert.throws(() => ssh.fingerprintOf(bad), /The host key is not valid/, JSON.stringify(bad));
  }
  assert.equal(ssh.knownHostsName("example.com", 22), "example.com");
  assert.equal(ssh.knownHostsName("example.com", 2222), "[example.com]:2222");
  assert.equal(ssh.knownHostsName("2001:db8::1", 2222), "[2001:db8::1]:2222");
  const key = { type: "ssh-ed25519", blob };
  assert.equal(ssh.knownHostsLine({ host: "example.com", port: 22, key }), `example.com ssh-ed25519 ${blob}`);
  assert.equal(ssh.knownHostsLine({ host: "example.com", port: 2222, key }), `[example.com]:2222 ssh-ed25519 ${blob}`);
  assert.throws(() => ssh.knownHostsLine({ host: "example.com\n* ", port: 22, key }), /cannot be pinned/);
  assert.throws(() => ssh.knownHostsLine({ host: "example.com", port: 22, key: { type: "ssh-rsa", blob } }), /The host key is not valid/);
  assert.deepEqual(ssh.parseKnownHostsLine(`[example.com]:2222 ssh-ed25519 ${blob} a comment`), { name: "[example.com]:2222", type: "ssh-ed25519", blob });
  for (const line of [
    `@cert-authority * ssh-ed25519 ${blob}`, `@revoked example.com ssh-ed25519 ${blob}`, `# example.com ssh-ed25519 ${blob}`,
    `example.com ssh-rsa ${blob}`, "example.com ssh-ed25519 AAAA", `example.com ${blob}`, "",
  ]) {
    assert.equal(ssh.parseKnownHostsLine(line), null, line);
  }
});

// ---------------------------------------------------------------------------------------------
// The store

test("add makes a draft, fetch only shows the server's key, and confirming by comparison pins it", async () => {
  const blob = keyBlob("first");
  const context = makeStore({ script: [serverShows(blob)] });
  const { store, fake, clock } = context;

  const added = await store.add({ ...HOST, host: "Example.com" });
  assert.deepEqual(added, {
    ok: true,
    host: {
      id: added.host.id, label: "Build server", host: "example.com", port: 22, user: "deploy", identityFile: null,
      production: false, state: "draft", key: null, candidate: null, createdAt: clock.iso(),
    },
  });
  assert.match(added.host.id, /^[0-9a-f]{12}$/);
  const id = added.host.id;
  assert.deepEqual(readStore(context.file), { version: 1, hosts: [{ ...added.host }] });
  assert.deepEqual(pinnedLines(context.knownHostsFile), [], "a draft pins nothing");
  assert.deepEqual(store.approvedHosts(), []);

  const listed = await store.list();
  assert.deepEqual(listed, { ok: true, client: { path: PROGRAM, version: "OpenSSH_for_Windows_9.5p2" }, hosts: [added.host] });
  await store.list();
  assert.equal(fake.calls.filter((call) => call.argv[0] === "-V").length, 1, "the client's version is read once");

  clock.advance(60_000);
  const fetched = await store.fetchKey({ id });
  assert.equal(fetched.ok, true, fetched.error);
  assert.deepEqual(fetched.host.candidate, { type: "ssh-ed25519", fingerprint: fingerprint(blob), fetchedAt: clock.iso() });
  assert.equal(fetched.host.state, "draft", "a fetched key is not a trusted key");
  assert.equal(fetched.host.key, null);
  assert.deepEqual(pinnedLines(context.knownHostsFile), [], "the probe writes nothing to the pinned file");
  assert.deepEqual(store.approvedHosts(), []);

  // The probe: the program by absolute path, the throwaway file in a private folder under the
  // probe folder, the hard limit, and nothing of the pinned file.
  const [probe] = fake.probes();
  assert.equal(probe.executable, PROGRAM);
  const target = probeFileIn(probe.argv);
  assert.match(target, /\/ssh-probe\/p-[A-Za-z0-9]{6}\/known_hosts$/);
  assert.ok(target.startsWith(context.probeDir.replaceAll("\\", "/")), "inside the probe folder");
  assert.ok(target.includes("user data"), "the folder's name has a space, so the quotes matter");
  assert.deepEqual(probe.argv, ssh.probeArgv({ host: "example.com", port: 22, user: "deploy", knownHostsFile: path.join(context.probeDir, path.basename(path.dirname(target)), "known_hosts"), client: CLIENT }));
  assert.equal(probe.argv.some((value) => value.includes("ssh-known-hosts")), false);
  assert.equal(probe.options.timeoutMs, 25_000);
  assert.equal(probe.options.timeoutMs, ssh.PROBE_TIMEOUT_MS);
  assert.deepEqual(probe.options.env, { SystemRoot: "C:\\Windows" });
  assert.deepEqual(fs.readdirSync(context.probeDir), [], "the throwaway folder is removed");

  clock.advance(60_000);
  const confirmed = await store.confirmKey({ id, fingerprint: fingerprint(blob) });
  assert.equal(confirmed.ok, true, confirmed.error);
  assert.equal(confirmed.host.state, "pinned");
  assert.deepEqual(confirmed.host.key, { type: "ssh-ed25519", fingerprint: fingerprint(blob), pinnedAt: clock.iso(), method: "compared" });
  assert.equal(confirmed.host.candidate, null);
  assert.deepEqual(pinnedLines(context.knownHostsFile), [`example.com ssh-ed25519 ${blob}`]);
  assert.deepEqual(store.approvedHosts(), [{ id, label: "Build server", host: "example.com", port: 22, user: "deploy", production: false }]);
  assert.equal(fake.probes().length, 1, "confirming contacts no server");
});

test("a pasted fingerprint must match exactly after trimming; a wrong one changes nothing", async () => {
  const blob = keyBlob("pasted");
  const context = makeStore({ script: [serverShows(blob)] });
  const { store } = context;
  const { host } = await store.add(HOST);
  const fetched = await store.fetchKey({ id: host.id });
  const shown = fetched.host.candidate.fingerprint;
  const before = { store: fs.readFileSync(context.file, "utf8"), pinned: fs.readFileSync(context.knownHostsFile, "utf8") };
  const unchanged = async () => {
    assert.equal(fs.readFileSync(context.file, "utf8"), before.store);
    assert.equal(fs.readFileSync(context.knownHostsFile, "utf8"), before.pinned);
    assert.deepEqual((await store.list()).hosts, [fetched.host]);
    assert.deepEqual(store.approvedHosts(), []);
  };

  for (const pasted of [fingerprint(keyBlob("another server")), shown.slice(0, -1), shown.toLowerCase(), `256 ${shown} root@example (ED25519)`, "", "   ", 7, {}]) {
    const refused = await store.confirmKey({ id: host.id, fingerprint: shown, pasted });
    assert.equal(refused.ok, false, JSON.stringify(pasted));
    assert.equal(refused.error, "The pasted fingerprint does not match this server's key.");
    await unchanged();
  }
  // The fingerprint the page shows must be the one last fetched, pasted value or not.
  for (const stale of [fingerprint(keyBlob("another server")), `${shown} `, undefined, null, ""]) {
    const refused = await store.confirmKey({ id: host.id, fingerprint: stale, pasted: shown });
    assert.equal(refused.ok, false, JSON.stringify(stale));
    assert.match(refused.error, /not the one last fetched from this server/);
    await unchanged();
  }
  assert.match((await store.confirmKey({ id: "000000000000", fingerprint: shown })).error, /no longer in the list/);
  assert.match((await store.confirmKey({ id: host.id, fingerprint: shown, trust: "always" })).error, /no extra options or arguments/);
  await unchanged();

  const pinned = await store.confirmKey({ id: host.id, fingerprint: shown, pasted: `  ${shown}\r\n` });
  assert.equal(pinned.ok, true, pinned.error);
  assert.equal(pinned.host.state, "pinned");
  assert.equal(pinned.host.key.method, "pasted");
  assert.equal(pinned.host.key.fingerprint, shown);
  assert.deepEqual(pinnedLines(context.knownHostsFile), [`example.com ssh-ed25519 ${blob}`]);

  // Nothing is left to confirm: a second confirmation needs a new fetch.
  assert.match((await store.confirmKey({ id: host.id, fingerprint: shown })).error, /Fetch the server's key first/);
});

test("a pinned host whose server shows another key is blocked until the person confirms the new key", async () => {
  const first = keyBlob("original");
  const second = keyBlob("replacement");
  const context = makeStore();
  const { store, fake, clock } = context;
  const pinned = await pinnedHost(context, first);
  const id = pinned.id;

  // The same key again: still pinned.
  fake.answer(serverShows(first));
  const same = await store.fetchKey({ id });
  assert.equal(same.host.state, "pinned");
  assert.equal(same.host.candidate.fingerprint, fingerprint(first));
  assert.equal(store.approvedHosts().length, 1);

  clock.advance(3_600_000);
  fake.answer(serverShows(second));
  const changed = await store.fetchKey({ id });
  assert.equal(changed.ok, true, changed.error);
  assert.equal(changed.host.state, "changed");
  assert.deepEqual(changed.host.key, pinned.key, "the key first trusted stays beside the new one");
  assert.deepEqual(changed.host.candidate, { type: "ssh-ed25519", fingerprint: fingerprint(second), fetchedAt: clock.iso() });
  assert.deepEqual(store.approvedHosts(), [], "a changed host is not an approved host");
  assert.deepEqual(pinnedLines(context.knownHostsFile), [], "neither key is trusted while it is blocked");
  assert.throws(() => ssh.terminalArgv({ ...changed.host, knownHostsFile: context.knownHostsFile }), /Confirm this host's key/);

  // The old key showing again does not unblock it by itself.
  fake.answer(serverShows(first));
  const back = await store.fetchKey({ id });
  assert.equal(back.host.state, "changed");
  assert.deepEqual(store.approvedHosts(), []);
  assert.deepEqual(pinnedLines(context.knownHostsFile), []);

  // The fingerprint of the first fetch is no longer the one on screen.
  fake.answer(serverShows(second));
  await store.fetchKey({ id });
  assert.match((await store.confirmKey({ id, fingerprint: fingerprint(first) })).error, /not the one last fetched/);
  assert.equal((await store.confirmKey({ id, fingerprint: fingerprint(second), pasted: fingerprint(first) })).error,
    "The pasted fingerprint does not match this server's key.");
  assert.deepEqual(store.approvedHosts(), []);

  clock.advance(60_000);
  const replaced = await store.confirmKey({ id, fingerprint: fingerprint(second), pasted: fingerprint(second) });
  assert.equal(replaced.host.state, "pinned");
  assert.deepEqual(replaced.host.key, { type: "ssh-ed25519", fingerprint: fingerprint(second), pinnedAt: clock.iso(), method: "pasted" });
  assert.deepEqual(pinnedLines(context.knownHostsFile), [`example.com ssh-ed25519 ${second}`], "only the confirmed key is pinned");
  assert.equal(store.approvedHosts().length, 1);
});

test("one server has one approved key: a second entry for it cannot pin another key beside the first", async () => {
  const first = keyBlob("server key");
  const second = keyBlob("another key");
  const context = makeStore();
  const { store, fake, clock } = context;
  // The second entry's key was fetched before the first entry's key was approved: it says nothing
  // about what the server shows since (a key fetched later blocks the approved entry; see below).
  const root = (await store.add({ ...HOST, label: "Same server as root", user: "root" })).host;
  fake.answer(serverShows(second));
  assert.equal((await store.fetchKey({ id: root.id })).host.candidate.fingerprint, fingerprint(second));
  clock.advance(60_000);
  const deploy = await pinnedHost(context, first);
  assert.deepEqual(store.approvedHosts().map((host) => host.user), ["deploy"]);
  const before = { store: fs.readFileSync(context.file, "utf8"), pinned: fs.readFileSync(context.knownHostsFile, "utf8") };

  // ssh trusts a key for a host and port, whoever signs in: both keys in the pinned file would be
  // accepted for both entries.
  for (const pasted of [undefined, fingerprint(second)]) {
    const refused = await store.confirmKey({ id: root.id, fingerprint: fingerprint(second), ...(pasted ? { pasted } : {}) });
    assert.deepEqual([refused.ok, refused.code], [false, "other_key_approved"]);
    assert.equal(refused.error, "\"Build server\" is the same server and has a different approved key. Check that host's key first, then approve this one.");
  }
  assert.equal(fs.readFileSync(context.file, "utf8"), before.store);
  assert.equal(fs.readFileSync(context.knownHostsFile, "utf8"), before.pinned);
  assert.deepEqual(store.approvedHosts().map((host) => host.user), ["deploy"]);

  // Checked as the message says, the first entry shows the other key too and is blocked...
  clock.advance(60_000);
  fake.answer(serverShows(second));
  assert.equal((await store.fetchKey({ id: deploy.id })).host.state, "changed");
  assert.deepEqual(pinnedLines(context.knownHostsFile), []);
  // ...and with no other key approved for the server, each entry can be approved with the new one.
  assert.equal((await store.confirmKey({ id: root.id, fingerprint: fingerprint(second) })).host.state, "pinned");
  assert.deepEqual(store.approvedHosts().map((host) => host.user), ["root"], "the other entry still waits for its own review");
  assert.equal((await store.confirmKey({ id: deploy.id, fingerprint: fingerprint(second) })).host.state, "pinned");
  assert.deepEqual(pinnedLines(context.knownHostsFile), [`example.com ssh-ed25519 ${second}`], "one line, one key, for both entries");
  assert.deepEqual(store.approvedHosts().map((host) => host.user), ["root", "deploy"]);

  // Another port is another server: it has its own key.
  const third = keyBlob("port 2222");
  assert.equal((await pinnedHost(context, third, { ...HOST, label: "Other port", port: 2222 })).state, "pinned");
  assert.deepEqual(pinnedLines(context.knownHostsFile), [`example.com ssh-ed25519 ${second}`, `[example.com]:2222 ssh-ed25519 ${third}`]);
});

test("a server that shows another key is blocked through every entry for it, not only the one it was fetched through", async () => {
  const first = keyBlob("approved for the server");
  const second = keyBlob("shown later");
  const context = makeStore();
  const { store, fake, clock } = context;
  const deploy = await pinnedHost(context, first);
  const root = await pinnedHost(context, first, { ...HOST, label: "Same server as root", user: "root" });
  const otherPort = await pinnedHost(context, keyBlob("port 2222"), { ...HOST, label: "Other port", port: 2222 });
  assert.equal(store.approvedHosts().length, 3);

  clock.advance(60_000);
  fake.answer(serverShows(second));
  const changed = await store.fetchKey({ id: deploy.id });
  assert.equal(changed.host.state, "changed");
  // ssh trusts a key for a host and port, whoever signs in: the root entry is the same server.
  const listed = Object.fromEntries((await store.list()).hosts.map((host) => [host.id, host]));
  assert.equal(listed[root.id].state, "changed");
  assert.deepEqual(listed[root.id].key, root.key, "each entry keeps the key approved for it");
  assert.deepEqual(listed[root.id].candidate, changed.host.candidate, "and is shown the key the server shows now");
  assert.equal(listed[otherPort.id].state, "pinned", "another port is another server");
  assert.deepEqual(store.approvedHosts().map((host) => host.id), [otherPort.id]);
  assert.deepEqual((await store.terminalCommand({ id: root.id })).code, "not_pinned");
  assert.deepEqual(pinnedLines(context.knownHostsFile), [`[example.com]:2222 ssh-ed25519 ${keyBlob("port 2222")}`]);
  assert.ok(context.logs.some((entry) => entry[1] === "ssh.key_fetched" && entry[2].hostId === deploy.id && entry[2].blocked === 2));
  // The same after a restart.
  await store.dispose();
  const restarted = makeStore({ root: context.root });
  assert.deepEqual((await restarted.store.list()).hosts.map((host) => host.state), ["changed", "changed", "pinned"]);
  assert.deepEqual(restarted.store.approvedHosts().map((host) => host.id), [otherPort.id]);
  // Each entry is approved again only by the person, one by one.
  assert.equal((await restarted.store.confirmKey({ id: root.id, fingerprint: fingerprint(second) })).host.state, "pinned");
  assert.deepEqual(restarted.store.approvedHosts().map((host) => host.id), [root.id, otherPort.id]);
});

test("a new entry that fetches another key than the one approved for its server blocks the approved entry", async () => {
  const first = keyBlob("approved");
  const second = keyBlob("shown to the new entry");
  const context = makeStore();
  const { store, fake, clock } = context;
  const deploy = await pinnedHost(context, first);
  const root = (await store.add({ ...HOST, label: "Same server as root", user: "root" })).host;
  clock.advance(60_000);
  fake.answer(serverShows(second));
  const fetched = await store.fetchKey({ id: root.id });
  assert.deepEqual([fetched.host.state, fetched.host.candidate.fingerprint], ["draft", fingerprint(second)], "the new entry is a draft with what it was shown");
  const [listedDeploy] = (await store.list()).hosts;
  assert.equal(listedDeploy.state, "changed", "the server is known to show another key now");
  assert.deepEqual(listedDeploy.key, deploy.key);
  assert.deepEqual(store.approvedHosts(), []);
  assert.deepEqual(pinnedLines(context.knownHostsFile), []);
  // The same key again changes nothing.
  const other = makeStore();
  const pinned = await pinnedHost(other, first);
  const sibling = (await other.store.add({ ...HOST, user: "root" })).host;
  other.fake.answer(serverShows(first));
  assert.equal((await other.store.fetchKey({ id: sibling.id })).ok, true);
  assert.deepEqual(other.store.approvedHosts().map((host) => host.id), [pinned.id]);
});

/**
 * Holds the rename that puts `target` in place (atomic-file.cjs writes a temporary file, then
 * renames it): `reached` resolves when the save got there, `release(error)` lets it go on, or fail.
 */
function holdSave(target) {
  const realRename = fs.promises.rename;
  let arrive;
  let letGo;
  const reached = new Promise((resolve) => { arrive = resolve; });
  const released = new Promise((resolve) => { letGo = resolve; });
  fs.promises.rename = async (from, to) => {
    if (to === target) {
      arrive();
      const failure = await released;
      if (failure) throw failure;
    }
    return realRename.call(fs.promises, from, to);
  };
  return { reached, release: (failure = null) => letGo(failure), restore: () => { fs.promises.rename = realRename; } };
}

const diskError = () => Object.assign(new Error("i/o error"), { code: "EIO" });

test("a server that showed another key stays blocked when the save fails, and is blocked before the save lands", async () => {
  const first = keyBlob("approved before");
  const second = keyBlob("shown while the disk fails");
  const context = makeStore();
  const { store, fake, clock } = context;
  const host = await pinnedHost(context, first);
  const sibling = await pinnedHost(context, first, { ...HOST, user: "root" });
  clock.advance(60_000);
  fake.answer(serverShows(second));
  const held = holdSave(context.file);
  let answer;
  try {
    const fetching = store.fetchKey({ id: host.id });
    await held.reached;
    assert.deepEqual(store.approvedHosts(), [], "blocked from the start, not once the disk has flushed the file");
    held.release(diskError());
    answer = await fetching;
  } finally {
    held.restore();
  }
  assert.deepEqual([answer.ok, answer.code], [false, "not_saved"]);
  assert.equal(answer.error, "This server showed a key other than the one you approved, so it is blocked. The block could not be saved and would be lost when the app restarts. Check the disk, then check the key again.");
  assert.deepEqual(store.approvedHosts(), [], "a failed save does not approve it again");
  const listed = (await store.list()).hosts;
  assert.deepEqual(listed.map((entry) => [entry.state, entry.key.fingerprint, entry.candidate.fingerprint]), [
    ["changed", fingerprint(first), fingerprint(second)], ["changed", fingerprint(first), fingerprint(second)],
  ]);
  assert.deepEqual(pinnedLines(context.knownHostsFile), [], "the pinned file follows the list in memory");
  assert.equal((await store.terminalCommand({ id: sibling.id })).code, "not_pinned");
  assert.deepEqual(readStore(context.file).hosts.map((entry) => entry.state), ["pinned", "pinned"], "the disk still has the old list");
  assert.deepEqual(context.logs.find((entry) => entry[1] === "ssh.key_fetched" && entry[2].saved === false),
    ["warn", "ssh.key_fetched", { hostId: host.id, changed: true, blocked: 2, saved: false }]);

  // Once the disk takes a write again, the next change saves the block with it.
  assert.equal((await store.update({ id: host.id, label: "Renamed" })).ok, true);
  assert.deepEqual(readStore(context.file).hosts.map((entry) => entry.state), ["changed", "changed"]);
  await store.dispose();
  const restarted = makeStore({ root: context.root });
  await restarted.store.ready();
  assert.deepEqual(restarted.store.approvedHosts(), []);
});

test("a host being removed is not approved while the save runs; a failed save puts it back, as the answer says", async () => {
  const context = makeStore();
  const { store } = context;
  const host = await pinnedHost(context, keyBlob("removed"));
  const held = holdSave(context.file);
  let answer;
  try {
    const removing = store.remove({ id: host.id });
    await held.reached;
    assert.deepEqual(store.approvedHosts(), [], "trust is taken away at once");
    held.release(diskError());
    answer = await removing;
  } finally {
    held.restore();
  }
  assert.deepEqual([answer.ok, answer.code], [false, "save_failed"]);
  assert.match(answer.error, /could not be saved, so nothing was changed/);
  assert.deepEqual((await store.list()).hosts, [host]);
  assert.equal(store.approvedHosts().length, 1);
  // A change that adds no trust still lands only with its save.
  const renaming = holdSave(context.file);
  try {
    const update = store.update({ id: host.id, production: true });
    await renaming.reached;
    assert.equal((await store.list()).hosts[0].production, false);
    renaming.release();
    assert.equal((await update).host.production, true);
  } finally {
    renaming.restore();
  }
  assert.equal((await store.remove({ id: host.id })).ok, true);
  assert.deepEqual(store.approvedHosts(), []);
});

test("the pinned file is written whole from the store: a hand-added line disappears, another port uses [host]:port", async () => {
  const context = makeStore();
  const { store } = context;
  const one = keyBlob("one");
  const two = keyBlob("two");
  const three = keyBlob("three");
  await pinnedHost(context, one);
  await pinnedHost(context, two, { label: "Staging", host: "example.com", port: 2222, user: "deploy" });
  await pinnedHost(context, three, { label: "IPv6 box", host: "2001:db8::1", port: 2200, user: "root" });
  const draft = (await store.add({ label: "Not confirmed", host: "draft.example.com", user: "deploy" })).host;
  const expected = [
    `example.com ssh-ed25519 ${one}`,
    `[example.com]:2222 ssh-ed25519 ${two}`,
    `[2001:db8::1]:2200 ssh-ed25519 ${three}`,
  ];
  assert.deepEqual(pinnedLines(context.knownHostsFile), expected);
  assert.match(fs.readFileSync(context.knownHostsFile, "utf8"), /^# Coding Tools writes this file from its SSH hosts list\. Changes made here are lost\.\n/);

  // A line added by hand (as an agent might try) goes with the next change of any kind...
  const planted = `evil.example.com ssh-ed25519 ${keyBlob("planted")}`;
  fs.appendFileSync(context.knownHostsFile, `${planted}\n@cert-authority * ssh-ed25519 ${keyBlob("ca")}\n`);
  assert.equal((await store.update({ id: draft.id, label: "Still not confirmed" })).ok, true);
  assert.deepEqual(pinnedLines(context.knownHostsFile), expected);

  // ...and at start: a new store on the same files writes the file again from its records.
  fs.appendFileSync(context.knownHostsFile, `${planted}\n`);
  fs.writeFileSync(path.join(context.root, "ssh-known-hosts.note"), "untouched");
  await store.dispose();
  const restarted = makeStore({ root: context.root });
  await restarted.store.ready();
  assert.deepEqual(pinnedLines(context.knownHostsFile), expected);
  assert.equal((await restarted.store.list()).hosts.length, 4);
  assert.equal(fs.readFileSync(path.join(context.root, "ssh-known-hosts.note"), "utf8"), "untouched");

  // Removing a host removes its line.
  const listed = (await restarted.store.list()).hosts;
  const removed = await restarted.store.remove({ id: listed[1].id });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.hosts.map((host) => host.label), ["Build server", "IPv6 box", "Still not confirmed"]);
  assert.deepEqual(pinnedLines(context.knownHostsFile), [expected[0], expected[2]]);
  // The pinned file was deleted: the next change brings it back.
  fs.rmSync(context.knownHostsFile);
  await restarted.store.update({ id: listed[0].id, production: true });
  assert.deepEqual(pinnedLines(context.knownHostsFile), [expected[0], expected[2]]);
});

test("the terminal's command is built only for a pinned host, after the pinned file is written again", async () => {
  const blob = keyBlob("terminal");
  const context = makeStore();
  const { store, fake } = context;
  const keyFile = path.join(context.root, "keys", "id_ed25519");
  const host = await pinnedHost(context, blob, { ...HOST, port: 2222, identityFile: keyFile });
  const draft = (await store.add({ ...HOST, user: "other" })).host;

  // Between two changes a line planted in the pinned file would be a second key ssh accepts for the host.
  fs.appendFileSync(context.knownHostsFile, `[example.com]:2222 ssh-ed25519 ${keyBlob("planted")}\n`);
  const command = await store.terminalCommand({ id: host.id });
  assert.equal(command.ok, true, command.error);
  assert.equal(command.program, PROGRAM);
  assert.deepEqual(command.argv, ssh.terminalArgv({
    host: "example.com", port: 2222, user: "deploy", identityFile: keyFile, state: "pinned", knownHostsFile: context.knownHostsFile, client: CLIENT,
  }));
  assert.deepEqual(command.argv.slice(-9), ["-i", keyFile, "-t", "-p", "2222", "-l", "deploy", "--", "example.com"]);
  assert.deepEqual(pinnedLines(context.knownHostsFile), [`[example.com]:2222 ssh-ed25519 ${blob}`], "the planted line is gone before ssh starts");

  const unconfirmed = await store.terminalCommand({ id: draft.id });
  assert.equal(unconfirmed.ok, false);
  assert.match(unconfirmed.error, /Confirm this host's key before opening a terminal/);
  fake.answer(serverShows(keyBlob("another key"), "[example.com]:2222"));
  assert.equal((await store.fetchKey({ id: host.id })).host.state, "changed");
  const blocked = await store.terminalCommand({ id: host.id });
  assert.deepEqual([blocked.ok, blocked.code, blocked.argv], [false, "not_pinned", undefined]);
  assert.match((await store.terminalCommand({ id: host.id, command: "id" })).error, /no extra options or arguments/);
  // The window cannot ask for a command line: this is not an operation of the app module. Its
  // terminal operations (milestone 2) open and close an AO terminal and hand back only its handle.
  assert.match((await store.call("terminal_command", { id: host.id })).error, /no such action/);
  assert.match((await store.call("terminalCommand", { id: host.id })).error, /no such action/);
  assert.deepEqual(ssh.OPERATIONS.filter((name) => /terminal/.test(name)), ["terminal_open", "terminal_close"]);
});

test("the terminal's command comes with its environment, and is not built for a key file that is gone", async () => {
  const present = new Set();
  // What the app itself runs with: ssh would start SSH_ASKPASS for a prompt and load SSH_SK_PROVIDER.
  const appEnvironment = {
    SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\pat", PATH: "C:\\planted;C:\\Windows",
    SSH_ASKPASS: "C:\\planted\\askpass.exe", SSH_ASKPASS_REQUIRE: "force", SSH_SK_PROVIDER: "C:\\planted\\sk.dll", SSH_AUTH_SOCK: "\\\\.\\pipe\\agent",
  };
  const context = makeStore({ fileExists: async (file) => present.has(file), environment: () => ssh.childEnvironment(appEnvironment) });
  const keyFile = path.join(context.root, "keys", "id_real");
  present.add(keyFile);
  const host = await pinnedHost(context, keyBlob("key file"), { ...HOST, identityFile: keyFile });
  const command = await context.store.terminalCommand({ id: host.id });
  assert.equal(command.ok, true, command.error);
  assert.deepEqual(Object.keys(command).sort(), ["argv", "env", "ok", "program"]);
  assert.deepEqual(command.env, { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\pat" }, "the caller is handed the environment, not left to pick one");
  assert.ok(command.argv.includes(keyFile));

  // Deleted afterwards: ssh would warn, drop -i and offer the person's default keys to this host.
  present.delete(keyFile);
  const gone = await context.store.terminalCommand({ id: host.id });
  assert.deepEqual([gone.ok, gone.code, gone.argv, gone.env], [false, "key_file_missing", undefined, undefined]);
  assert.match(gone.error, /^Key file: no file was found at that path, so the terminal was not opened\./);
  // A host with no key file needs none.
  const plain = await pinnedHost(context, keyBlob("no key file"), { ...HOST, host: "plain.example.com" });
  assert.equal((await context.store.terminalCommand({ id: plain.id })).ok, true);
});

// ---------------------------------------------------------------------------------------------
// The in-app terminal (milestone 2): terminal_open and terminal_close

/**
 * A store wired to a stand-in for AO's terminal (the upstream's openSshTerminal and closeTerminal).
 * It records each call and what the pinned file held when AO was asked; `behaviour.open` and
 * `behaviour.close` answer in its place when set.
 */
function withAo(options = {}) {
  const ao = { opened: [], closed: [] };
  const behaviour = { open: null, close: null };
  let count = 0;
  const context = makeStore({
    ...options,
    openTerminal: async (fields) => {
      ao.opened.push({ fields: JSON.parse(JSON.stringify(fields)), pinned: pinnedLines(context.knownHostsFile) });
      if (behaviour.open) return behaviour.open(fields);
      count += 1;
      return { handle: `shellterm-ssh-${count}`, generation: `2026-11-27T10:00:0${count}Z`, title: fields.title };
    },
    closeTerminal: async (handle) => {
      ao.closed.push(handle);
      if (behaviour.close) return behaviour.close(handle);
      return undefined;
    },
  });
  return Object.assign(context, { ao, behaviour });
}

/** Each terminal log line names an event, a host id and a short code, and nothing of the host. */
function assertTerminalLogs(logs, forbidden) {
  const lines = logs.filter((entry) => /^ssh\.terminal_/.test(entry[1]));
  assert.ok(lines.length > 0);
  for (const [level, event, fields, ...rest] of lines) {
    assert.ok(["info", "warn"].includes(level), event);
    assert.ok(["ssh.terminal_opened", "ssh.terminal_closed", "ssh.terminal_refused", "ssh.terminal_close_failed"].includes(event), event);
    assert.deepEqual(rest, [], `${event} logs one object of fields`);
    assert.ok(Object.keys(fields).every((name) => ["hostId", "code"].includes(name)), `${event}: ${Object.keys(fields)}`);
    const text = JSON.stringify(fields);
    for (const secret of forbidden) assert.equal(text.includes(secret), false, `${event} must not log ${JSON.stringify(secret)}: ${text}`);
    for (const [name, value] of Object.entries(fields)) {
      assert.ok(typeof value === "string" && /^[A-Za-z0-9_]{1,24}$/.test(value), `${event}.${name} is an id or a code: ${JSON.stringify(value)}`);
    }
  }
  return lines;
}

test("terminal_open opens an approved host in AO's terminal after the pinned file is written again, and terminal_close closes only its own", async () => {
  const blob = keyBlob("terminal open");
  const context = withAo();
  const { store, ao, behaviour, logs } = context;
  const keyFile = path.join(context.root, "keys", "id_ed25519");
  const host = await pinnedHost(context, blob, { ...HOST, port: 2222, identityFile: keyFile, production: true });

  // Between two changes a line planted in the pinned file would be a second key ssh accepts for the host.
  fs.appendFileSync(context.knownHostsFile, `[example.com]:2222 ssh-ed25519 ${keyBlob("planted")}\n`);
  const answer = await store.call("terminal_open", { id: host.id });
  assert.equal(answer.ok, true, answer.error);
  assert.deepEqual(answer, { ok: true, terminal: {
    handle: "shellterm-ssh-1", generation: "2026-11-27T10:00:01Z", title: "Build server", remote: true, hostId: host.id, production: true,
  } });
  assert.deepEqual(ao.opened, [{
    fields: { host: "example.com", port: 2222, user: "deploy", identityFile: keyFile, title: "Build server", client: { major: 9, minor: 5 } },
    pinned: [`[example.com]:2222 ssh-ed25519 ${blob}`],
  }], "AO gets the typed fields only, and the planted line was gone before it was asked");
  assert.deepEqual(Object.keys(ao.opened[0].fields), ["host", "port", "user", "identityFile", "title", "client"]);
  // The window gets a handle to show: no command line, no path, no key.
  const shown = JSON.stringify(answer);
  for (const hidden of [keyFile, context.knownHostsFile, "UserKnownHostsFile", "\"-o\"", PROGRAM, blob, "SHA256:", "argv"]) {
    assert.equal(shown.includes(hidden), false, hidden);
  }

  // One terminal at a time: another open is refused while this one is open, for any host.
  const long = "L".repeat(60);
  const plain = await pinnedHost(context, keyBlob("plain"), { label: long, host: "plain.example.com", port: 22, user: "deploy" });
  for (const id of [host.id, plain.id]) {
    const refused = await store.call("terminal_open", { id });
    assert.deepEqual(refused, { ok: false, error: "A terminal is already open from this page. Close it first, then open another.", code: "already_open" });
  }
  assert.equal(ao.opened.length, 1, "AO was not asked again");

  // Closing: only a terminal this store opened, and each once. Then another can open.
  assert.deepEqual(await store.call("terminal_close", { handle: "shellterm-ssh-1" }), { ok: true });
  assert.deepEqual(ao.closed, ["shellterm-ssh-1"]);

  // No key file: none is sent. The label is the title (at most 60 characters, under AO's 80).
  const second = await store.call("terminal_open", { id: plain.id });
  assert.equal(second.ok, true, second.error);
  assert.deepEqual(ao.opened[1].fields, { host: "plain.example.com", port: 22, user: "deploy", identityFile: null, title: long, client: { major: 9, minor: 5 } });
  assert.deepEqual([second.terminal.title, second.terminal.production, second.terminal.remote], [long, false, true]);

  for (const args of [{ handle: "shellterm-ssh-1" }, { handle: "shellterm-1" }, { handle: "shellterm-ssh-9" }, { handle: "" }, { handle: "__proto__" },
    { handle: "constructor" }, { handle: 7 }, { handle: null }, {}, undefined]) {
    const refused = await store.call("terminal_close", args);
    assert.deepEqual([refused.ok, refused.code], [false, "not_own"], JSON.stringify(args));
    assert.equal(refused.error, "This terminal was not opened from the SSH hosts page, so it was not closed here.");
  }
  assert.deepEqual(ao.closed, ["shellterm-ssh-1"], "AO was not asked to close any other terminal");

  // A close AO failed keeps the terminal, to be tried again; one AO no longer has is closed.
  behaviour.close = async () => { throw Object.assign(new Error("AO daemon unavailable"), { status: 502 }); };
  const failed = await store.call("terminal_close", { handle: "shellterm-ssh-2" });
  assert.deepEqual(failed, { ok: false, error: "The terminal could not be closed. Try again.", code: "close_failed" });
  behaviour.close = async () => { throw Object.assign(new Error("No such terminal (SHELL_TERMINAL_NOT_FOUND)"), { status: 404, code: "SHELL_TERMINAL_NOT_FOUND" }); };
  assert.deepEqual(await store.call("terminal_close", { handle: "shellterm-ssh-2" }), { ok: true });
  assert.equal((await store.call("terminal_close", { handle: "shellterm-ssh-2" })).code, "not_own");
  assert.deepEqual(ao.closed, ["shellterm-ssh-1", "shellterm-ssh-2", "shellterm-ssh-2"]);

  const lines = assertTerminalLogs(logs, [scratch, "example.com", "deploy", "Build server", long, keyFile, "ssh-known-hosts", "shellterm", "UserKnownHostsFile", PROGRAM, blob]);
  assert.deepEqual(lines.map((entry) => [entry[1], entry[2]]), [
    ["ssh.terminal_opened", { hostId: host.id }], ["ssh.terminal_refused", { code: "already_open" }], ["ssh.terminal_refused", { code: "already_open" }],
    ["ssh.terminal_closed", { hostId: host.id }], ["ssh.terminal_opened", { hostId: plain.id }],
    ...Array(10).fill(["ssh.terminal_refused", { code: "not_own" }]),
    ["ssh.terminal_refused", { hostId: plain.id, code: "close_failed" }], ["ssh.terminal_closed", { hostId: plain.id }], ["ssh.terminal_refused", { code: "not_own" }],
  ]);
});

test("terminal_open refuses a host that is not approved with terminalCommand's codes, and AO is asked nothing", async () => {
  const present = new Set();
  const context = withAo({ fileExists: async (file) => present.has(file) });
  const { store, fake, clock, ao, logs } = context;
  const keyFile = path.join(context.root, "keys", "id_gone");
  present.add(keyFile);
  const withKey = await pinnedHost(context, keyBlob("key file"), { ...HOST, label: "With key", host: "key.example.com", identityFile: keyFile });
  const draft = (await store.add({ ...HOST, label: "Draft", host: "draft.example.com" })).host;
  const blocked = await pinnedHost(context, keyBlob("blocked"), { ...HOST, label: "Blocked", host: "blocked.example.com" });
  const sibling = await pinnedHost(context, keyBlob("blocked"), { ...HOST, label: "Blocked as root", host: "blocked.example.com", user: "root" });
  clock.advance(60_000);
  fake.answer(serverShows(keyBlob("someone else"), "blocked.example.com"));
  assert.equal((await store.fetchKey({ id: blocked.id })).host.state, "changed");

  const refusal = async (id) => { const answer = await store.call("terminal_open", { id }); assert.equal(answer.ok, false, id); return answer; };
  for (const id of [draft.id, blocked.id, sibling.id]) {
    const answer = await refusal(id);
    assert.equal(answer.code, "not_pinned", id);
    assert.match(answer.error, /Confirm this host's key before opening a terminal/);
  }
  assert.equal((await refusal("000000000000")).code, "not_found");
  assert.equal((await refusal("evil.example.com")).code, "not_found");
  present.delete(keyFile);
  const gone = await refusal(withKey.id);
  assert.equal(gone.code, "key_file_missing");
  assert.match(gone.error, /^Key file: no file was found at that path, so the terminal was not opened\./);
  present.add(keyFile);

  // The pinned file cannot be written: nothing opens against an old one.
  fs.rmSync(context.knownHostsFile);
  fs.mkdirSync(path.join(context.knownHostsFile, "in the way"), { recursive: true });
  const unwritten = await refusal(withKey.id);
  assert.deepEqual([unwritten.code, unwritten.error], ["pinned_write_failed", "The pinned keys file could not be written, so the terminal was not opened. Try again."]);
  assert.deepEqual(ao.opened, [], "AO was asked nothing");

  // No ssh client on this computer.
  const noClient = withAo({ run: async () => { throw new Error("spawn ENOENT"); } });
  const record = (await noClient.store.add(HOST)).host;
  const missing = await noClient.store.call("terminal_open", { id: record.id });
  assert.deepEqual([missing.ok, missing.code], [false, "no_client"]);
  assert.equal(missing.error, "OpenSSH was not found on this computer, so the terminal was not opened.");
  assert.deepEqual(noClient.ao.opened, []);

  // A store made without AO's terminal (the default) opens nothing and says so; so does a stopped one.
  const unwired = makeStore();
  const lone = await pinnedHost(unwired, keyBlob("unwired"));
  const none = await unwired.store.call("terminal_open", { id: lone.id });
  assert.deepEqual(none, { ok: false, error: "The in-app terminal is not available right now. Try again in a moment.", code: "no_terminal" });
  assert.equal((await unwired.store.call("terminal_close", { handle: "shellterm-ssh-1" })).code, "not_own");
  const stopped = withAo();
  const later = await pinnedHost(stopped, keyBlob("stopped"));
  await stopped.store.dispose();
  assert.equal((await stopped.store.call("terminal_open", { id: later.id })).code, "restarting");
  assert.deepEqual(stopped.ao.opened, []);

  const lines = assertTerminalLogs(logs, [scratch, "example.com", "deploy", "evil", keyFile, "ssh-known-hosts", "Draft", "Blocked"]);
  assert.deepEqual(lines.map((entry) => entry[2].code), ["not_pinned", "not_pinned", "not_pinned", "not_found", "not_found", "key_file_missing", "pinned_write_failed"]);
  assert.deepEqual(lines.slice(3, 5).map((entry) => entry[2]), [{ code: "not_found" }, { code: "not_found" }], "an id that is not in the list is not logged");
});

test("a host that cannot show the terminal: the list says so, and terminal_open refuses before the pinned file or AO", async () => {
  // Coding Agent's web host, which has no web views yet: the hosts list and the agent rules stay.
  const context = withAo({ canShowTerminal: false });
  const { store, ao, logs } = context;
  const host = await pinnedHost(context, keyBlob("no web views"));
  const listed = await store.call("list");
  assert.equal(listed.ok, true, listed.error);
  assert.equal(listed.terminals, false);
  assert.equal(listed.hosts.length, 1, "the approved host is listed as before");
  const pinned = fs.readFileSync(context.knownHostsFile, "utf8");
  const answer = await store.call("terminal_open", { id: host.id });
  assert.deepEqual(answer, { ok: false, error: "This app can't show the in-app terminal yet. The hosts list and the agent rules work as usual.", code: "no_terminal" });
  assert.deepEqual(ao.opened, [], "AO was asked nothing");
  assert.equal(fs.readFileSync(context.knownHostsFile, "utf8"), pinned, "the pinned file was not written for it");
  assert.deepEqual(assertTerminalLogs(logs, ["example.com", "deploy"]).map((entry) => entry[2]), [{ code: "no_terminal" }], "no host id: nothing was looked up");
  // A host that can show it says nothing about it.
  assert.equal("terminals" in (await withAo().store.call("list")), false);
});

test("AO's refusals are said in the module's words, and an answer that is no terminal opens nothing", async () => {
  const context = withAo();
  const { store, ao, behaviour, logs } = context;
  const host = await pinnedHost(context, keyBlob("refused"));
  for (const [code, mine, words] of [
    ["SSH_TERMINAL_DISABLED", "terminal_off", "Agent Orchestrator has SSH terminals switched off, so the terminal was not opened. Restart the app, then try again."],
    ["SSH_TERMINAL_FORBIDDEN", "refused", "Agent Orchestrator refused to open the terminal. Restart the app, then try again."],
    ["SSH_TERMINAL_LOCAL_ONLY", "refused", "Agent Orchestrator refused to open the terminal. Restart the app, then try again."],
    ["SSH_TERMINAL_INVALID", "invalid", "Agent Orchestrator did not accept this host's details, so the terminal was not opened. Remove this host and add it again."],
    ["SSH_TERMINAL_NO_PINNED_KEYS", "pinned_missing", "The pinned keys file was not found, so the terminal was not opened. Try again."],
    ["SSH_TERMINAL_NO_CLIENT", "no_client", "OpenSSH was not found on this computer, so the terminal was not opened."],
    // AO could not start ssh for it: its own sentence, not the "still starting" one.
    ["SSH_TERMINAL_START_FAILED", "start_failed", "OpenSSH could not be started for this host, so the terminal was not opened. Try again, or check the host's details."],
    ["ECONNREFUSED", "open_failed", "The terminal could not be opened. Agent Orchestrator may still be starting; try again in a moment."],
    [undefined, "open_failed", "The terminal could not be opened. Agent Orchestrator may still be starting; try again in a moment."],
  ]) {
    behaviour.open = async () => { throw Object.assign(new Error(`AO said: secret detail about example.com and C:\\keys (${code})`), { code, status: 403 }); };
    const answer = await store.call("terminal_open", { id: host.id });
    assert.deepEqual(answer, { ok: false, error: words, code: mine }, String(code));
  }
  // An older backend whose upstream has no SSH route throws a TypeError: the same plain refusal.
  behaviour.open = async () => { throw new TypeError("agentOrchestratorUpstream.harness.openSshTerminal is not a function"); };
  assert.equal((await store.call("terminal_open", { id: host.id })).code, "open_failed");
  // An answer that is not a terminal handle is not shown or kept.
  for (const opened of [null, {}, { handle: "bad handle" }, { handle: "" }, { handle: 7 }, { handle: "x".repeat(201) }]) {
    behaviour.open = async () => opened;
    const answer = await store.call("terminal_open", { id: host.id });
    assert.deepEqual([answer.ok, answer.code], [false, "open_failed"], JSON.stringify(opened));
  }
  assert.equal((await store.call("terminal_close", { handle: "bad handle" })).code, "not_own");
  assert.deepEqual(ao.closed, []);
  // A generation AO did not give is the handle.
  behaviour.open = async () => ({ handle: "shellterm-ssh-5" });
  assert.equal((await store.call("terminal_open", { id: host.id })).terminal.generation, "shellterm-ssh-5");
  assert.equal(ao.opened.length, 17);
  assertTerminalLogs(logs, [scratch, "example.com", "deploy", "secret detail", "SSH_TERMINAL", "C:\\\\keys", "shellterm", "bad handle", "AO said"]);
});

test("one terminal at a time: an open on its way holds the place too", async () => {
  const context = withAo();
  const { store, ao, behaviour } = context;
  const host = await pinnedHost(context, keyBlob("one at a time"));
  let release;
  const going = new Promise((resolve) => { release = resolve; });
  behaviour.open = async () => { await going; return { handle: "shellterm-ssh-slow", generation: "g" }; };
  const first = store.call("terminal_open", { id: host.id });
  // A double click, or the page asking again: refused while the first is on its way.
  await new Promise(setImmediate);
  assert.equal((await store.call("terminal_open", { id: host.id })).code, "already_open");
  release();
  assert.equal((await first).ok, true);
  assert.equal((await store.call("terminal_open", { id: host.id })).code, "already_open");
  assert.equal(ao.opened.length, 1);
  // A refused open frees the place: the next one is asked of AO.
  assert.deepEqual(await store.call("terminal_close", { handle: "shellterm-ssh-slow" }), { ok: true });
  behaviour.open = async () => { throw Object.assign(new Error("no"), { code: "SSH_TERMINAL_START_FAILED" }); };
  assert.equal((await store.call("terminal_open", { id: host.id })).code, "start_failed");
  behaviour.open = null;
  assert.equal((await store.call("terminal_open", { id: host.id })).ok, true);
  assert.equal(ao.opened.length, 3);
});

test("closeAll closes every terminal the store opened, best effort, and never throws", async () => {
  const context = withAo();
  const { store, ao, behaviour, logs } = context;
  const host = await pinnedHost(context, keyBlob("close all"));
  const closeLogs = () => logs.filter((entry) => entry[1] === "ssh.terminals_closed");

  // Nothing open: nothing asked of AO, nothing logged.
  assert.deepEqual(await store.closeAll("navigation"), { closed: 0, failed: 0 });
  assert.deepEqual([ao.closed, closeLogs()], [[], []]);

  // The page went away (a reload): its terminal is closed and forgotten, and a new one can open.
  const opened = await store.call("terminal_open", { id: host.id });
  assert.equal(opened.ok, true, opened.error);
  assert.deepEqual(await store.closeAll("navigation"), { closed: 1, failed: 0 });
  assert.deepEqual(ao.closed, [opened.terminal.handle]);
  assert.equal((await store.call("terminal_close", { handle: opened.terminal.handle })).code, "not_own", "forgotten");
  assert.deepEqual(closeLogs(), [["info", "ssh.terminals_closed", { count: 1, failed: 0 }]], "the event and counts only");

  // AO refused the close: still forgotten (no page can reach it), counted as failed, nothing thrown.
  // One AO no longer has (404) counts as closed. A close that throws at once is caught too.
  for (const [close, failed] of [
    [async () => { throw Object.assign(new Error("AO daemon unavailable at C:\\secret"), { status: 502 }); }, 1],
    [async () => { throw Object.assign(new Error("gone"), { status: 404 }); }, 0],
    [() => { throw new Error("thrown at once"); }, 1],
  ]) {
    behaviour.close = null;
    const next = await store.call("terminal_open", { id: host.id });
    assert.equal(next.ok, true, next.error);
    behaviour.close = close;
    assert.deepEqual(await store.closeAll("renderer_gone"), { closed: 1 - failed, failed });
    assert.equal((await store.call("terminal_close", { handle: next.terminal.handle })).code, "not_own");
  }
  for (const [level, , fields] of closeLogs()) {
    assert.ok(["info", "warn"].includes(level));
    assert.deepEqual(Object.keys(fields).sort(), ["count", "failed"]);
    assert.equal(JSON.stringify(fields).includes("secret"), false);
  }

  // An open on its way when the page goes away is closed as it arrives.
  behaviour.close = null;
  let release;
  const going = new Promise((resolve) => { release = resolve; });
  behaviour.open = async () => { await going; return { handle: "shellterm-ssh-late", generation: "g" }; };
  const late = store.call("terminal_open", { id: host.id });
  await new Promise(setImmediate);
  await store.closeAll("navigation");
  release();
  assert.deepEqual([(await late).ok, (await late).code], [false, "page_gone"]);
  assert.equal(ao.closed.at(-1), "shellterm-ssh-late");

  // dispose() closes too (a backend restart): through this store's own closeTerminal.
  behaviour.open = null;
  const kept = await store.call("terminal_open", { id: host.id });
  assert.equal(kept.ok, true, kept.error);
  await store.dispose();
  assert.equal(ao.closed.at(-1), kept.terminal.handle);
  assert.deepEqual(await store.closeAll("quit"), { closed: 0, failed: 0 }, "nothing left after dispose");
  // A store without AO's terminal has nothing to close.
  assert.deepEqual(await makeStore().store.closeAll("quit"), { closed: 0, failed: 0 });
});

test("a terminal whose host stops being approved, or whose store stops, while it opens is closed again", async () => {
  const held = () => {
    let release;
    let begin;
    const started = new Promise((resolve) => { begin = resolve; });
    const going = new Promise((resolve) => { release = resolve; });
    return { started, release: () => release(), open: (handle) => async () => { begin(); await going; return { handle, generation: "g" }; } };
  };
  for (const [name, meanwhile, code] of [
    ["blocked", async (context, host) => {
      context.clock.advance(60_000);
      context.fake.answer(serverShows(keyBlob("another key")));
      assert.equal((await context.store.fetchKey({ id: host.id })).host.state, "changed");
    }, "host_changed"],
    ["removed", async (context, host) => assert.equal((await context.store.remove({ id: host.id })).ok, true), "host_changed"],
    ["stopped", async (context) => { await context.store.dispose(); }, "restarting"],
  ]) {
    const context = withAo();
    const host = await pinnedHost(context, keyBlob(`held ${name}`));
    const open = held();
    context.behaviour.open = open.open(`shellterm-ssh-${name}`);
    const opening = context.store.call("terminal_open", { id: host.id });
    await open.started;
    // The open waits outside the change queue: the person's other changes are not held up by it.
    await meanwhile(context, host);
    open.release();
    const answer = await opening;
    assert.deepEqual([answer.ok, answer.code], [false, code], name);
    assert.deepEqual(context.ao.closed, [`shellterm-ssh-${name}`], `${name}: the terminal AO opened is closed again`);
    assert.equal((await context.store.call("terminal_close", { handle: `shellterm-ssh-${name}` })).code, "not_own", "and not kept");
  }
});

test("what leaves the store carries fingerprints, never a key blob", async () => {
  const pinnedBlob = keyBlob("pinned blob");
  const candidateBlob = keyBlob("candidate blob");
  const context = makeStore();
  const { store, fake } = context;
  const host = await pinnedHost(context, pinnedBlob);
  const approved = store.approvedHosts();
  assert.deepEqual(Object.keys(approved[0]).sort(), ["host", "id", "label", "port", "production", "user"]);
  fake.answer(serverShows(candidateBlob));
  const changed = await store.fetchKey({ id: host.id });
  const answers = [
    approved, changed, await store.list(), await store.update({ id: host.id, label: "Renamed" }),
    await store.call("list"), await store.confirmKey({ id: host.id, fingerprint: "wrong" }),
    await store.add({ ...HOST, user: "other" }), await store.remove({ id: "000000000000" }),
  ];
  for (const answer of answers) {
    const text = JSON.stringify(answer);
    assert.equal(text.includes(pinnedBlob), false);
    assert.equal(text.includes(candidateBlob), false);
    assert.equal(text.includes("blob"), false);
  }
  assert.deepEqual(Object.keys(changed.host).sort(), ["candidate", "createdAt", "host", "id", "identityFile", "key", "label", "port", "production", "state", "user"]);
  assert.deepEqual(Object.keys(changed.host.key).sort(), ["fingerprint", "method", "pinnedAt", "type"]);
  assert.deepEqual(Object.keys(changed.host.candidate).sort(), ["fetchedAt", "fingerprint", "type"]);
  // The blobs are in the store file only.
  const saved = readStore(context.file).hosts[0];
  assert.equal(saved.key.blob, pinnedBlob);
  assert.equal(saved.candidate.blob, candidateBlob);
});

test("approved hosts are the pinned ones only, in the shape the agent rules read", async () => {
  const context = makeStore();
  const { store, fake } = context;
  assert.deepEqual(store.approvedHosts(), [], "nothing is approved before the store has loaded");
  const production = await pinnedHost(context, keyBlob("prod"), { label: "Production", host: "prod.example.com", port: 2222, user: "deploy", production: true });
  const blocked = await pinnedHost(context, keyBlob("blocked"), { label: "Blocked", host: "blocked.example.com", user: "deploy" });
  const draft = (await store.add({ label: "Draft", host: "draft.example.com", user: "deploy" })).host;
  fake.answer(serverShows(keyBlob("fetched only"), "draft.example.com"), serverShows(keyBlob("someone else"), "blocked.example.com"));
  assert.equal((await store.fetchKey({ id: draft.id })).host.state, "draft");
  assert.equal((await store.fetchKey({ id: blocked.id })).host.state, "changed");
  assert.deepEqual(store.approvedHosts(), [
    { id: production.id, label: "Production", host: "prod.example.com", port: 2222, user: "deploy", production: true },
  ]);
  // The list handed out is a copy: changing it changes nothing here.
  store.approvedHosts()[0].host = "evil.example.com";
  store.approvedHosts().push({ host: "evil.example.com" });
  assert.equal(store.approvedHosts().length, 1);
  assert.equal(store.approvedHosts()[0].host, "prod.example.com");
  await store.remove({ id: production.id });
  assert.deepEqual(store.approvedHosts(), []);
});

test("a probe that times out, writes nothing, or answers for another host is said plainly and trusts nothing", async () => {
  const blob = keyBlob("never trusted");
  const context = makeStore();
  const { store, fake } = context;
  const { host } = await store.add({ ...HOST, port: 2222 });
  const before = { store: fs.readFileSync(context.file, "utf8"), pinned: fs.readFileSync(context.knownHostsFile, "utf8") };
  const name = "[example.com]:2222";
  const cases = [
    ["timeout", { result: { code: null, stdout: "", stderr: "", timedOut: true } }, /did not answer within 25 seconds.*No key was saved\.$/],
    // The limit passed after the server had answered: the answer is still not used.
    ["timeout", { write: `${name} ssh-ed25519 ${blob}\n`, result: { code: null, stdout: "", stderr: "", timedOut: true } }, /did not answer within 25 seconds/],
    ["no_key", { result: DENIED }, /The server sent no host key\..*No key was saved\.$/],
    ["no_key", { write: "", result: DENIED }, /The server sent no host key/],
    ["no_key", { write: "# only a comment\n\n", result: DENIED }, /The server sent no host key/],
    ["no_key", { result: { code: 255, stdout: "", stderr: "ssh: Could not resolve hostname example.com: No such host is known.\r\n" } }, /host name could not be found/],
    ["no_key", { result: { code: 255, stdout: "", stderr: "ssh: connect to host example.com port 2222: Connection refused\r\n" } }, /refused the connection\. Check the port/],
    ["no_key", { result: { code: 255, stdout: "", stderr: "ssh: connect to host example.com port 2222: Connection timed out\r\n" } }, /The server did not answer\./],
    ["no_key", { result: { code: 255, stdout: "", stderr: "command-line: line 0: Bad configuration option: kbdinteractiveauthentication\r\n" } }, /did not accept the app's settings/],
    ["wrong_host", { write: `other.example.com ssh-ed25519 ${blob}\n` }, /did not match this host, so it was not used.*No key was saved\.$/],
    // The right host on the default port is another known-hosts name than [host]:2222.
    ["wrong_host", { write: `example.com ssh-ed25519 ${blob}\n` }, /did not match this host/],
    ["wrong_host", { write: `[example.com]:22 ssh-ed25519 ${blob}\n` }, /did not match this host/],
    ["wrong_host", { write: `${name},other.example.com ssh-ed25519 ${blob}\n` }, /did not match this host/],
    ["wrong_host", { write: `* ssh-ed25519 ${blob}\n` }, /did not match this host/],
    ["unexpected_answer", { write: `${name} ssh-ed25519 ${blob}\nother.example.com ssh-ed25519 ${blob}\n` }, /did not match this host/],
    ["unexpected_answer", { write: `${name} ssh-ed25519 ${blob}\n`.repeat(2000) }, /did not match this host/],
    ["malformed_answer", { write: `@cert-authority ${name} ssh-ed25519 ${blob}\n` }, /did not match this host/],
    ["malformed_answer", { write: `${name} ssh-rsa ${blob}\n` }, /did not match this host/],
    ["malformed_answer", { write: `${name} ssh-ed25519 not-a-key\n` }, /did not match this host/],
    ["not_started", () => { throw new Error("spawn ENOENT"); }, /OpenSSH could not be started.*No key was saved\.$/],
    ["not_started", { result: { code: null, stdout: "", stderr: "", failed: true } }, /OpenSSH could not be started/],
    // ssh left a line but never reported an exit code: it did not run to its end, so the line is not read.
    ["not_started", { write: `${name} ssh-ed25519 ${blob}\n`, result: { code: null, stdout: "", stderr: "" } }, /OpenSSH could not be started/],
    ["not_started", { write: `${name} ssh-ed25519 ${blob}\n`, result: {} }, /OpenSSH could not be started/],
  ];
  for (const [code, step, message] of cases) {
    fake.answer(step);
    const answer = await store.fetchKey({ id: host.id });
    assert.equal(answer.ok, false, code);
    assert.equal(answer.code, code);
    assert.match(answer.error, message, code);
    assert.equal(answer.error.includes(blob), false);
    assert.equal(answer.error.includes("SHA256:"), false);
    assert.equal(fs.readFileSync(context.file, "utf8"), before.store, `${code}: the store is unchanged`);
    assert.equal(fs.readFileSync(context.knownHostsFile, "utf8"), before.pinned, `${code}: nothing is pinned`);
    assert.deepEqual((await store.list()).hosts, [host], `${code}: no candidate is kept`);
    assert.deepEqual(store.approvedHosts(), []);
    assert.deepEqual(fs.readdirSync(context.probeDir), [], `${code}: the throwaway folder is removed`);
  }
  assert.equal(fake.probes().length, cases.length);
  // A failed fetch leaves a pinned host as it was, too.
  const second = makeStore();
  const pinned = await pinnedHost(second, blob);
  second.fake.answer({ result: { code: null, stdout: "", stderr: "", timedOut: true } }, { write: `evil.example.com ssh-ed25519 ${keyBlob("evil")}\n` });
  assert.equal((await second.store.fetchKey({ id: pinned.id })).ok, false);
  assert.equal((await second.store.fetchKey({ id: pinned.id })).ok, false);
  assert.deepEqual((await second.store.list()).hosts, [pinned]);
  assert.equal(second.store.approvedHosts().length, 1);
});

test("without a usable ssh client nothing is fetched, and the list still answers", async () => {
  const clock = fakeClock();
  const context = makeStore({ clock, run: async () => { throw new Error("spawn ENOENT"); } });
  const { host } = await context.store.add(HOST);
  const listed = await context.store.list();
  assert.deepEqual(listed, { ok: true, client: null, hosts: [host] });
  const answer = await context.store.fetchKey({ id: host.id });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, "no_client");
  assert.match(answer.error, /OpenSSH was not found on this computer.*No key was saved\.$/);

  // A client that could not be read is not started again on every list, only after a while.
  const asked = [];
  const later = makeStore({ clock, run: async (...call) => { asked.push(call); return { code: 1, stdout: "", stderr: "" }; } });
  await later.store.list();
  await later.store.list();
  assert.equal(asked.length, 1);
  clock.advance(61_000);
  await later.store.list();
  assert.equal(asked.length, 2);
});

test("the host, port and user cannot be changed, and nothing takes an extra argument", async () => {
  const context = makeStore();
  const { store } = context;
  const host = await pinnedHost(context, keyBlob("bound"));
  for (const change of [{ host: "evil.example.com" }, { port: 2222 }, { user: "root" }, { identityFile: "C:\\Keys\\other" }]) {
    const answer = await store.update({ id: host.id, ...change });
    assert.equal(answer.ok, false, JSON.stringify(change));
    assert.match(answer.error, /cannot be changed, because the pinned key belongs to them\. Remove this host and add it again\./);
  }
  for (const [operation, args] of [
    ["update", { id: host.id, state: "pinned" }], ["update", { id: host.id, key: {} }], ["update", "rename"],
    ["remove", { id: host.id, force: true }], ["fetch_key", { id: host.id, port: 2222 }], ["fetch_key", { id: host.id, extraArgs: ["-A"] }],
    ["add", { ...HOST, user: "second", state: "pinned" }], ["add", { ...HOST, user: "second", key: { type: "ssh-ed25519", blob: keyBlob("x") } }],
  ]) {
    const answer = await store.call(operation, args);
    assert.equal(answer.ok, false, `${operation} ${JSON.stringify(args)}`);
    assert.match(answer.error, /no extra options or arguments/);
  }
  assert.match((await store.update({ id: host.id, label: "" })).error, /^Name: /);
  assert.match((await store.update({ id: host.id, production: "yes" })).error, /^Production: /);
  assert.match((await store.update({ id: "nope" })).error, /no longer in the list/);
  assert.match((await store.remove({})).error, /no longer in the list/);
  // The terminal takes a host id or a handle and nothing else: no command, port or option of its own.
  for (const [operation, args] of [
    ["terminal_open", { id: host.id, command: "id" }], ["terminal_open", { id: host.id, port: 2222 }], ["terminal_open", { id: host.id, extraArgs: ["-A"] }],
    ["terminal_open", "example.com"], ["terminal_close", { handle: "shellterm-1", force: true }], ["terminal_close", ["shellterm-1"]],
  ]) {
    const answer = await store.call(operation, args);
    assert.equal(answer.ok, false, `${operation} ${JSON.stringify(args)}`);
    assert.match(answer.error, /no extra options or arguments/);
  }
  assert.match((await store.call("terminal_command", { id: host.id })).error, /no such action/);
  assert.match((await store.call("constructor", {})).error, /no such action/);
  assert.equal(context.fake.probes().length, 1, "a refused call starts nothing");
  assert.deepEqual((await store.list()).hosts, [host]);

  const renamed = await store.update({ id: host.id, label: "  Renamed  ", production: true });
  assert.equal(renamed.host.label, "Renamed");
  assert.equal(renamed.host.production, true);
  assert.equal(renamed.host.state, "pinned");
  assert.deepEqual(renamed.host.key, host.key);
  assert.deepEqual(store.approvedHosts(), [{ id: host.id, label: "Renamed", host: "example.com", port: 22, user: "deploy", production: true }]);
});

test("add refuses a wrong field with its reason, a missing key file, a duplicate and a full list", async () => {
  const seen = [];
  const context = makeStore({ fileExists: async (file) => { seen.push(file); return !file.includes("missing"); } });
  const { store } = context;
  for (const [fields, reason] of [
    [{ ...HOST, host: "deploy@example.com" }, /^Host: enter the host name only\. The user has its own field\./],
    [{ ...HOST, host: "ssh://example.com" }, /^Host: .*not an ssh:\/\/ address/],
    [{ ...HOST, user: "de ploy" }, /^User: /],
    [{ ...HOST, port: 0 }, /^Port: /],
    [{ ...HOST, label: " " }, /^Name: /],
    [{ ...HOST, identityFile: "relative-key" }, /^Key file: /],
    [{ ...HOST, proxyCommand: "calc.exe" }, /no extra options or arguments/],
    [undefined, /Enter the host's name, host, port and user/],
  ]) {
    const answer = await store.add(fields);
    assert.equal(answer.ok, false, JSON.stringify(fields));
    assert.match(answer.error, reason, JSON.stringify(fields));
  }
  const keys = path.join(context.root, "keys");
  const missing = await store.add({ ...HOST, identityFile: path.join(keys, "missing_key") });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /^Key file: no file was found at that path/);
  const withKey = await store.add({ ...HOST, identityFile: path.join(keys, "id_ed25519") });
  assert.equal(withKey.ok, true, withKey.error);
  assert.equal(withKey.host.identityFile, path.join(keys, "id_ed25519"), "the path is kept, never the file's contents");
  assert.deepEqual(seen, [path.join(keys, "missing_key"), path.join(keys, "id_ed25519")]);
  assert.equal(fs.existsSync(keys), false, "the store never opens or creates the key file");

  assert.match((await store.add({ ...HOST, host: "EXAMPLE.com", label: "Again" })).error, /already in the list with that port and user/);
  assert.equal((await store.add({ ...HOST, user: "other" })).ok, true, "another user on the same host is another entry");
  assert.equal((await store.add({ ...HOST, port: 2222 })).ok, true);
  assert.equal(readStore(context.file).hosts.length, 3);
  assert.equal(context.fake.calls.length, 0, "adding a host contacts nothing");

  // A full list takes no more, and a saved list longer than the limit is cut at it.
  const fullRoot = path.join(scratch, "full list", "integrations");
  fs.mkdirSync(fullRoot, { recursive: true });
  const many = Array.from({ length: 201 }, (_, index) => ({
    id: index.toString(16).padStart(12, "0"), label: `Host ${index}`, host: `h${index}.example.com`, port: 22, user: "deploy",
    identityFile: null, production: false, state: "draft", key: null, candidate: null, createdAt: "2026-11-26T12:00:00.000Z",
  }));
  fs.writeFileSync(path.join(fullRoot, "ssh-hosts.json"), JSON.stringify({ version: 1, hosts: many }));
  const full = makeStore({ root: fullRoot });
  assert.equal((await full.store.list()).hosts.length, 200);
  const overflow = await full.store.add(HOST);
  assert.deepEqual([overflow.ok, overflow.code, overflow.error], [false, "full", "The list holds up to 200 hosts. Remove one first."]);
  assert.equal((await full.store.remove({ id: many[0].id })).ok, true);
  assert.equal((await full.store.add(HOST)).ok, true);
});

test("a saved list loads again as it was; what was tampered with is not trusted", async () => {
  const good = keyBlob("good");
  const context = makeStore();
  const pinned = await pinnedHost(context, good);
  await context.store.dispose();
  const saved = readStore(context.file);
  const at = "2026-11-26T12:00:00.000Z";
  const base = { label: "Tampered", port: 22, user: "deploy", identityFile: null, production: false, candidate: null, createdAt: at };
  const forgedKey = { type: "ssh-ed25519", blob: keyBlob("forged"), fingerprint: fingerprint(good), pinnedAt: at, method: "pasted" };
  saved.hosts.push(
    // Says pinned, has no key.
    { ...base, id: "aaaaaaaaaaaa", host: "nokey.example.com", state: "pinned", key: null },
    // A key that is not a key.
    { ...base, id: "bbbbbbbbbbbb", host: "badkey.example.com", state: "pinned", key: { ...forgedKey, blob: "AAAA" } },
    // A key whose confirmation method is made up.
    { ...base, id: "cccccccccccc", host: "method.example.com", state: "pinned", key: { ...forgedKey, method: "always" } },
    // A fingerprint that does not belong to its blob: the blob decides.
    { ...base, id: "dddddddddddd", host: "forged.example.com", state: "pinned", key: forgedKey, extraArgs: "-oProxyCommand=calc.exe" },
    // Fields no host can have.
    { ...base, id: "eeeeeeeeeeee", host: "-oProxyCommand=calc.exe", state: "pinned", key: forgedKey },
    { ...base, id: "ffffffffffff", host: "user.example.com", user: "de ploy", state: "pinned", key: forgedKey },
    { ...base, id: "not-an-id", host: "id.example.com", state: "pinned", key: forgedKey },
    { ...base, id: "111111111111", host: "Upper.example.com", state: "pinned", key: forgedKey },
    { ...base, id: "222222222222", host: "state.example.com", state: "trusted", key: forgedKey },
    { ...base, id: pinned.id, host: "duplicate-id.example.com", state: "pinned", key: forgedKey },
    "not a record",
  );
  fs.writeFileSync(context.file, JSON.stringify(saved));

  const reloaded = makeStore({ root: context.root });
  const { hosts } = await reloaded.store.list();
  assert.deepEqual(hosts.map((host) => [host.host, host.state]), [
    ["example.com", "pinned"], ["nokey.example.com", "draft"], ["badkey.example.com", "draft"],
    ["method.example.com", "draft"], ["forged.example.com", "pinned"],
  ]);
  assert.deepEqual(hosts[0], pinned, "the good record is exactly as it was saved");
  assert.equal(hosts[4].key.fingerprint, fingerprint(forgedKey.blob), "the fingerprint is worked out from the blob, not read from the file");
  assert.deepEqual(reloaded.store.approvedHosts().map((host) => host.host), ["example.com", "forged.example.com"]);
  assert.deepEqual(pinnedLines(context.knownHostsFile), [`example.com ssh-ed25519 ${good}`, `forged.example.com ssh-ed25519 ${forgedKey.blob}`]);
  assert.deepEqual(reloaded.logs.find((entry) => entry[1] === "ssh.store_loaded"), ["warn", "ssh.store_loaded", { hosts: 5, pinned: 2, dropped: 7, repaired: 0, unreadable: false }]);
  // The next save writes only what a record can hold, and the file the dropped records were in is
  // kept beside it first.
  const tampered = fs.readFileSync(context.file, "utf8");
  await reloaded.store.update({ id: hosts[1].id, label: "Seen" });
  assert.equal(fs.readFileSync(context.file, "utf8").includes("ProxyCommand"), false);
  assert.equal(fs.readFileSync(`${context.file}.unreadable`, "utf8"), tampered);
});

test("a saved list is held to the rules the operations keep, and what load leaves out is kept aside", async () => {
  const root = path.join(scratch, "hand edited", "integrations");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "ssh-hosts.json");
  const k1 = keyBlob("one");
  const k2 = keyBlob("two");
  const before = "2026-11-26T11:00:00.000Z";
  const at = "2026-11-26T12:00:00.000Z";
  const after = "2026-11-26T13:00:00.000Z";
  const pinnedKey = (blob, pinnedAt = at) => ({ type: "ssh-ed25519", blob, fingerprint: fingerprint(blob), pinnedAt, method: "compared" });
  const fetchedKey = (blob, fetchedAt) => ({ type: "ssh-ed25519", blob, fingerprint: fingerprint(blob), fetchedAt });
  let next = 0;
  const record = (fields) => ({
    id: (++next).toString(16).padStart(12, "0"), label: `Host ${next}`, port: 22, user: "deploy", identityFile: null,
    production: false, state: "pinned", key: pinnedKey(k1), candidate: null, createdAt: before, ...fields,
  });
  const production = [
    record({ host: "string.example.com", production: "true" }),
    record({ host: "number.example.com", production: 1 }),
    record({ host: "missing.example.com", production: undefined }),
  ];
  const twice = [record({ host: "twice.example.com" }), record({ host: "twice.example.com", label: "Same entry again" })];
  const twoKeys = [record({ host: "two-keys.example.com" }), record({ host: "two-keys.example.com", user: "root", key: pinnedKey(k2) })];
  // Another entry was shown another key after this one was approved, then before.
  const late = [record({ host: "late.example.com" }), record({ host: "late.example.com", user: "root", state: "draft", key: null, candidate: fetchedKey(k2, after) })];
  const early = [record({ host: "early.example.com" }), record({ host: "early.example.com", user: "root", state: "draft", key: null, candidate: fetchedKey(k2, before) })];
  const damaged = record({ host: "damaged.example.com", label: "x".repeat(61) });
  const saved = { version: 1, hosts: [...production, ...twice, ...twoKeys, ...late, ...early, damaged] };
  const text = JSON.stringify(saved);
  fs.writeFileSync(file, text);

  const context = makeStore({ root });
  const listed = (await context.store.list()).hosts;
  assert.deepEqual(listed.map((host) => [host.host, host.user, host.state, host.production]), [
    // A production flag that is not a boolean is read as on, never as off.
    ["string.example.com", "deploy", "pinned", true],
    ["number.example.com", "deploy", "pinned", true],
    ["missing.example.com", "deploy", "pinned", true],
    // One entry for each host, port and user: the second is left out, as add would refuse it.
    ["twice.example.com", "deploy", "pinned", false],
    // Two keys approved for one server would each be accepted by ssh for both entries.
    ["two-keys.example.com", "deploy", "changed", false],
    ["two-keys.example.com", "root", "changed", false],
    ["late.example.com", "deploy", "changed", false],
    ["late.example.com", "root", "draft", false],
    ["early.example.com", "deploy", "pinned", false],
    ["early.example.com", "root", "draft", false],
  ]);
  assert.deepEqual(context.store.approvedHosts().map((host) => [host.host, host.production]), [
    ["string.example.com", true], ["number.example.com", true], ["missing.example.com", true], ["twice.example.com", false], ["early.example.com", false],
  ]);
  assert.equal(pinnedLines(context.knownHostsFile).some((line) => /two-keys|late/.test(line)), false);
  assert.deepEqual(context.logs.find((entry) => entry[1] === "ssh.store_loaded"),
    ["warn", "ssh.store_loaded", { hosts: 10, pinned: 5, dropped: 2, repaired: 6, unreadable: false }]);

  // The file is left alone until a change; then its records left out are kept in a copy beside it.
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.equal((await context.store.update({ id: listed[0].id, label: "Seen" })).ok, true);
  assert.equal(fs.readFileSync(`${file}.unreadable`, "utf8"), text);
  assert.deepEqual(readStore(file).hosts.map((host) => host.id), listed.map((host) => host.id));
  assert.deepEqual(readStore(file).hosts.slice(0, 3).map((host) => host.production), [true, true, true]);
  // Once: the next change makes no second copy.
  assert.equal((await context.store.update({ id: listed[0].id, label: "Seen again" })).ok, true);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes(".unreadable")), ["ssh-hosts.json.unreadable"]);
});

test("an IPv6 address is kept in the form ssh writes, so its key can be fetched and one server is one host", async () => {
  const blob = keyBlob("ipv6");
  const context = makeStore();
  const { store, fake } = context;
  const added = await store.add({ label: "IPv6 box", host: "2001:0DB8:0:0:0:0:0:1", port: 22, user: "deploy" });
  assert.equal(added.ok, true, added.error);
  assert.equal(added.host.host, "2001:db8::1");
  // The client names the key by the short form ("2001:0db8::1" -> "2001:db8::1", ssh -G on the target machine).
  fake.answer(serverShows(blob, "2001:db8::1"));
  const fetched = await store.fetchKey({ id: added.host.id });
  assert.equal(fetched.ok, true, fetched.error);
  assert.equal(fake.probes()[0].argv.at(-1), "2001:db8::1");
  for (const spelling of ["2001:db8::1", "2001:db8::0:1", "2001:0db8::0001"]) {
    const again = await store.add({ label: "Same address", host: spelling, port: 22, user: "deploy" });
    assert.deepEqual([again.ok, again.code], [false, "duplicate"], spelling);
  }
  // A saved record in any other spelling is not one the app wrote: it is left out, as an upper-case host is.
  await store.dispose();
  const saved = readStore(context.file);
  saved.hosts.push({ ...saved.hosts[0], id: "abcdefabcdef", host: "2001:db8:0:0:0:0:0:2" });
  fs.writeFileSync(context.file, JSON.stringify(saved));
  const restarted = makeStore({ root: context.root });
  assert.deepEqual((await restarted.store.list()).hosts.map((host) => host.host), ["2001:db8::1"]);
});

test("a store file that cannot be read trusts nothing and is kept aside, not overwritten", async () => {
  for (const [name, content] of [["torn", "{\"version\":1,\"hosts\":[{\"id\":\"aaaa"], ["newer", JSON.stringify({ version: 2, hosts: [] })], ["nul", "\x00".repeat(64)]]) {
    const root = path.join(scratch, `unreadable ${name}`, "integrations");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "ssh-hosts.json"), content);
    fs.writeFileSync(path.join(root, "ssh-known-hosts"), `stale.example.com ssh-ed25519 ${keyBlob("stale")}\n`);
    const context = makeStore({ root });
    const listed = await context.store.list();
    assert.deepEqual(listed.hosts, [], name);
    // An empty list is not shown as if it were the person's.
    assert.equal(listed.notice, "The saved SSH hosts list could not be read, so no host is approved. The next change keeps that file beside a new list; nothing in it is deleted.");
    assert.deepEqual(context.store.approvedHosts(), []);
    assert.deepEqual(pinnedLines(context.knownHostsFile), [], `${name}: no stale line stays trusted`);
    assert.equal(fs.readFileSync(context.file, "utf8"), content, `${name}: the file is left alone until something changes`);
    assert.equal((await context.store.add(HOST)).ok, true);
    assert.equal(fs.readFileSync(`${context.file}.unreadable`, "utf8"), content, `${name}: kept beside the new file`);
    assert.equal(readStore(context.file).hosts.length, 1);
    assert.equal((await context.store.list()).notice, undefined, "the new list is the person's");
  }

  // A file that cannot be set aside is not written over: it may hold the person's whole list. Every
  // name beside it is taken here (copies set aside before are never replaced).
  const root = path.join(scratch, "unreadable stuck", "integrations");
  const torn = "{\"version\":1,\"hosts\":[";
  const stamp = "20261126T120000Z";
  const taken = ["ssh-hosts.json.unreadable", `ssh-hosts.json.unreadable-${stamp}`, ...Array.from({ length: 8 }, (_, index) => `ssh-hosts.json.unreadable-${stamp}-${index + 2}`)];
  for (const name of taken) fs.mkdirSync(path.join(root, name, "in the way"), { recursive: true });
  fs.writeFileSync(path.join(root, "ssh-hosts.json"), torn);
  const stuck = makeStore({ root });
  const refused = await stuck.store.add(HOST);
  assert.deepEqual([refused.ok, refused.code], [false, "save_failed"]);
  assert.match(refused.error, /could not be read, and it could not be set aside, so nothing was changed\. Restart the app, then try again\./);
  assert.equal(fs.readFileSync(stuck.file, "utf8"), torn);
  assert.deepEqual((await stuck.store.list()).hosts, []);
  assert.deepEqual(stuck.store.approvedHosts(), []);
  fs.rmSync(path.join(root, taken.at(-1)), { recursive: true });
  assert.equal((await stuck.store.add(HOST)).ok, true, "once a name is free the change lands");
  assert.equal(fs.readFileSync(path.join(root, taken.at(-1)), "utf8"), torn);
});

test("a store file that could not be read at start is read again before a change, and no copy set aside is replaced", async () => {
  const first = makeStore();
  await pinnedHost(first, keyBlob("one"));
  await pinnedHost(first, keyBlob("two"), { ...HOST, host: "two.example.com" });
  await first.store.dispose();

  // Held by another program at start (here a folder in its place, so every read fails), then back.
  fs.renameSync(first.file, `${first.file}.held`);
  fs.mkdirSync(first.file);
  const second = makeStore({ root: first.root });
  const listed = await second.store.list();
  assert.deepEqual(listed.hosts, []);
  assert.match(listed.notice, /could not be read, so no host is approved/);
  assert.deepEqual(second.store.approvedHosts(), []);
  fs.rmdirSync(first.file);
  fs.renameSync(`${first.file}.held`, first.file);
  const added = await second.store.add({ ...HOST, host: "three.example.com" });
  assert.equal(added.ok, true, added.error);
  assert.deepEqual(readStore(first.file).hosts.map((host) => host.host), ["example.com", "two.example.com", "three.example.com"], "the list is not replaced by one host");
  assert.equal(fs.readdirSync(first.root).some((name) => name.includes(".unreadable")), false, "nothing needed setting aside");
  assert.equal(second.store.approvedHosts().length, 2);
  assert.equal((await second.store.list()).notice, undefined);
  assert.ok(second.logs.some((entry) => entry[1] === "ssh.store_loaded" && entry[2].again === true && entry[2].hosts === 2));
  await second.store.dispose();

  // Damaged twice: each copy set aside is kept.
  for (const [index, content] of [JSON.stringify({ version: 2, hosts: [] }), "damaged again", "and again"].entries()) {
    fs.writeFileSync(first.file, content);
    const next = makeStore({ root: first.root });
    assert.equal((await next.store.add({ ...HOST, host: `after-${index}.example.com` })).ok, true);
    await next.store.dispose();
  }
  assert.equal(fs.readFileSync(`${first.file}.unreadable`, "utf8"), JSON.stringify({ version: 2, hosts: [] }));
  assert.equal(fs.readFileSync(`${first.file}.unreadable-20261126T120000Z`, "utf8"), "damaged again");
  assert.equal(fs.readFileSync(`${first.file}.unreadable-20261126T120000Z-2`, "utf8"), "and again");
});

test("a stopped store changes nothing more, and the one that replaces it reads what it left", async () => {
  const blob = keyBlob("handoff");
  const first = makeStore();
  const host = await pinnedHost(first, blob);
  // A fetch is still running when the backend restarts, and a rename was just asked for.
  const probe = heldProbe(`example.com ssh-ed25519 ${keyBlob("late")}\n`);
  first.fake.answer(probe.step);
  const running = first.store.fetchKey({ id: host.id });
  await probe.started;
  const renaming = first.store.update({ id: host.id, label: "Renamed before the restart" });
  const stopped = first.store.dispose();
  assert.equal(first.store.dispose(), stopped, "stopping twice is the same stop");
  const second = makeStore({ root: first.root, after: stopped });
  assert.equal((await renaming).ok, true, "a change already asked for lands");
  assert.equal((await second.store.list()).hosts[0].label, "Renamed before the restart", "and the new store waited for it");
  probe.finish();
  const late = await running;
  assert.equal(late.ok, false, "the stopped store does not save the late answer");
  assert.match(late.error, /restarting/);
  for (const answer of [await first.store.add({ ...HOST, user: "late" }), await first.store.remove({ id: host.id }), await first.store.confirmKey({ id: host.id, fingerprint: "x" })]) {
    assert.equal(answer.ok, false);
    assert.equal(answer.code, "restarting");
  }
  assert.deepEqual((await second.store.list()).hosts.map((entry) => [entry.label, entry.state, entry.candidate]), [["Renamed before the restart", "pinned", null]]);
  assert.deepEqual(pinnedLines(first.knownHostsFile), [`example.com ssh-ed25519 ${blob}`]);
  assert.equal(readStore(first.file).hosts.length, 1);
});

test("two fetches for one host at once are one probe, and a host removed meanwhile gets no key", async () => {
  const blob = keyBlob("shared");
  const context = makeStore();
  const { store, fake } = context;
  const { host } = await store.add(HOST);
  const shared = heldProbe(`example.com ssh-ed25519 ${blob}\n`);
  fake.answer(shared.step);
  const both = [store.fetchKey({ id: host.id }), store.call("fetch_key", { id: host.id })];
  await shared.started;
  await store.list();
  assert.equal(fake.probes().length, 1);
  shared.finish();
  const [one, two] = await Promise.all(both);
  assert.deepEqual(one, two);
  assert.equal(one.host.candidate.fingerprint, fingerprint(blob));
  assert.equal(fake.probes().length, 1, "the second click got the first probe's answer");

  const orphaned = heldProbe(`example.com ssh-ed25519 ${blob}\n`);
  fake.answer(orphaned.step);
  const fetching = store.fetchKey({ id: host.id });
  await orphaned.started;
  assert.equal((await store.remove({ id: host.id })).ok, true);
  orphaned.finish();
  const gone = await fetching;
  assert.equal(gone.ok, false);
  assert.match(gone.error, /no longer in the list/);
  assert.deepEqual(readStore(context.file).hosts, []);
});

test("no log call carries a path, a command line, a host or user name, or a fingerprint", async () => {
  const first = keyBlob("log one");
  const second = keyBlob("log two");
  const context = makeStore();
  const { store, fake, logs } = context;
  const keyFile = path.join(context.root, "keys", "id_ed25519");
  const host = await pinnedHost(context, first, { ...HOST, identityFile: keyFile });
  fake.answer(
    { result: { code: null, stdout: "", stderr: "", timedOut: true } },
    { write: `other.example.com ssh-ed25519 ${second}\n` },
    { result: { code: 255, stdout: "", stderr: "ssh: Could not resolve hostname example.com\r\n" } },
    serverShows(second),
  );
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await store.fetchKey({ id: host.id })).ok, false);
  assert.equal((await store.fetchKey({ id: host.id })).host.state, "changed");
  await store.confirmKey({ id: host.id, fingerprint: fingerprint(second), pasted: "SHA256:wrong" });
  await store.confirmKey({ id: host.id, fingerprint: fingerprint(second), pasted: fingerprint(second) });
  await store.add({ ...HOST, host: "deploy@example.com" });
  await store.update({ id: host.id, label: "Renamed", production: true });
  await store.update({ id: host.id, host: "evil.example.com" });
  await store.list();
  await store.remove({ id: host.id });
  // A save that fails is logged by its error code alone (the message names the file).
  const blocked = makeStore();
  await blocked.store.ready();
  fs.mkdirSync(path.join(blocked.file, "in the way"), { recursive: true });
  const unsaved = await blocked.store.add(HOST);
  assert.equal(unsaved.ok, false);
  assert.match(unsaved.error, /could not be saved, so nothing was changed/);
  assert.deepEqual((await blocked.store.list()).hosts, [], "a failed save changes nothing");
  // An unexpected failure inside an action, too.
  const broken = makeStore({ fileExists: async () => { throw Object.assign(new Error(`EACCES: permission denied, stat '${keyFile}'`), { code: "EACCES" }); } });
  const failed = await broken.store.add({ ...HOST, identityFile: keyFile });
  assert.deepEqual(failed, { ok: false, error: "The SSH hosts list could not finish that. Try again.", code: "unexpected" });

  const all = [...logs, ...blocked.logs, ...broken.logs];
  const events = all.map((entry) => entry[1]);
  for (const expected of ["ssh.store_loaded", "ssh.host_added", "ssh.key_fetched", "ssh.key_fetch_failed", "ssh.key_pinned", "ssh.host_updated", "ssh.host_removed", "ssh.store_save_failed", "ssh.operation_failed"]) {
    assert.ok(events.includes(expected), `${expected} is logged`);
  }
  const forbidden = [
    scratch, scratch.replaceAll("\\", "/"), "user data", "integrations", "ssh-hosts.json", "ssh-known-hosts", "known_hosts", "ssh-probe", "id_ed25519", "keys",
    "example.com", "deploy", "Build server", "Renamed", PROGRAM, "ssh.exe", "OpenSSH", "UserKnownHostsFile", "StrictHostKeyChecking", "-o", "--",
    "SHA256:", first, second, fingerprint(first).slice(7), fingerprint(second).slice(7), "Permission denied", "Could not resolve", "EACCES: ",
  ];
  for (const [level, event, fields, ...rest] of all) {
    assert.ok(["info", "warn", "error"].includes(level));
    assert.match(event, /^ssh\.[a-z_]+$/);
    assert.deepEqual(rest, [], `${event} logs one object of fields`);
    const text = JSON.stringify(fields);
    for (const secret of forbidden) assert.equal(text.includes(secret), false, `${event} must not log ${JSON.stringify(secret)}: ${text}`);
    // Event names, a host id, counts and short codes only.
    for (const [name, value] of Object.entries(fields)) {
      const plain = typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && /^[A-Za-z0-9_]{1,24}$/.test(value));
      assert.ok(plain, `${event}.${name} is a count, a flag, an id or a code: ${JSON.stringify(value)}`);
    }
  }
  assert.deepEqual(all.find((entry) => entry[1] === "ssh.key_pinned"), ["info", "ssh.key_pinned", { hostId: host.id, method: "compared" }]);
  assert.deepEqual(all.filter((entry) => entry[1] === "ssh.key_fetch_failed").map((entry) => entry[2].reason), ["timeout", "wrong_host", "no_key"]);
});

// ---------------------------------------------------------------------------------------------
// Who can reach it

function sshService() {
  const calls = [];
  return { calls, call: async (operation, args) => { calls.push([operation, args]); return { ok: true, hosts: [] }; } };
}

test("the app module names its operations, and only list reads", async () => {
  const service = sshService();
  const host = createCodingToolsAppsHost({ services: { sshConnections: service.call } });
  const listed = host.catalog().modules.find((entry) => entry.id === "ssh-connections");
  assert.deepEqual(listed.operations.map((entry) => [entry.name, entry.readOnly]), [
    ["inspect", false], ["list", true], ["add", false], ["update", false], ["remove", false], ["fetch_key", false], ["confirm_key", false],
    ["terminal_open", false], ["terminal_close", false],
  ]);
  assert.deepEqual(listed.operations.filter((entry) => entry.readOnly).map((entry) => entry.name), ["list"], "list is the only read");
  assert.equal(host.isReadOnly("ssh-connections", "list"), true);
  for (const operation of [...WRITE_OPERATIONS, "inspect", "terminal_command", "constructor", "toString", "LIST", "list ", ""]) {
    assert.equal(host.isReadOnly("ssh-connections", operation), false, operation);
  }
  assert.deepEqual(ssh.OPERATIONS, ["list", ...WRITE_OPERATIONS]);
  // inspect describes the module and reads nothing.
  const inspected = await host.call("ssh-connections", "inspect");
  assert.equal(inspected.result.status, "ready");
  assert.equal(inspected.result.agentAccess, "none");
  assert.deepEqual(service.calls, []);
  await host.call("ssh-connections", "list");
  await host.call({ moduleId: "ssh-connections", operation: "add", arguments: HOST });
  await host.call("ssh-connections", "terminal_open", { id: "aaaaaaaaaaaa" });
  await host.call("ssh-connections", "terminal_close", { handle: "shellterm-ssh-1" });
  assert.deepEqual(service.calls, [["list", {}], ["add", HOST], ["terminal_open", { id: "aaaaaaaaaaaa" }], ["terminal_close", { handle: "shellterm-ssh-1" }]]);
  // The command line is still no operation of the module.
  await assert.rejects(host.call("ssh-connections", "terminal_command", {}), /does not expose terminal_command/);
  const unavailable = await createCodingToolsAppsHost().call("ssh-connections", "list");
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.result.error, /SSH hosts are unavailable right now/);
});

test("the window's own apps.call carries the hosts, with fingerprints and without key blobs", async () => {
  const blob = keyBlob("over ipc");
  const context = makeStore();
  const pinned = await pinnedHost(context, blob);
  const host = createCodingToolsAppsHost({ services: { sshConnections: (operation, args) => context.store.call(operation, args) } });
  // The preload's contract check and the response's sensitive-key check both pass.
  const ipc = { invoke: async (_channel, payload) => host.call(payload.moduleId, payload.operation, payload.arguments || {}) };
  const answer = await invokeContract(ipc, "apps.call", { moduleId: "ssh-connections", operation: "list" });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.result, { ok: true, client: { path: PROGRAM, version: "OpenSSH_for_Windows_9.5p2" }, hosts: [pinned] });
  assert.equal(JSON.stringify(answer).includes(blob), false);
  const refused = await invokeContract(ipc, "apps.call", { moduleId: "ssh-connections", operation: "confirm_key", arguments: { id: pinned.id, fingerprint: "x" } });
  assert.equal(refused.ok, false);
  assert.match(refused.result.error, /Fetch the server's key first/);
});

test("agents cannot list, describe or call the SSH hosts module through the apps tools", async () => {
  assert.deepEqual(PERSON_ONLY_MODULES, ["ssh-connections"]);
  const service = sshService();
  const host = createCodingToolsAppsHost({
    services: { sshConnections: service.call, inspect: async (id) => ({ id, status: "ready" }) },
  });
  assert.ok(host.list().modules.some((entry) => entry.id === "ssh-connections"), "the window's host has the module");
  const mcp = createCodingToolsAppsMcp({ getHost: () => host });

  // What an agent's catalog read reaches (control-server.cjs: apps_list, apps_catalog, apps_status).
  for (const tool of ["apps_list", "apps_catalog", "apps_status"]) {
    const answer = await mcp.callTool(tool, {});
    assert.deepEqual(answer.modules.map((entry) => entry.id), ["cpa", "agent-orchestrator", "antigravity-cli"], tool);
    assert.equal(JSON.stringify(answer).includes("ssh-connections"), false, `${tool} does not name the module`);
    assert.equal(JSON.stringify(answer).includes("fetch_key"), false, `${tool} does not name its operations`);
  }

  const operations = ["list", "inspect", ...WRITE_OPERATIONS];
  const spellings = ["ssh-connections", " ssh-connections ", "SSH-Connections", "ssh-connections\n"];
  for (const operation of operations) {
    for (const id of spellings) {
      for (const [tool, args] of [
        ["apps_call", { moduleId: id, operation, arguments: HOST }],
        ["apps_call", { handle: id, operation, arguments: HOST }],
        ["apps_call", { moduleId: "cpa", handle: id, operation: "inspect" }],
        ["apps_invoke", { handle: id, operation, arguments: HOST }],
        ["apps_invoke", { moduleId: id, operation, arguments: HOST }],
        ["apps_invoke", { handle: "cpa", moduleId: id, operation: "inspect" }],
      ]) {
        await assert.rejects(mcp.callTool(tool, args), /ssh-connections is managed only from the Coding Tools window; tools cannot call it/, `${tool} ${JSON.stringify(args)}`);
        assert.equal(mcp.isReadOnly(tool, args), false, "never a read, so the window route asks for focus before it is refused");
      }
    }
  }
  // The host's object form cannot be smuggled through a tool either.
  await assert.rejects(mcp.callTool("apps_call", { moduleId: { moduleId: "ssh-connections", operation: "add", arguments: HOST }, operation: "inspect" }), /requires moduleId/);
  assert.deepEqual(service.calls, [], "no tool call reached the store");
  // Refused before the host is asked, so also when there is none.
  await assert.rejects(createCodingToolsAppsMcp({ getHost: () => null }).callTool("apps_call", { moduleId: "ssh-connections", operation: "list" }), /managed only from the Coding Tools window/);
  // The other modules still answer.
  assert.equal((await mcp.callTool("apps_call", { moduleId: "cpa", operation: "inspect" })).result.status, "ready");
  assert.equal(mcp.isReadOnly("apps_call", { moduleId: "cpa", operation: "inspect" }), true);
});

test("main.cjs gives agents no other way in: the control server never gets the store, and the chat tools get ssh_exec only", () => {
  const main = fs.readFileSync(path.join(electronRoot, "main.cjs"), "utf8");
  // The control server (what tools outside the window call) reads the catalog through the apps
  // tools above, with no arguments, and calls one module by a fixed id.
  assert.match(main, /callReadOnlyAppTool: \(tool\) => appsMcp\.callTool\(tool, \{\}\),/);
  assert.match(main, /callAgentOrchestrator: \(operation, args\) => appsHost\.call\("agent-orchestrator", operation, args\),/);
  const hostCalls = [...main.matchAll(/appsHost\.(?:call|invoke)\(([^,)]*)/g)].map((match) => match[1]);
  assert.deepEqual(hostCalls, ["input.moduleId", "\"agent-orchestrator\""], "the window's handler and the fixed-id route are the only callers of the host");
  assert.deepEqual([...main.matchAll(/appsMcp\.callTool\(([^)]*)\)/g)].map((match) => match[1].split(",")[0]), ["input.tool", "tool"]);

  // The store is made once per backend start and handed to exactly three readers: the app module's
  // service (the window), the agent rules, which get the approved list and nothing else, and the
  // chat tools' ssh_exec (milestone 3), which gets the approved list and exec, never `call`: it
  // cannot add a host, confirm a key or open a terminal.
  const uses = main.split(/\r?\n/).filter((line) => /sshconnections/i.test(line) && !/^\s*\/\//.test(line)).map((line) => line.trim());
  // The rest of main.cjs only closes its terminals (closeAll: the page went away, AO restarts, the
  // backend restarts, the app quits).
  assert.deepEqual(uses, [
    "let sshConnectionsService = null;",
    "\"agent-orchestrator\": async () => { await sshConnectionsService?.closeAll(\"ao_restart\"); await agentOrchestratorUpstream?.stop(); return agentOrchestratorUpstream?.start(); },",
    "void sshConnectionsService?.closeAll(\"navigation\");",
    "if (mainWindow === window) void sshConnectionsService?.closeAll(\"renderer_gone\");",
    "window.webContents.once(\"destroyed\", () => { void sshConnectionsService?.closeAll(\"window_destroyed\"); });",
    "await step(\"ssh-terminals\", () => sshConnectionsService?.closeAll(\"quit\"), 10_000);",
    "const { createSshConnections } = backendBundles.requireModule(backend, \"ssh-connections.cjs\");",
    "hosts: () => sshConnectionsService?.approvedHosts?.() ?? [],",
    "run: (input) => (sshConnectionsService",
    "? sshConnectionsService.exec(input)",
    "const sshConnections = createSshConnections({",
    "after: sshConnectionsService?.dispose(),",
    "sshConnectionsService = sshConnections;",
    "sshApprovedHosts: () => sshConnections.approvedHosts(),",
    "sshConnections: (operation, args) => sshConnections.call(operation, args),",
    "await sshConnectionsService?.closeAll(\"backend_restart\");",
  ]);
  const made = main.slice(main.indexOf("const sshConnections = createSshConnections({"), main.indexOf("sshConnectionsService = sshConnections;"));
  assert.match(made, /file: path\.join\(app\.getPath\("userData"\), "integrations", "ssh-hosts\.json"\),/);
  assert.match(made, /knownHostsFile: path\.join\(app\.getPath\("userData"\), "integrations", "ssh-known-hosts"\),/);
  assert.match(made, /probeDir: path\.join\(app\.getPath\("userData"\), "integrations", "ssh-probe"\),/);
  // The in-app terminal (milestone 2): the store reaches AO through two closures bound to the
  // upstream made with it, and only its own close sends AO's SSH token. The upstream gets the same
  // pinned-keys path, made directly (the store is created after it).
  assert.match(made, /openTerminal: \(fields\) => sshUpstream\.harness\.openSshTerminal\(fields\),/);
  assert.match(made, /closeTerminal: \(handle\) => sshUpstream\.harness\.closeTerminal\(handle, \{ ssh: true \}\),/);
  assert.match(main, /const sshUpstream = agentOrchestratorUpstream;\s*const sshConnections = createSshConnections\(\{/);
  assert.deepEqual([...main.matchAll(/openSshTerminal\(/g)].length, 1, "the store is the only caller of the SSH route");
  assert.deepEqual([...main.matchAll(/\{ ssh: true \}/g)].length, 1, "and the only close that sends the token");
  assert.match(main, /case "terminal_close":\s*await agentOrchestratorUpstream\.harness\.closeTerminal\(args\.handle\);/, "the Antigravity CLI page's close goes without it");
  const upstream = main.slice(main.indexOf("agentOrchestratorUpstream = createAgentOrchestratorUpstream({"), main.indexOf("// Push AO changes to the Mission chat"));
  assert.match(upstream, /sshKnownHostsFile: path\.join\(app\.getPath\("userData"\), "integrations", "ssh-known-hosts"\),/);
  assert.ok(main.indexOf("agentOrchestratorUpstream = createAgentOrchestratorUpstream({") < main.indexOf("const sshConnections = createSshConnections({"));
  const chatTools = main.slice(main.indexOf("chatAgentTools = createChatAgentTools({"), main.indexOf("void chatAgentTools.listen()"));
  assert.ok(chatTools.length > 1000);
  assert.doesNotMatch(chatTools, /appsHost|appsMcp/, "the chat agents' tool server is never given the apps host");
  // ssh_exec (milestone 3) reaches the current store for its approved hosts and exec, and nothing
  // else: never the window's dispatcher (call), so no agent adds a host, confirms a key or opens a terminal.
  assert.deepEqual([...chatTools.matchAll(/sshConnectionsService\??\.(\w+)/g)].map((match) => match[1]), ["approvedHosts", "exec"]);
  assert.doesNotMatch(chatTools, /\.call\(operation|\bsshConnections\b/, "neither the store's dispatcher nor a backend start's own store");
});

/** One statement of main.cjs, from `start` to the end of the block it opens (its closing `});` at `indent`). */
function mainStatement(main, start, indent = "  ") {
  const from = main.indexOf(start);
  assert.ok(from > 0, start);
  const end = main.indexOf(`\n${indent}});`, from);
  assert.ok(end > from, start);
  return main.slice(from, end + indent.length + 4);
}

test("main.cjs closes the SSH page's terminal when its page goes away, and before AO stops", async () => {
  const main = fs.readFileSync(path.join(electronRoot, "main.cjs"), "utf8");
  const closes = [];
  const sshConnectionsService = { closeAll: async (reason) => { closes.push(reason); return { closed: 0, failed: 0 }; } };
  const handlers = {};
  const window = { webContents: {
    on: (name, handler) => { handlers[name] = handler; },
    once: (name, handler) => { handlers[name] = handler; },
  } };
  const surfaces = [];
  const run = (code, mainWindow = window) => new Function("window", "mainWindow", "sshConnectionsService", "registerHost", "rendererNavigationAllowed", "logger", "recoverRenderer", code)(
    window, mainWindow, sshConnectionsService, { setSurfaceActive: (active) => surfaces.push(active) },
    (url) => url.startsWith("app://renderer/"), { warn: () => undefined }, () => undefined);

  // A reload or another page in the main frame closes it; a hash route change is the same document.
  const navigation = mainStatement(main, "window.webContents.on(\"did-start-navigation\"");
  run(navigation);
  for (const [url, inPlace, isMainFrame] of [
    ["app://renderer/index.html#/ssh-connections", true, true], ["app://renderer/frame.html", false, false], ["https://evil.example/", false, true],
  ]) {
    handlers["did-start-navigation"]({}, url, inPlace, isMainFrame);
    assert.deepEqual(closes, [], `${url} ${inPlace} ${isMainFrame}`);
  }
  handlers["did-start-navigation"]({}, "app://renderer/index.html", false, true);
  assert.deepEqual(closes, ["navigation"]);
  // Another window's navigation is not the page's.
  run(navigation, {});
  handlers["did-start-navigation"]({}, "app://renderer/index.html", false, true);
  assert.deepEqual(closes, ["navigation"]);

  // The renderer is gone, for any reason (a clean exit included), and the window is destroyed.
  closes.length = 0;
  run(mainStatement(main, "window.webContents.on(\"render-process-gone\""));
  handlers["render-process-gone"]({}, { reason: "clean-exit", exitCode: 0 });
  handlers["render-process-gone"]({}, { reason: "crashed", exitCode: 1 });
  const destroyed = main.slice(main.indexOf("window.webContents.once(\"destroyed\""), main.indexOf("\n", main.indexOf("window.webContents.once(\"destroyed\"")));
  run(destroyed);
  handlers.destroyed();
  assert.deepEqual(closes, ["renderer_gone", "renderer_gone", "window_destroyed"]);

  // Quitting (normal, keep-bridge and installer quits share requestQuit): closed while AO still answers.
  const quit = main.slice(main.indexOf("async function requestQuit("), main.indexOf("exitCommitted = true;", main.indexOf("async function requestQuit(")));
  const quitClose = quit.indexOf("await step(\"ssh-terminals\", () => sshConnectionsService?.closeAll(\"quit\"), 10_000);");
  const quitStop = quit.indexOf("await step(\"agent-orchestrator\", () => agentOrchestratorUpstream?.stop(), 20_000);");
  assert.ok(quitClose > 0 && quitStop > quitClose, "closed before AO stops");
  assert.equal((quit.match(/agentOrchestratorUpstream\?\.stop\(\)/g) || []).length, 1);
  assert.doesNotMatch(quit.slice(quit.lastIndexOf("\n", quitClose), quitClose), /if \(|keepBridge/, "on every kind of quit");

  // A backend restart: closed through the old store before the old upstream stops, then the new store
  // is made (its `after` is the old store's dispose, which closes too).
  const stopBackend = main.slice(main.indexOf("const stopBackend = async (reason) => {"), main.indexOf("appsHost = null;", main.indexOf("const stopBackend = async (reason) => {")));
  assert.ok(stopBackend.length > 100);
  const backendClose = stopBackend.indexOf("await sshConnectionsService?.closeAll(\"backend_restart\");");
  assert.ok(backendClose > 0 && stopBackend.indexOf("await agentOrchestratorUpstream?.stop()") > backendClose);
  assert.match(main, /await stopBackend\(reason\);\s*startBackend\(\);/);
  // Restarting AO alone (the parts menu): closed first too.
  assert.match(main, /"agent-orchestrator": async \(\) => \{ await sshConnectionsService\?\.closeAll\("ao_restart"\); await agentOrchestratorUpstream\?\.stop\(\);/);
});

test("each SSH hosts store closes its terminals through the upstream it was made with, also after a backend restart", async () => {
  const main = fs.readFileSync(path.join(electronRoot, "main.cjs"), "utf8");
  const block = main.slice(main.indexOf("const sshUpstream = agentOrchestratorUpstream;"), main.indexOf("sshConnectionsService = sshConnections;"));
  assert.ok(block.includes("createSshConnections({"));
  const calls = [];
  const upstream = (name) => ({ harness: {
    openSshTerminal: async (fields) => { calls.push([name, "open", fields.title]); return { handle: `shellterm-ssh-${name}`, generation: "g" }; },
    closeTerminal: async (handle, options) => { calls.push([name, "close", handle, options]); },
  } });
  // The block as main.cjs runs it in startBackendFrom; afterwards the module's upstream is replaced,
  // as the next backend start does.
  const make = new Function("scope", "createSshConnections", "app", "path", "logger", "runningHost",
    `let agentOrchestratorUpstream = scope.upstream; let sshConnectionsService = scope.previous;\n${block}\nscope.replace = (next) => { agentOrchestratorUpstream = next; };\nreturn sshConnections;`);
  const userData = { getPath: () => path.join(scratch, "bound") };
  const scope = { upstream: upstream("first"), previous: null };
  const options = make(scope, (given) => given, userData, path, null, { capabilities: { webViews: true } });
  scope.replace(upstream("second"));
  await options.openTerminal({ title: "Build server" });
  await options.closeTerminal("shellterm-ssh-first");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["first", "open", "Build server"], ["first", "close", "shellterm-ssh-first", { ssh: true }]],
    "the old store's close reaches the upstream that opened the terminal, never the new one");

  // The terminal shows in AO's page, a web view: offered on Electron's host and on a host that names
  // no capabilities, not on one without web views (Coding Agent's web host).
  assert.equal(options.canShowTerminal, true);
  const hostOf = (runningHost) => make({ upstream: upstream("other"), previous: null }, (given) => given, userData, path, null, runningHost);
  assert.equal(hostOf({ capabilities: { webViews: false } }).canShowTerminal, false);
  assert.equal(hostOf({}).canShowTerminal, true);

  // With the real store: its dispose (the next store's `after`) closes through that same upstream.
  calls.length = 0;
  const context = makeStore({ openTerminal: options.openTerminal, closeTerminal: options.closeTerminal });
  const host = await pinnedHost(context, keyBlob("bound upstream"));
  const opened = await context.store.call("terminal_open", { id: host.id });
  assert.equal(opened.ok, true, opened.error);
  await context.store.dispose();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["first", "open", "Build server"], ["first", "close", "shellterm-ssh-first", { ssh: true }]]);
});

/**
 * The window's apps.call handler and the app's focus check, as main.cjs has them, run on a fake
 * main window. `sender` is the window the call comes from (the main window unless given).
 */
function appsCallHandler({ window, host, sender = window }) {
  const main = fs.readFileSync(path.join(electronRoot, "main.cjs"), "utf8");
  const gate = main.slice(main.indexOf("function assertFocusedMainWindow(event"), main.indexOf("function launcherSnapshotPayload"));
  const handler = main.slice(main.indexOf("handle(\"coding-tools:apps:call\""), main.indexOf("handle(\"launcher:browser-bounds\""));
  assert.ok(gate.includes("runs only from the focused app window") && handler.includes("appsHost.call("));
  let registered = null;
  new Function("BrowserWindow", "mainWindow", "waitForFocus", "appsHost", "activeAoWorkflow", "handle", `${gate}\n${handler}`)(
    { fromWebContents: () => sender }, window, async ({ focused }) => focused(), host, null, (_channel, callback) => { registered = callback; },
  );
  const frame = {};
  const event = { sender: { isFocused: () => sender.focused, mainFrame: frame, getZoomFactor: () => 1 }, senderFrame: frame };
  return (input) => registered(event, input);
}

function fakeWindow(state = {}) {
  return {
    focused: false, minimized: false, ...state,
    isDestroyed: () => false, isVisible() { return !this.minimized; }, isMinimized() { return this.minimized; }, isFocused() { return this.focused; },
  };
}

test("every SSH hosts operation except list is refused unless it comes from the focused app window", async () => {
  const window = fakeWindow();
  const service = sshService();
  const tables = {
    // The module's own table, and a table that wrongly calls everything a read: the handler's own
    // rule for this module holds either way.
    real: createCodingToolsAppsHost({ services: { sshConnections: service.call } }),
    wrong: { isReadOnly: () => true, call: async (id, operation, args) => { service.calls.push([operation, args]); return { ok: true }; } },
  };
  for (const [name, host] of Object.entries(tables)) {
    const call = appsCallHandler({ window, host });
    service.calls.length = 0;
    window.focused = false;
    window.minimized = false;
    // Visible but not focused (focus is in another app, or an agent's turn is running).
    for (const operation of [...WRITE_OPERATIONS, "inspect", "terminal_open", "LIST", "list "]) {
      await assert.rejects(call({ moduleId: "ssh-connections", operation, arguments: { id: "aaaaaaaaaaaa" } }),
        /Click into the Coding Tools window and try again: this action runs only from the focused app window/, `${name} ${operation}`);
    }
    // The other spellings the host takes for a call (a padded id, an id in a list, the whole call as
    // one object in the id's place) are read the way the host reads them.
    for (const input of [
      { moduleId: " ssh-connections ", operation: "add", arguments: HOST },
      { moduleId: ["ssh-connections"], operation: "add", arguments: HOST },
      { handle: "ssh-connections", operation: "add", arguments: HOST },
      { moduleId: { moduleId: "ssh-connections", operation: "add", arguments: HOST }, operation: "list" },
      { moduleId: { handle: "ssh-connections", operation: "remove", arguments: { id: "aaaaaaaaaaaa" } }, operation: "list" },
    ]) {
      await assert.rejects(call(input), /this action runs only from the focused app window/, `${name} ${JSON.stringify(input)}`);
    }
    assert.deepEqual(service.calls, [], `${name}: nothing refused reached the store`);
    await call({ moduleId: "ssh-connections", operation: "list" });
    assert.deepEqual(service.calls.map((entry) => entry[0]), ["list"], `${name}: the list is a read`);

    // A minimized window gets nothing, not even the list.
    window.minimized = true;
    await assert.rejects(call({ moduleId: "ssh-connections", operation: "list" }), /Open the Coding Tools window \(not minimized\)/);
    await assert.rejects(call({ moduleId: "ssh-connections", operation: "add", arguments: HOST }), /runs only from the focused app window/);
    assert.equal(service.calls.length, 1);

    // The focused window may change the list.
    window.minimized = false;
    window.focused = true;
    for (const operation of WRITE_OPERATIONS) await call({ moduleId: "ssh-connections", operation, arguments: { id: "aaaaaaaaaaaa" } });
    assert.deepEqual(service.calls.map((entry) => entry[0]), ["list", ...WRITE_OPERATIONS], name);
  }
  // A page in any other window is refused, focused or not, for the list too.
  service.calls.length = 0;
  const other = appsCallHandler({ window, host: tables.real, sender: fakeWindow({ focused: true }) });
  await assert.rejects(other({ moduleId: "ssh-connections", operation: "list" }), /Open the Coding Tools window/);
  for (const operation of WRITE_OPERATIONS) {
    await assert.rejects(other({ moduleId: "ssh-connections", operation, arguments: HOST }), /runs only from the focused app window/, operation);
  }
  assert.deepEqual(service.calls, []);
});

test("the module is registered for the window, bundled with the backend and needs nothing outside it", () => {
  assert.ok(BACKEND_MODULES.includes("ssh-connections.cjs"));
  const source = fs.readFileSync(path.join(electronRoot, "ssh-connections.cjs"), "utf8");
  const required = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
  assert.deepEqual(required, ["node:crypto", "node:fs", "node:net", "node:path", "./atomic-file.cjs", "./off-thread-run.cjs"]);
  for (const target of required.filter((name) => name.startsWith("./"))) assert.ok(BACKEND_MODULES.includes(target.slice(2)), target);
  // It starts ssh through the off-thread runner with an argv array: no shell, no child_process here.
  assert.doesNotMatch(source, /child_process|shell:|\bexec\(/);
  assert.doesNotMatch(source, /\b[A-Za-z]+Sync\s*\(/, "nothing synchronous: it runs on Electron main");
  const schema = fs.readFileSync(path.join(electronRoot, "ipc-schema.cjs"), "utf8");
  assert.match(schema, /enum: Object\.freeze\(\["cpa", "agent-orchestrator", "antigravity-cli", "ssh-connections", \.\.\.RETIRED_APP_MODULE_IDS\]\)/);
});
