from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, before: str, after: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    if after in text:
        print(f"already applied: {relative}")
        return
    count = text.count(before)
    if count != 1:
        raise SystemExit(f"expected one anchor in {relative}, found {count}: {before[:120]!r}")
    path.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"patched: {relative}")


replace_once(
    "desktop-electron/electron/update.cjs",
    'const MAX_REDIRECTS = 5;\n',
    'const MAX_REDIRECTS = 5;\nconst DEFAULT_UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;\n',
)

replace_once(
    "desktop-electron/electron/update.cjs",
    '''  let state = packaged && supportedAsset ? { status: "idle" } : { status: "disabled" };
  let checked = false;
  let pending = null;
  let candidate = null;
''',
    '''  let state = packaged && supportedAsset ? { status: "idle" } : { status: "disabled" };
  let checked = false;
  let checking = null;
  let pending = null;
  let candidate = null;
  let periodicTimer = null;
''',
)

replace_once(
    "desktop-electron/electron/update.cjs",
    '''  async function checkOnce() {
    if (state.status === "disabled" || checked) return state;
    checked = true;
    transition({ status: "checking" });
    try {
      const selected = selectCompatibleRelease(await deps.fetchRelease(), platform, arch);
      if (!selected || compareVersions(selected.version, currentVersion) <= 0) {
        candidate = null;
        return transition({ status: "up-to-date" });
      }
      const { version, assetName, asset, checksums } = selected;
      candidate = {
        version,
        assetName,
        assetUrl: validateReleaseAssetUrl(asset.browser_download_url, version, assetName),
        checksumsUrl: validateReleaseAssetUrl(
          checksums.browser_download_url,
          version,
          CHECKSUM_ASSET_NAME,
        ),
      };
      logger?.info("launcher.update_available", { currentVersion, version, platform, arch });
      return transition({ status: "available", version });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn("launcher.update_check_failed", { message });
      return transition({ status: "error", message });
    }
  }
''',
    '''  async function checkNow({ force = true } = {}) {
    if (state.status === "disabled") return state;
    if (state.status === "downloading" || state.status === "installing") return state;
    if (checking) return checking;
    if (!force && checked) return state;
    checked = true;
    checking = (async () => {
      transition({ status: "checking" });
      try {
        const selected = selectCompatibleRelease(await deps.fetchRelease(), platform, arch);
        if (!selected || compareVersions(selected.version, currentVersion) <= 0) {
          candidate = null;
          return transition({ status: "up-to-date" });
        }
        const { version, assetName, asset, checksums } = selected;
        candidate = {
          version,
          assetName,
          assetUrl: validateReleaseAssetUrl(asset.browser_download_url, version, assetName),
          checksumsUrl: validateReleaseAssetUrl(
            checksums.browser_download_url,
            version,
            CHECKSUM_ASSET_NAME,
          ),
        };
        logger?.info("launcher.update_available", { currentVersion, version, platform, arch });
        return transition({ status: "available", version });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger?.warn("launcher.update_check_failed", { message });
        return transition({ status: "error", message });
      }
    })();
    try {
      return await checking;
    } finally {
      checking = null;
    }
  }

  async function checkOnce() {
    return checkNow({ force: false });
  }

  function stopPeriodicChecks() {
    if (periodicTimer !== null) clearInterval(periodicTimer);
    periodicTimer = null;
  }

  function startPeriodicChecks({
    intervalMs = DEFAULT_UPDATE_CHECK_INTERVAL_MS,
    onAvailable,
  } = {}) {
    if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
      throw new Error("Update check interval must be at least one second");
    }
    stopPeriodicChecks();
    const tick = async () => {
      const next = await checkNow({ force: true });
      if (next.status === "available") await onAvailable?.(next);
      return next;
    };
    periodicTimer = setInterval(() => {
      void tick().catch((error) => {
        logger?.warn("launcher.periodic_update_check_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
    periodicTimer.unref?.();
    return { tick, stop: stopPeriodicChecks };
  }
''',
)

replace_once(
    "desktop-electron/electron/update.cjs",
    '''  return {
    getState: () => state,
    checkOnce,
    beginInstall,
    cancelInstall,
  };
''',
    '''  return {
    getState: () => state,
    checkOnce,
    checkNow,
    startPeriodicChecks,
    stopPeriodicChecks,
    beginInstall,
    cancelInstall,
  };
''',
)

replace_once(
    "desktop-electron/electron/update.cjs",
    '''module.exports = {
  buildJob,
''',
    '''module.exports = {
  DEFAULT_UPDATE_CHECK_INTERVAL_MS,
  buildJob,
''',
)

replace_once(
    "desktop-electron/electron/state.cjs",
    '''  autoStart: true,
  keepRunningOnClose: true,
''',
    '''  autoStart: true,
  automaticUpdates: true,
  keepRunningOnClose: true,
''',
)

replace_once(
    "desktop-electron/electron/state.cjs",
    '''      "autoStart",
      "keepRunningOnClose",
''',
    '''      "autoStart",
      "automaticUpdates",
      "keepRunningOnClose",
''',
)

replace_once(
    "desktop-electron/electron/preload.cjs",
    '''  exportLogs: () => ipcRenderer.invoke("launcher:export-logs"),
  installUpdate: () => ipcRenderer.invoke("launcher:update-install"),
''',
    '''  exportLogs: () => ipcRenderer.invoke("launcher:export-logs"),
  checkForUpdates: () => ipcRenderer.invoke("launcher:update-check"),
  setAutomaticUpdates: (enabled) => ipcRenderer.invoke("launcher:update-automatic", enabled),
  installUpdate: () => ipcRenderer.invoke("launcher:update-install"),
''',
)

replace_once(
    "desktop-electron/src/types.ts",
    '''  autoStart: boolean;
  keepRunningOnClose: boolean;
''',
    '''  autoStart: boolean;
  automaticUpdates: boolean;
  keepRunningOnClose: boolean;
''',
)

replace_once(
    "desktop-electron/src/types.ts",
    '''  exportLogs(): Promise<string | null>;
  installUpdate(): Promise<boolean>;
''',
    '''  exportLogs(): Promise<string | null>;
  checkForUpdates(): Promise<UpdateState>;
  setAutomaticUpdates(enabled: boolean): Promise<LauncherState>;
  installUpdate(): Promise<boolean>;
''',
)

replace_once(
    "desktop-electron/electron/main.cjs",
    '''  handle("launcher:update-install", async () => {
''',
    '''  handle("launcher:update-check", async () => {
    if (!updateController) throw new Error("Launcher updates are unavailable");
    return updateController.checkNow({ force: true });
  });
  handle("launcher:update-automatic", async (_event, enabled) => {
    const state = stateStore.update({ automaticUpdates: enabled === true });
    send("launcher:state-changed", state);
    if (state.automaticUpdates && updateController) {
      void updateController.checkNow({ force: true }).catch((error) => {
        logger.warn("launcher.update_check_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return state;
  });
  handle("launcher:update-install", async () => {
''',
)

replace_once(
    "desktop-electron/electron/main.cjs",
    '''    stopCatalogVerificationMonitor();
    quitting = true;
''',
    '''    stopCatalogVerificationMonitor();
    updateController?.stopPeriodicChecks?.();
    quitting = true;
''',
)

replace_once(
    "desktop-electron/electron/main.cjs",
    '''  await loadRenderer(mainWindow);
  if (!launcherSmokeTest) void updateController.checkOnce();
''',
    '''  await loadRenderer(mainWindow);
  if (!launcherSmokeTest) {
    const maybeInstallAutomaticUpdate = async (next) => {
      if (next?.status !== "available" || stateStore.read().automaticUpdates !== true) return;
      if (runtimeHost?.currentOperation() || browserHost?.currentOperation() || browserHost?.activeTraceId) {
        logger.info("launcher.automatic_update_deferred", { version: next.version });
        return;
      }
      try {
        const launch = await updateController.beginInstall();
        const result = await requestQuit();
        if (!result.ok) {
          updateController.cancelInstall(launch);
          logger.warn("launcher.automatic_update_deferred", {
            version: next.version,
            message: result.message,
          });
        }
      } catch (error) {
        logger.warn("launcher.automatic_update_failed", {
          version: next.version,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    void updateController.checkNow({ force: true }).then(maybeInstallAutomaticUpdate);
    updateController.startPeriodicChecks({ onAvailable: maybeInstallAutomaticUpdate });
  }
''',
)

replace_once(
    "desktop-electron/src/App.tsx",
    '''  const [integrationRemoved, setIntegrationRemoved] = useState(false);
''',
    '''  const [integrationRemoved, setIntegrationRemoved] = useState(false);
  const [updateNotice, setUpdateNotice] = useState("");
''',
)

replace_once(
    "desktop-electron/src/App.tsx",
    '''  const uninstallIntegration = async () => {
''',
    '''  const checkForUpdates = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api!.checkForUpdates();
      setUpdateNotice(next.status === "available"
        ? (language === "zh-TW" ? `已找到 Coding Tools v${next.version}` : `Coding Tools v${next.version} is available`)
        : next.status === "up-to-date"
          ? (language === "zh-TW" ? "目前已是最新版本。" : "Coding Tools is up to date.")
          : next.status === "error"
            ? next.message
            : (language === "zh-TW" ? "正在檢查更新…" : "Checking for updates…"));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setAutomaticUpdates = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setAutomaticUpdates(enabled));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const uninstallIntegration = async () => {
''',
)

replace_once(
    "desktop-electron/src/App.tsx",
    '''        {!devProfile ? <SettingRow body={copy.launchAtLoginBody} flushAfter label={copy.launchAtLogin}>
          <Switch
            checked={snapshot.state.autoStart}
            onChange={(checked) => void api!.setAutostart(checked)
              .then((result) => updateState(result.state))
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow> : null}
''',
    '''        {!devProfile ? <SettingRow body={copy.launchAtLoginBody} flushAfter label={copy.launchAtLogin}>
          <Switch
            checked={snapshot.state.autoStart}
            onChange={(checked) => void api!.setAutostart(checked)
              .then((result) => updateState(result.state))
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow> : null}
        {!devProfile ? <SettingRow
          body={updateNotice || (language === "zh-TW"
            ? "定期尋找完整而相容的 Coding Tools release；閒置時可自動安裝，亦可立即手動檢查。"
            : "Periodically discover complete compatible Coding Tools releases, install while idle, or check immediately.")}
          label={language === "zh-TW" ? "自動更新" : "Automatic updates"}
        >
          <div className="inline-actions">
            <SecondaryButton disabled={busy} onClick={() => void checkForUpdates()}>
              {language === "zh-TW" ? "立即檢查" : "Check now"}
            </SecondaryButton>
            <Switch
              checked={snapshot.state.automaticUpdates}
              disabled={busy}
              onChange={(checked) => void setAutomaticUpdates(checked)}
            />
          </div>
        </SettingRow> : null}
''',
)

replace_once(
    "desktop-electron/tests/update.test.cjs",
    '''test("verified update is handed to one detached worker", async () => {
''',
    '''test("manual and periodic checks can discover a release published after startup", async () => {
  let latest = "1.1.4";
  let calls = 0;
  let periodicCallback = null;
  const controller = createUpdateController({
    currentVersion: "1.1.4",
    platform: "win32",
    arch: "x64",
    packaged: true,
    executablePath: "C:\\\\Coding Tools\\\\Coding Tools.exe",
    runtimeExecutable: process.execPath,
    logsDirectory: os.tmpdir(),
    dependencies: {
      fetchRelease: async () => {
        calls += 1;
        const version = latest;
        return [{
          tag_name: `v${version}`,
          prerelease: version.includes("-"),
          assets: [
            {
              name: `Coding.Tools_${version}_windows_x64_setup.exe`,
              browser_download_url: `https://github.com/p90-lover/coding-tools-mcp/releases/download/v${version}/Coding.Tools_${version}_windows_x64_setup.exe`,
            },
            {
              name: "SHA256SUMS.txt",
              browser_download_url: `https://github.com/p90-lover/coding-tools-mcp/releases/download/v${version}/SHA256SUMS.txt`,
            },
          ],
        }];
      },
    },
  });

  assert.equal((await controller.checkOnce()).status, "up-to-date");
  latest = "1.2.0";
  assert.equal((await controller.checkOnce()).status, "up-to-date", "startup check remains idempotent");
  assert.deepEqual(await controller.checkNow({ force: true }), { status: "available", version: "1.2.0" });

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.setInterval = (callback) => {
    periodicCallback = callback;
    return { unref() {} };
  };
  global.clearInterval = () => {};
  try {
    const periodic = controller.startPeriodicChecks({ intervalMs: 1_000 });
    latest = "1.3.0";
    await periodic.tick();
    assert.deepEqual(controller.getState(), { status: "available", version: "1.3.0" });
    assert.equal(typeof periodicCallback, "function");
    periodic.stop();
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
  assert.ok(calls >= 3);
});

test("verified update is handed to one detached worker", async () => {
''',
)

print("RC7_UPDATER_PATCH_APPLIED")
