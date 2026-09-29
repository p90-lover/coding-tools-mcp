import { useCallback, useEffect, useState } from "react";
import type { Copy } from "../i18n";
import type { KeysmithCommandResult, KeysmithSelectedFile, LauncherApi } from "../types";

export function KeysmithSetupPanel({ api, copy, onInstalledChange }: {
  api: LauncherApi;
  copy: Copy;
  onInstalledChange: (installed: boolean) => void;
}) {
  const [status, setStatus] = useState<KeysmithCommandResult | null>(null);
  const [file, setFile] = useState<KeysmithSelectedFile | null>(null);
  const [preview, setPreview] = useState<KeysmithCommandResult | null>(null);
  const [removalPreview, setRemovalPreview] = useState<KeysmithCommandResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const next = await api.keysmithStatus();
    setStatus(next);
    onInstalledChange(next.ok && next.managedByCodingTools === true && next.state === "active");
    if (!next.ok) setError(next.error || copy.failed);
    return next;
  }, [api, copy.failed, onInstalledChange]);

  useEffect(() => {
    let active = true;
    void api.keysmithStatus().then((next) => {
      if (!active) return;
      setStatus(next);
      onInstalledChange(next.ok && next.managedByCodingTools === true && next.state === "active");
      if (!next.ok) setError(next.error || copy.failed);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : copy.failed);
    });
    return () => { active = false; };
  }, [api, copy.failed, onInstalledChange]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : copy.failed); }
    finally { setBusy(false); }
  };

  const statusText = !status ? copy.loading
    : !status.ok ? copy.failed
      : status.managedByCodingTools && status.state === "active" ? copy.done
        : status.installed ? copy.keysmithManagedOther : copy.keysmithNotInstalled;
  const plannedText = removalPreview?.stdout || preview?.stdout || null;

  return (
    <section aria-busy={busy} aria-label={copy.keysmithStep} className="keysmith-panel">
      <div className="keysmith-status">
        <strong>{copy.keysmithStatus}</strong>
        <span>{statusText}</span>
        {status?.pythonVersion ? <small>Python {status.pythonVersion}</small> : null}
      </div>
      <div className="keysmith-actions">
        <button className="button-secondary" disabled={busy} onClick={() => void run(async () => {
          const selected = await api.keysmithSelectFile();
          if (!selected) return;
          setFile(selected);
          setPreview(null);
          setRemovalPreview(null);
        })} type="button">{copy.keysmithChooseFile}</button>
        <button className="button-secondary" disabled={busy || !file || status?.ok === false} onClick={() => void run(async () => {
          const result = await api.keysmithPreview();
          if (!result.ok) { setError(result.error || copy.failed); return; }
          setPreview(result);
          setRemovalPreview(null);
        })} type="button">{copy.keysmithPreview}</button>
        <button className="button-secondary" disabled={busy || !preview?.ok} onClick={() => void run(async () => {
          const result = await api.keysmithApply();
          if (result.cancelled) return;
          if (!result.ok) { setError(result.error || copy.failed); return; }
          setPreview(null);
          const verified = await refreshStatus();
          if (verified.ok && verified.managedByCodingTools && verified.state === "active") {
            setNotice(copy.keysmithNewChats);
          } else setError(copy.failed);
        })} type="button">{copy.keysmithApply}</button>
      </div>
      {file ? (
        <div className="keysmith-file">
          <strong title={file.path}>{file.name}</strong>
          <pre aria-label={copy.keysmithChooseFile} tabIndex={0}>{file.content}</pre>
        </div>
      ) : <p className="keysmith-hint">{copy.keysmithNoFile}</p>}
      {status?.managedByCodingTools ? (
        <div className="keysmith-actions">
          <button className="button-secondary" disabled={busy} onClick={() => void run(async () => {
            const result = await api.keysmithPreviewRemoval();
            if (!result.ok) { setError(result.error || copy.failed); return; }
            setRemovalPreview(result);
            setPreview(null);
          })} type="button">{copy.keysmithPreviewRemoval}</button>
          <button className="button-secondary keysmith-remove" disabled={busy || !removalPreview?.ok} onClick={() => void run(async () => {
            const result = await api.keysmithRemove();
            if (result.cancelled) return;
            if (!result.ok) { setError(result.error || copy.failed); return; }
            setRemovalPreview(null);
            const verified = await refreshStatus();
            if (!verified.ok || verified.managedByCodingTools) setError(copy.failed);
            else setNotice(copy.done);
          })} type="button">{copy.keysmithRemove}</button>
        </div>
      ) : null}
      {plannedText ? <pre aria-label={removalPreview ? copy.keysmithPreviewRemoval : copy.keysmithPreview} className="keysmith-preview" tabIndex={0}>{plannedText}</pre> : null}
      {error ? <p className="keysmith-error" role="alert">{error}</p> : null}
      {notice ? <p aria-live="polite" className="keysmith-notice">{notice}</p> : null}
    </section>
  );
}
