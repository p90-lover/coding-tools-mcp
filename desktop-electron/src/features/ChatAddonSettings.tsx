import type { ReactNode } from "react";
import type { Copy } from "../i18n";
import { logKey, useLogs } from "../log-store";
import type { LauncherSnapshot, LogRecord, McpServerEntry } from "../types";

const ADDON_GROUPS = [
  { label: "Access", keys: ["chatAgentTools"] },
  { label: "Workspace", keys: ["chatAgentTerminalTools", "chatAgentPreviewTools"] },
  { label: "Desktop", keys: ["chatAgentDesktopTools"] },
  { label: "Privacy", keys: ["chatAgentRedactSecrets"] },
] as const;

type AddonPreference = typeof ADDON_GROUPS[number]["keys"][number];
type AddonToggle = { key: AddonPreference; label: string; body: string; checked: boolean; disabled: boolean };

const ADDON_NAMES: Readonly<Record<string, string>> = Object.freeze({
  agent: "Project tools", terminal: "Terminal", desktop: "Desktop", preview: "Preview",
  subagents: "Subagents", chats: "Chat history", "builtin:coding-tools": "Coding Tools",
  "builtin:unified-agent-tools": "Unified Agent Tools", "builtin:attached-server": "Another attached server",
  "headless-catalog": "Runtime catalog", "app-catalog": "App catalog",
});

function nameOf(id: string, servers: ReadonlyArray<Pick<McpServerEntry, "id" | "name">>) {
  if (id.startsWith("mcp:")) return servers.find(server => server.id === id.slice(4))?.name ?? "A configured MCP server";
  return Object.hasOwn(ADDON_NAMES, id) ? ADDON_NAMES[id] : "Another add-on";
}

export function describeChatAddonConflict(record: LogRecord, servers: ReadonlyArray<Pick<McpServerEntry, "id" | "name">>) {
  if (record.event !== "chat_addons.conflict") return null;
  const { kind, addon, existing, capability } = record.detail;
  if (typeof addon !== "string" || typeof existing !== "string") return null;
  const own = nameOf(addon, servers), other = nameOf(existing, servers);
  if (kind === "server_name") return `${own} was skipped. ${other} already uses that server name in this chat.`;
  if (typeof capability !== "string") return null;
  if (kind === "tool_group") return `${own} and ${other} both claim ${capability}. Only that tool is unavailable.`;
  if (kind === "tool_definition") return `${own}: ${other} listed ${capability} more than once. One definition was kept.`;
  return null;
}

function ChatAddonConflicts({ servers }: { servers: ReadonlyArray<Pick<McpServerEntry, "id" | "name">> }) {
  const logs = useLogs();
  const recent = logs.filter(record => record.event === "chat_addons.conflict").slice(-12).reverse()
    .flatMap(record => {
      const text = describeChatAddonConflict(record, servers);
      return text ? [{ record, text }] : [];
    });
  return <section aria-label="Add-on diagnostics">
    <div className="section-heading"><span>Recent add-on conflicts</span></div>
    {recent.length ? <ul>{recent.map(({ record, text }) => <li key={logKey(record)}>
      <time dateTime={record.at}>{new Date(record.at).toLocaleTimeString()}</time>{" · "}{text}
    </li>)}</ul> : <p className="surface-empty-note">No conflicts recorded in this app session.</p>}
  </section>;
}

export function ChatAddonSettings({ copy, snapshot, servers, renderToggle, redactionDetails }: {
  copy: Copy;
  snapshot: LauncherSnapshot;
  servers: ReadonlyArray<Pick<McpServerEntry, "id" | "name">>;
  renderToggle: (row: AddonToggle) => ReactNode;
  redactionDetails?: ReactNode;
}) {
  const state = snapshot.state;
  const toolsOn = state.chatAgentTools !== false;
  const enabled: Record<AddonPreference, boolean> = {
    chatAgentTools: toolsOn,
    chatAgentTerminalTools: toolsOn && (state.chatAgentTerminalTools === true || (state.chatAgentTerminalTools !== false && snapshot.chatAgentSandbox === true)),
    chatAgentPreviewTools: toolsOn && state.chatAgentPreviewTools !== false,
    chatAgentDesktopTools: toolsOn && state.chatAgentDesktopTools === true,
    chatAgentRedactSecrets: toolsOn && state.chatAgentRedactSecrets === true,
  };
  return <>
    {ADDON_GROUPS.map(({ label, keys }) => <section key={label} aria-label={label}>
      <div className="section-heading"><span>{label}</span></div>
      <div className="settings-list">{keys.map(key => renderToggle({ key, label: copy[key], body: copy[`${key}Body`],
        checked: enabled[key], disabled: key !== "chatAgentTools" && !toolsOn }))}</div>
      {label === "Privacy" && enabled.chatAgentRedactSecrets ? redactionDetails : null}
    </section>)}
    <ChatAddonConflicts servers={servers} />
  </>;
}
