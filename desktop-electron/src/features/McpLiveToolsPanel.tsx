import { useEffect, useMemo, useState } from "react";
import { getCodingToolsClient } from "../api/client";
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

  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    try {
      const client = getCodingToolsClient();
      const page = await client.workspaces.list({ cursor: 0, limit: 50 });
      const items = page.items;
      setWorkspaces([...items]);
      const nextWorkspace = items.some((item) => item.id === workspaceId)
        ? workspaceId
        : items[0]?.id ?? "";
      setWorkspaceId(nextWorkspace);
      if (!nextWorkspace) {
        setTools([]);
        setTool("");
        return;
      }
      const catalog = await client.tools.catalog({ workspaceId: nextWorkspace });
      const nextTools = toolEntries(asRecord(catalog));
      setTools(nextTools);
      setTool((current) => nextTools.some((item) => item.name === current) ? current : nextTools[0]?.name ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
    // Quiet reconnect while the MCP surface stays mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runTool = async () => {
    if (!workspaceId || !tool || busy) return;
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
      const response = await getCodingToolsClient().tools.call({
        workspaceId,
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
    <section className="mcp-live-tools" aria-label={copy.liveMcpTools}>
      <div className="section-heading">
        <span>{copy.liveMcpTools}</span>
        <button className="button-secondary" disabled={busy !== null} onClick={() => void refresh()} type="button">
          {busy === "refresh" ? copy.running : copy.refreshTools}
        </button>
      </div>
      <p>{copy.liveMcpToolsBody}</p>
      {workspaces.length === 0 ? (
        <div className="surface-empty">
          <span>{copy.noWorkspaces}</span>
        </div>
      ) : (
        <div className="field-list mcp-live-fields">
          <label className="field-row">
            <span>{copy.selectWorkspace}</span>
            <select
              aria-label={copy.selectWorkspace}
              onChange={(event) => {
                setWorkspaceId(event.target.value);
                void (async () => {
                  setBusy("refresh");
                  try {
                    const catalog = await getCodingToolsClient().tools.catalog({ workspaceId: event.target.value });
                    const nextTools = toolEntries(asRecord(catalog));
                    setTools(nextTools);
                    setTool(nextTools[0]?.name ?? "");
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
          disabled={busy !== null || !workspaceId || !tool}
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
