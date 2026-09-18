import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const evidenceRoot = path.join(root, "aiTemp", "installer-location-beta-popup", "evidence");
fs.mkdirSync(evidenceRoot, { recursive: true });

function replaceOnce(relativePath, before, after, marker) {
  const filePath = path.join(root, relativePath);
  const source = fs.readFileSync(filePath, "utf8");
  if (source.includes(marker)) return false;
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${relativePath}: expected one replacement target, found ${count}`);
  }
  fs.writeFileSync(filePath, source.replace(before, after), "utf8");
  return true;
}

const changed = [];

if (replaceOnce(
  "desktop-electron/electron/update.cjs",
  `  if (platform === "win32") {\n    return {\n      version,\n      platform,\n      parentPid: process.pid,\n      tempRoot,\n      logPath,\n      source: assetPath,\n      target: executablePath,\n    };\n  }`,
  `  if (platform === "win32") {\n    return {\n      version,\n      platform,\n      parentPid: process.pid,\n      tempRoot,\n      logPath,\n      installDirectory: path.dirname(executablePath),\n      source: assetPath,\n      target: executablePath,\n    };\n  }`,
  "installDirectory: path.dirname(executablePath)",
)) changed.push("desktop-electron/electron/update.cjs");

if (replaceOnce(
  "desktop-electron/electron/update-worker.cjs",
  `function updateWindows(job) {\n  requireFile(job.source, "Windows installer");\n  const result = spawnSync(job.source, ["/S"], { encoding: "utf8", timeout: 15 * 60_000, windowsHide: true });`,
  `function windowsInstallerArguments(job) {\n  const args = ["/S", "/UPDATE", "/CLOSEAPPLICATIONS", "/NORESTART"];\n  const installDirectory = typeof job.installDirectory === "string"\n    ? path.win32.normalize(job.installDirectory.trim())\n    : "";\n  if (installDirectory) {\n    if (!path.win32.isAbsolute(installDirectory)) {\n      throw new Error(\`Windows install directory must be absolute: \${installDirectory}\`);\n    }\n    // electron-builder/NSIS requires /D to be the final argument and it must not be quoted.\n    args.push(\`/D=\${installDirectory}\`);\n  }\n  return args;\n}\n\nfunction updateWindows(job) {\n  requireFile(job.source, "Windows installer");\n  const result = spawnSync(job.source, windowsInstallerArguments(job), {\n    encoding: "utf8",\n    timeout: 15 * 60_000,\n    windowsHide: true,\n  });`,
  "function windowsInstallerArguments(job)",
)) changed.push("desktop-electron/electron/update-worker.cjs");

if (replaceOnce(
  "desktop-electron/electron/update-worker.cjs",
  `void main().catch(() => process.exit(1));`,
  `if (require.main === module) {\n  void main().catch(() => process.exit(1));\n}\n\nmodule.exports = {\n  windowsInstallerArguments,\n};`,
  "module.exports = {\n  windowsInstallerArguments,",
)) {
  if (!changed.includes("desktop-electron/electron/update-worker.cjs")) {
    changed.push("desktop-electron/electron/update-worker.cjs");
  }
}

const updatePromptSupport = `function nativeCopyFor(language) {\n  return NATIVE_COPY[language] || NATIVE_COPY.en;\n}\n\nconst UPDATE_PROMPT_COPY = Object.freeze({\n  en: Object.freeze({\n    title: "Coding Tools beta update",\n    message: "A newer Coding Tools beta is ready.",\n    detail: "Install it into the current application folder and restart Coding Tools now?",\n    installNow: "Install and restart",\n    later: "Later",\n  }),\n  "zh-CN": Object.freeze({\n    title: "Coding Tools 测试版更新",\n    message: "检测到较新的 Coding Tools 测试版。",\n    detail: "是否安装到当前应用目录并立即重新启动 Coding Tools？",\n    installNow: "安装并重新启动",\n    later: "稍后",\n  }),\n  "zh-TW": Object.freeze({\n    title: "Coding Tools 測試版更新",\n    message: "偵測到較新嘅 Coding Tools 測試版。",\n    detail: "要唔要安裝到目前應用程式目錄，並立即重新啟動 Coding Tools？",\n    installNow: "安裝並重新啟動",\n    later: "稍後",\n  }),\n  ja: Object.freeze({\n    title: "Coding Tools ベータ更新",\n    message: "新しい Coding Tools ベータ版を検出しました。",\n    detail: "現在のアプリケーションフォルダーにインストールして再起動しますか？",\n    installNow: "インストールして再起動",\n    later: "後で",\n  }),\n});\n\nfunction updatePromptCopyFor(language) {\n  return UPDATE_PROMPT_COPY[language] || UPDATE_PROMPT_COPY.en;\n}\n\nlet updatePromptVersion = null;\nlet updatePromptInFlight = false;\n\nasync function promptForAvailableUpdate(next, { logger, stateStore }) {\n  if (next?.status !== "available" || typeof next.version !== "string") return;\n  if (stateStore.read().automaticUpdates !== true) return;\n  if (updatePromptInFlight || updatePromptVersion === next.version) return;\n\n  updatePromptInFlight = true;\n  updatePromptVersion = next.version;\n  const copy = updatePromptCopyFor(stateStore.read().language);\n  try {\n    showMainWindow();\n    const result = await dialog.showMessageBox(mainWindow, {\n      type: "info",\n      title: copy.title,\n      message: \`\${copy.message} v\${next.version}\`,\n      detail: copy.detail,\n      buttons: [copy.installNow, copy.later],\n      defaultId: 0,\n      cancelId: 1,\n      noLink: true,\n    });\n    if (result.response !== 0) {\n      logger.info("launcher.update_prompt_deferred", { version: next.version });\n      return;\n    }\n    const launch = await updateController.beginInstall();\n    const quitResult = await requestQuit();\n    if (!quitResult.ok) {\n      updateController.cancelInstall(launch);\n      throw new Error(quitResult.message);\n    }\n  } catch (error) {\n    updatePromptVersion = null;\n    logger.warn("launcher.update_prompt_failed", {\n      version: next.version,\n      message: error instanceof Error ? error.message : String(error),\n    });\n  } finally {\n    updatePromptInFlight = false;\n  }\n}`;

if (replaceOnce(
  "desktop-electron/electron/main.cjs",
  `function nativeCopyFor(language) {\n  return NATIVE_COPY[language] || NATIVE_COPY.en;\n}`,
  updatePromptSupport,
  "async function promptForAvailableUpdate(next, { logger, stateStore })",
)) changed.push("desktop-electron/electron/main.cjs");

if (replaceOnce(
  "desktop-electron/electron/main.cjs",
  `    publish: (state) => send("launcher:update-state", state),`,
  `    publish: (state) => {\n      send("launcher:update-state", state);\n      if (state.status === "available") {\n        void promptForAvailableUpdate(state, { logger, stateStore });\n      }\n    },`,
  "void promptForAvailableUpdate(state, { logger, stateStore })",
)) {
  if (!changed.includes("desktop-electron/electron/main.cjs")) changed.push("desktop-electron/electron/main.cjs");
}

if (replaceOnce(
  "desktop-electron/electron/main.cjs",
  `  if (!launcherSmokeTest) {\n    const maybeInstallAutomaticUpdate = async (next) => {\n      if (next?.status !== "available" || stateStore.read().automaticUpdates !== true) return;\n      if (runtimeHost?.currentOperation() || browserHost?.currentOperation() || browserHost?.activeTraceId) {\n        logger.info("launcher.automatic_update_deferred", { version: next.version });\n        return;\n      }\n      try {\n        const launch = await updateController.beginInstall();\n        const result = await requestQuit();\n        if (!result.ok) {\n          updateController.cancelInstall(launch);\n          logger.warn("launcher.automatic_update_deferred", {\n            version: next.version,\n            message: result.message,\n          });\n        }\n      } catch (error) {\n        logger.warn("launcher.automatic_update_failed", {\n          version: next.version,\n          message: error instanceof Error ? error.message : String(error),\n        });\n      }\n    };\n    void updateController.checkNow({ force: true }).then(maybeInstallAutomaticUpdate);\n    updateController.startPeriodicChecks({ onAvailable: maybeInstallAutomaticUpdate });\n  }`,
  `  if (!launcherSmokeTest) {\n    void updateController.checkNow({ force: true }).catch((error) => {\n      logger.warn("launcher.update_check_failed", {\n        message: error instanceof Error ? error.message : String(error),\n      });\n    });\n    updateController.startPeriodicChecks();\n  }`,
  "updateController.startPeriodicChecks();",
)) {
  if (!changed.includes("desktop-electron/electron/main.cjs")) changed.push("desktop-electron/electron/main.cjs");
}

const receipt = {
  changed,
  noDeletion: true,
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(evidenceRoot, "materializer-receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(receipt));
