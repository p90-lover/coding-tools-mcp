import { useEffect, useState } from "react";
import type { JsonObject } from "../api/contracts";
import "./original-ui.css";

export function RegisterSurface() {
  const [url, setUrl] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(operation: string) {
    const apps = window.codingTools?.apps;
    if (!apps?.call) throw new Error("Coding Tools apps API is unavailable");
    const response = await apps.call({ moduleId: "reg-machine", operation, arguments: {} });
    const envelope = response as JsonObject;
    const result = (envelope.result ?? envelope) as JsonObject;
    if (result.ok === false) throw new Error(String(result.reason ?? result.error ?? "Register is unavailable"));
    return result;
  }

  async function open() {
    setBusy(true);
    setError("");
    try {
      const result = await run("ui-open");
      if (result.url !== "coding-tools-register://app/") throw new Error("Invalid Register visual address");
      setUrl(result.url);
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  useEffect(() => { void open(); }, []);

  return (
    <section className="original-ui-surface" data-tool="reg-machine">
      <header className="original-ui-hostbar">
        <strong>Register</strong>
        <span className={`original-ui-status status-${url ? "ready" : "offline"}`}>{url ? "Connected" : "Offline"}</span>
        <div className="original-ui-hostbar-actions">
          <button type="button" disabled={busy} onClick={() => void open()}>{busy ? "Starting…" : url ? "Reload visual" : "Start Register"}</button>
          <button type="button" disabled={busy || !url} onClick={() => {
            setBusy(true);
            void run("stop").then(() => setUrl("")).catch((cause) => setError(String(cause))).finally(() => setBusy(false));
          }}>Stop</button>
        </div>
      </header>
      {error ? <p className="original-ui-error" role="alert">{error}</p> : null}
      <div className="original-ui-frame-shell">
        {url ? <iframe key={revision} src={url} title="Register hosted in Coding Tools" referrerPolicy="no-referrer"
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts" />
          : <div className="original-ui-frame-empty"><strong>Register</strong><span>{busy ? "Starting the bundled registration app…" : "Start Register to use its accounts, tasks, authenticator and settings."}</span></div>}
      </div>
    </section>
  );
}
