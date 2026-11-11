"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { systemDriveRedirects, pruneTemp, driveOf, DAY_MS } = require("../electron/system-drive.cjs");

// Test folders live in the repository's aiTemp, never the system temporary folder.
const fixtureRoot = path.resolve(__dirname, "../../aiTemp", `system-drive-${process.pid}`);
test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

const onC = { SystemDrive: "C:", TEMP: "C:\\Users\\a\\AppData\\Local\\Temp", TMP: "C:\\Users\\a\\AppData\\Local\\Temp", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
const dataRoot = "G:\\AppData\\Coding Tools";

test("temporary files and rtk's history move to the data root when they would land on the system drive", () => {
  const result = systemDriveRedirects({ env: onC, dataRoot, platform: "win32" });
  assert.equal(result.tempDir, "G:\\AppData\\Coding Tools\\tmp");
  assert.equal(result.rtkDir, "G:\\AppData\\Coding Tools\\rtk");
  assert.deepEqual(result.env, {
    TEMP: "G:\\AppData\\Coding Tools\\tmp", TMP: "G:\\AppData\\Coding Tools\\tmp", TMPDIR: "G:\\AppData\\Coding Tools\\tmp",
    RTK_DB_PATH: "G:\\AppData\\Coding Tools\\rtk\\history.db",
  });
  // Unset counts as the system drive: Windows' defaults are under the profile there.
  assert.equal(systemDriveRedirects({ env: { SystemDrive: "C:" }, dataRoot, platform: "win32" }).env.TEMP, "G:\\AppData\\Coding Tools\\tmp");
});

test("a person's own choices off the system drive are kept", () => {
  const own = systemDriveRedirects({ env: { ...onC, TEMP: "D:\\temp", TMP: "D:\\temp", RTK_DB_PATH: "E:\\rtk.db" }, dataRoot, platform: "win32" });
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
