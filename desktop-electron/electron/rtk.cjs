"use strict";

// RTK (github.com/rtk-ai/rtk, Apache-2.0 / BUSL-1.1): rewrites the shell commands an agent runs to
// compact equivalents ("git status" -> "rtk git status"), so the model reads a fraction of their
// output. Coding Tools uses the person's rtk, installing it with winget at startup when it is
// missing (autoInstall), and never edits their global agent settings: an AO agent's commands
// reach it two ways, each per session.
// - Every command a chat agent runs through Coding Tools' terminal tool (any harness) is passed
//   through `rtk rewrite` first (rewrite below).
// - Claude Code's own Bash tool gets RTK's PreToolUse hook in its session settings: AO reads the
//   hook command from CODING_TOOLS_RTK_CLAUDE_HOOK (daemonEnvironment below).
// Off in Settings, or with no rtk found, commands run exactly as written.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");

/** `rtk rewrite` landed in 0.23.0. */
const MIN_VERSION = [0, 23, 0];
const FIND_TTL_MS = 60_000;
const AUTO_INSTALL_RETRY_MS = 24 * 60 * 60 * 1000;
const REWRITE_TIMEOUT_MS = 3_000;
const MAX_COMMAND = 16_384;
const VERSION_LINE = /^rtk\s+(\d+)\.(\d+)\.(\d+)/m;

const atLeast = (version, minimum) => {
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
};

/** rtk's path as a command word for cmd.exe and Git Bash alike (always quoted: one form to unwrap). */
const quoted = (file) => `"${file}"`;

function createRtk({ getEnabled = () => true, logger = null, env = process.env, platform = process.platform,
  run = spawnSync, spawnProcess = spawn, now = Date.now, exists = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } },
  listDir = (dir) => fs.readdirSync(dir) } = {}) {
  let found = null;
  let checkedAt = -Infinity;
  /** The winget install in progress (the person's click or the automatic one), shared by both. */
  let installing = null;
  const exe = platform === "win32" ? "rtk.exe" : "rtk";

  /**
   * winget's own folders for rtk. Without symlink rights (no Developer Mode) winget makes no Links
   * shim: it unpacks rtk into Packages\rtk-ai.rtk_<source> and adds that folder to the user's PATH
   * in the registry, which no process started before the install sees (this app included).
   */
  function wingetPackages() {
    const roots = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages"),
      env.ProgramFiles && path.join(env.ProgramFiles, "WinGet", "Packages")].filter(Boolean);
    const list = [];
    for (const root of roots) {
      let names = [];
      try { names = listDir(root); } catch { continue; }
      for (const name of names) if (/^rtk-ai\.rtk_/i.test(name)) list.push(path.join(root, name, exe));
    }
    return list;
  }

  /** Where rtk may be: an explicit CODING_TOOLS_RTK, PATH, then the usual install folders. */
  function candidates() {
    const list = [];
    if (env.CODING_TOOLS_RTK) list.push(env.CODING_TOOLS_RTK);
    const pathValue = env.PATH ?? env.Path ?? "";
    for (const dir of String(pathValue).split(path.delimiter)) if (dir.trim()) list.push(path.join(dir.trim(), exe));
    const home = env.USERPROFILE || env.HOME;
    if (platform === "win32" && env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", exe));
    if (platform === "win32") list.push(...wingetPackages());
    if (home) list.push(path.join(home, ".cargo", "bin", exe), path.join(home, ".local", "bin", exe));
    return [...new Set(list)];
  }

  /** The installed rtk ({ path, version }), or null. Another project on crates.io is also called rtk: only one that reports `rtk x.y.z` counts. */
  function locate(force = false) {
    if (!force && now() - checkedAt < FIND_TTL_MS) return found;
    checkedAt = now();
    found = null;
    for (const file of candidates()) {
      if (!exists(file)) continue;
      const out = run(file, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
      const match = VERSION_LINE.exec(String(out?.stdout ?? ""));
      if (out?.status !== 0 || !match) continue;
      const version = match.slice(1, 4).map(Number);
      if (!atLeast(version, MIN_VERSION)) {
        logger?.warn?.("rtk.too_old", { version: version.join(".") });
        continue;
      }
      found = { path: file, version: version.join(".") };
      break;
    }
    return found;
  }

  /**
   * `run` without blocking: rtk started on its own and read when it ends. The rewrite ran rtk with
   * spawnSync on the app's main process for every command an agent ran, and starting a process on a
   * busy Windows machine took up to the 3 s timeout: the whole app froze meanwhile (seen on 0.8.5:
   * a 2.1 s stall, CPU idle, beside an agent's command). A `run` given for tests is used as it is.
   */
  const runAsync = run === spawnSync
    ? (file, args, { timeout = 10_000, env: childEnv = env } = {}) => new Promise((resolve) => {
      let stdout = "", settled = false, child = null, timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      try {
        // stderr unread would fill its pipe and stall rtk until the timeout killed it.
        child = spawn(file, args, { windowsHide: true, env: childEnv, stdio: ["ignore", "pipe", "ignore"] });
      } catch (error) {
        finish({ error });
        return;
      }
      timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ error: new Error("timed out") }); }, timeout);
      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.on("error", (error) => finish({ error }));
      child.on("close", (status) => finish({ status, stdout }));
    })
    : async (...args) => run(...args);

  // locate() for the command path: the cached answer, refreshed without blocking when it is stale
  // (or always, with `force`; a refresh already running is joined).
  let refreshing = null;
  function locateAsync(force = false) {
    if (!force && now() - checkedAt < FIND_TTL_MS) return Promise.resolve(found);
    refreshing ??= (async () => {
      let next = null;
      for (const file of candidates()) {
        if (!exists(file)) continue;
        const out = await runAsync(file, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
        const match = VERSION_LINE.exec(String(out?.stdout ?? ""));
        if (out?.status !== 0 || !match) continue;
        const version = match.slice(1, 4).map(Number);
        if (!atLeast(version, MIN_VERSION)) { logger?.warn?.("rtk.too_old", { version: version.join(".") }); continue; }
        next = { path: file, version: version.join(".") };
        break;
      }
      found = next;
      checkedAt = now();
      return found;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  const enabled = () => getEnabled() !== false;
  /**
   * rtk, when it is installed and turned on. Once rtk has been looked up, the answer at hand is
   * used and a stale one is refreshed in the background: the blocking lookup (`rtk --version`, 5 s
   * timeout per place) ran whenever AO's start read the hook after the 1-minute cache expired.
   * Only the very first answer, before any lookup, is waited for.
   */
  const active = () => {
    if (!enabled()) return null;
    if (checkedAt === -Infinity) return locate();
    if (now() - checkedAt >= FIND_TTL_MS) void locateAsync().catch(() => {});
    return found;
  };

  /**
   * The command rtk would run instead of `command`, or null to run it as written (resolves). rtk's
   * exit code contract: 0 or 3 with the rewrite on stdout ("allow" or "ask"; the chat's own approval
   * still reviews what runs), 1 no rtk equivalent, 2 a deny rule. Any error runs the original.
   */
  async function rewrite(command) {
    const tool = enabled() ? await locateAsync() : null;
    if (!tool || typeof command !== "string" || !command.trim() || command.length > MAX_COMMAND) return null;
    const childEnv = { ...env };
    // That channel relaxes rtk's approval gate; only a delegate that sets it itself may rely on it.
    delete childEnv.RTK_REWRITE_HOST;
    const out = await runAsync(tool.path, ["rewrite", command], { encoding: "utf8", timeout: REWRITE_TIMEOUT_MS, windowsHide: true, env: childEnv });
    // RTK turned off while rtk ran: the command runs as written.
    if (!enabled()) return null;
    if (out?.error || (out?.status !== 0 && out?.status !== 3)) return null;
    const next = String(out.stdout ?? "").trim();
    if (!next || next === command.trim() || next.includes("\n")) return null;
    // The rewrite names `rtk`; run that rtk even where its folder is not on the command's PATH.
    return next.replace(/(^|&&|\|\||[;|])(\s*)rtk(?=\s)/g, (_all, before, space) => `${before}${space}${quoted(tool.path)}`);
  }

  /**
   * The command line without rtk in front ("<rtk> git status" -> "git status"), for judging what a
   * rewritten command does: rtk's wrappers run the same command, so "Approve for me" treats them as
   * the command itself (a routine `git status` stays routine; `rtk git push` is still a push).
   */
  function unwrap(command) {
    if (typeof command !== "string") return command;
    const names = ["rtk"];
    const tool = found;
    if (tool) names.unshift(quoted(tool.path), tool.path);
    const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    return command.replace(new RegExp(`(^|&&|\\|\\||[;|])(\\s*)(?:${escaped})\\s+`, "g"), "$1$2");
  }

  /** RTK's Claude Code hook command, or "" when rtk is off or missing. */
  const claudeHook = () => {
    const tool = active();
    return tool ? `${quoted(tool.path)} hook claude` : "";
  };
  /** The folder holding rtk, for the agents' PATH (a rewritten command calls `rtk`). */
  const binDir = () => {
    const tool = active();
    return tool ? path.dirname(tool.path) : "";
  };
  /** What AO's daemon passes to every chat agent. An empty hook turns it off. */
  const daemonEnvironment = () => ({ CODING_TOOLS_RTK_CLAUDE_HOOK: claudeHook() });

  /** RTK's own savings report (`rtk gain`), as text and, when rtk can give it, JSON (resolves). */
  async function gain() {
    const tool = await locateAsync();
    if (!tool) return { available: false };
    // Two runs of up to 10 s each blocked the main process while the RTK page asked for them.
    const [text, json] = await Promise.all([
      runAsync(tool.path, ["gain"], { encoding: "utf8", timeout: 10_000, windowsHide: true }),
      runAsync(tool.path, ["gain", "--all", "--format", "json"], { encoding: "utf8", timeout: 10_000, windowsHide: true }),
    ]);
    let data = null;
    try { data = json?.status === 0 ? JSON.parse(String(json.stdout)) : null; } catch { data = null; }
    return { available: true, text: String(text?.stdout ?? "").slice(0, 20_000), data };
  }

  /**
   * The RTK page's status (resolves). rtk is looked up afresh, without blocking: `rtk --version`
   * through spawnSync (5 s timeout per candidate) froze the app each time the page asked.
   */
  async function status() {
    const tool = await locateAsync(true);
    return { enabled: enabled(), installed: Boolean(tool), installing: Boolean(installing), path: tool?.path ?? null, version: tool?.version ?? null,
      minimum: MIN_VERSION.join("."), installCommand: platform === "win32" ? "winget install rtk-ai.rtk" : "brew install rtk" };
  }

  /** Installs rtk with winget (Windows); resolves with its exit code and output tail. One at a time. */
  function install() {
    if (platform !== "win32") return Promise.reject(new Error("Install rtk with your package manager: brew install rtk"));
    if (installing) return installing;
    installing = new Promise((resolve, reject) => {
      let output = "";
      const child = spawnProcess("winget", ["install", "--id", "rtk-ai.rtk", "-e", "--accept-source-agreements", "--accept-package-agreements", "--silent"],
        { windowsHide: true, env });
      child.stdout?.on("data", (chunk) => { output = (output + chunk).slice(-4_000); });
      child.stderr?.on("data", (chunk) => { output = (output + chunk).slice(-4_000); });
      child.on("error", (error) => { installing = null; reject(error); });
      child.on("close", (code) => {
        installing = null;
        checkedAt = -Infinity;
        logger?.info?.("rtk.install_finished", { code });
        status().then((current) => resolve({ code, output: output.trim().slice(-2_000), status: current }), reject);
      });
    });
    return installing;
  }

  /**
   * Installs rtk at startup when it is on and missing, without a click: every agent harness gets
   * it with nothing for the person to do. An attempt that failed (offline, no winget) is not
   * repeated for a day; `record` keeps when it ran. Resolves with the install's result, or null.
   */
  // The startup check in progress: AO's start (ready) waits for it as for an install.
  let checking = null;
  function autoInstall(options = {}) {
    if (platform !== "win32" || !enabled()) return Promise.resolve(null);
    if (installing) return installing.catch(() => null);
    if (checking) return checking;
    // rtk is looked up without blocking: `rtk --version` through spawnSync (5 s timeout per place
    // looked) held up every start. The answer also fills the cache AO's environment reads.
    checking = locateAsync(true).then((tool) => (tool ? null : startAutoInstall(options)), () => startAutoInstall(options))
      .finally(() => { checking = null; });
    return checking;
  }

  function startAutoInstall({ lastAttemptAt = null, record = () => {} }) {
    if (!enabled()) return Promise.resolve(null);
    if (installing) return installing.catch(() => null);
    // Never tried is null (Number(null) would be 0, "just now" at the epoch); a clock moved back retries.
    const last = typeof lastAttemptAt === "number" ? lastAttemptAt : NaN;
    if (Number.isFinite(last) && now() - last >= 0 && now() - last < AUTO_INSTALL_RETRY_MS) return Promise.resolve(null);
    try { record(now()); } catch { /* tries again next start */ }
    logger?.info?.("rtk.auto_install");
    return install().catch((error) => {
      logger?.warn?.("rtk.auto_install_failed", { message: String(error?.message ?? error) });
      return null;
    });
  }

  /**
   * Waits for an install in progress, at most `timeoutMs`, so a process started now (AO's daemon,
   * which hands its PATH and Claude's hook to every agent) is started with rtk.
   */
  function ready(timeoutMs) {
    const pending = checking ?? installing;
    if (!pending) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      // The startup check resolves with the install it started, if any.
      pending.then(() => {}, () => {}).then(() => { clearTimeout(timer); resolve(); });
    });
  }

  return { locate, active, rewrite, unwrap, claudeHook, binDir, daemonEnvironment, gain, status, install, autoInstall, ready };
}

module.exports = { createRtk };
