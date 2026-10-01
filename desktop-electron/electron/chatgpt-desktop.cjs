"use strict";

// Runs the installed ChatGPT desktop app (MSIX package OpenAI.Codex) as an isolated,
// Coding Tools-owned instance per account and docks its window over the ChatGPT Desktop pane.
//
// Isolation: the instance is activated inside the package (it needs package identity) through
// cmd.exe, which sets CODEX_HOME, APPDATA and LOCALAPPDATA to a per-account slot under
// <core home>/chatgpt-desktop before starting ChatGPT.exe. The slot therefore owns the Electron
// profile, the single-instance lock and the Codex auth.json; the user's own installed ChatGPT
// keeps running untouched. Slots live outside %APPDATA% so MSIX file virtualization never
// redirects them into the package's private LocalCache.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createWin32Helper } = require("./chatgpt-desktop-win32.cjs");
const {
  desktopAuthFromCpa,
  jwtEmail,
  readJson,
  syncAccountPair,
  writeJson,
} = require("./chatgpt-desktop-sync.cjs");

const WINDOW_WAIT_MS = 60_000;
// ChatGPT treats WM_CLOSE as "hide to background" at times; give it a moment to flush its
// profile, then end the tree.
const CLOSE_WAIT_MS = 3_000;
const PLACEMENT_INTERVAL_MS = 500;
const SYNC_INTERVAL_MS = 60_000;
const SYNC_DEBOUNCE_MS = 800;
const ACCOUNT_POLL_MS = 15_000;
// Each instance is a full ChatGPT app (Electron plus its Codex backend); past this many, the
// least recently used background account is closed to make room.
const MAX_RUNNING_INSTANCES = 4;
// Background (hidden) instances are checked for exit every this many placement ticks (~5s).
const BACKGROUND_CHECK_EVERY = 10;
// A background (hidden) account nobody has looked at for this long is closed to free memory.
// The account shown in the pane is never closed automatically.
const IDLE_CLOSE_MS = 20 * 60_000;
// A failed auto-start waits this long before its next try, doubling up to an hour.
const AUTO_START_RETRY_MS = 5 * 60_000;
const AUTO_START_RETRY_MAX_MS = 60 * 60_000;
const SEED_SANDBOX_MODE = "unelevated";
const GLOBAL_STATE_FILE = ".codex-global-state.json";
const PERSISTED_ATOMS = "electron-persisted-atom-state";
const ONBOARDED_BY_ACCOUNT = "electron:onboarding-conversational-completed-by-account-id";
const ONBOARDING_FLAGS = [
  "electron:onboarding-projectless-completed",
  "chatgpt-migration-announcement-completed-v1",
  "electron:onboarding-welcome-v2-role-state",
  "electron:conversational-onboarding-workflow",
  "electron:onboarding-hide-first-new-thread-promos",
];
const SLOT_ID = /^(cpa|local)-[a-z0-9]{6,32}$/;
// cmd.exe expands or splits on these even inside quotes, so slot paths must not contain them.
const CMD_UNSAFE = /["%^&|<>!\r\n]/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function slotPaths(dataRoot, slotId) {
  if (!SLOT_ID.test(slotId)) throw new Error("Invalid ChatGPT desktop account slot");
  const root = path.join(dataRoot, "slots", slotId);
  const codexHome = path.join(root, "codex-home");
  return {
    root,
    codexHome,
    auth: path.join(codexHome, "auth.json"),
    roaming: path.join(root, "roaming"),
    local: path.join(root, "local"),
  };
}

function cpaSlotId(accountId, email) {
  const digest = crypto.createHash("sha256").update(`${accountId || ""}|${(email || "").toLowerCase()}`).digest("hex");
  return `cpa-${digest.slice(0, 16)}`;
}

// Coding Tools' global proxy routing publishes its route in this process's environment
// (provider-network applyGlobalRouting). The ChatGPT instance is a separate program that inherits
// none of it; launched without it, it reaches chatgpt.com directly, where a region block answers
// every account lookup with 403 and the app falls back to its sign-in screen.
function proxyRouteFromEnvironment(env = process.env) {
  const url = env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY;
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  // A command line is visible to every local process, so credentials never go on it.
  if (parsed.username || parsed.password) return null;
  const bypass = String(env.NO_PROXY || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return { url, bypass };
}

function planFromFileName(fileName, email) {
  const stem = fileName.replace(/^codex-/, "").replace(/\.json$/i, "");
  return email && stem.startsWith(`${email}-`) ? stem.slice(email.length + 1) || null : null;
}

function createChatGptDesktopHost({
  logger,
  dataRoot,
  resolveCpaAuthDir,
  onChange = () => {},
  helper = createWin32Helper({ logger }),
  platform = process.platform,
  getProxyRoute = proxyRouteFromEnvironment,
  homeDir = require("node:os").homedir(),
  autoStart = true,
  idleCloseMs = IDLE_CLOSE_MS,
  windowWaitMs = WINDOW_WAIT_MS,
  autoStartRetryMs = AUTO_START_RETRY_MS,
}) {
  const statePath = path.join(dataRoot, "state.json");
  let state = { active: null, local: [] };
  try {
    const saved = readJson(statePath);
    if (saved && typeof saved === "object") {
      state = {
        active: typeof saved.active === "string" && SLOT_ID.test(saved.active) ? saved.active : null,
        local: Array.isArray(saved.local) ? saved.local.filter((entry) => SLOT_ID.test(entry?.id)) : [],
      };
    }
  } catch (error) {
    logger?.warn?.("chatgpt_desktop.state_unreadable", { message: error.message });
  }

  let packageInfo;
  // Every account keeps its own instance running once started, so switching only swaps which
  // window is docked instead of closing one app and cold-starting another.
  const instances = new Map(); // slotId -> { slotId, pid, hwnd, lastActiveAt }
  const activeInstance = () => (state.active ? instances.get(state.active) ?? null : null);
  let owner = null;
  let ownerVisible = true;
  let surfaceActive = false;
  let bounds = null;
  let busy = null;
  let lastError = null;
  let queue = Promise.resolve();
  let placementTimer = null;
  let placementRunning = false;
  const syncs = new Map(); // slotId -> { watchers, timer, debounce }
  let autoStartQueued = false;
  const autoStartBackoff = new Map(); // slotId -> { until, delay }

  function persist() {
    writeJson(statePath, state);
  }

  function emit() {
    try { onChange(status()); } catch {}
  }

  // --- account discovery ----------------------------------------------------------------
  // Accounts added, removed or disabled in CPA must reach the picker without a restart: the
  // pane stays mounted, so nothing else would ever re-read the list.

  let accountWatch = null; // { directory, watcher, timer, debounce, signature }

  function accountSignature() {
    return JSON.stringify(accountList().map((a) => [a.slotId, a.email, a.plan, a.disabled, a.signedIn]));
  }

  function currentCpaAuthDir() {
    try { return resolveCpaAuthDir(); } catch { return null; }
  }

  function stopWatchingAccounts() {
    if (!accountWatch) return;
    try { accountWatch.watcher?.close(); } catch {}
    clearInterval(accountWatch.timer);
    clearTimeout(accountWatch.debounce);
    accountWatch = null;
  }

  function watchAccounts() {
    stopWatchingAccounts();
    const current = { directory: currentCpaAuthDir(), watcher: null, timer: null, debounce: null, signature: accountSignature() };
    const check = () => {
      clearTimeout(current.debounce);
      current.debounce = setTimeout(() => {
        if (accountWatch !== current) return;
        // CPA's auth-dir setting can move; follow it.
        if (currentCpaAuthDir() !== current.directory) { watchAccounts(); emit(); return; }
        const next = accountSignature();
        if (next === current.signature) return;
        current.signature = next;
        emit();
        scheduleAutoStart();
      }, SYNC_DEBOUNCE_MS);
    };
    if (current.directory) {
      try {
        current.watcher = fs.watch(current.directory, (_event, name) => {
          if (!name || /\.json$/i.test(String(name))) check();
        });
      } catch (error) {
        // Missing folder (no CPA account yet) or a watch failure: the slow re-check still covers it.
        if (error?.code !== "ENOENT") logger?.warn?.("chatgpt_desktop.account_watch_failed", { message: error.message });
      }
    }
    // fs.watch can miss atomic renames and cannot watch a folder that does not exist yet.
    current.timer = setInterval(check, ACCOUNT_POLL_MS);
    current.timer.unref?.();
    accountWatch = current;
  }

  function exclusive(label, action) {
    const run = queue.then(async () => {
      busy = label;
      lastError = null;
      emit();
      try {
        return await action();
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        logger?.warn?.("chatgpt_desktop.operation_failed", { operation: label, message: lastError });
        throw error;
      } finally {
        busy = null;
        emit();
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  async function resolvePackage() {
    if (packageInfo !== undefined) return packageInfo;
    if (platform !== "win32") return (packageInfo = null);
    const found = await helper.call("package");
    const exe = found?.location ? path.join(found.location, "app", "ChatGPT.exe") : null;
    packageInfo = exe && fs.existsSync(exe) ? { ...found, exe } : null;
    return packageInfo;
  }

  function cpaAccounts() {
    let directory;
    try { directory = resolveCpaAuthDir(); } catch { return []; }
    let names;
    try { names = fs.readdirSync(directory); } catch { return []; }
    const accounts = [];
    for (const name of names) {
      // CPA identifies a Codex account by its `type`, not its file name: accounts added through
      // some flows are saved as "<email>.json" with no "codex-" prefix. The type check below decides.
      if (!/\.json$/i.test(name)) continue;
      const file = path.join(directory, name);
      let raw;
      try { raw = readJson(file); } catch { continue; }
      if (!raw || String(raw.type || "").toLowerCase() !== "codex" || typeof raw.refresh_token !== "string") continue;
      const email = typeof raw.email === "string" ? raw.email : jwtEmail(raw.id_token);
      accounts.push({
        slotId: cpaSlotId(raw.account_id, email),
        source: "cpa",
        file,
        email: email || null,
        plan: planFromFileName(name, email),
        disabled: raw.disabled === true,
      });
    }
    return accounts.sort((a, b) => String(a.email).localeCompare(String(b.email)));
  }

  function slotSignedIn(slotId) {
    try { return fs.existsSync(slotPaths(dataRoot, slotId).auth); } catch { return false; }
  }

  function localEmail(slotId) {
    try { return jwtEmail(readJson(slotPaths(dataRoot, slotId).auth)?.tokens?.id_token); } catch { return null; }
  }

  function accountList() {
    const fromCpa = cpaAccounts().map((account) => ({
      slotId: account.slotId,
      source: account.source,
      email: account.email,
      plan: account.plan,
      disabled: account.disabled,
      signedIn: slotSignedIn(account.slotId),
    }));
    const local = state.local.map((entry) => ({
      slotId: entry.id,
      source: "local",
      email: localEmail(entry.id),
      plan: null,
      disabled: false,
      signedIn: slotSignedIn(entry.id),
    }));
    return [...fromCpa, ...local].map((account) => ({ ...account, active: account.slotId === state.active }));
  }

  function status() {
    return {
      supported: platform === "win32",
      installed: Boolean(packageInfo),
      version: packageInfo?.version ?? null,
      running: Boolean(activeInstance()),
      activeSlotId: state.active,
      runningSlotId: activeInstance()?.slotId ?? null,
      runningSlotIds: [...instances.keys()],
      busy,
      error: lastError,
      accounts: accountList(),
    };
  }

  // --- token hand-off -------------------------------------------------------------------

  function prepareCpaAuth(account, paths) {
    if (!fs.existsSync(paths.auth)) {
      // First use of this account in the slot: sign the instance in with CPA's tokens.
      writeJson(paths.auth, desktopAuthFromCpa(readJson(account.file)));
      logger?.info?.("chatgpt_desktop.auto_login_seeded", { slotId: account.slotId });
      return;
    }
    syncNow(account, paths);
  }

  function syncNow(account, paths) {
    try {
      const direction = syncAccountPair({ desktopPath: paths.auth, cpaPath: account.file });
      if (direction) logger?.info?.("chatgpt_desktop.tokens_synced", { slotId: account.slotId, direction });
    } catch (error) {
      logger?.warn?.("chatgpt_desktop.token_sync_failed", { slotId: account.slotId, message: error.message });
    }
  }

  function stopSync(slotId) {
    const current = syncs.get(slotId);
    if (!current) return;
    for (const watcher of current.watchers) { try { watcher.close(); } catch {} }
    clearInterval(current.timer);
    clearTimeout(current.debounce);
    syncs.delete(slotId);
  }

  function stopAllSync() {
    for (const slotId of [...syncs.keys()]) stopSync(slotId);
  }

  function startSync(slotId) {
    stopSync(slotId);
    const account = cpaAccounts().find((entry) => entry.slotId === slotId);
    if (!account) return;
    const paths = slotPaths(dataRoot, slotId);
    const current = { watchers: [], timer: null, debounce: null };
    const schedule = () => {
      clearTimeout(current.debounce);
      current.debounce = setTimeout(() => {
        // CPA may have renamed or rewritten the file; resolve it again each time.
        const latest = cpaAccounts().find((entry) => entry.slotId === slotId);
        if (latest) syncNow(latest, paths);
      }, SYNC_DEBOUNCE_MS);
    };
    for (const [directory, fileName] of [[paths.codexHome, "auth.json"], [path.dirname(account.file), null]]) {
      try {
        current.watchers.push(fs.watch(directory, (_event, changed) => {
          const name = changed ? String(changed) : "";
          if (fileName ? name === fileName : /\.json$/i.test(name)) schedule();
        }));
      } catch (error) {
        logger?.warn?.("chatgpt_desktop.watch_failed", { message: error.message });
      }
    }
    // fs.watch can miss atomic renames; a slow sweep keeps both sides converged regardless.
    current.timer = setInterval(schedule, SYNC_INTERVAL_MS);
    current.timer.unref?.();
    syncs.set(slotId, current);
  }

  function finalSync(slotId) {
    const account = cpaAccounts().find((entry) => entry.slotId === slotId);
    if (account) syncNow(account, slotPaths(dataRoot, slotId));
  }

  // --- first-run profile ----------------------------------------------------------------
  // Every slot is a fresh ChatGPT profile, so without this each account would stop on the
  // Windows sandbox prompt and replay the "personalize your experience" onboarding. Only missing
  // settings are added; anything the app or the user already chose is left alone.

  function seedSandboxMode(paths) {
    const file = path.join(paths.codexHome, "config.toml");
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch {}
    if (/^\s*\[windows\]\s*$/m.test(text)) return;
    // "unelevated" needs no one-time administrator (UAC) setup, unlike "elevated".
    const section = `[windows]\nsandbox = "${SEED_SANDBOX_MODE}"\n`;
    fs.writeFileSync(file, text ? `${text.replace(/\s*$/, "\n")}\n${section}` : section);
  }

  // Onboarding answers from a profile that already finished it: another slot first, then the
  // user's own Codex home. Only the allowlisted UI flags are read.
  function onboardingTemplate() {
    const candidates = [];
    try {
      for (const name of fs.readdirSync(path.join(dataRoot, "slots"))) {
        candidates.push(path.join(dataRoot, "slots", name, "codex-home", GLOBAL_STATE_FILE));
      }
    } catch {}
    candidates.push(path.join(homeDir, ".codex", GLOBAL_STATE_FILE));
    for (const file of candidates) {
      let atoms;
      try { atoms = readJson(file)?.[PERSISTED_ATOMS]; } catch { continue; }
      if (atoms?.["electron:onboarding-welcome-v2-role-state"]?.completedConversationalOnboarding === true) {
        return Object.fromEntries(ONBOARDING_FLAGS.filter((key) => key in atoms).map((key) => [key, atoms[key]]));
      }
    }
    return {
      "electron:onboarding-projectless-completed": true,
      "chatgpt-migration-announcement-completed-v1": true,
      "electron:onboarding-welcome-v2-role-state": { completedConversationalOnboarding: true },
    };
  }

  function seedOnboarding(paths, accountId) {
    const file = path.join(paths.codexHome, GLOBAL_STATE_FILE);
    let saved = {};
    try { saved = readJson(file) ?? {}; } catch {}
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return; // unreadable: leave it
    const atoms = { ...(saved[PERSISTED_ATOMS] ?? {}) };
    let changed = false;
    for (const [key, value] of Object.entries(onboardingTemplate())) {
      if (key in atoms) continue;
      atoms[key] = value;
      changed = true;
    }
    if (!atoms.last_completed_onboarding) {
      atoms.last_completed_onboarding = Math.floor(Date.now() / 1000);
      changed = true;
    }
    if (accountId) {
      const done = { ...(atoms[ONBOARDED_BY_ACCOUNT] ?? {}) };
      if (done[accountId] !== true) {
        done[accountId] = true;
        atoms[ONBOARDED_BY_ACCOUNT] = done;
        changed = true;
      }
    }
    if (changed) writeJson(file, { ...saved, [PERSISTED_ATOMS]: atoms });
  }

  function prepareProfile(slotId, paths) {
    const account = cpaAccounts().find((entry) => entry.slotId === slotId);
    let accountId = null;
    try { accountId = account ? readJson(account.file)?.account_id ?? null : null; } catch {}
    try {
      seedSandboxMode(paths);
      seedOnboarding(paths, typeof accountId === "string" ? accountId : null);
    } catch (error) {
      logger?.warn?.("chatgpt_desktop.profile_seed_failed", { slotId, message: error.message });
    }
  }

  // --- process and window ---------------------------------------------------------------

  async function findInstance(slotId) {
    const found = await helper.call("find", { marker: slotPaths(dataRoot, slotId).roaming });
    return found?.pid ? { slotId, pid: found.pid, hwnd: Number(found.hwnd) || 0 } : null;
  }

  async function waitForWindow(slotId) {
    const deadline = Date.now() + windowWaitMs;
    while (Date.now() < deadline) {
      const found = await findInstance(slotId);
      if (found?.hwnd) return found;
      await sleep(750);
    }
    throw new Error("ChatGPT did not open a window within a minute");
  }

  async function launchInstance(slotId) {
    const pkg = await resolvePackage();
    if (!pkg) throw new Error("The ChatGPT desktop app is not installed (Microsoft Store package OpenAI.Codex)");
    const paths = slotPaths(dataRoot, slotId);
    for (const value of [paths.codexHome, paths.roaming, paths.local, pkg.exe]) {
      if (CMD_UNSAFE.test(value)) throw new Error(`ChatGPT desktop path contains characters cmd.exe cannot pass safely: ${value}`);
    }
    for (const directory of [paths.codexHome, paths.roaming, paths.local]) fs.mkdirSync(directory, { recursive: true });

    const account = cpaAccounts().find((entry) => entry.slotId === slotId);
    if (account) prepareCpaAuth(account, paths);

    // A slow start has a process before it has a window. Starting another copy then would
    // run the same account twice and, on every account change, pile up more of them.
    const existing = await findInstance(slotId);
    if (existing?.hwnd) return existing;
    if (existing?.pid) return await waitForWindow(slotId);
    prepareProfile(slotId, paths);

    const command = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
    const env = [
      ["CODEX_HOME", paths.codexHome],
      ["APPDATA", paths.roaming],
      ["LOCALAPPDATA", paths.local],
      ["CODEX_ELECTRON_DISABLE_QUIT_CONFIRMATION", "1"],
    ];
    // The app's Rust backend reads the *_PROXY variables; its Electron window ignores them on
    // Windows and needs Chromium's own switches.
    let proxy = getProxyRoute();
    if (proxy && [proxy.url, ...proxy.bypass].some((value) => CMD_UNSAFE.test(value) || /\s/.test(value))) {
      logger?.warn?.("chatgpt_desktop.proxy_not_passed", { reason: "unsafe_characters" });
      proxy = null;
    }
    let switches = "";
    if (proxy) {
      const noProxy = proxy.bypass.join(",");
      env.push(["HTTPS_PROXY", proxy.url], ["HTTP_PROXY", proxy.url], ["ALL_PROXY", proxy.url], ["NO_PROXY", noProxy]);
      switches = ` --proxy-server="${proxy.url}"${proxy.bypass.length ? ` --proxy-bypass-list="${proxy.bypass.join(";")}"` : ""}`;
    }
    const argumentsText = `/d /c ${env.map(([key, value]) => `set "${key}=${value}"&& `).join("")}start "" "${pkg.exe}"${switches}`;
    await helper.call("launch", { family: pkg.family, command, arguments: argumentsText }, 45_000);
    logger?.info?.("chatgpt_desktop.instance_launched", {
      slotId, signedIn: fs.existsSync(paths.auth), proxied: Boolean(proxy),
    });
    return await waitForWindow(slotId);
  }

  async function stopInstance(slotId = state.active) {
    const current = slotId ? instances.get(slotId) : null;
    if (!current) return;
    instances.delete(slotId);
    if (!instances.size) stopPlacementLoop();
    finalSync(slotId);
    stopSync(slotId);
    try {
      if (current.hwnd) await helper.call("close", { hwnd: current.hwnd });
      const deadline = Date.now() + CLOSE_WAIT_MS;
      while (Date.now() < deadline && await helper.call("running", { pid: current.pid })) await sleep(300);
      if (await helper.call("running", { pid: current.pid })) await helper.call("kill-tree", { pid: current.pid });
    } catch (error) {
      logger?.warn?.("chatgpt_desktop.stop_failed", { message: error.message });
    }
    logger?.info?.("chatgpt_desktop.instance_stopped", { slotId });
  }

  async function stopAllInstances() {
    for (const slotId of [...instances.keys()]) await stopInstance(slotId);
  }

  // Past the cap, close the least recently used background account (never the active one).
  async function makeRoom() {
    while (instances.size >= MAX_RUNNING_INSTANCES) {
      const idle = [...instances.values()]
        .filter((entry) => entry.slotId !== state.active)
        .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
      if (!idle) return;
      await stopInstance(idle.slotId);
    }
  }

  async function adopt(found) {
    const previous = instances.get(found.slotId);
    instances.set(found.slotId, {
      ...found,
      startedAt: previous?.startedAt ?? Date.now(),
      lastActiveAt: found.slotId === state.active ? Date.now() : previous?.lastActiveAt ?? 0,
    });
    if (owner) await helper.call("dock", { hwnd: found.hwnd, owner });
    startSync(found.slotId);
    startPlacementLoop();
    await placeNow({ hideOthers: true });
  }

  function shouldShow() {
    return Boolean(activeInstance()?.hwnd && owner && surfaceActive && ownerVisible && bounds
      && bounds.width >= 80 && bounds.height >= 80);
  }

  // Only the active account's window is ever shown; the other instances keep running hidden.
  async function placeNow({ hideOthers = false } = {}) {
    const active = activeInstance();
    if (hideOthers) {
      for (const entry of instances.values()) {
        if (entry !== active && entry.hwnd) await helper.call("hide", { hwnd: entry.hwnd });
      }
    }
    if (!active?.hwnd) return;
    if (shouldShow()) {
      await helper.call("place", {
        hwnd: active.hwnd,
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    } else {
      await helper.call("hide", { hwnd: active.hwnd });
    }
  }

  let placementTicks = 0;

  async function placementTick() {
    if (placementRunning || !instances.size) return;
    placementRunning = true;
    try {
      // The docked window every tick; background instances only every few seconds.
      const everyone = placementTicks++ % BACKGROUND_CHECK_EVERY === 0;
      for (const entry of [...instances.values()]) {
        if (!everyone && entry.slotId !== state.active) continue;
        if (await helper.call("alive", { hwnd: entry.hwnd })) continue;
        // The app can replace its window (sign-in, crash recovery); follow it or notice it exited.
        const again = await findInstance(entry.slotId);
        if (again?.hwnd) {
          instances.set(entry.slotId, { ...again, startedAt: entry.startedAt, lastActiveAt: entry.lastActiveAt });
          if (owner) await helper.call("dock", { hwnd: again.hwnd, owner });
          if (entry.slotId !== state.active) await helper.call("hide", { hwnd: again.hwnd });
        } else {
          instances.delete(entry.slotId);
          finalSync(entry.slotId);
          stopSync(entry.slotId);
          logger?.info?.("chatgpt_desktop.instance_exited", { slotId: entry.slotId });
          emit();
        }
      }
      if (!instances.size) {
        stopPlacementLoop();
        return;
      }
      if (everyone) closeIdleInstances();
      if (shouldShow()) await placeNow();
    } catch (error) {
      logger?.warn?.("chatgpt_desktop.placement_failed", { message: error.message });
    } finally {
      placementRunning = false;
    }
  }

  function startPlacementLoop() {
    if (placementTimer) return;
    placementTimer = setInterval(() => void placementTick(), PLACEMENT_INTERVAL_MS);
  }

  function stopPlacementLoop() {
    clearInterval(placementTimer);
    placementTimer = null;
  }

  function idleSince(entry) {
    return Math.max(entry.lastActiveAt || 0, entry.startedAt || 0);
  }

  // Queued like any other operation, so an idle close never races a switch to that account.
  function closeIdleInstances(now = Date.now()) {
    for (const entry of instances.values()) {
      if (entry.slotId === state.active || now - idleSince(entry) < idleCloseMs) continue;
      const { slotId } = entry;
      queue = queue.then(async () => {
        const current = instances.get(slotId);
        if (!current || slotId === state.active || Date.now() - idleSince(current) < idleCloseMs) return;
        await stopInstance(slotId);
        logger?.info?.("chatgpt_desktop.idle_closed", { slotId });
        emit();
      }).catch(() => {});
    }
  }

  async function openSlot(slotId) {
    // Leaving an account is its last use; the idle clock starts now.
    const leaving = activeInstance();
    if (leaving && leaving.slotId !== slotId) leaving.lastActiveAt = Date.now();
    state.active = slotId;
    persist();
    // Hide whatever was docked right away, even if the new account still has to start.
    await placeNow({ hideOthers: true });
    const ready = instances.get(slotId);
    if (ready) {
      ready.lastActiveAt = Date.now();
      await placeNow();
      return;
    }
    await makeRoom();
    await adopt(await launchInstance(slotId));
  }

  // --- auto-start -----------------------------------------------------------------------
  // CPA accounts that can sign in start hidden in the background, so picking one is instant.
  // One queued job per account keeps the user's own clicks able to run in between.

  function autoStartCandidates() {
    return cpaAccounts()
      .filter((account) => !account.disabled && !instances.has(account.slotId)
        && !(autoStartBackoff.get(account.slotId)?.until > Date.now()))
      .sort((a, b) => Number(b.slotId === state.active) - Number(a.slotId === state.active));
  }

  function scheduleAutoStart() {
    if (!autoStart || !packageInfo || autoStartQueued) return;
    autoStartQueued = true;
    queue = queue.then(async () => {
      autoStartQueued = false;
      for (const account of autoStartCandidates()) {
        queue = queue.then(async () => {
          // Re-check: the user may have opened it, or the cap filled, while this waited.
          if (instances.has(account.slotId) || instances.size >= MAX_RUNNING_INSTANCES) return;
          if (!autoStartCandidates().some((entry) => entry.slotId === account.slotId)) return;
          try {
            await adopt(await launchInstance(account.slotId));
            autoStartBackoff.delete(account.slotId);
            logger?.info?.("chatgpt_desktop.auto_started", { slotId: account.slotId });
          } catch (error) {
            // Account changes (CPA rewrites auth files on every token refresh) re-run auto-start;
            // without a pause each run would relaunch the same failing account.
            const previous = autoStartBackoff.get(account.slotId)?.delay;
            const delay = previous ? Math.min(previous * 2, AUTO_START_RETRY_MAX_MS) : autoStartRetryMs;
            autoStartBackoff.set(account.slotId, { until: Date.now() + delay, delay });
            logger?.warn?.("chatgpt_desktop.auto_start_failed", { slotId: account.slotId, message: error.message, retryInMs: delay });
          }
          emit();
        }).catch(() => {});
      }
    }).catch(() => { autoStartQueued = false; });
  }

  function newLocalSlot() {
    const id = `local-${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
    state.local.push({ id, createdAt: new Date().toISOString() });
    persist();
    return id;
  }

  function trashSlot(slotId) {
    const paths = slotPaths(dataRoot, slotId);
    if (!fs.existsSync(paths.root)) return;
    const trash = path.join(dataRoot, "Trash");
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(paths.root, path.join(trash, `${slotId}-${Date.now()}`));
  }

  function knownSlot(slotId) {
    return accountList().some((account) => account.slotId === slotId);
  }

  return {
    async initialize() {
      await resolvePackage().catch((error) => {
        lastError = error.message;
        packageInfo = undefined;
      });
      // Re-adopt every account's instance that survived a Coding Tools restart.
      if (packageInfo) {
        for (const account of accountList()) {
          const found = await findInstance(account.slotId).catch(() => null);
          if (found?.hwnd) await adopt(found).catch(() => {});
        }
      }
      watchAccounts();
      emit();
      scheduleAutoStart();
      return status();
    },
    status,
    open(slotId) {
      if (typeof slotId !== "string" || !knownSlot(slotId)) throw new Error("Unknown ChatGPT desktop account");
      const account = accountList().find((entry) => entry.slotId === slotId);
      if (account.disabled) throw new Error("This CPA account is disabled; enable it in CPA first");
      return exclusive(instances.size ? "switching" : "launching", () => openSlot(slotId)).then(status);
    },
    newSignIn() {
      return exclusive("launching", async () => openSlot(newLocalSlot())).then(status);
    },
    // Wipes the active account's local session (moved to Trash) and opens a fresh sign-in slot.
    clearActive() {
      return exclusive("clearing", async () => {
        const slotId = state.active;
        if (!slotId) throw new Error("No ChatGPT desktop account is active");
        await stopInstance(slotId);
        finalSync(slotId);
        trashSlot(slotId);
        state.local = state.local.filter((entry) => entry.id !== slotId);
        state.active = null;
        persist();
        logger?.info?.("chatgpt_desktop.slot_cleared", { slotId });
        await openSlot(newLocalSlot());
      }).then(status);
    },
    stop() {
      return exclusive("stopping", stopInstance).then(status);
    },
    setOwner(hwnd) {
      if (!Number.isSafeInteger(hwnd) || hwnd <= 0 || hwnd === owner) return;
      owner = hwnd;
      void (async () => {
        for (const entry of instances.values()) {
          if (entry.hwnd) await helper.call("dock", { hwnd: entry.hwnd, owner });
        }
        await placeNow({ hideOthers: true });
      })().catch(() => {});
    },
    setOwnerVisible(visible) {
      ownerVisible = visible === true;
      void placeNow().catch(() => {});
    },
    setSurfaceActive(active) {
      surfaceActive = active === true;
      void placeNow().catch(() => {});
    },
    setBounds(next) {
      bounds = next;
      void placeNow().catch(() => {});
    },
    async shutdown() {
      stopPlacementLoop();
      stopWatchingAccounts();
      try { await stopAllInstances(); } finally { stopAllSync(); helper.dispose(); }
    },
  };
}

module.exports = {
  proxyRouteFromEnvironment, createChatGptDesktopHost, cpaSlotId, planFromFileName, slotPaths };
