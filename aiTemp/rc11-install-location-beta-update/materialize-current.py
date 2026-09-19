from __future__ import annotations

from pathlib import Path


def replace_once(pathname: str, old: str, new: str, sentinel: str | None = None) -> None:
    path = Path(pathname)
    text = path.read_text(encoding="utf-8")
    marker = sentinel or new
    if marker in text:
        print(f"already patched {pathname}")
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {pathname}, found {count}: {old[:120]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"patched {pathname}")


installer = "desktop-electron/build/installer.nsh"
replace_once(
    installer,
    '''!macroend

!macro RemoveLegacyMsi ROOT VIEW
''',
    '''!macroend

!macro CaptureLegacyInstallLocation ROOT
  ClearErrors
  ReadRegStr $LegacyInstallLocation ${ROOT} "$LegacyRegistryKey" "InstallLocation"
  ${Unless} ${Errors}
    StrCpy $LegacyFirstChar $LegacyInstallLocation 1
    StrCpy $LegacyLastChar $LegacyInstallLocation 1 -1
    ${If} $LegacyFirstChar == "$\\\""
    ${AndIf} $LegacyLastChar == "$\\\""
      StrCpy $LegacyInstallLocation $LegacyInstallLocation -1 1
    ${EndIf}
    ${If} $LegacyInstallLocation != ""
      IfFileExists "$LegacyInstallLocation\\*.*" 0 +3
        StrCpy $INSTDIR $LegacyInstallLocation
        DetailPrint "Reusing legacy Coding Tools install location: $INSTDIR"
    ${EndIf}
  ${EndUnless}
!macroend

!macro RemoveLegacyMsi ROOT VIEW
''',
    "!macro CaptureLegacyInstallLocation ROOT",
)
replace_once(
    installer,
    '''      ${If} $LegacyDisplayName == "${LEGACY_PRODUCT_NAME}"
        ClearErrors
        ReadRegDWORD $LegacyWindowsInstaller ${ROOT} "$LegacyRegistryKey" "WindowsInstaller"
''',
    '''      ${If} $LegacyDisplayName == "${LEGACY_PRODUCT_NAME}"
        !insertmacro CaptureLegacyInstallLocation ${ROOT}
        ClearErrors
        ReadRegDWORD $LegacyWindowsInstaller ${ROOT} "$LegacyRegistryKey" "WindowsInstaller"
''',
    "!insertmacro CaptureLegacyInstallLocation ${ROOT}",
)

update = "desktop-electron/electron/update.cjs"
replace_once(
    update,
    '''      tempRoot,
      logPath,
      source: assetPath,
      target: executablePath,
''',
    '''      tempRoot,
      logPath,
      installDirectory: path.dirname(executablePath),
      source: assetPath,
      target: executablePath,
''',
    "installDirectory: path.dirname(executablePath)",
)

worker = "desktop-electron/electron/update-worker.cjs"
replace_once(
    worker,
    '''function updateWindows(job) {
  requireFile(job.source, "Windows installer");
  const result = spawnSync(job.source, ["/S"], { encoding: "utf8", timeout: 45 * 60_000, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows installer exited with code ${result.status}`);
  requireFile(job.target, "Installed Windows launcher");
  launch(job.target);
}
''',
    '''function windowsInstallerArguments(job) {
  const args = ["/S", "/UPDATE", "/CLOSEAPPLICATIONS", "/NORESTART"];
  const installDirectory = typeof job.installDirectory === "string"
    ? path.win32.normalize(job.installDirectory.trim())
    : "";
  if (installDirectory) {
    if (!path.win32.isAbsolute(installDirectory)) {
      throw new Error(`Windows install directory must be absolute: ${installDirectory}`);
    }
    // electron-builder/NSIS requires /D to be the final argument and it must not be quoted.
    args.push(`/D=${installDirectory}`);
  }
  return args;
}

function updateWindows(job) {
  requireFile(job.source, "Windows installer");
  const result = spawnSync(job.source, windowsInstallerArguments(job), {
    encoding: "utf8",
    timeout: 45 * 60_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows installer exited with code ${result.status}`);
  requireFile(job.target, "Installed Windows launcher");
  launch(job.target);
}
''',
    "function windowsInstallerArguments(job)",
)
replace_once(
    worker,
    '''void main().catch(() => process.exit(1));
''',
    '''if (require.main === module) {
  void main().catch(() => process.exit(1));
}

module.exports = {
  windowsInstallerArguments,
};
''',
    "module.exports = {\n  windowsInstallerArguments,",
)

main = "desktop-electron/electron/main.cjs"
replace_once(
    main,
    '''function nativeCopyFor(language) {
  return NATIVE_COPY[language] || NATIVE_COPY.en;
}

function updateTrayMenu(language) {
''',
    '''function nativeCopyFor(language) {
  return NATIVE_COPY[language] || NATIVE_COPY.en;
}

const UPDATE_PROMPT_COPY = Object.freeze({
  en: Object.freeze({
    title: "Coding Tools beta update",
    message: "A newer Coding Tools beta is ready.",
    detail: "Install it into the current application folder and restart Coding Tools now?",
    installNow: "Install and restart",
    later: "Later",
  }),
  "zh-CN": Object.freeze({
    title: "Coding Tools 测试版更新",
    message: "检测到较新的 Coding Tools 测试版。",
    detail: "是否安装到当前应用目录并立即重新启动 Coding Tools？",
    installNow: "安装并重新启动",
    later: "稍后",
  }),
  "zh-TW": Object.freeze({
    title: "Coding Tools 測試版更新",
    message: "偵測到較新嘅 Coding Tools 測試版。",
    detail: "要唔要安裝到目前應用程式目錄，並立即重新啟動 Coding Tools？",
    installNow: "安裝並重新啟動",
    later: "稍後",
  }),
  ja: Object.freeze({
    title: "Coding Tools ベータ更新",
    message: "新しい Coding Tools ベータ版を検出しました。",
    detail: "現在のアプリケーションフォルダーにインストールして再起動しますか？",
    installNow: "インストールして再起動",
    later: "後で",
  }),
});

function updatePromptCopyFor(language) {
  return UPDATE_PROMPT_COPY[language] || UPDATE_PROMPT_COPY.en;
}

let updatePromptVersion = null;
let updatePromptInFlight = false;

async function promptForAvailableUpdate(next, { logger, stateStore }) {
  if (next?.status !== "available" || typeof next.version !== "string") return;
  if (stateStore.read().automaticUpdates !== true) return;
  if (updatePromptInFlight || updatePromptVersion === next.version) return;

  updatePromptInFlight = true;
  updatePromptVersion = next.version;
  const copy = updatePromptCopyFor(stateStore.read().language);
  try {
    showMainWindow();
    const result = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: copy.title,
      message: `${copy.message} v${next.version}`,
      detail: copy.detail,
      buttons: [copy.installNow, copy.later],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response !== 0) {
      logger.info("launcher.update_prompt_deferred", { version: next.version });
      return;
    }
    const launch = await updateController.beginInstall();
    const quitResult = await requestQuit();
    if (!quitResult.ok) {
      updateController.cancelInstall(launch);
      throw new Error(quitResult.message);
    }
  } catch (error) {
    updatePromptVersion = null;
    logger.warn("launcher.update_prompt_failed", {
      version: next.version,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    updatePromptInFlight = false;
  }
}

function updateTrayMenu(language) {
''',
    "async function promptForAvailableUpdate(next, { logger, stateStore })",
)
replace_once(
    main,
    '''    publish: (state) => send("launcher:update-state", state),
''',
    '''    publish: (state) => {
      send("launcher:update-state", state);
      if (state.status === "available") {
        void promptForAvailableUpdate(state, { logger, stateStore });
      }
    },
''',
    "void promptForAvailableUpdate(state, { logger, stateStore })",
)
replace_once(
    main,
    '''  if (!launcherSmokeTest) {
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
    '''  if (!launcherSmokeTest) {
    void updateController.checkNow({ force: true }).catch((error) => {
      logger.warn("launcher.update_check_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    updateController.startPeriodicChecks();
  }
''',
    "updateController.startPeriodicChecks();",
)

print("RC11_INSTALL_LOCATION_BETA_UPDATE_MATERIALIZED")
