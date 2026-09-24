import { useEffect, useMemo, useState } from "react";
import type { JsonObject } from "../api/contracts";
import type { Language, ProviderAccountRecord, ProviderNetworkSnapshot } from "../types";
import {
  messageOf,
  object,
  workspaceOptions,
  type WorkspaceOption,
} from "./execution-surface-utils";
import "./orchestration-control.css";

function usable(snapshot: ProviderNetworkSnapshot | null): ProviderAccountRecord[] {
  return (snapshot?.accounts ?? []).filter((account) => (
    account.enabled && account.status === "connected" && !account.archivedAt
  ));
}

function localize(language: Language, english: string, traditionalChinese: string): string {
  return language === "zh-TW" || language === "zh-CN" ? traditionalChinese : english;
}

export function RuntimeTaskSurface({
  language,
  setError,
}: {
  language: Language;
  setError: (error: string | null) => void;
}) {
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [network, setNetwork] = useState<ProviderNetworkSnapshot | null>(null);
  const [brief, setBrief] = useState("");
  const [orchestratorId, setOrchestratorId] = useState("");
  const [workerIds, setWorkerIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<JsonObject | null>(null);

  const accounts = useMemo(() => usable(network), [network]);
  const orchestrator = accounts.find((account) => account.id === orchestratorId) ?? accounts[0];
  const workers = accounts.filter((account) => workerIds.includes(account.id));

  useEffect(() => {
    const launcher = window.codexWebLauncher;
    const codingTools = window.codingTools;
    if (!launcher || !codingTools) return;
    let cancelled = false;
    void Promise.all([launcher.providerSnapshot(), codingTools.workspaces.list({})])
      .then(([snapshot, page]) => {
        if (cancelled) return;
        setNetwork(snapshot);
        const options = workspaceOptions(page);
        setWorkspaces(options);
        setWorkspaceId(options[0]?.id ?? "");
      })
      .catch((cause) => setError(messageOf(cause)));
    const unsubscribe = launcher.onProviderNetworkChanged(setNetwork);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setError]);

  useEffect(() => {
    if (!accounts.length) return;
    setOrchestratorId((current) => (
      accounts.some((account) => account.id === current) ? current : accounts[0].id
    ));
    setWorkerIds((current) => {
      const valid = current.filter((id) => accounts.some((account) => account.id === id));
      if (valid.length) return valid;
      const fallback = accounts.find((account) => account.id !== accounts[0].id) ?? accounts[0];
      return fallback ? [fallback.id] : [];
    });
  }, [accounts]);

  const openTask = async () => {
    const api = window.codingTools;
    if (!api) throw new Error(localize(language, "Runtime tools are unavailable.", "執行環境工具無法使用。"));
    if (!workspaceId) throw new Error(localize(language, "Choose a workspace.", "請選擇工作區。"));
    if (!brief.trim()) throw new Error(localize(language, "Enter a task brief.", "請輸入任務說明。"));
    if (!orchestrator) throw new Error(localize(language, "Choose an orchestrator account.", "請選擇協調器帳戶。"));
    if (!workers.length) throw new Error(localize(language, "Assign at least one worker.", "請至少指派一個工作代理。"));
    setBusy(true);
    setError(null);
    try {
      const next = await api.tools.call({
        workspaceId,
        tool: "runtime_open_task",
        arguments: {
          brief: brief.trim(),
          orchestrator: {
            providerId: orchestrator.providerId,
            accountId: orchestrator.id,
            model: orchestrator.models[0],
          },
          workers: workers.map((account, index) => ({
            role: `worker-${index + 1}`,
            providerId: account.providerId,
            accountId: account.id,
            model: account.models[0],
          })),
        },
      }) as JsonObject;
      setResult(next);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const response = typeof result?.response === "string" ? result.response : "";
  const awaiting = result?.awaitingWorkers === true;

  return (
    <section className="control-surface runtime-task-surface">
      <header className="control-heading">
        <div>
          <span className="surface-kicker">{localize(language, "RUNTIME", "執行環境")}</span>
          <h1>{localize(language, "Open task", "開啟任務")}</h1>
          <p>
            {localize(
              language,
              "Web GPT uses runtime_open_task on this tab. The selected orchestrator assigns workers; worker responses return to the ChatGPT Web model.",
              "Web GPT 會在此分頁使用 runtime_open_task。選定的協調器會指派工作代理，工作代理回傳後再交還 ChatGPT Web 模型。",
            )}
          </p>
        </div>
      </header>

      <div className="control-grid two-column">
        <section className="control-card">
          <label>
            <span>{localize(language, "Workspace", "工作區")}</span>
            <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              <option value="">{localize(language, "Select workspace", "選擇工作區")}</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{localize(language, "Orchestrator", "協調器")}</span>
            <select value={orchestrator?.id ?? ""} onChange={(event) => setOrchestratorId(event.target.value)}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{account.label} · {account.providerId}</option>
              ))}
            </select>
          </label>
          <fieldset className="runtime-worker-fieldset">
            <legend>{localize(language, "Workers", "工作代理")}</legend>
            {accounts.map((account) => {
              const checked = workerIds.includes(account.id);
              return (
                <label className="provider-check-row" key={account.id}>
                  <input
                    checked={checked}
                    onChange={() => setWorkerIds((current) => (
                      checked ? current.filter((id) => id !== account.id) : [...current, account.id]
                    ))}
                    type="checkbox"
                  />
                  <span>{account.label} · {account.providerId}</span>
                </label>
              );
            })}
          </fieldset>
          <label className="provider-full-row">
            <span>{localize(language, "Task brief", "任務說明")}</span>
            <textarea
              onChange={(event) => setBrief(event.target.value)}
              rows={6}
              value={brief}
            />
          </label>
          <button
            className="secondary-button"
            disabled={busy || !brief.trim() || !workers.length}
            onClick={() => void openTask().catch((cause) => setError(messageOf(cause)))}
            type="button"
          >
            {busy
              ? localize(language, "Opening task…", "正在開啟任務…")
              : localize(language, "Open task", "開啟任務")}
          </button>
        </section>

        <section className="control-card">
          <h2>{localize(language, "Web GPT response", "Web GPT 回傳")}</h2>
          {result ? (
            <>
              <p>
                {awaiting
                  ? localize(
                    language,
                    "Workers are still running. Their summaries return here and through runtime_open_task once submitted.",
                    "工作代理仍在執行。完成並提交後，摘要會顯示在這裡，並透過 runtime_open_task 回傳。",
                  )
                  : localize(language, "Workers returned. This payload is what Web GPT receives.", "工作代理已回傳。這就是 Web GPT 收到的內容。")}
              </p>
              <pre>{response || JSON.stringify({
                taskId: result.taskId,
                runId: result.runId,
                status: result.status,
                workers: object(result)?.workers,
              }, null, 2)}</pre>
            </>
          ) : (
            <p>{localize(language, "Open a task to dispatch workers.", "開啟任務後會分派工作代理。")}</p>
          )}
        </section>
      </div>
    </section>
  );
}
