"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  systemDriveRedirects, pruneTemp, driveOf, DAY_MS,
  CACHE_VARIABLES, physicalDriveOf, guardWritePath, SystemDriveWriteError, checkDataRoot,
} = require("../electron/system-drive.cjs");

const pick = (object, keys) => Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]));

// Test folders live in the repository's aiTemp, never the system temporary folder.
const fixtureRoot = path.resolve(__dirname, "../../aiTemp", `system-drive-${process.pid}`);
test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

const onC = { SystemDrive: "C:", TEMP: "C:\\Users\\a\\AppData\\Local\\Temp", TMP: "C:\\Users\\a\\AppData\\Local\\Temp", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
const dataRoot = "G:\\AppData\\Coding Tools";

test("temporary files and rtk's history move to the data root when they would land on the system drive", () => {
  const result = systemDriveRedirects({ env: onC, dataRoot, platform: "win32" });
  assert.equal(result.tempDir, "G:\\AppData\\Coding Tools\\tmp");
  assert.equal(result.rtkDir, "G:\\AppData\\Coding Tools\\rtk");
  assert.deepEqual(pick(result.env, ["TEMP", "TMP", "TMPDIR", "RTK_DB_PATH"]), {
    TEMP: "G:\\AppData\\Coding Tools\\tmp", TMP: "G:\\AppData\\Coding Tools\\tmp", TMPDIR: "G:\\AppData\\Coding Tools\\tmp",
    RTK_DB_PATH: "G:\\AppData\\Coding Tools\\rtk\\history.db",
  });
  // Unset counts as the system drive: Windows' defaults are under the profile there.
  assert.equal(systemDriveRedirects({ env: { SystemDrive: "C:" }, dataRoot, platform: "win32" }).env.TEMP, "G:\\AppData\\Coding Tools\\tmp");
});

test("a person's own choices off the system drive are kept", () => {
  const ownCaches = Object.fromEntries(Object.keys(CACHE_VARIABLES).map((name) => [name, `E:\\cache\\${name}`]));
  const own = systemDriveRedirects({ env: { ...onC, ...ownCaches, GOTMPDIR: "D:\\gotmp", TEMP: "D:\\temp", TMP: "D:\\temp", RTK_DB_PATH: "E:\\rtk.db" }, dataRoot, platform: "win32" });
  assert.deepEqual(own.env, {});
  assert.equal(own.tempDir, null);
  // One of the pair still on C: moves both, so no child is left on the system drive.
  assert.equal(systemDriveRedirects({ env: { ...onC, TEMP: "D:\\temp" }, dataRoot, platform: "win32" }).env.TMP, "G:\\AppData\\Coding Tools\\tmp");
  // An explicit CODING_TOOLS_TEMP_DIR wins.
  assert.equal(systemDriveRedirects({ env: { ...onC, CODING_TOOLS_TEMP_DIR: "H:\\scratch" }, dataRoot, platform: "win32" }).env.TEMP, "H:\\scratch");
});

test("nothing changes where it can't help: data root on the system drive, other systems, no data root", () => {
  assert.deepEqual(systemDriveRedirects({ env: onC, dataRoot: "C:\\Users\\a\\AppData\\Roaming\\Coding Tools", platform: "win32" }).env, {});
  assert.deepEqual(systemDriveRedirects({ env: onC, dataRoot, platform: "linux" }).env, {});
  assert.deepEqual(systemDriveRedirects({ env: onC, dataRoot: "relative\\path", platform: "win32" }).env, {});
  // A machine whose system drive is D: treats D: as the one to avoid.
  const onD = { SystemDrive: "D:", TEMP: "D:\\Temp", TMP: "D:\\Temp", LOCALAPPDATA: "D:\\Users\\a\\AppData\\Local" };
  assert.equal(systemDriveRedirects({ env: onD, dataRoot: "C:\\Data", platform: "win32" }).env.TEMP, "C:\\Data\\tmp");
  assert.deepEqual(systemDriveRedirects({ env: onD, dataRoot: "D:\\Data", platform: "win32" }).env, {});
  assert.equal(driveOf("g:\\x"), "G");
  assert.equal(driveOf("\\\\server\\share"), "");
});

test("pruning removes only what nothing has touched for a week, oldest first, and never follows links", async () => {
  const dir = path.join(fixtureRoot, "prune");
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const age = (target, days) => { const at = new Date(now - days * DAY_MS); fs.utimesSync(target, at, at); };
  fs.writeFileSync(path.join(dir, "old.tmp"), "x"); age(path.join(dir, "old.tmp"), 10);
  fs.writeFileSync(path.join(dir, "fresh.tmp"), "x"); age(path.join(dir, "fresh.tmp"), 1);
  fs.mkdirSync(path.join(dir, "old-folder", "deep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "old-folder", "deep", "a.txt"), "x");
  age(path.join(dir, "old-folder", "deep", "a.txt"), 9); age(path.join(dir, "old-folder", "deep"), 9); age(path.join(dir, "old-folder"), 9);
  // A running agent's folder: old itself, but with a file written today.
  fs.mkdirSync(path.join(dir, "live-agent"));
  fs.writeFileSync(path.join(dir, "live-agent", "old.txt"), "x"); age(path.join(dir, "live-agent", "old.txt"), 20);
  fs.writeFileSync(path.join(dir, "live-agent", "today.txt"), "x");
  age(path.join(dir, "live-agent"), 20);
  // A link out of the folder is neither followed nor removed.
  const outside = path.join(fixtureRoot, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "keep.txt"), "x"); age(path.join(outside, "keep.txt"), 30);
  fs.symlinkSync(outside, path.join(dir, "link"), "junction");

  const removed = await pruneTemp(dir, { now, timeOf: (stat) => stat.mtimeMs });
  assert.deepEqual(removed.sort(), ["old-folder", "old.tmp"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["fresh.tmp", "link", "live-agent"]);
  assert.ok(fs.existsSync(path.join(outside, "keep.txt")), "the link's target is untouched");
  // Bounded, oldest first: two entries examined, the 20-day live folder (kept) and the 12-day file;
  // the 8-day file waits for the next pass.
  fs.writeFileSync(path.join(dir, "a.tmp"), "x"); age(path.join(dir, "a.tmp"), 8);
  fs.writeFileSync(path.join(dir, "b.tmp"), "x"); age(path.join(dir, "b.tmp"), 12);
  assert.deepEqual(await pruneTemp(dir, { now, maxEntries: 2, timeOf: (stat) => stat.mtimeMs }), ["b.tmp"]);
  assert.ok(fs.existsSync(path.join(dir, "a.tmp")) && fs.existsSync(path.join(dir, "live-agent", "today.txt")));
  assert.deepEqual(await pruneTemp(path.join(fixtureRoot, "missing")), []);
});

test("Codex's and Claude Code's homes stay where they are, even on the system drive", () => {
  // The person keeps ~\.codex and ~\.claude on C: (sign-ins and history): never redirect or refuse them.
  const homes = { ...onC, USERPROFILE: "C:\\Users\\a", HOME: "C:\\Users\\a", CODEX_HOME: "C:\\Users\\a\\.codex", CLAUDE_CONFIG_DIR: "C:\\Users\\a\\.claude" };
  const result = systemDriveRedirects({ env: homes, dataRoot, platform: "win32" });
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    assert.equal(name in result.env, false, `${name} is left alone`);
  }
  assert.equal(Object.keys(CACHE_VARIABLES).some((name) => /CODEX|CLAUDE/i.test(name)), false);
  // Only the app's own data root and the updater's download folder go through the guard.
  const sources = ["main.cjs", "update.cjs"].map((file) => fs.readFileSync(path.join(__dirname, "../electron", file), "utf8")).join("\n");
  assert.doesNotMatch(sources, /guardWritePath\([^)]*(codexHome|CODEX_HOME|claude)/i);
  assert.doesNotMatch(sources, /checkDataRoot\([^)]*(codexHome|CODEX_HOME|claude)/i);
});

test("main sets the redirects before anything starts and prunes after startup", () => {
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const redirect = main.indexOf("systemDrive.systemDriveRedirects({ env: process.env, dataRoot: launcherUserData })");
  const assign = main.indexOf("Object.assign(process.env, systemDriveRedirect.env)");
  assert.ok(redirect > 0 && assign > redirect, "main computes and applies the redirects");
  assert.ok(assign < main.indexOf("caDistrust.childNodeOptions("), "before the child Node options and every later start");
  assert.ok(assign < main.indexOf("await app.whenReady()"), "before the app is ready, so no child inherits the system drive's folder");
  assert.match(main, /fs\.mkdirSync\(systemDriveRedirect\.tempDir, \{ recursive: true \}\)/);
  assert.match(main, /systemDrive\.pruneTemp\(systemDriveRedirect\.tempDir\)/);
});

test("package, build and model caches move to the data root when unset or on the system drive", () => {
  const env = systemDriveRedirects({ env: { ...onC, npm_config_cache: "C:\\Users\\a\\AppData\\Local\\npm-cache", PIP_CACHE_DIR: "F:\\pip" }, dataRoot, platform: "win32" }).env;
  assert.equal(env.npm_config_cache, "G:\\AppData\\Coding Tools\\cache\\npm");
  assert.equal(env.GOCACHE, "G:\\AppData\\Coding Tools\\cache\\go-build");
  assert.equal(env.HF_HOME, "G:\\AppData\\Coding Tools\\cache\\huggingface");
  assert.equal(env.GOTMPDIR, "G:\\AppData\\Coding Tools\\tmp", "Go's build scratch follows TEMP");
  assert.equal("PIP_CACHE_DIR" in env, false, "a cache the person already put off the system drive stays");
  // Sign-ins and installed programs are not caches: never moved behind the person's back.
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CARGO_HOME", "PLAYWRIGHT_BROWSERS_PATH"]) assert.equal(name in env, false, name);
});

// A fake file system: `links` maps a folder to where it really is; `present` lists what exists.
const fakeDisk = ({ links = {}, present = [] } = {}) => ({
  realpath(target) {
    const key = target.toLowerCase();
    for (const [link, real] of Object.entries(links)) {
      if (key === link.toLowerCase() || key.startsWith(`${link.toLowerCase()}\\`)) return real + target.slice(link.length);
    }
    if (present.some((p) => p.toLowerCase() === key)) return target;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
  exists: (target) => present.some((p) => p.toLowerCase() === target.toLowerCase()),
});

test("the physical drive follows junctions and walks up to the nearest folder that exists", () => {
  const disk = fakeDisk({ links: { "C:\\Users\\a\\.ao": "G:\\AppData\\.ao" }, present: ["C:\\", "C:\\Users", "G:\\"] });
  assert.equal(physicalDriveOf("C:\\Users\\a\\.ao\\new\\folder", disk), "G", "a junction to G: counts as G:");
  assert.equal(physicalDriveOf("C:\\Users\\a\\not-yet\\made", disk), "C");
  assert.equal(physicalDriveOf("Z:\\nowhere", disk), "Z", "a missing drive still names its letter");
  // The real file system: a path that doesn't exist yet under this test's folder is on its drive.
  assert.equal(physicalDriveOf(path.join(fixtureRoot, "later", "deep")), driveOf(path.resolve(fixtureRoot)) || physicalDriveOf(fixtureRoot));
});

test("the write guard keeps off-system paths, redirects to the fallback, and refuses the system drive", () => {
  const disk = fakeDisk({ links: { "C:\\Users\\a\\.coding-tools": "G:\\AppData\\.coding-tools" }, present: ["C:\\", "G:\\", "H:\\"] });
  const env = { SystemDrive: "C:" };
  const guard = (target, extra = {}) => guardWritePath(target, { env, platform: "win32", ...disk, ...extra });
  assert.equal(guard("G:\\AppData\\Coding Tools\\logs"), "G:\\AppData\\Coding Tools\\logs");
  assert.equal(guard("C:\\Users\\a\\.coding-tools\\runtime"), "C:\\Users\\a\\.coding-tools\\runtime", "behind a junction to G: is fine");
  assert.equal(guard("C:\\Users\\a\\AppData\\Local\\Temp", { fallback: "G:\\AppData\\Coding Tools\\tmp" }), "G:\\AppData\\Coding Tools\\tmp");
  assert.throws(() => guard("C:\\Users\\a\\AppData\\Local\\Temp"), (error) => error instanceof SystemDriveWriteError && error.code === "SYSTEM_DRIVE_WRITE");
  assert.throws(() => guard("C:\\x", { fallback: "C:\\also-c" }), SystemDriveWriteError, "a fallback on the system drive is no escape");
  // Opt-outs: the person's setting, CI runners, and a PC with only a system drive.
  assert.equal(guard("C:\\x", { env: { ...env, CODING_TOOLS_ALLOW_SYSTEM_DRIVE: "1" } }), "C:\\x");
  assert.equal(guard("C:\\x", { env: { ...env, GITHUB_ACTIONS: "true" } }), "C:\\x");
  assert.equal(guard("C:\\x", { exists: (target) => target === "C:\\" }), "C:\\x");
  assert.equal(guardWritePath("/tmp/x", { env, platform: "linux" }), "/tmp/x");
});

test("startup refuses a data root on the system drive when another drive can hold it", () => {
  const disk = fakeDisk({ links: { "C:\\Users\\a\\AppData\\Roaming\\Coding Tools": "G:\\AppData\\Coding Tools" }, present: ["C:\\", "G:\\", "H:\\"] });
  const env = { SystemDrive: "C:" };
  const check = (root, extra = {}) => checkDataRoot(root, { env, platform: "win32", ...disk, ...extra });
  assert.deepEqual(check("C:\\Users\\a\\AppData\\Roaming\\Coding Tools"), { ok: true }, "junctioned to G: passes");
  assert.deepEqual(check("H:\\Coding Tools"), { ok: true });
  const refused = check("C:\\Users\\b\\AppData\\Roaming\\Coding Tools");
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.drives, ["G", "H"]);
  assert.match(refused.message, /CODING_TOOLS_LAUNCHER_DATA_DIR/);
  assert.match(refused.message, /G: or H:/);
  const single = check("C:\\Data", { exists: (target) => target === "C:\\" });
  assert.equal(single.ok, true);
  assert.match(single.warning, /system drive/);
  assert.equal(check("C:\\Data", { env: { ...env, CODING_TOOLS_ALLOW_SYSTEM_DRIVE: "1" } }).ok, true);
});

test("main checks the data root before making any folder, and the updater guards its download folder", () => {
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const check = main.indexOf("systemDrive.checkDataRoot(LAUNCHER_PROFILE.userData");
  assert.ok(check > 0 && check < main.indexOf("fs.mkdirSync(LAUNCHER_PROFILE.userData"), "checked before the data folder is made");
  assert.match(main, /if \(!dataRootCheck\.ok\) \{\s*dialog\.showErrorBox/);
  const update = fs.readFileSync(path.join(__dirname, "../electron/update.cjs"), "utf8");
  assert.match(update, /mkdtempSync\(path\.join\(guardWritePath\(os\.tmpdir\(\)\)/);
});
