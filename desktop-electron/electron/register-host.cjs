"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { DETACH_OWNED_CHILD, terminateOwnedProcessTreeAsync } = require("./process-tree.cjs");
const { browserViewVisible } = require("./browser-state.cjs");

const PARTITION = "persist:coding-tools-register";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function createRegisterHost({
  projectRoot = "", configPath, createView, attachView, detachView, openExternal, onChange,
  prepareSession, spawnProcess = spawn, origin = "http://127.0.0.1:8000", isQuitting = () => false,
  healthTimeoutMs = 1200, startupTimeoutMs = 30000, pollIntervalMs = 120,
} = {}) {
  const endpoint = new URL(origin);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1"
    || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("Register requires a loopback HTTP origin");
  }
  origin = endpoint.origin;
  if (![healthTimeoutMs, startupTimeoutMs, pollIntervalMs].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("Register deadlines must be positive finite numbers");
  }
  healthTimeoutMs = Math.max(1, Math.min(1200, healthTimeoutMs));
  startupTimeoutMs = Math.max(1, Math.min(30000, startupTimeoutMs));
  pollIntervalMs = Math.max(5, Math.min(500, pollIntervalMs));
  let error = null;
  if (configPath && fs.existsSync(configPath)) {
    try {
      const stat = fs.lstatSync(configPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error("Invalid config");
      const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (typeof saved.projectRoot === "string") projectRoot = saved.projectRoot;
    } catch { error = "Register project settings could not be read. Choose its folder again."; }
  }
  if (projectRoot) {
    projectRoot = path.resolve(projectRoot);
    try { projectRoot = fs.realpathSync.native(projectRoot); } catch { /* Start reports missing folders. */ }
  }
  let ready = false, starting = false, active = false, bounds = null, disposed = false;
  let owned = null, view = null, attached = false, viewPending = null, viewToken = null;
  let generation = 0, startPending = null, stopPending = null, statusPending = null;
  let shutdownPending = null, recoveryPending = null, recoveryRequested = false;
  const requests = new Set();

  const snapshot = () => ({
    projectRoot, origin, ready, owned: Boolean(owned && !owned.ended), starting, error,
    ...(owned && !owned.ended && Number.isInteger(owned.child.pid) ? { pid: owned.child.pid } : {}),
  });
  const emit = () => { try { onChange?.(snapshot()); } catch { /* A closing renderer has no listener. */ } };
  const current = token => !disposed && !isQuitting() && token === generation;

  function health(timeout = healthTimeoutMs) {
    return new Promise(resolve => {
      let settled = false, request;
      const finish = kind => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        requests.delete(request);
        resolve(kind);
      };
      const timer = setTimeout(() => { finish("conflict"); request?.destroy(); }, Math.max(1, timeout));
      request = http.get(new URL("/api/health", origin), { agent: false }, response => {
        let body = "", bytes = 0;
        response.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > 4096) { finish("conflict"); response.destroy(); return; }
          body += chunk.toString("utf8");
        });
        response.on("error", () => finish("conflict"));
        response.on("end", () => {
          let value;
          try { value = JSON.parse(body); } catch { /* Any other HTTP service is a conflict. */ }
          finish(response.statusCode === 200 && value?.ok === true
            && value.service === "account-manager-v2" ? "ready" : "conflict");
        });
      });
      requests.add(request);
      request.on("error", failure => finish(failure.code === "ECONNREFUSED" ? "absent" : "conflict"));
    });
  }
  function cancelProbes() { for (const request of requests) request.destroy(); }

  function syncView() {
    const visible = view && !view.webContents.isDestroyed() && ready
      && browserViewVisible(true, active, Boolean(bounds)) && !disposed && !isQuitting();
    try {
      if (visible) {
        view.setBounds(bounds);
        if (!attached) { attachView?.(view); attached = true; }
      } else if (attached) {
        detachView?.(view);
        attached = false;
      }
    } catch { attached = false; error = "Register view could not attach. Reload the workspace."; }
  }
  function closeView() {
    const previous = view;
    view = null;
    if (!previous) return;
    if (attached) { try { detachView?.(previous); } catch {} attached = false; }
    try { previous.unregister?.(); } catch {}
    try {
      if (!previous.webContents.isDestroyed()) previous.webContents.close({ waitForBeforeUnload: false });
    } catch { /* The main window may already have closed this owned view. */ }
  }
  function localUrl(raw) {
    try { const url = new URL(raw); return url.protocol === "http:" && url.origin === origin && !url.username && !url.password; }
    catch { return false; }
  }
  function externalUrl(raw) {
    if (typeof raw !== "string" || raw.trim() !== raw || /[\u0000-\u001f\u007f]/.test(raw)) return null;
    try {
      const url = new URL(raw);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  function ensureView(token = generation) {
    if (!current(token) || !ready) return Promise.resolve();
    if (viewPending) return viewToken === token ? viewPending : viewPending.then(() => ensureView(token));
    if (view && !view.webContents.isDestroyed()) { syncView(); return Promise.resolve(); }
    viewToken = token;
    const pending = (async () => {
      let created;
      try {
        if (!current(token) || !ready) return;
        created = createView(PARTITION);
        if (!current(token)) { created.webContents.close({ waitForBeforeUnload: false }); return; }
        view = created;
        const contents = created.webContents;
        const guardNavigation = (event, url) => { if (!localUrl(url ?? event.url)) event.preventDefault(); };
        contents.on("will-navigate", guardNavigation);
        contents.on("will-redirect", guardNavigation);
        contents.setWindowOpenHandler(({ url }) => {
          const safe = externalUrl(url);
          if (safe && !disposed && !isQuitting() && view === created) {
            Promise.resolve().then(() => {
              if (!disposed && !isQuitting() && view === created && ready) return openExternal?.(safe);
            }).catch(() => {
              if (!disposed) { error = "The external Register link could not be opened."; emit(); }
            });
          }
          return { action: "deny" };
        });
        contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
          if (view === created && !disposed && code !== -3 && isMainFrame !== false) {
            error = "Register page could not load. Check the service and reload."; emit();
          }
        });
        const unregister = await prepareSession?.(contents.session, origin);
        if (!current(token) || view !== created || !ready) {
          if (typeof unregister === "function") { try { unregister(); } catch {} }
          if (view === created) closeView();
          return;
        }
        if (typeof unregister === "function") created.unregister = unregister;
        let loadTimer;
        try {
          await Promise.race([contents.loadURL(new URL("/register", origin).href), new Promise((_, reject) => {
            loadTimer = setTimeout(() => reject(new Error("View load timeout")), 10000);
          })]);
        } finally { clearTimeout(loadTimer); }
        if (!current(token) || view !== created || !ready) { if (view === created) closeView(); return; }
        syncView();
      } catch {
        if (view === created) closeView();
        if (current(token)) { error = "Register view could not load. Check the service and reload."; emit(); }
      }
    })();
    viewPending = pending;
    void pending.finally(() => { if (viewPending === pending) viewPending = null; });
    return pending;
  }

  function status() {
    if (disposed || isQuitting() || stopPending) return Promise.resolve(snapshot());
    if (statusPending) return statusPending;
    const token = generation;
    const pending = health().then(kind => {
      if (current(token) && !starting) {
        ready = kind === "ready";
        error = kind === "conflict" ? "The Register port belongs to a different or unresponsive service." : null;
        syncView(); emit();
      }
      return snapshot();
    }).finally(() => { if (statusPending === pending) statusPending = null; });
    statusPending = pending;
    return pending;
  }

  async function configure(nextRoot) {
    if (disposed || isQuitting()) throw new Error("Register host is closed");
    if (owned || starting || stopPending) throw new Error("Stop Register before changing its project folder.");
    if (typeof nextRoot !== "string" || !path.isAbsolute(nextRoot)) throw new Error("Choose an absolute Register project folder.");
    let canonical;
    try { canonical = fs.realpathSync.native(nextRoot); if (!fs.statSync(canonical).isDirectory()) throw new Error(); }
    catch { throw new Error("The Register project folder does not exist."); }
    if (configPath) {
      try { writePrivateFileAtomic(configPath, JSON.stringify({ projectRoot: canonical }) + "\n"); }
      catch { throw new Error("Register settings could not be saved. Check the app profile permissions."); }
    }
    projectRoot = canonical;
    error = null; emit();
    return snapshot();
  }

  function validateProject() {
    if (!projectRoot) throw new Error("Choose the reg-machine project folder first.");
    for (const [relative, message] of [
      ["main.py", "Register main.py is missing. Choose the reg-machine project folder."],
      ["static/index.html", "Register static UI is missing. Build its frontend first."],
    ]) {
      try { if (!fs.statSync(path.join(projectRoot, relative)).isFile()) throw new Error(); }
      catch { throw new Error(message); }
    }
    const python = path.join(projectRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    try { if (!fs.statSync(python).isFile()) throw new Error(); }
    catch { throw new Error("Register .venv Python is missing. Create its environment and install requirements."); }
    return python;
  }

  async function terminate(record) {
    if (!record) return;
    if (record.termination) return record.termination;
    record.stopping = true;
    record.termination = (async () => {
      if (!record.ended) await terminateOwnedProcessTreeAsync(record.child);
      const deadline = Date.now() + 1500;
      while (!record.ended && Date.now() < deadline) await delay(20);
      if (!record.ended) {
        await terminateOwnedProcessTreeAsync(record.child, "SIGKILL");
        const forcedDeadline = Date.now() + 1500;
        while (!record.ended && Date.now() < forcedDeadline) await delay(20);
      }
      if (!record.ended) throw new Error("Register did not stop. Retry Stop before closing the app.");
      if (owned === record) owned = null;
    })();
    try { await record.termination; }
    catch (failure) { record.termination = null; throw failure; }
  }

  function start() {
    if (disposed || isQuitting()) return Promise.resolve(snapshot());
    if (startPending) return startPending;
    if (stopPending) return stopPending.then(start);
    const token = ++generation;
    starting = true; error = null; emit();
    const pending = (async () => {
      let record;
      try {
        const found = await health();
        if (!current(token)) return snapshot();
        if (found === "ready") {
          ready = true;
          if (active) void ensureView(token);
          return snapshot();
        }
        if (found !== "absent") throw new Error("The Register port is already in use. Choose the existing service or free the port.");
        if (owned) throw new Error("Register is still running but is not ready. Stop it before retrying.");
        const python = validateProject();
        if (!current(token)) return snapshot();
        let child;
        try {
          child = spawnProcess(python, ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", endpoint.port || "80"], {
            cwd: projectRoot, env: { ...process.env }, windowsHide: true, detached: DETACH_OWNED_CHILD, stdio: ["ignore", "ignore", "ignore"],
          });
        } catch { throw new Error("Register Python could not start. Check its environment and dependencies."); }
        record = { child, ended: false, stopping: false, failure: null, termination: null };
        owned = record;
        const ended = () => {
          record.ended = true;
          if (owned === record) {
            owned = null; ready = false; closeView();
            if (!record.stopping && !starting && !disposed) error = "Register exited. Check its environment and start it again.";
            emit(); void recoverIfSafe();
          }
        };
        child.once("exit", ended);
        child.once("error", () => { record.failure = "Register Python could not start. Check its environment and dependencies."; ended(); });
        const deadline = Date.now() + startupTimeoutMs;
        while (current(token)) {
          if (record.ended) throw new Error(record.failure || "Register exited during startup. Verify uvicorn and project dependencies.");
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("Register did not become ready within 30 seconds. Check its environment and dependencies.");
          const result = await health(Math.min(healthTimeoutMs, remaining));
          if (!current(token)) break;
          if (record.ended) throw new Error(record.failure || "Register exited during startup. Verify uvicorn and project dependencies.");
          if (result === "ready") {
            ready = true;
            if (active) void ensureView(token);
            return snapshot();
          }
          await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
        }
      } catch (failure) {
        if (current(token)) { ready = false; error = failure.message; closeView(); }
      } finally {
        if (record && (!current(token) || !ready)) {
          try { await terminate(record); }
          catch { error = "Register could not be stopped. Retry Stop."; }
        }
      }
      return snapshot();
    })().finally(() => {
      if (startPending === pending) { startPending = null; starting = false; emit(); void recoverIfSafe(); }
    }).then(() => snapshot());
    startPending = pending;
    return pending;
  }

  function stop() {
    if (stopPending) return stopPending;
    if (!owned && !startPending) return Promise.resolve(snapshot());
    ++generation; ready = false; error = null;
    closeView(); cancelProbes();
    const record = owned, launch = startPending;
    const pending = (async () => {
      try { await terminate(record); }
      catch { error = "Register could not be stopped. Retry Stop."; }
      await launch?.catch(() => {});
      emit(); return snapshot();
    })().finally(() => { if (stopPending === pending) stopPending = null; })
      .then(async () => { await recoverIfSafe(); return snapshot(); });
    stopPending = pending;
    return pending;
  }

  async function reload() {
    const value = await status();
    if (!disposed && !isQuitting() && value.ready) {
      if (view && !view.webContents.isDestroyed()) view.webContents.reload();
      else await ensureView();
    }
    return snapshot();
  }
  function setSurfaceActive(value) {
    active = value === true;
    syncView();
    if (active && !disposed && !isQuitting()) {
      const token = generation;
      void (ready ? ensureView(token) : status().then(() => {
        if (current(token) && active && ready) return ensureView(token);
      }));
    }
    return snapshot();
  }
  function setBounds(value) {
    if (!value || !["x", "y", "width", "height"].every(key => Number.isFinite(value[key]))
      || value.width <= 0 || value.height <= 0) { bounds = null; syncView(); return false; }
    bounds = Object.fromEntries(["x", "y", "width", "height"].map(key => [
      key, Math.min(16384, Math.max(key === "x" || key === "y" ? 0 : 1, Math.round(value[key]))),
    ]));
    syncView(); return true;
  }
  function recoverIfSafe() {
    if (recoveryPending) return recoveryPending;
    if (!disposed || !recoveryRequested || isQuitting() || owned || startPending || stopPending || shutdownPending) return Promise.resolve(snapshot());
    const token = ++generation;
    const pending = health().then(kind => {
      if (token !== generation || isQuitting() || !recoveryRequested || owned || startPending || stopPending || shutdownPending) return snapshot();
      disposed = false; recoveryRequested = false; ready = kind === "ready";
      error = kind === "conflict" ? "The Register port belongs to a different or unresponsive service." : null;
      emit();
      if (ready && active) void ensureView(token);
      return snapshot();
    }).finally(() => {
      if (recoveryPending === pending) recoveryPending = null;
      if (recoveryRequested && token !== generation) void recoverIfSafe();
    });
    recoveryPending = pending;
    return pending;
  }
  function recoverAfterCancelledQuit() {
    if (isQuitting()) return Promise.resolve(snapshot());
    if (!disposed && !startPending) {
      if (ready && active) void ensureView(++generation);
      return Promise.resolve(snapshot());
    }
    if (!disposed) { disposed = true; ++generation; ready = false; closeView(); cancelProbes(); }
    recoveryRequested = true; emit();
    return recoverIfSafe();
  }
  function shutdown() {
    recoveryRequested = false;
    disposed = true; ++generation; ready = false;
    closeView(); cancelProbes();
    if (shutdownPending) return shutdownPending;
    const pending = (async () => {
      await terminate(owned);
      await startPending?.catch(() => {});
      await statusPending?.catch(() => {});
    })().finally(() => {
      if (shutdownPending === pending) shutdownPending = null;
      void recoverIfSafe();
    });
    shutdownPending = pending;
    return pending;
  }

  return { status, configure, start, stop, reload, setSurfaceActive, setBounds, shutdown, recoverAfterCancelledQuit };
}

module.exports = { createRegisterHost };
