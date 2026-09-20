import { useEffect, useMemo, useState } from "react";
import {
  INSTANT_MCP_TOOLS_MODULE_ID,
  callInstantMcpTools,
} from "../api/instant-mcp-tools-contract";
import type { JsonObject, WorkspaceSummary } from "../api/contracts";
import type { Copy } from "../i18n";
import type { Language } from "../types";

interface McpLiveToolsPanelProps {
  copy: Copy;
  language: Language;
  setError: (error: string | null) => void;
}

interface CatalogTool {
  name: string;
  description?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toolEntries(catalog: Record<string, unknown>): CatalogTool[] {
  const raw = Array.isArray(catalog.tools) ? catalog.tools : [];
  return raw.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [{ name: entry }];
    const record = asRecord(entry);
    const name = typeof record.name === "string" ? record.name
      : typeof record.tool === "string" ? record.tool
        : "";
    if (!name) return [];
    return [{
      name,
      description: typeof record.description === "string" ? record.description : undefined,
    }];
  });
}

function workspaceEntries(payload: Record<string, unknown>): WorkspaceSummary[] {
  const raw = Array.isArray(payload.items) ? payload.items : [];
  return raw.flatMap((entry) => {
    const record = asRecord(entry);
    const id = typeof record.id === "string" ? record.id : "";
    const name = typeof record.name === "string" ? record.name : id;
    const pathValue = typeof record.path === "string" ? record.path : "";
    if (!id || !pathValue) return [];
    const mcpState = record.mcpState;
    return [{
      id,
      name: name || id,
      path: pathValue,
      mcpState: mcpState === "starting" || mcpState === "running" || mcpState === "stopping" || mcpState === "error"
        ? mcpState
        : "stopped",
      policyRevision: Number.isInteger(record.policyRevision) ? Number(record.policyRevision) : 0,
    }];
  });
}

export function McpLiveToolsPanel({ copy, language, setError }: McpLiveToolsPanelProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [tools, setTools] = useState<CatalogTool[]>([]);
  const [tool, setTool] = useState("");
  const [argumentsText, setArgumentsText] = useState("{}");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const selectedWorkspace = useMemo(
    () => workspaces.find((item) => item.id === workspaceId) ?? null,
    [workspaceId, workspaces],
  );

  const loadTools = async (nextWorkspace: string) => {
    // Primary op: listTools. Kebab alias list-tools is accepted by callInstantMcpTools.
    const catalog = await callInstantMcpTools("listTools", nextWorkspace ? { workspaceId: nextWorkspace } : {});
    const nextTools = toolEntries(catalog);
    setTools(nextTools);
    setTool((current) => nextTools.some((item) => item.name === current) ? current : nextTools[0]?.name ?? "");
  };

  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    try {
      const listed = await callInstantMcpTools("listWorkspaces");
      const items = workspaceEntries(listed);
      setWorkspaces([...items]);
      const nextWorkspace = items.some((item) => item.id === workspaceId)
        ? workspaceId
        : items[0]?.id ?? "";
      setWorkspaceId(nextWorkspace);
      await loadTools(nextWorkspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void refresh();
    // Load once when the Instant MCP Tools surface mounts; later refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runTool = async () => {
    if (!tool || busy) return;
    setBusy("call");
    setError(null);
    try {
      let parsed: JsonObject = {};
      if (argumentsText.trim()) {
        const value = JSON.parse(argumentsText) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error(language === "zh-TW" ? "參數必須是 JSON 物件。" : "Arguments must be a JSON object.");
        }
        parsed = value as JsonObject;
      }
      // Primary op: runTool. Kebab alias run-tool is accepted by callInstantMcpTools.
      const response = await callInstantMcpTools("runTool", {
        ...(workspaceId ? { workspaceId } : {}),
        tool,
        arguments: parsed,
      });
      setResult(JSON.stringify(response, null, 2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mcp-live-tools" aria-label={copy.liveMcpTools} data-module={INSTANT_MCP_TOOLS_MODULE_ID}>
      <div className="section-heading">
        <span>{copy.liveMcpTools}</span>
        <button className="button-secondary" disabled={busy !== null} onClick={() => void refresh()} type="button">
          {busy === "refresh" ? copy.running : copy.refreshTools}
        </button>
      </div>
      <p>{copy.liveMcpToolsBody}</p>
      {workspaces.length === 0 && tools.length === 0 ? (
        <div className="surface-empty">
          <span>{copy.noWorkspaces}</span>
        </div>
      ) : (
        <div className="field-list mcp-live-fields">
          {workspaces.length > 0 ? (
            <label className="field-row">
              <span>{copy.selectWorkspace}</span>
              <select
                aria-label={copy.selectWorkspace}
                onChange={(event) => {
                  setWorkspaceId(event.target.value);
                  void (async () => {
                    setBusy("refresh");
                    try {
                      await loadTools(event.target.value);
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : String(cause));
                    } finally {
                      setBusy(null);
                    }
                  })();
                }}
                value={workspaceId}
              >
                {workspaces.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field-row">
            <span>{copy.selectTool}</span>
            <select aria-label={copy.selectTool} onChange={(event) => setTool(event.target.value)} value={tool}>
              {tools.map((item) => (
                <option key={item.name} value={item.name}>{item.name}</option>
              ))}
            </select>
          </label>
          <label className="field-row is-stacked">
            <span>{copy.toolArguments}</span>
            <textarea
              aria-label={copy.toolArguments}
              onChange={(event) => setArgumentsText(event.target.value)}
              rows={5}
              spellCheck={false}
              value={argumentsText}
            />
          </label>
        </div>
      )}
      {selectedWorkspace ? (
        <p className="mcp-live-meta">
          <code>{selectedWorkspace.path}</code>
          <em>{selectedWorkspace.mcpState}</em>
        </p>
      ) : null}
      <div className="inline-actions">
        <button
          className="button-primary"
          disabled={busy !== null || !tool}
          onClick={() => void runTool()}
          type="button"
        >
          {busy === "call" ? copy.running : copy.runTool}
        </button>
      </div>
      {result ? (
        <pre className="mcp-live-result" tabIndex={0}>{result}</pre>
      ) : null}
    </section>
  );
}
