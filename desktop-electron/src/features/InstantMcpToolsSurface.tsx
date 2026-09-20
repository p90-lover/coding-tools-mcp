import { useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import {
  INSTANT_MCP_TOOLS_OPERATIONS,
  INSTANT_MCP_TOOLS_MODULE_ID,
  callInstantMcpTools,
} from "../api/instant-mcp-tools-contract";
import type { Copy } from "../i18n";
import type { Language } from "../types";
import { InProcessAppsPanel } from "./InProcessAppsPanel";
import { McpLiveToolsPanel } from "./McpLiveToolsPanel";
import "./original-ui.css";
import "./instant-mcp-tools.css";

interface InstantMcpToolsSurfaceProps {
  copy: Copy;
  language: Language;
  setError: (error: string | null) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function moduleIds(payload: Record<string, unknown>): string[] {
  const raw = Array.isArray(payload.modules) ? payload.modules : [];
  return raw.flatMap((entry) => {
    const id = asRecord(entry).id;
    return typeof id === "string" && id.trim() ? [id] : [];
  });
}

export function InstantMcpToolsSurface({ copy, language, setError }: InstantMcpToolsSurfaceProps) {
  const [busy, setBusy] = useState(false);
  const [listedIds, setListedIds] = useState<string[]>([]);
  const [handlerReady, setHandlerReady] = useState(false);
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = async () => {
    setBusy(true);
    setLocalError("");
    setError(null);
    try {
      const client = getCodingToolsClient();
      const listed = asRecord(await client.apps.list());
      const ids = moduleIds(listed);
      setListedIds(ids);
      let ready = ids.includes(INSTANT_MCP_TOOLS_MODULE_ID);
      try {
        const inspected = await callInstantMcpTools("inspect");
        ready = ready || inspected.status === "ready" || inspected.ok === true;
      } catch {
        // Handler may not be registered until Bot GG #236 lands; visual still embeds in-process.
      }
      setHandlerReady(ready);
      setNotice(copy.instantMcpToolsHostBody);
    } catch (cause) {
      setListedIds([]);
      setHandlerReady(false);
      setLocalError(cause instanceof Error ? cause.message : String(cause));
      setNotice(copy.instantMcpToolsHandlerStub);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // Load once when the Managed App surface mounts; later refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusText = handlerReady ? copy.instantMcpToolsConnected : copy.instantMcpToolsInProcessStatus;

  return (
    <section
      className="original-ui-surface instant-mcp-tools-surface"
      data-managed-app="instant-mcp-tools"
      data-no-listen-port="true"
      data-start="false"
      data-tool={INSTANT_MCP_TOOLS_MODULE_ID}
      data-transport="in-process"
    >
      <header className="original-ui-hostbar">
        <strong>{copy.instantMcpTools}</strong>
        <span className={`original-ui-status ${handlerReady ? "status-ready" : "status-offline"}`}>
          {statusText}
        </span>
        <em className="instant-mcp-tools-transport">{copy.inProcessAppsTransport}</em>
        <div className="original-ui-hostbar-actions">
          <button className="primary" disabled={busy} onClick={() => void refresh()} type="button">
            {busy ? copy.running : copy.refreshTools}
          </button>
        </div>
      </header>
      {notice ? <p className="original-ui-note">{notice}</p> : null}
      {localError ? <p className="original-ui-error">{localError}</p> : null}
      {!handlerReady ? (
        <p className="original-ui-note instant-mcp-tools-stub" data-handler-lane="Bot GG">
          {copy.instantMcpToolsHandlerStub}
          {" "}
          <code>{INSTANT_MCP_TOOLS_MODULE_ID}</code>
          {" · "}
          {INSTANT_MCP_TOOLS_OPERATIONS.join(", ")}
        </p>
      ) : null}
      {listedIds.length > 0 ? (
        <p className="instant-mcp-tools-listed" data-apps-list="true">
          <code>apps_list</code>
          <span>{listedIds.join(" · ")}</span>
        </p>
      ) : null}
      <div className="original-ui-frame-shell is-native instant-mcp-tools-embed">
        <McpLiveToolsPanel copy={copy} language={language} setError={setError} />
        <InProcessAppsPanel copy={copy} language={language} setError={setError} />
      </div>
    </section>
  );
}
