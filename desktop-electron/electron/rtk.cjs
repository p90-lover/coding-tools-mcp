"use strict";

// RTK (github.com/rtk-ai/rtk, Apache-2.0 / BUSL-1.1): rewrites the shell commands an agent runs to
// compact equivalents ("git status" -> "rtk git status"), so the model reads a fraction of their
// output. Coding Tools uses the person's rtk, installing it with winget at startup when it is
// missing (autoInstall), and never edits their global agent settings: an AO agent's commands
// reach it these ways, each per session.
// - Every command a chat agent runs through Coding Tools' terminal tool (any harness) is passed
//   through `rtk rewrite` first (rewrite below).
// - Claude Code's own Bash tool gets RTK's PreToolUse hook in its session settings: AO reads the
//   hook command from CODING_TOOLS_RTK_CLAUDE_HOOK (daemonEnvironment below). Its PowerShell tool
//   gets the same hook, minus rewrites PowerShell can't run, from
//   CODING_TOOLS_RTK_CLAUDE_POWERSHELL_HOOK (claudePowerShellHook).
// - Codex's own shell gets RTK's PreToolUse hook on its app-server command line, trusted for that
//   process only: AO reads it from CODING_TOOLS_RTK_CODEX_HOOK.
// - OpenCode's own bash tool gets a plugin that asks rtk about each command (OPENCODE_PLUGIN), which
//   AO lists in that chat's inline OpenCode config only: AO reads its path from
//   CODING_TOOLS_RTK_OPENCODE_PLUGIN.
// Off in Settings, or with no rtk found, commands run exactly as written.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const { runOffThread } = require("./off-thread-run.cjs");
const { writePrivateFileAtomicAsync } = require("./atomic-file.cjs");

/** `rtk rewrite` landed in 0.23.0. */
const MIN_VERSION = [0, 23, 0];
/** The oldest rtk seen with `rtk hook codex`; an older one would fail every hook run. */
const CODEX_HOOK_VERSION = [1, 0, 1];
/** `rtk hook opencode`, which OPENCODE_PLUGIN asks, landed in 0.52.0 (2026-10-13). */
const OPENCODE_HOOK_VERSION = [0, 52, 0];
/**
 * The OpenCode plugin for AO's OpenCode chats, written to the app's own folder (OpenCode imports a
 * plugin from a file, which app.asar is not) and listed in each chat's OPENCODE_CONFIG_CONTENT by
 * AO: the person's OpenCode config never changes, and OpenCode keeps loading their own plugins
 * beside it. rtk decides each rewrite with `rtk hook opencode`, the protocol of rtk's own plugin
 * (hooks/opencode/rtk.ts): it answers {} where the rewrite would change what OpenCode's permission
 * rules decide. Without rtk on OpenCode's PATH (binDir puts it there; the rewritten command needs
 * it too) the hook fails and the command runs as written. Checked live with OpenCode 1.19.5 and
 * rtk 1.2.0 (AO's TestLiveRTKPluginRewritesOpenCodeShellCommands). OpenCode 1.x calls server(),
 * OpenCode 2.x setup().
 */
const OPENCODE_PLUGIN = `// RTK for this OpenCode chat's own shell, written by Coding Tools and listed only in the chat's
// OPENCODE_CONFIG_CONTENT (your OpenCode config is unchanged). rtk decides each rewrite:
// "rtk hook opencode [--agent <name>] <command>" answers {"command": "..."}, or {} where the rewrite
// would change what OpenCode's permission rules decide, the protocol of rtk's own plugin
// (hooks/opencode/rtk.ts). An rtk that is missing, fails or times out leaves the command as written.
import { execFile } from "node:child_process"

function rewrite(command: unknown, agent?: string): Promise<string | null> {
  if (typeof command !== "string" || !command.trim() || process.env.RTK_DISABLED === "1") return Promise.resolve(null)
  const args = ["hook", "opencode", ...(agent ? ["--agent", agent] : []), command]
  return new Promise((resolve) => {
    execFile("rtk", args, { encoding: "utf8", timeout: 3000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null)
      try {
        const answer = JSON.parse(String(stdout ?? "").trim() || "{}")
        const next = typeof answer?.command === "string" ? answer.command.trim() : ""
        resolve(next && next !== command ? next : null)
      } catch {
        resolve(null)
      }
    })
  })
}

async function handle(tool: unknown, args: any, agent?: string) {
  const name = String(tool ?? "").toLowerCase()
  if ((name !== "bash" && name !== "shell") || !args || typeof args !== "object") return
  const next = await rewrite(args.command, agent)
  if (next) args.command = next
}

// OpenCode 1.x calls server(), 2.x setup().
export default {
  id: "rtk",
  async setup(ctx: any) {
    await ctx?.tool?.hook?.("execute.before", (event: any) =>
      handle(event?.tool, event?.input, typeof event?.agent === "string" ? event.agent : undefined))
  },
  async server() {
    return { "tool.execute.before": (input: any, output: any) => handle(input?.tool, output?.args) }
  },
}
`;
const FIND_TTL_MS = 60_000;
const AUTO_INSTALL_RETRY_MS = 24 * 60 * 60 * 1000;
const REWRITE_TIMEOUT_MS = 3_000;
const MAX_COMMAND = 16_384;
const VERSION_LINE = /^rtk\s+(\d+)\.(\d+)\.(\d+)/m;
/**
 * What every rtk run for an agent or the RTK page gets. Without its hook in the person's global
 * Claude settings, which Coding Tools never edits (each session gets the hook instead), rtk starts
 * every run with "[rtk] /!\ No hook installed — run `rtk init -g`" on stderr. Claude Code's Bash
 * tool showed that line atop 952 of the agents' outputs in two days (2026-11-02), telling the agent
 * and the person that rtk wasn't set up when it had just compacted that very output.
 */
const QUIET = Object.freeze({ RTK_SUPPRESS_HOOK_WARNING: "1" });

/**
 * rtk subcommands that run a Unix program of that name (`rtk ls` and `rtk tree` "proxy to native"
 * ls and tree) or need one (grep, wc, wget). In Claude Code's PowerShell tool on Windows `ls` is
 * Get-ChildItem, `tree` is tree.com and the rest are missing, so "rtk ls -Force" fails where
 * "ls -Force" worked (rtk 1.2.0, 2026-11-12). The rest of what rtk rewrites there runs the same
 * program (all 351 rewrites of 5,365 recorded PowerShell commands were git, gh, cargo or bun) or is
 * rtk's own (read, find, diff).
 */
const POWERSHELL_MISSING = Object.freeze(["ls", "tree", "grep", "wc", "wget"]);

/**
 * The hook command for Claude Code's PowerShell tool built around `hook` (RTK's Claude hook), or "".
 * rtk's Claude hook answers the same whichever tool asks, so its answer is dropped when the rewrite
 * would run one of POWERSHELL_MISSING: the command then runs as written. Claude Code runs a hook
 * command with Git Bash where there is one (its Bash tool needs it, and the Bash hook's quoted path
 * already relies on it), so bash's own [[ =~ ]] does the check with no process besides rtk's; rtk's
 * stdin and exit status pass through. Without Git Bash it fails to parse and nothing is rewritten.
 */
function powerShellHookFrom(hook) {
  if (!hook) return "";
  return `o=$(${hook}); s=$?; [[ $o =~ rtk\\ (${POWERSHELL_MISSING.join("|")})([^[:alnum:]_-]|$) ]] && o=; printf '%s' "$o"; exit $s`;
}

const atLeast = (version, minimum) => {
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
};

/** rtk's path as a command word for cmd.exe and Git Bash alike (always quoted: one form to unwrap). */
const quoted = (file) => `"${file}"`;

/**
 * `pluginDir` is the app's own folder for OPENCODE_PLUGIN (on the app's data drive, never the system
 * one); without it OpenCode chats get no plugin.
 */
function createRtk({ getEnabled = () => true, logger = null, env = process.env, platform = process.platform,
  run = spawnSync, spawnProcess = spawn, now = Date.now, exists = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } },
  listDir = (dir) => fs.readdirSync(dir), pluginDir = null } = {}) {
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
   * Even an asynchronous spawn creates the process on the calling thread, so it starts from a worker
   * (off-thread-run.cjs): 0.8.35's first start logged rtk's spawn holding main for 1.6 s.
   */
  const runAsync = run === spawnSync
    ? async (file, args, { timeout = 10_000, env: childEnv = env } = {}) => {
      const reply = await runOffThread({ file, args, env: childEnv, timeoutMs: timeout, maxBytes: 256 * 1024 });
      if (reply.timedOut) return { error: new Error("timed out") };
      if (reply.error) return { error: new Error(reply.error) };
      return { status: reply.code, stdout: reply.stdout };
    }
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
    if (checkedAt === -Infinity) return refreshing ? null : locate();
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
    const childEnv = { ...env, ...QUIET };
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
  /**
   * RTK's hook for Claude Code's PowerShell tool (powerShellHookFrom), or "" when rtk is off or
   * missing. Agents moved to that tool: 6,283 of their 13,087 commands in three days, and 136 of
   * 137 in two hours (2026-11-12), went through it, and a hook for Bash alone rewrote none of them.
   */
  const claudePowerShellHook = () => powerShellHookFrom(claudeHook());
  /**
   * RTK's Codex hook command, or "" when rtk is off, missing or too old for it. Codex runs a hook
   * with the turn's own shell, PowerShell on Windows, where a quoted path followed by arguments is a
   * syntax error (every run failed with exit 1). So rtk is named bare: binDir puts its folder first
   * on the agents' PATH, which the command rtk returns ("rtk git status") needs as well. Without it
   * the hook fails and Codex runs the command as written.
   */
  const codexHook = () => {
    const tool = active();
    return tool && atLeast(tool.version.split(".").map(Number), CODEX_HOOK_VERSION) ? "rtk hook codex" : "";
  };
  /**
   * OPENCODE_PLUGIN's file, written to `pluginDir` once per run (again only when it is missing or
   * differs). Resolves with its path, or "" without a folder or when the write failed (the next
   * AO start tries again).
   */
  let pluginFile = "";
  let pluginWrite = null;
  function writeOpencodePlugin() {
    if (!pluginDir) return Promise.resolve("");
    pluginWrite ??= (async () => {
      const file = path.join(pluginDir, "rtk.ts");
      try {
        const current = await fs.promises.readFile(file, "utf8").catch(() => null);
        if (current !== OPENCODE_PLUGIN) await writePrivateFileAtomicAsync(file, OPENCODE_PLUGIN);
        pluginFile = file;
        return file;
      } catch (error) {
        logger?.warn?.("rtk.opencode_plugin_failed", { message: String(error?.message ?? error) });
        pluginWrite = null;
        return "";
      }
    })();
    return pluginWrite;
  }
  /**
   * The OpenCode plugin's path for AO, or "" when rtk is off, missing or too old for
   * `rtk hook opencode`, or the file isn't written (ready writes it before AO starts).
   */
  const opencodePlugin = () => {
    const tool = active();
    return tool && pluginFile && atLeast(tool.version.split(".").map(Number), OPENCODE_HOOK_VERSION) ? pluginFile : "";
  };
  /** The folder holding rtk, for the agents' PATH (a rewritten command calls `rtk`). */
  const binDir = () => {
    const tool = active();
    return tool ? path.dirname(tool.path) : "";
  };
  /** What a command an agent runs gets while rtk is on: no "No hook installed" line (QUIET). */
  const commandEnvironment = () => (active() ? { ...QUIET } : {});
  /** What AO's daemon passes to every chat agent. An empty hook or plugin turns it off. */
  const daemonEnvironment = () => {
    const hook = claudeHook();
    return { CODING_TOOLS_RTK_CLAUDE_HOOK: hook, CODING_TOOLS_RTK_CLAUDE_POWERSHELL_HOOK: powerShellHookFrom(hook),
      CODING_TOOLS_RTK_CODEX_HOOK: codexHook(), CODING_TOOLS_RTK_OPENCODE_PLUGIN: opencodePlugin(), ...(hook ? QUIET : {}) };
  };

  /** RTK's own savings report (`rtk gain`), as text and, when rtk can give it, JSON (resolves). */
  async function gain() {
    const tool = await locateAsync();
    if (!tool) return { available: false };
    // Two runs of up to 10 s each blocked the main process while the RTK page asked for them.
    // Quiet too: the page showed "No hook installed — run `rtk init -g`" above the savings.
    const quietEnv = { ...env, ...QUIET };
    const [text, json] = await Promise.all([
      runAsync(tool.path, ["gain"], { encoding: "utf8", timeout: 10_000, windowsHide: true, env: quietEnv }),
      runAsync(tool.path, ["gain", "--all", "--format", "json"], { encoding: "utf8", timeout: 10_000, windowsHide: true, env: quietEnv }),
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

  /**
   * winget `verb` for rtk (Windows); resolves with its exit code and output tail. One at a time:
   * a retry (`retry` answers the first run with extra arguments, or null) runs inside the same turn.
   */
  function winget(verb, args, retry = () => null) {
    if (installing) return installing;
    const once = (extra) => new Promise((resolve, reject) => {
      let output = "";
      const child = spawnProcess("winget", [verb, ...args, ...extra, "--accept-source-agreements", "--accept-package-agreements", "--silent"],
        { windowsHide: true, env });
      child.stdout?.on("data", (chunk) => { output = (output + chunk).slice(-4_000); });
      child.stderr?.on("data", (chunk) => { output = (output + chunk).slice(-4_000); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output: output.trim().slice(-2_000) }));
    });
    installing = (async () => {
      let run;
      try {
        run = await once([]);
        const extra = retry(run);
        if (extra) run = await once(extra);
      } finally {
        installing = null;
        checkedAt = -Infinity;
      }
      logger?.info?.(`rtk.${verb}_finished`, { code: run.code });
      return { ...run, status: await status() };
    })();
    return installing;
  }

  /** Installs rtk with winget (Windows); resolves with its exit code and output tail. One at a time. */
  function install() {
    if (platform !== "win32") return Promise.reject(new Error("Install rtk with your package manager: brew install rtk"));
    return winget("install", ["--id", "rtk-ai.rtk", "-e"]);
  }

  /**
   * Upgrades the winget-installed rtk to winget's newest (App plugins' Update button). winget won't
   * replace a portable package whose folder changed since it was installed ("Unable to remove
   * Portable package as it has been modified"); rtk's folder is ours to replace, so that one refusal
   * is answered with --force. The caller still checks the version that results.
   */
  function upgrade() {
    if (platform !== "win32") return Promise.reject(new Error("Update rtk with your package manager: brew upgrade rtk"));
    return winget("upgrade", ["--id", "rtk-ai.rtk", "--exact"],
      (run) => run.code !== 0 && /portable package as it has been modified/i.test(run.output) ? ["--force"] : null);
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
   * which hands its PATH and Claude's hook to every agent) is started with rtk. The OpenCode
   * plugin's file is written meanwhile, for daemonEnvironment.
   */
  function ready(timeoutMs) {
    // The startup check resolves with the install it started, if any.
    const pending = [checking ?? installing, pluginDir ? writeOpencodePlugin() : null].filter(Boolean);
    if (!pending.length) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      Promise.all(pending.map((work) => work.then(() => {}, () => {}))).then(() => { clearTimeout(timer); resolve(); });
    });
  }

  return { locate, active, rewrite, unwrap, claudeHook, claudePowerShellHook, codexHook, opencodePlugin, binDir, commandEnvironment, daemonEnvironment, gain, status, install, upgrade, autoInstall, ready };
}

module.exports = { createRtk, powerShellHookFrom, POWERSHELL_MISSING };
