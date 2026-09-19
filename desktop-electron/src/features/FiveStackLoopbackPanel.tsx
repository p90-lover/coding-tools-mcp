import { useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import type { Copy } from "../i18n";
import type { ExternalServiceId, Language } from "../types";

interface FiveStackLoopbackPanelProps {
  copy: Copy;
  language: Language;
  setError: (error: string | null) => void;
}

interface LoopbackStack {
  id: string;
  name: string;
  origin: string;
  port: number;
  listening: boolean;
  fallbackUsed?: boolean;
  probeUrl?: string;
  statusCode?: number | null;
  error?: string | null;
  preview?: string;
  execution?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stacksFrom(payload: unknown): LoopbackStack[] {
  const health = asRecord(asRecord(payload).health);
  const raw = Array.isArray(health.stacks) ? health.stacks : [];
  return raw.flatMap((entry) => {
    const record = asRecord(entry);
    const id = typeof record.id === "string" ? record.id : "";
    if (!id) return [];
    return [{
      id,
      name: typeof record.name === "string" ? record.name : id,
      origin: typeof record.origin === "string" ? record.origin : "",
      port: typeof record.port === "number" ? record.port : 0,
      listening: record.listening === true,
      fallbackUsed: record.fallbackUsed === true,
      probeUrl: typeof record.probeUrl === "string" ? record.probeUrl : undefined,
      statusCode: typeof record.statusCode === "number" ? record.statusCode : null,
      error: typeof record.error === "string" ? record.error : null,
      preview: typeof record.preview === "string" ? record.preview : undefined,
      execution: typeof record.execution === "string" ? record.execution : undefined,
    }];
  });
}

export function FiveStackLoopbackPanel({ copy, language, setError }: FiveStackLoopbackPanelProps) {
  const [stacks, setStacks] = useState<LoopbackStack[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    setBusy((current) => current ?? "refresh");
    setError(null);
    try {
      const snapshot = await getCodingToolsClient().integrations.snapshot();
      setStacks(stacksFrom(snapshot));
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

  const start = async (stackId: string) => {
    if (busy) return;
    setBusy(`start:${stackId}`);
    setError(null);
    try {
      const api = window.codexWebLauncher;
      if (api?.startExternalService) {
        await api.startExternalService(stackId as ExternalServiceId);
      } else {
        await getCodingToolsClient().tools.call({
          workspaceId: "loopback",
          tool: "five_stack_start",
          arguments: { stack: stackId },
        });
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
    }
  };

  return (
    <section className="five-stack-loopbacks" aria-label={copy.fiveStackLoopbacks}>
      <div className="section-heading">
        <span>{copy.fiveStackLoopbacks}</span>
        <button className="button-secondary" disabled={busy !== null} onClick={() => void refresh()} type="button">
          {busy === "refresh" ? copy.running : copy.refreshTools}
        </button>
      </div>
      <p>{copy.fiveStackLoopbacksBody}</p>
      <div className="five-stack-loopback-grid">
        {stacks.map((stack) => (
          <article className={`five-stack-loopback-card${stack.listening ? " is-listening" : ""}`} key={stack.id}>
            <header>
              <strong>{stack.name}</strong>
              <em>{stack.listening
                ? (stack.fallbackUsed ? copy.fiveStackFallback : copy.fiveStackListening)
                : copy.fiveStackOffline}</em>
            </header>
            <code>{stack.origin || `127.0.0.1:${stack.port}`}</code>
            {stack.preview ? <small>{stack.preview}</small> : null}
            {stack.execution ? <small>{stack.execution}</small> : null}
            <button
              className="button-primary"
              disabled={busy !== null}
              onClick={() => void start(stack.id)}
              type="button"
            >
              {busy === `start:${stack.id}` ? copy.running : copy.fiveStackStart}
            </button>
          </article>
        ))}
      </div>
      {stacks.length === 0 && busy === null ? (
        <p className="five-stack-loopback-empty">
          {language === "zh-TW" || language === "zh-CN"
            ? "尚未取得 loopback 狀態。按重新整理以探測本機端口。"
            : "Loopback status is not available yet. Refresh to probe the local ports."}
        </p>
      ) : null}
    </section>
  );
}
