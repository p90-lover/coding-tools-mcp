import { useEffect, useRef, useState } from "react";
import type { Language, OperationState } from "./types";
import "./chrome-login-notice.css";

/** The legacy operation id also serves ordinary Chrome sign-in on Windows. */
export function chromeLoginPending(operation: OperationState | null, authenticated?: boolean): boolean {
  return operation?.name === "passkey-login" && operation.status === "running" && authenticated !== true;
}

/** Keep the explicit Continue step reachable while the person works outside the Browser page. */
export function ChromeLoginNotice({ open, operation, language, continueLogin, openBrowser, setError }: {
  open: boolean; operation: OperationState | null; language: Language;
  continueLogin: () => Promise<boolean>; openBrowser: () => void; setError: (error: string | null) => void;
}) {
  const [requested, setRequested] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!open) { inFlight.current = false; setRequested(false); }
  }, [open]);
  if (!open) return null;
  const zh = language !== "en";
  const importing = requested || /^Capturing and verifying the (?:passkey|Chrome) session$/.test(operation?.message ?? "");
  const proceed = async () => {
    if (inFlight.current || importing) return;
    inFlight.current = true; setRequested(true); setError(null);
    try { await continueLogin(); }
    catch (error) { inFlight.current = false; setRequested(false); setError(error instanceof Error ? error.message : String(error)); }
  };
  return <section className="chrome-login-notice" role="status" aria-live="polite">
    <span><strong>{zh ? "完成 Chrome 登入" : "Finish Chrome sign-in"}</strong>
      {zh ? "請在專用 Chrome 視窗中登入 ChatGPT，關閉該視窗，再按「繼續」。" : "Sign in to ChatGPT in the dedicated Chrome window, close that window, then choose Continue."}</span>
    <div className="chrome-login-actions">
      <button type="button" disabled={importing} onClick={() => void proceed()}>{importing
        ? zh ? "正在驗證登入…" : "Verifying sign-in…"
        : zh ? "繼續" : "Continue"}</button>
      <button type="button" onClick={openBrowser}>{zh ? "開啟瀏覽器頁面" : "Open Browser"}</button>
    </div>
  </section>;
}
