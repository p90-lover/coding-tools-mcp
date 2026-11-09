"use strict";

// Chromium's accessibility tree for every page, on only for a screen reader (or when the person
// turns it on in Settings → General → Accessibility).
//
// Any UI Automation client on the computer turns it on in every Chromium app, and it stays on until
// the app quits. On 2026-11-09 the app had it on with inline text boxes although no screen reader ran
// (SPI_GETSCREENREADER false, UiaClientsAreListening true), and main stalled 2-4 s about 7 times an
// hour, CPU-bound with no JavaScript running: Chromium turns each DOM change in the chats into
// accessibility updates and serves every client's queries on the main thread.
//
// So the app starts with --disable-renderer-accessibility unless the person chose "on". Checked in
// Electron 45.2.2 on 2026-11-10: with the switch, a UI Automation client's walk no longer turns it on
// (the client sees only the window frame), app.setAccessibilitySupportEnabled(true) still does (the
// client then reads the page) and (false) turns it off again. "auto" turns it on while Windows says a
// screen reader runs (SPI_GETSCREENREADER, set by NVDA, JAWS and Narrator). Windows sends each change
// of that flag to every top-level window (WM_SETTINGCHANGE with SPI_SETSCREENREADER), so a screen
// reader started later is seen too. Other systems have no such check here, so "auto" leaves Chromium
// alone there.

const fs = require("node:fs");
const path = require("node:path");
// PowerShell starts from a worker: starting it on main held every window 1.6 s (app-processes.cjs).
const { execFileOffThread } = require("./off-thread-run.cjs");

const MODES = Object.freeze(["auto", "on", "off"]);
const WM_SETTINGCHANGE = 0x001a;
const SPI_GETSCREENREADER = 0x0046;
const SPI_SETSCREENREADER = 0x0047;
// The first check waits until the window is up and the launch's own work has eased.
const FIRST_CHECK_MS = 10_000;
// A screen reader that starts or quits can send several changes; one check follows the last.
const CHANGE_SETTLE_MS = 1_000;

const POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
// SystemParametersInfoW through a P/Invoke stub built in memory: Add-Type would start the C#
// compiler. PreserveSig keeps the BOOL return a BOOL (without it the call reads as failed).
const SCREEN_READER_SCRIPT = [
  "$b = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'ctSpi'), 'Run').DefineDynamicModule('ctSpi').DefineType('ctSpi', 'Public,Class')",
  "$m = $b.DefinePInvokeMethod('SystemParametersInfoW', 'user32.dll', 'Public,Static,PinvokeImpl', 'Standard', [bool], [Type[]]@([uint32], [uint32], [int].MakeByRefType(), [uint32]), 'Winapi', 'Unicode')",
  "$m.SetImplementationFlags('PreserveSig')",
  "$t = $b.CreateType()",
  "$on = 0",
  `if ($t::SystemParametersInfoW(${SPI_GETSCREENREADER}, 0, [ref]$on, 0)) { "screenReader=$on" } else { 'screenReader=unknown' }`,
].join("\n");

/** A saved mode, or "auto" for anything else. */
function accessibilityMode(value) {
  return MODES.includes(value) ? value : "auto";
}

/** Whether the app starts with renderer accessibility blocked in this mode. */
function blocksAtLaunch(mode, platform = process.platform) {
  return mode === "off" || (mode === "auto" && platform === "win32");
}

/**
 * Before ready, in start()'s first tick: Chromium reads its switches once start() awaits. Reads the
 * saved mode from launcher-state.json and adds the switch when that mode blocks. The one synchronous
 * read runs before any window exists. Returns `{ mode, blocked }` for createRendererAccessibility.
 */
function applyLaunchSwitch(app, statePath, { platform = process.platform, readFile = (file) => fs.readFileSync(file, "utf8") } = {}) {
  let mode = "auto";
  try { mode = accessibilityMode(JSON.parse(readFile(statePath))?.rendererAccessibility); }
  catch { /* no saved settings yet, or unreadable: automatic */ }
  const blocked = blocksAtLaunch(mode, platform);
  if (blocked) app.commandLine.appendSwitch("disable-renderer-accessibility");
  return { mode, blocked };
}

/** Windows' screen reader flag: true, false, or null when it could not be read. */
function readScreenReaderFlag(run = execFileOffThread) {
  const encoded = Buffer.from(SCREEN_READER_SCRIPT, "utf16le").toString("base64");
  return new Promise((resolve) => {
    run(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        const found = error ? null : /screenReader=(\d+)/.exec(String(stdout ?? ""));
        resolve(found ? Number(found[1]) !== 0 : null);
      });
  });
}

/**
 * After ready. `launch` is applyLaunchSwitch's answer and `readMode` reads the saved mode. This run
 * turns accessibility on or off itself only while the launch switch blocks it; without the switch
 * Chromium decides until the next start, which `status().restartNeeded` reports.
 */
function createRendererAccessibility({
  app, launch, readMode, logger = null, platform = process.platform,
  readScreenReader = readScreenReaderFlag, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let screenReader = null;
  let turnedOn = false;
  let timer = null;
  let stopped = false;
  // Checks run one after another, each reading the flag afresh: one that started before Windows
  // changed it must not stand in for one asked for after.
  let checks = Promise.resolve();

  const mode = () => accessibilityMode(readMode());
  const active = () => {
    try { return app.getAccessibilitySupportFeatures().length > 0; }
    catch { return app.isAccessibilitySupportEnabled() === true; }
  };

  function set(on, reason) {
    if (!launch.blocked || stopped || on === turnedOn) return;
    app.setAccessibilitySupportEnabled(on);
    turnedOn = on;
    logger?.info("launcher.renderer_accessibility", { on, reason, mode: mode() });
  }

  // What the saved mode asks for, with Windows' last answer about a screen reader.
  function settle(reason) {
    const current = mode();
    if (current === "on") set(true, reason);
    else if (current === "off") set(false, reason);
    else set(screenReader === true, screenReader === true ? "screen-reader" : reason);
  }

  function checkScreenReader(reason) {
    checks = checks.then(async () => {
      if (stopped || platform !== "win32" || !launch.blocked || mode() !== "auto") return;
      const found = await readScreenReader();
      if (found !== null) screenReader = found;
      settle(reason);
    }).catch((error) => {
      logger?.warn("launcher.renderer_accessibility_check_failed", { message: String(error?.message ?? error).slice(0, 300) });
    });
    return checks;
  }

  function schedule(ms, reason) {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; void checkScreenReader(reason); }, ms);
    timer?.unref?.();
  }

  function status() {
    const current = mode();
    return {
      mode: current,
      active: active(),
      screenReader,
      // Only the launch switch can keep clients from turning it on.
      restartNeeded: !launch.blocked && blocksAtLaunch(current, platform),
    };
  }

  return {
    /** Logs how this run started and, in auto mode on Windows, checks for a screen reader soon. */
    start() {
      logger?.info("launcher.renderer_accessibility_launch", { mode: launch.mode, blocked: launch.blocked });
      if (!launch.blocked) return;
      if (launch.mode === "auto") schedule(FIRST_CHECK_MS, "start");
      else settle("start");
    },
    /** Hears Windows announce a change of its screen reader flag (any top-level window gets it). */
    watchWindow(window) {
      if (platform !== "win32" || !launch.blocked || typeof window?.hookWindowMessage !== "function") return;
      window.hookWindowMessage(WM_SETTINGCHANGE, (wParam) => {
        if (Buffer.isBuffer(wParam) && wParam.length >= 4 && wParam.readUInt32LE(0) === SPI_SETSCREENREADER) {
          schedule(CHANGE_SETTLE_MS, "screen-reader-changed");
        }
      });
    },
    /** After the saved mode changed: does what this run can and returns the new status. */
    async apply() {
      if (mode() === "auto") await checkScreenReader("setting");
      else settle("setting");
      return status();
    },
    status,
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

module.exports = {
  MODES,
  WM_SETTINGCHANGE,
  SPI_SETSCREENREADER,
  FIRST_CHECK_MS,
  CHANGE_SETTLE_MS,
  SCREEN_READER_SCRIPT,
  accessibilityMode,
  blocksAtLaunch,
  applyLaunchSwitch,
  readScreenReaderFlag,
  createRendererAccessibility,
};
