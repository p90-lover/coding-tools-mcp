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
  let instance = null; // { slotId, pid, hwnd }
  let owner = null;
  let ownerVisible = true;
  let surfaceActive = false;
  let bounds = null;
  let busy = null;
  let lastError = null;
  let queue = Promise.resolve();
  let placementTimer = null;
  let placementRunning = false;
  let sync = null; // { slotId, watchers, timer, debounce }

  function persist() {
    writeJson(statePath, state);
  }

  function emit() {
    try { onChange(status()); } catch {}
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
      running: Boolean(instance),
      activeSlotId: state.active,
      runningSlotId: instance?.slotId ?? null,
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

  function stopSync() {
    if (!sync) return;
    for (const watcher of sync.watchers) { try { watcher.close(); } catch {} }
    clearInterval(sync.timer);
    clearTimeout(sync.debounce);
    sync = null;
  }

  function startSync(slotId) {
    stopSync();
    const account = cpaAccounts().find((entry) => entry.slotId === slotId);
    if (!account) return;
    const paths = slotPaths(dataRoot, slotId);
    const current = { slotId, watchers: [], timer: null, debounce: null };
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
    sync = current;
  }

  function finalSync(slotId) {
    const account = cpaAccounts().find((entry) => entry.slotId === slotId);
    if (account) syncNow(account, slotPaths(dataRoot, slotId));
  }

  // --- process and window ---------------------------------------------------------------

  async function findInstance(slotId) {
    const found = await helper.call("find", { marker: slotPaths(dataRoot, slotId).roaming });
    return found?.pid ? { slotId, pid: found.pid, hwnd: Number(found.hwnd) || 0 } : null;
  }

  async function waitForWindow(slotId) {
    const deadline = Date.now() + WINDOW_WAIT_MS;
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

    const existing = await findInstance(slotId);
    if (existing?.hwnd) return existing;

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

  async function stopInstance() {
    const current = instance;
    if (!current) return;
    instance = null;
    stopPlacementLoop();
    finalSync(current.slotId);
    stopSync();
    try {
      if (current.hwnd) await helper.call("close", { hwnd: current.hwnd });
      const deadline = Date.now() + CLOSE_WAIT_MS;
      while (Date.now() < deadline && await helper.call("running", { pid: current.pid })) await sleep(300);
      if (await helper.call("running", { pid: current.pid })) await helper.call("kill-tree", { pid: current.pid });
    } catch (error) {
      logger?.warn?.("chatgpt_desktop.stop_failed", { message: error.message });
    }
    logger?.info?.("chatgpt_desktop.instance_stopped", { slotId: current.slotId });
  }

  async function adopt(found) {
    instance = found;
    if (owner) await helper.call("dock", { hwnd: found.hwnd, owner });
    startSync(found.slotId);
    startPlacementLoop();
    await placeNow();
  }

  function shouldShow() {
    return Boolean(instance?.hwnd && owner && surfaceActive && ownerVisible && bounds
      && bounds.width >= 80 && bounds.height >= 80);
  }

  async function placeNow() {
    if (!instance?.hwnd) return;
    if (shouldShow()) {
      await helper.call("place", {
        hwnd: instance.hwnd,
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    } else {
      await helper.call("hide", { hwnd: instance.hwnd });
    }
  }

  async function placementTick() {
    if (placementRunning || !instance) return;
    placementRunning = true;
    try {
      if (!await helper.call("alive", { hwnd: instance.hwnd })) {
        // The app can replace its window (sign-in, crash recovery); follow it or notice it exited.
        const again = await findInstance(instance.slotId);
        if (again?.hwnd) {
          instance = again;
          if (owner) await helper.call("dock", { hwnd: again.hwnd, owner });
        } else {
          const ended = instance;
          instance = null;
          stopPlacementLoop();
          finalSync(ended.slotId);
          stopSync();
          logger?.info?.("chatgpt_desktop.instance_exited", { slotId: ended.slotId });
          emit();
          return;
        }
      }
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

  async function openSlot(slotId) {
    if (instance && instance.slotId !== slotId) await stopInstance();
    state.active = slotId;
    persist();
    if (instance?.slotId === slotId) return;
    await adopt(await launchInstance(slotId));
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
      // Re-adopt an instance that survived a Coding Tools restart.
      if (packageInfo && state.active) {
        const found = await findInstance(state.active).catch(() => null);
        if (found?.hwnd) await adopt(found).catch(() => {});
      }
      emit();
      return status();
    },
    status,
    open(slotId) {
      if (typeof slotId !== "string" || !knownSlot(slotId)) throw new Error("Unknown ChatGPT desktop account");
      const account = accountList().find((entry) => entry.slotId === slotId);
      if (account.disabled) throw new Error("This CPA account is disabled; enable it in CPA first");
      return exclusive(instance ? "switching" : "launching", () => openSlot(slotId)).then(status);
    },
    newSignIn() {
      return exclusive("launching", async () => openSlot(newLocalSlot())).then(status);
    },
    // Wipes the active account's local session (moved to Trash) and opens a fresh sign-in slot.
    clearActive() {
      return exclusive("clearing", async () => {
        const slotId = state.active;
        if (!slotId) throw new Error("No ChatGPT desktop account is active");
        if (instance) await stopInstance();
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
      if (instance?.hwnd) void helper.call("dock", { hwnd: instance.hwnd, owner }).then(placeNow).catch(() => {});
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
      try { await stopInstance(); } finally { stopSync(); helper.dispose(); }
    },
  };
}

module.exports = {
  proxyRouteFromEnvironment, createChatGptDesktopHost, cpaSlotId, planFromFileName, slotPaths };
