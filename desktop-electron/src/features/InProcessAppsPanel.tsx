import { useEffect, useMemo, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import type { AppsModuleId, JsonObject } from "../api/contracts";
import type { Copy } from "../i18n";
import type { Language } from "../types";

interface InProcessAppsPanelProps {
  copy: Copy;
  language: Language;
  setError: (error: string | null) => void;
}

interface ModuleEntry {
  id: string;
  name: string;
  transport?: string;
  operations: string[];
}

const MCP_TOOL_NAMES = ["apps_list", "apps_catalog", "apps_call", "apps_invoke", "apps_status"] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function moduleEntries(payload: Record<string, unknown>): ModuleEntry[] {
  const raw = Array.isArray(payload.modules) ? payload.modules : [];
  return raw.flatMap((entry) => {
    const record = asRecord(entry);
    const id = typeof record.id === "string" ? record.id : "";
    if (!id) return [];
    const operations = Array.isArray(record.operations)
      ? record.operations.filter((name): name is string => typeof name === "string")
      : [];
    return [{
      id,
      name: typeof record.name === "string" && record.name.trim() ? record.name : id,
      transport: typeof record.transport === "string" ? record.transport : "in-process",
      operations,
    }];
  });
}

export function InProcessAppsPanel({ copy, language, setError }: InProcessAppsPanelProps) {
  const [modules, setModules] = useState<ModuleEntry[]>([]);
  const [moduleId, setModuleId] = useState("");
  const [operation, setOperation] = useState("inspect");
  const [argumentsText, setArgumentsText] = useState("{}");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const selected = useMemo(
    () => modules.find((item) => item.id === moduleId) ?? null,
    [moduleId, modules],
  );

  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    try {
      const client = getCodingToolsClient();
      const listed = asRecord(await client.apps.list());
      const nextModules = moduleEntries(listed);
      setModules(nextModules);
      const nextId = nextModules.some((item) => item.id === moduleId)
        ? moduleId
        : nextModules[0]?.id ?? "";
      setModuleId(nextId);
      const nextSelected = nextModules.find((item) => item.id === nextId);
      setOperation((current) => {
        if (nextSelected?.operations.includes(current)) return current;
        return nextSelected?.operations.includes("inspect") ? "inspect" : nextSelected?.operations[0] ?? "inspect";
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void refresh();
    // Load once when the MCP surface mounts; later refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCall = async (mode: "call" | "invoke") => {
    if (!moduleId || !operation || busy) return;
    setBusy(mode);
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
      const client = getCodingToolsClient();
      const response = mode === "invoke"
        ? await client.apps.invoke({
          handle: moduleId as AppsModuleId,
          operation,
          arguments: parsed,
        })
        : await client.apps.call({
          moduleId: moduleId as AppsModuleId,
          operation,
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
    <section className="mcp-live-tools in-process-apps" aria-label={copy.inProcessApps}>
      <div className="section-heading">
        <span>{copy.inProcessApps}</span>
        <button className="button-secondary" disabled={busy !== null} onClick={() => void refresh()} type="button">
          {busy === "refresh" ? copy.running : copy.refreshTools}
        </button>
      </div>
      <p>{copy.inProcessAppsBody}</p>
      <p className="in-process-apps-tools">
        {MCP_TOOL_NAMES.map((name) => <code key={name}>{name}</code>)}
      </p>
      {modules.length === 0 ? (
        <div className="surface-empty">
          <span>{copy.inProcessAppsNoModules}</span>
        </div>
      ) : (
        <>
          <ul className="in-process-apps-list">
            {modules.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong>
                <code>{item.id}</code>
                <em>{item.transport || copy.inProcessAppsTransport}</em>
              </li>
            ))}
          </ul>
          <div className="field-list mcp-live-fields">
            <label className="field-row">
              <span>{copy.selectModule}</span>
              <select
                aria-label={copy.selectModule}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setModuleId(nextId);
                  const nextSelected = modules.find((item) => item.id === nextId);
                  setOperation(nextSelected?.operations.includes("inspect")
                    ? "inspect"
                    : nextSelected?.operations[0] ?? "inspect");
                }}
                value={moduleId}
              >
                {modules.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <label className="field-row">
              <span>{copy.selectOperation}</span>
              <select
                aria-label={copy.selectOperation}
                onChange={(event) => setOperation(event.target.value)}
                value={operation}
              >
                {(selected?.operations.length ? selected.operations : ["inspect"]).map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
            <label className="field-row is-stacked">
              <span>{copy.toolArguments}</span>
              <textarea
                aria-label={copy.toolArguments}
                onChange={(event) => setArgumentsText(event.target.value)}
                rows={4}
                spellCheck={false}
                value={argumentsText}
              />
            </label>
          </div>
        </>
      )}
      <div className="inline-actions">
        <button
          className="button-primary"
          disabled={busy !== null || !moduleId || !operation}
          onClick={() => void runCall("call")}
          type="button"
        >
          {busy === "call" ? copy.running : copy.inProcessAppsCall}
        </button>
        <button
          className="button-secondary"
          disabled={busy !== null || !moduleId || !operation}
          onClick={() => void runCall("invoke")}
          type="button"
        >
          {busy === "invoke" ? copy.running : copy.inProcessAppsInvoke}
        </button>
      </div>
      {result ? (
        <pre className="mcp-live-result" tabIndex={0}>{result}</pre>
      ) : null}
    </section>
  );
}
