from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path.cwd()
SOURCE_COMMIT = "cdfed4099dbf886cf20250e56320bf4ff0535a81"

COPIED_FILES = (
    "desktop-electron/electron/cpa-managed.cjs",
    "desktop-electron/electron/external-services.cjs",
    "desktop-electron/electron/managed-components.cjs",
    "desktop-electron/electron/managed-external-services.cjs",
    "desktop-electron/electron/provider-bootstrap.cjs",
    "desktop-electron/electron/provider-network.cjs",
    "desktop-electron/src/features/original-ui.css",
    "desktop-electron/tests/external-services-control-plane.test.cjs",
    "desktop-electron/tests/managed-components-runtime.test.cjs",
    "desktop-electron/tests/rc9-five-stack-completion.test.cjs",
    "desktop-electron/tests/rc9-managed-five-stack.test.cjs",
    "desktop-electron/tests/rc9-managed-cpa-runtime.test.cjs",
    "desktop-electron/vendor/managed-components/cpa.json",
    "desktop-electron/vendor/upstream/cpa.json",
)


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def write(relative: str, value: str) -> None:
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    current = path.read_text(encoding="utf-8") if path.exists() else None
    if current == value:
        print(f"already materialized {relative}")
        return
    path.write_text(value, encoding="utf-8")
    print(f"materialized {relative}")


def source_file(relative: str) -> str:
    completed = subprocess.run(
        ["git", "show", f"{SOURCE_COMMIT}:{relative}"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return completed.stdout


def replace_once(
    relative: str,
    old: str,
    new: str,
    *,
    sentinel: str | None = None,
) -> None:
    current = read(relative)
    marker = new if sentinel is None else sentinel
    if marker and marker in current:
        print(f"already patched {relative}: {marker[:80]}")
        return
    count = current.count(old)
    if count != 1:
        raise RuntimeError(
            f"Expected one anchor in {relative}, found {count}: {old[:160]!r}"
        )
    write(relative, current.replace(old, new, 1))


for copied_file in COPIED_FILES:
    write(copied_file, source_file(copied_file))


ORIGINAL_UI_CONTROLLER = r'''"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TOOL_IDS = Object.freeze(["cpa"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const READY_WAIT_MS = 20_000;
const READY_POLL_MS = 250;

function manifestPath(toolId) {
  return path.join(__dirname, "..", "vendor", "upstream", `${toolId}.json`);
}

function loadManifest(toolId) {
  if (!TOOL_IDS.includes(toolId)) throw new Error(`Unknown original UI: ${toolId}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath(toolId), "utf8"));
  if (manifest.id !== toolId) throw new Error(`Original UI manifest ID mismatch: ${toolId}`);
  if (!Array.isArray(manifest.sections) || manifest.sections.length === 0) {
    throw new Error(`Original UI manifest has no sections: ${toolId}`);
  }
  return Object.freeze({ ...manifest, sections: Object.freeze([...manifest.sections]) });
}

function canonicalHostname(value) {
  const hostname = String(value || "").toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function normalizeLoopbackEndpoint(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Original UI endpoints must use HTTP or HTTPS");
  }
  if (!LOOPBACK_HOSTS.has(canonicalHostname(parsed.hostname))) {
    throw new Error("Original UI endpoints are restricted to loopback hosts");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Original UI endpoints must not contain credentials");
  }
  parsed.hash = "";
  parsed.search = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

function sectionUrl(manifest, endpoint, section) {
  if (!manifest.sections.includes(section)) {
    throw new Error(`Unsupported ${manifest.id} section: ${section}`);
  }
  const pathname = manifest.sectionPaths?.[section] || `/${section}`;
  const target = new URL(pathname, normalizeLoopbackEndpoint(endpoint));
  if (!LOOPBACK_HOSTS.has(canonicalHostname(target.hostname))) {
    throw new Error("Original UI section URL escaped the loopback boundary");
  }
  return target.toString();
}

function createOriginalUiController({
  externalServices = null,
  openExternal = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const manifests = new Map(TOOL_IDS.map((toolId) => [toolId, loadManifest(toolId)]));

  function requireTool(toolId) {
    const manifest = manifests.get(toolId);
    if (!manifest) throw new Error(`Unknown original UI: ${toolId}`);
    return manifest;
  }

  function service(toolId) {
    return externalServices?.snapshot?.().services?.find((entry) => entry.id === toolId) || null;
  }

  function project(toolId) {
    const manifest = requireTool(toolId);
    const current = service(toolId);
    return {
      id: manifest.id,
      name: manifest.name,
      repository: manifest.repository,
      commit: String(manifest.commit || ""),
      version: manifest.version || null,
      license: manifest.license || "",
      sections: [...manifest.sections],
      endpoint: current?.endpoint || manifest.defaultEndpoint,
      status: current?.status || "unknown",
      pid: current?.pid ?? null,
      error: current?.error || null,
      sourceConfigured: Boolean(current?.home),
      installState: current?.managedInstall?.state || "not-installed",
      originalChrome: true,
    };
  }

  function snapshot() {
    return { version: 1, tools: TOOL_IDS.map(project) };
  }

  async function inspect(toolId) {
    requireTool(toolId);
    if (externalServices?.inspect) await externalServices.inspect(toolId);
    return project(toolId);
  }

  async function waitUntilReady(toolId) {
    const started = Date.now();
    while (true) {
      const state = await inspect(toolId);
      if (state.status === "ready") return state;
      if (state.status === "error") {
        throw new Error(state.error || `${requireTool(toolId).name} failed to start`);
      }
      if (Date.now() - started >= READY_WAIT_MS) {
        throw new Error(`${requireTool(toolId).name} is not ready`);
      }
      await sleep(READY_POLL_MS);
    }
  }

  async function start(toolId) {
    requireTool(toolId);
    const current = service(toolId);
    const installState = current?.managedInstall?.state;
    if (installState === "not-installed" && externalServices?.installManagedComponent) {
      await externalServices.installManagedComponent(toolId);
    } else if (
      (installState === "repair-required" || installState === "error")
      && externalServices?.repairManagedComponent
    ) {
      await externalServices.repairManagedComponent(toolId);
    } else if (externalServices?.start) {
      await externalServices.start(toolId);
    } else {
      throw new Error(`${requireTool(toolId).name} lifecycle is unavailable`);
    }
    return inspect(toolId);
  }

  async function stop(toolId) {
    requireTool(toolId);
    if (!externalServices?.stop) throw new Error(`${requireTool(toolId).name} lifecycle is unavailable`);
    await externalServices.stop(toolId);
    return inspect(toolId);
  }

  async function restart(toolId) {
    requireTool(toolId);
    if (!externalServices?.restart) throw new Error(`${requireTool(toolId).name} lifecycle is unavailable`);
    await externalServices.restart(toolId);
    return inspect(toolId);
  }

  async function openEmbedded(toolId, section) {
    const manifest = requireTool(toolId);
    const selected = section || manifest.sections[0];
    let state = await inspect(toolId);
    if (state.status !== "ready") {
      await start(toolId);
      state = await waitUntilReady(toolId);
    }
    return {
      tool: state,
      section: selected,
      url: sectionUrl(manifest, state.endpoint, selected),
      embedded: true,
    };
  }

  async function openExternalTool(toolId, section) {
    const result = await openEmbedded(toolId, section);
    if (typeof openExternal === "function") await openExternal(result.url);
    return { ...result, embedded: false };
  }

  function cpaManagementKey() {
    const connection = externalServices?.cpaConnection?.();
    const key = String(connection?.managementKey || "").trim();
    if (!key) throw new Error("Install and start managed CPA before copying its management key");
    return { length: key.length, value: key };
  }

  function copyCpaManagementKey(clipboard) {
    const { value, length } = cpaManagementKey();
    if (!clipboard?.writeText) throw new Error("Clipboard is unavailable");
    clipboard.writeText(value);
    return { copied: true, length };
  }

  function dispose() {}

  return Object.freeze({
    snapshot,
    inspect,
    start,
    stop,
    restart,
    openEmbedded,
    openExternalTool,
    copyCpaManagementKey,
    dispose,
  });
}

module.exports = {
  TOOL_IDS,
  createOriginalUiController,
  loadManifest,
  normalizeLoopbackEndpoint,
  sectionUrl,
};
'''
write("desktop-electron/electron/original-ui.cjs", ORIGINAL_UI_CONTROLLER)


ORIGINAL_UI_SURFACE = r'''import { useEffect, useMemo, useRef, useState } from "react";
import type { Language, OriginalUiCatalog, OriginalUiId, OriginalUiSnapshot } from "../types";
import "./original-ui.css";

interface OriginalUiSurfaceProps {
  toolId: OriginalUiId;
  language: Language;
  setError: (error: string | null) => void;
}

function localize(language: Language, english: string, traditionalChinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? traditionalChinese : english;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function toolFrom(snapshot: OriginalUiCatalog | null, toolId: OriginalUiId): OriginalUiSnapshot | null {
  return snapshot?.tools.find((candidate) => candidate.id === toolId) ?? null;
}

export function OriginalUiSurface({ toolId, language, setError }: OriginalUiSurfaceProps) {
  const api = window.codexWebLauncher;
  const [snapshot, setSnapshot] = useState<OriginalUiCatalog | null>(null);
  const [selectedSection, setSelectedSection] = useState("");
  const [frameUrl, setFrameUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const autoOpened = useRef(false);
  const tool = useMemo(() => toolFrom(snapshot, toolId), [snapshot, toolId]);

  const refresh = async () => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    const next = await api.originalUiSnapshot();
    setSnapshot(next);
    const current = toolFrom(next, toolId);
    if (current) setSelectedSection((value) => value || current.sections[0] || "");
    return current;
  };

  useEffect(() => {
    autoOpened.current = false;
    setFrameUrl("");
    setNotice("");
    setSelectedSection("");
  }, [toolId]);

  useEffect(() => {
    let cancelled = false;
    if (!api) return;
    void api.originalUiSnapshot().then((next) => {
      if (cancelled) return;
      setSnapshot(next);
      const current = toolFrom(next, toolId);
      if (current) setSelectedSection(current.sections[0] || "");
    }).catch((cause) => setError(messageOf(cause)));
    const unsubscribe = api.onExternalServicesChanged?.(() => {
      void api.originalUiSnapshot().then((next) => {
        if (!cancelled) setSnapshot(next);
      }).catch((cause) => setError(messageOf(cause)));
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, setError, toolId]);

  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    setNotice("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const openSection = async (section = selectedSection) => {
    if (!api) throw new Error("Launcher IPC is unavailable");
    const result = await api.openOriginalUi(toolId, section);
    setSelectedSection(result.section);
    setFrameUrl(result.url);
    setSnapshot((current) => current
      ? {
          ...current,
          tools: current.tools.map((candidate) => candidate.id === result.tool.id ? result.tool : candidate),
        }
      : current);
    return result;
  };

  useEffect(() => {
    if (!tool || autoOpened.current || busy || !api || tool.status !== "ready") return;
    autoOpened.current = true;
    void openSection(tool.sections[0]).catch((cause) => setError(messageOf(cause)));
  }, [api, busy, setError, tool]);

  if (!tool) {
    return (
      <section className="original-ui-surface" data-tool={toolId} data-original-chrome="true">
        <div className="original-ui-frame-empty">
          <strong>{localize(language, "Loading original interface…", "正在載入原始介面…")}</strong>
        </div>
      </section>
    );
  }

  const ready = tool.status === "ready";
  const needsInstall = tool.installState === "not-installed"
    || tool.installState === "repair-required"
    || tool.installState === "error";
  const statusText = ready
    ? localize(language, "Connected", "已連線")
    : tool.status === "starting"
      ? localize(language, "Starting", "正在啟動")
      : tool.status === "error"
        ? localize(language, "Error", "錯誤")
        : localize(language, "Offline", "離線");

  return (
    <section className="original-ui-surface" data-tool={toolId} data-original-chrome="true">
      <header className="original-ui-hostbar">
        <strong>{tool.name}</strong>
        <span className={`original-ui-status status-${tool.status}`}>{statusText}</span>
        <div className="original-ui-hostbar-actions">
          <button className="primary" disabled={busy !== null} onClick={() => void run(ready ? "open" : "start", async () => {
            if (!api) throw new Error("Launcher IPC is unavailable");
            if (!ready) await api.startOriginalUi(toolId);
            await openSection();
          })} type="button">
            {busy === "start" || busy === "open" ? "…" : ready
              ? localize(language, "Open original UI", "開啟原始介面")
              : needsInstall
                ? localize(language, "Install and start CPA", "安裝並啟動 CPA")
                : localize(language, "Start original UI", "啟動原始介面")}
          </button>
          <button disabled={busy !== null} onClick={() => void run("copy-key", async () => {
            if (!api) throw new Error("Launcher IPC is unavailable");
            const copied = await api.copyCpaManagementKey();
            setNotice(localize(
              language,
              `CPA management key copied (${copied.length} chars). Paste it into the original login form.`,
              `已複製 CPA 管理金鑰（${copied.length} 字）。請貼到原始登入表單。`,
            ));
          })} type="button">
            {busy === "copy-key" ? "…" : localize(language, "Copy management key", "複製管理金鑰")}
          </button>
          <button disabled={busy !== null || !ready} onClick={() => void run("external", async () => {
            if (!api) throw new Error("Launcher IPC is unavailable");
            await api.openOriginalUiExternal(toolId, selectedSection);
          })} type="button">
            {busy === "external" ? "…" : localize(language, "Open externally", "外部開啟")}
          </button>
          <button disabled={busy !== null || tool.pid === null} onClick={() => void run("restart", async () => {
            if (!api) throw new Error("Launcher IPC is unavailable");
            await api.restartOriginalUi(toolId);
            await openSection();
          })} type="button">
            {busy === "restart" ? "…" : localize(language, "Restart", "重新啟動")}
          </button>
          <button disabled={busy !== null || (!ready && tool.pid === null)} onClick={() => void run("stop", async () => {
            if (!api) throw new Error("Launcher IPC is unavailable");
            await api.stopOriginalUi(toolId);
            setFrameUrl("");
            autoOpened.current = false;
          })} type="button">
            {busy === "stop" ? "…" : localize(language, "Stop", "停止")}
          </button>
        </div>
      </header>

      {tool.error ? <p className="original-ui-error">{tool.error}</p> : null}
      {notice ? <p className="original-ui-note">{notice}</p> : null}

      <div className="original-ui-frame-shell">
        {frameUrl ? (
          <iframe
            allow="clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            src={frameUrl}
            title={`${tool.name} original ${selectedSection}`}
          />
        ) : (
          <div className="original-ui-frame-empty">
            <strong>{localize(language, "Original CLIProxyAPI interface", "原始 CLIProxyAPI 介面")}</strong>
            <span>
              {ready
                ? localize(
                  language,
                  "The original management panel fills this tab. Dashboard, providers, auth files, OAuth, quota, config, logs, system, and plugins retain their original layout.",
                  "原始管理面板會填滿呢個分頁。儀表板、供應商、授權檔、OAuth、配額、設定、日誌、系統同外掛會保持原本版面。",
                )
                : localize(
                  language,
                  "Install and start the managed CPA runtime; its original application will open inside this tab.",
                  "安裝並啟動受管理 CPA 執行環境後，原始應用程式會直接喺呢個分頁開啟。",
                )}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
'''
write("desktop-electron/src/features/OriginalUiSurface.tsx", ORIGINAL_UI_SURFACE)


package_path = "desktop-electron/package.json"
package_data = json.loads(read(package_path))
asar_unpack = package_data["build"].setdefault("asarUnpack", [])
for required in ("electron/cpa-managed.cjs", "electron/atomic-file.cjs"):
    if required not in asar_unpack:
        asar_unpack.append(required)
write(package_path, json.dumps(package_data, indent=2, ensure_ascii=False) + "\n")


replace_once(
    "desktop-electron/electron/main.cjs",
    '  BrowserWindow,\n  dialog,',
    '  BrowserWindow,\n  clipboard,\n  dialog,',
    sentinel='  clipboard,\n  dialog,',
)
replace_once(
    "desktop-electron/electron/main.cjs",
    '  providerNetworkReady,\n  setProviderBrowserHost,\n} = require("./provider-bootstrap.cjs");',
    '  providerNetworkReady,\n  setProviderBrowserHost,\n  setProviderCpaConnection,\n} = require("./provider-bootstrap.cjs");',
    sentinel='  setProviderCpaConnection,\n} = require("./provider-bootstrap.cjs");',
)
replace_once(
    "desktop-electron/electron/main.cjs",
    'const { createUpstreamToolController } = require("./upstream-tools.cjs");\nconst {',
    'const { createUpstreamToolController } = require("./upstream-tools.cjs");\n'
    'const { createOriginalUiController } = require("./original-ui.cjs");\nconst {',
    sentinel='const { createOriginalUiController } = require("./original-ui.cjs");',
)
replace_once(
    "desktop-electron/electron/main.cjs",
    'let externalServicesController = null;\nlet upstreamToolController = null;',
    'let externalServicesController = null;\nlet upstreamToolController = null;\nlet originalUiController = null;',
    sentinel='let originalUiController = null;',
)

IPC_ANCHOR = '''  handle("launcher:upstream-tool-open-external", (event, toolId, section) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.openExternalTool(toolId, section);
  });

  handle("launcher:browser-bounds",'''
IPC_REPLACEMENT = '''  handle("launcher:upstream-tool-open-external", (event, toolId, section) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.openExternalTool(toolId, section);
  });
  handle("launcher:original-ui-snapshot", (event) => {
    assertFocusedMainWindow(event, false);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.snapshot();
  });
  handle("launcher:original-ui-inspect", (event, toolId) => {
    assertFocusedMainWindow(event, false);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.inspect(toolId);
  });
  handle("launcher:original-ui-start", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.start(toolId);
  });
  handle("launcher:original-ui-stop", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.stop(toolId);
  });
  handle("launcher:original-ui-restart", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.restart(toolId);
  });
  handle("launcher:original-ui-open", (event, toolId, section) => {
    assertFocusedMainWindow(event, true);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.openEmbedded(toolId, section);
  });
  handle("launcher:original-ui-open-external", (event, toolId, section) => {
    assertFocusedMainWindow(event, true);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.openExternalTool(toolId, section);
  });
  handle("launcher:original-ui-copy-cpa-key", (event) => {
    assertFocusedMainWindow(event, true);
    if (!originalUiController) throw new Error("Original UI controller is unavailable");
    return originalUiController.copyCpaManagementKey(clipboard);
  });

  handle("launcher:browser-bounds",'''
replace_once(
    "desktop-electron/electron/main.cjs",
    IPC_ANCHOR,
    IPC_REPLACEMENT,
    sentinel='handle("launcher:original-ui-copy-cpa-key"',
)

replace_once(
    "desktop-electron/electron/main.cjs",
    '''    updateController?.stopPeriodicChecks?.();
    externalServicesController?.dispose();
    upstreamToolController?.dispose();''',
    '''    updateController?.stopPeriodicChecks?.();
    originalUiController?.dispose();
    externalServicesController?.dispose();
    upstreamToolController?.dispose();''',
    sentinel='    originalUiController?.dispose();\n    externalServicesController?.dispose();',
)

INIT_ANCHOR = '''  upstreamToolController = createUpstreamToolController({
    env: process.env,
    logger,
    openExternal: openWebUrl,
    externalServices: externalServicesController,
  });
  app.once("before-quit", () => {
    externalServicesController?.dispose();
    upstreamToolController?.dispose();
  });'''
INIT_REPLACEMENT = '''  setProviderCpaConnection(() => externalServicesController?.cpaConnection());
  upstreamToolController = createUpstreamToolController({
    env: process.env,
    logger,
    openExternal: openWebUrl,
    externalServices: externalServicesController,
  });
  originalUiController = createOriginalUiController({
    externalServices: externalServicesController,
    openExternal: openWebUrl,
  });
  app.once("before-quit", () => {
    originalUiController?.dispose();
    externalServicesController?.dispose();
    upstreamToolController?.dispose();
  });'''
replace_once(
    "desktop-electron/electron/main.cjs",
    INIT_ANCHOR,
    INIT_REPLACEMENT,
    sentinel='  setProviderCpaConnection(() => externalServicesController?.cpaConnection());',
)


PRELOAD_ANCHOR = '''  openUpstreamToolExternal: (toolId, section) => ipcRenderer.invoke(
    "launcher:upstream-tool-open-external",
    toolId,
    section,
  ),
  providerSnapshot:'''
PRELOAD_REPLACEMENT = '''  openUpstreamToolExternal: (toolId, section) => ipcRenderer.invoke(
    "launcher:upstream-tool-open-external",
    toolId,
    section,
  ),
  originalUiSnapshot: () => ipcRenderer.invoke("launcher:original-ui-snapshot"),
  inspectOriginalUi: (toolId) => ipcRenderer.invoke("launcher:original-ui-inspect", toolId),
  startOriginalUi: (toolId) => ipcRenderer.invoke("launcher:original-ui-start", toolId),
  stopOriginalUi: (toolId) => ipcRenderer.invoke("launcher:original-ui-stop", toolId),
  restartOriginalUi: (toolId) => ipcRenderer.invoke("launcher:original-ui-restart", toolId),
  openOriginalUi: (toolId, section) => ipcRenderer.invoke("launcher:original-ui-open", toolId, section),
  openOriginalUiExternal: (toolId, section) => ipcRenderer.invoke(
    "launcher:original-ui-open-external",
    toolId,
    section,
  ),
  copyCpaManagementKey: () => ipcRenderer.invoke("launcher:original-ui-copy-cpa-key"),
  providerSnapshot:'''
replace_once(
    "desktop-electron/electron/preload.cjs",
    PRELOAD_ANCHOR,
    PRELOAD_REPLACEMENT,
    sentinel='copyCpaManagementKey: () => ipcRenderer.invoke("launcher:original-ui-copy-cpa-key")',
)


replace_once(
    "desktop-electron/src/types.ts",
    'export type ExternalServiceId = "codex-router" | "commandcode-proxy" | "paseo" | "anneal";',
    'export type ExternalServiceId = "codex-router" | "commandcode-proxy" | "cpa" | "paseo" | "anneal";',
    sentinel='| "cpa" | "paseo"',
)
replace_once(
    "desktop-electron/src/types.ts",
    '  home: string;\n  executable: string;',
    '  home: string;\n  stateDir?: string;\n  executable: string;',
    sentinel='  stateDir?: string;',
)
replace_once(
    "desktop-electron/src/types.ts",
    'export type UpstreamToolId = "anneal" | "paseo";\nexport type UpstreamToolStatus',
    'export type UpstreamToolId = "anneal" | "paseo";\n'
    'export type OriginalUiId = "cpa";\n'
    'export type UpstreamToolStatus',
    sentinel='export type OriginalUiId = "cpa";',
)

ORIGINAL_TYPES = '''export interface UpstreamToolOpenResult {
  tool: UpstreamToolSnapshot;
  section: string;
  url: string;
  embedded: boolean;
}

export interface LauncherState'''
ORIGINAL_TYPES_REPLACEMENT = '''export interface UpstreamToolOpenResult {
  tool: UpstreamToolSnapshot;
  section: string;
  url: string;
  embedded: boolean;
}

export interface OriginalUiSnapshot {
  id: OriginalUiId;
  name: string;
  repository: string;
  commit: string;
  version: string | null;
  license: string;
  sections: string[];
  endpoint: string;
  status: ExternalServiceStatus;
  pid: number | null;
  error: string | null;
  sourceConfigured: boolean;
  installState: ManagedComponentInstallState;
  originalChrome: boolean;
}

export interface OriginalUiCatalog {
  version: 1;
  tools: OriginalUiSnapshot[];
}

export interface OriginalUiOpenResult {
  tool: OriginalUiSnapshot;
  section: string;
  url: string;
  embedded: boolean;
}

export interface LauncherState'''
replace_once(
    "desktop-electron/src/types.ts",
    ORIGINAL_TYPES,
    ORIGINAL_TYPES_REPLACEMENT,
    sentinel="export interface OriginalUiCatalog",
)

API_ANCHOR = '''  openEmbeddedTool(toolId: UpstreamToolId, section: string): Promise<UpstreamToolOpenResult>;
  openUpstreamToolExternal(toolId: UpstreamToolId, section: string): Promise<UpstreamToolOpenResult>;
  providerSnapshot(): Promise<ProviderNetworkSnapshot>;'''
API_REPLACEMENT = '''  openEmbeddedTool(toolId: UpstreamToolId, section: string): Promise<UpstreamToolOpenResult>;
  openUpstreamToolExternal(toolId: UpstreamToolId, section: string): Promise<UpstreamToolOpenResult>;
  originalUiSnapshot(): Promise<OriginalUiCatalog>;
  inspectOriginalUi(toolId: OriginalUiId): Promise<OriginalUiSnapshot>;
  startOriginalUi(toolId: OriginalUiId): Promise<OriginalUiSnapshot>;
  stopOriginalUi(toolId: OriginalUiId): Promise<OriginalUiSnapshot>;
  restartOriginalUi(toolId: OriginalUiId): Promise<OriginalUiSnapshot>;
  openOriginalUi(toolId: OriginalUiId, section: string): Promise<OriginalUiOpenResult>;
  openOriginalUiExternal(toolId: OriginalUiId, section: string): Promise<OriginalUiOpenResult>;
  copyCpaManagementKey(): Promise<{ copied: boolean; length: number }>;
  providerSnapshot(): Promise<ProviderNetworkSnapshot>;'''
replace_once(
    "desktop-electron/src/types.ts",
    API_ANCHOR,
    API_REPLACEMENT,
    sentinel="copyCpaManagementKey(): Promise<{ copied: boolean; length: number }>",
)


replace_once(
    "desktop-electron/src/features/ManagedAppsSurface.tsx",
    'import { ExternalServicesSurface } from "./ExternalServicesSurface";',
    'import { ExternalServicesSurface } from "./ExternalServicesSurface";\n'
    'import { OriginalUiSurface } from "./OriginalUiSurface";',
    sentinel='import { OriginalUiSurface } from "./OriginalUiSurface";',
)
replace_once(
    "desktop-electron/src/features/ManagedAppsSurface.tsx",
    '  { id: "cpa", english: "CPA", traditionalChinese: "CPA" },',
    '  { id: "cpa", english: "CPA", traditionalChinese: "CPA", serviceId: "cpa" },',
    sentinel='traditionalChinese: "CPA", serviceId: "cpa"',
)
replace_once(
    "desktop-electron/src/features/ManagedAppsSurface.tsx",
    '          const status = tab.id === "cpa" ? "ready" : service?.status ?? "unknown";',
    '          const status = service?.status ?? "unknown";',
    sentinel='const status = service?.status ?? "unknown";',
)

CPA_PANEL_ANCHOR = '''        {selectedTab === "cpa" ? (
          <ProviderCenterSurface language={language} setError={setError} />
        ) : null}'''
CPA_PANEL_REPLACEMENT = '''        {selectedTab === "cpa" ? (
          <div className="managed-cpa-tab">
            <OriginalUiSurface language={language} setError={setError} toolId="cpa" />
            <details className="managed-cpa-accounts">
              <summary>
                {text(language, "Accounts and routing", "帳戶與路由")}
              </summary>
              <p>
                {text(
                  language,
                  "Manage encrypted multi-account provider routing without replacing the original CPA application above.",
                  "管理已加密嘅多帳戶供應商路由，同時保留上方完整原始 CPA 應用程式。",
                )}
              </p>
              <ProviderCenterSurface language={language} setError={setError} />
            </details>
          </div>
        ) : null}'''
replace_once(
    "desktop-electron/src/features/ManagedAppsSurface.tsx",
    CPA_PANEL_ANCHOR,
    CPA_PANEL_REPLACEMENT,
    sentinel='className="managed-cpa-tab"',
)

css_path = "desktop-electron/src/features/managed-apps.css"
css = read(css_path)
css_marker = ".managed-cpa-tab"
if css_marker not in css:
    css += r'''

.managed-cpa-tab {
  display: grid;
  min-height: 0;
  gap: 14px;
}

.managed-cpa-accounts {
  border: 1px solid var(--line-subtle, rgba(255, 255, 255, 0.1));
  border-radius: 12px;
  background: var(--surface-raised, rgba(255, 255, 255, 0.035));
  overflow: clip;
}

.managed-cpa-accounts > summary {
  cursor: pointer;
  padding: 14px 16px;
  font-weight: 650;
}

.managed-cpa-accounts > p {
  margin: 0;
  padding: 0 16px 12px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.68));
}
'''
    write(css_path, css)
else:
    print(f"already patched {css_path}: {css_marker}")

print("managed CPA tab materialization complete")
