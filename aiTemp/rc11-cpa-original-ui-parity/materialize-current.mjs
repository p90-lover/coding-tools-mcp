import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.cwd());

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function write(relative, value) {
  fs.writeFileSync(path.join(root, relative), value, "utf8");
  process.stdout.write(`patched ${relative}\n`);
}

function replaceOnce(relative, oldValue, newValue, sentinel = newValue) {
  const current = read(relative);
  if (current.includes(sentinel)) {
    process.stdout.write(`already patched ${relative}\n`);
    return;
  }
  const count = current.split(oldValue).length - 1;
  if (count !== 1) {
    throw new Error(`Expected one anchor in ${relative}, found ${count}: ${oldValue.slice(0, 160)}`);
  }
  write(relative, current.replace(oldValue, newValue));
}

replaceOnce(
  "desktop-electron/src/types.ts",
  `export interface OriginalUiLongRun {
  desiredRunning: boolean;
  reconnectGeneration: number;
  lastEvent: string | null;
  lastError: string | null;
  backoffMs: number;
  keptAliveAt: string | null;
}`,
  `export interface OriginalUiLongRun {
  desiredRunning: boolean;
  reconnectGeneration: number;
  lastEvent: string | null;
  lastError: string | null;
  backoffMs: number;
  keptAliveAt: string | null;
  selectedSection?: string;
  uiStatus?: "ready" | "starting" | "reconnecting" | "blocked" | "stopped" | "offline";
}`,
  'selectedSection?: string;',
);

replaceOnce(
  "desktop-electron/src/features/OriginalUiSurface.tsx",
  `function withReconnect(url: string, generation: number): string {
  if (!url || generation < 1) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("lr", String(generation));
  return parsed.toString();
}

function toolFrom`,
  `function withReconnect(url: string, generation: number): string {
  if (!url || generation < 1) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("lr", String(generation));
  return parsed.toString();
}

function selectedFrom(tool: OriginalUiSnapshot | null): string {
  return tool?.longRun?.selectedSection || tool?.sections[0] || "";
}

function reconnectGenerationOf(tool: OriginalUiSnapshot | null): number {
  return tool?.longRun?.reconnectGeneration ?? 0;
}

function displayStatusOf(tool: OriginalUiSnapshot): string {
  if (tool.longRun?.uiStatus) return tool.longRun.uiStatus;
  if (tool.longRun?.lastEvent === "crash-recover" || tool.longRun?.lastEvent === "restart-failed") {
    return "reconnecting";
  }
  return tool.status;
}

function toolFrom`,
  'function selectedFrom(tool: OriginalUiSnapshot | null)',
);

replaceOnce(
  "desktop-electron/src/features/OriginalUiSurface.tsx",
  '    if (current) setSelectedSection((value) => value || current.sections[0] || "");',
  '    if (current) setSelectedSection((value) => value || selectedFrom(current));',
  'setSelectedSection((value) => value || selectedFrom(current))',
);

replaceOnce(
  "desktop-electron/src/features/OriginalUiSurface.tsx",
  '      if (current) setSelectedSection(current.sections[0] || "");',
  '      if (current) setSelectedSection((value) => value || selectedFrom(current));',
  'if (current) setSelectedSection((value) => value || selectedFrom(current));',
);

replaceOnce(
  "desktop-electron/src/features/OriginalUiSurface.tsx",
  `    const generation = tool.longRun?.reconnectGeneration ?? 0;
    const recovered = lastStatus.current !== "" && lastStatus.current !== "ready" && tool.status === "ready";
    const generationBumped = generation > lastGeneration.current;
    lastStatus.current = tool.status;
    lastGeneration.current = generation;
    if (toolId !== "cpa" || tool.status !== "ready") return;
    if (!autoOpened.current) {
      autoOpened.current = true;
      void openSection(tool.sections[0]).catch((cause) => setError(messageOf(cause)));
      return;
    }
    if (recovered || generationBumped) {
      void openSection(selectedSection || tool.sections[0]).catch((cause) => setError(messageOf(cause)));
    }`,
  `    const generation = reconnectGenerationOf(tool);
    const recovered = lastStatus.current !== "" && lastStatus.current !== "ready" && tool.status === "ready";
    const generationBumped = generation > lastGeneration.current;
    lastStatus.current = tool.status;
    lastGeneration.current = generation;
    if (toolId !== "cpa" || tool.status !== "ready") return;
    if (!autoOpened.current) {
      autoOpened.current = true;
      void openSection(selectedSection || selectedFrom(tool)).catch((cause) => setError(messageOf(cause)));
      return;
    }
    if (recovered || generationBumped) {
      void openSection(selectedSection || selectedFrom(tool)).catch((cause) => setError(messageOf(cause)));
    }`,
  'const generation = reconnectGenerationOf(tool);',
);

replaceOnce(
  "desktop-electron/src/features/OriginalUiSurface.tsx",
  `  const ready = tool.status === "ready";
  const statusText = ready
    ? localize(language, "Connected", "已連線")
    : tool.status === "starting"
      ? localize(language, "Starting", "正在啟動")
      : tool.status === "error"
        ? localize(language, "Error", "錯誤")
        : localize(language, "Offline", "離線");`,
  `  const ready = tool.status === "ready";
  const displayStatus = displayStatusOf(tool);
  const statusText = displayStatus === "ready"
    ? localize(language, "Connected", "已連線")
    : displayStatus === "reconnecting"
      ? localize(language, "Reconnecting", "正在重連")
      : displayStatus === "blocked"
        ? localize(language, "Reconnect paused", "重連已暫停")
        : displayStatus === "starting"
          ? localize(language, "Starting", "正在啟動")
          : tool.status === "error"
            ? localize(language, "Error", "錯誤")
            : localize(language, "Offline", "離線");`,
  'const displayStatus = displayStatusOf(tool);',
);

replaceOnce(
  "desktop-electron/src/features/OriginalUiSurface.tsx",
  '<span className={`original-ui-status status-${tool.status}`}>{statusText}</span>',
  '<span className={`original-ui-status status-${displayStatus}`}>{statusText}</span>',
  'status-${displayStatus}',
);

replaceOnce(
  "desktop-electron/src/features/OriginalUiSurface.tsx",
  `      {notice ? <p className="original-ui-note">{notice}</p> : null}

      <div className="original-ui-frame-shell">`,
  `      {notice ? <p className="original-ui-note">{notice}</p> : null}

      <nav className="original-ui-section-tabs" aria-label={\`${"${tool.name}"} sections\`}>
        {tool.sections.map((section) => (
          <button
            className={section === selectedSection ? "is-active" : ""}
            key={section}
            onClick={() => {
              setSelectedSection(section);
              if (frameUrl || originalWindow || ready) {
                void openSection(section).catch((cause) => setError(messageOf(cause)));
              }
            }}
            type="button"
          >
            {section.replaceAll("-", " ")}
          </button>
        ))}
      </nav>

      <div className="original-ui-frame-shell">`,
  'className="original-ui-section-tabs"',
);

replaceOnce(
  "desktop-electron/src/features/OriginalUiSurface.tsx",
  '            src={withReconnect(frameUrl, tool.longRun?.reconnectGeneration ?? 0)}',
  '            src={withReconnect(frameUrl, reconnectGenerationOf(tool))}',
  'src={withReconnect(frameUrl, reconnectGenerationOf(tool))}',
);

replaceOnce(
  "desktop-electron/src/features/original-ui.css",
  `.original-ui-status.status-starting {
  border-color: rgb(37 99 235 / 35%);
  color: #1d4ed8;
}

.original-ui-status.status-error {`,
  `.original-ui-status.status-starting,
.original-ui-status.status-reconnecting {
  border-color: rgb(37 99 235 / 35%);
  color: #1d4ed8;
}

.original-ui-status.status-blocked,
.original-ui-status.status-error {`,
  '.original-ui-status.status-reconnecting',
);

replaceOnce(
  "desktop-electron/src/features/original-ui.css",
  `.original-ui-frame-shell {
`,
  `.original-ui-section-tabs {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
  overflow-x: auto;
  padding: 8px 12px;
  border-bottom: 1px solid rgb(15 23 42 / 8%);
  background: #eef1f5;
}

.original-ui-section-tabs button {
  flex: 0 0 auto;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid rgb(15 23 42 / 10%);
  border-radius: 999px;
  background: #fff;
  color: #4b5563;
  font-size: 11px;
  text-transform: capitalize;
}

.original-ui-section-tabs button.is-active {
  border-color: #1d4ed8;
  background: #1d4ed8;
  color: #fff;
}

.original-ui-frame-shell {
`,
  '.original-ui-section-tabs {',
);

process.stdout.write("RC11_CPA_ORIGINAL_UI_PARITY_MATERIALIZED\n");
