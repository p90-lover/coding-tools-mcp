import { useEffect, useRef, useState } from "react";
import type { Language, OperationState } from "./types";
import "./chrome-login-notice.css";

/** The legacy operation id also serves ordinary Chrome sign-in on Windows. */
export function chromeLoginPending(operation: OperationState | null, authenticated?: boolean): boolean {
  return (operation?.name === "passkey-login" || operation?.name === "chrome-profile-login") && operation.status === "running" && authenticated !== true;
}

export function chromeLoginWaitingForClose(operation: OperationState | null): boolean {
  return operation?.name === "passkey-login" && operation.status === "running"
    && operation.message === "Waiting for the dedicated Chrome window to close before importing";
}

export function chromeLoginContinuationPending(operation: OperationState | null): boolean {
  return chromeLoginWaitingForClose(operation) || (operation?.name === "passkey-login" && operation.status === "running"
    && /^Capturing and verifying the (?:passkey|Chrome) session$/.test(operation.message));
}

/** Keep the explicit Continue step reachable while the person works outside the Browser page. */
export function ChromeLoginNotice({ open, operation, language, continueLogin, openBrowser, setError, openChrome, installConnector, cancelLogin }: {
  open: boolean; operation: OperationState | null; language: Language;
  continueLogin: () => Promise<boolean>; openBrowser: () => void; setError: (error: string | null) => void;
  openChrome?: () => Promise<boolean>; installConnector?: () => Promise<boolean>; cancelLogin?: () => Promise<boolean>;
}) {
  const [requested, setRequested] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!open) { inFlight.current = false; setRequested(false); }
  }, [open]);
  if (!open) return null;
  const zh = language !== "en";
  if (operation?.name === "chrome-profile-login") {
    const verifying = operation.message === "Verifying the ChatGPT session from your Chrome profile";
    const act = (action?: () => Promise<boolean>) => { if (action) { setError(null); void action().catch(error => setError(error instanceof Error ? error.message : String(error))); } };
    return <section className="chrome-login-notice" role="status" aria-live="polite">
      <span><strong>{zh ? "使用目前的 Chrome 設定檔登入" : "Sign in with your Chrome profile"}</strong>
        {verifying ? zh ? "正在獨立驗證登入…" : "Independently verifying sign-in…" : <>
          {zh ? "首次使用請安裝連接器（chrome://extensions → 載入未封裝項目），核對並批准配對碼，再登入 ChatGPT。驗證會自動完成；不用關閉 Chrome 或按繼續。" : "Install the connector once (chrome://extensions → Load unpacked), approve the matching pairing code, then sign in to ChatGPT. Verification is automatic; no need to close Chrome or press Continue."}
          <br />{operation.message}
        </>}</span>
      <div className="chrome-login-actions">
        <button type="button" disabled={verifying || !openChrome} onClick={() => act(openChrome)}>{zh ? "開啟 Chrome" : "Open Chrome"}</button>
        <button type="button" disabled={verifying || !installConnector} onClick={() => act(installConnector)}>{zh ? "安裝連接器" : "Install connector"}</button>
        <button type="button" disabled={!cancelLogin} onClick={() => act(cancelLogin)}>{zh ? "取消" : "Cancel"}</button>
      </div>
    </section>;
  }
  const waitingForClose = chromeLoginWaitingForClose(operation);
  const importing = requested || chromeLoginContinuationPending(operation);
  const proceed = async () => {
    if (inFlight.current || importing) return;
    inFlight.current = true; setRequested(true); setError(null);
    try { await continueLogin(); }
    catch (error) { inFlight.current = false; setRequested(false); setError(error instanceof Error ? error.message : String(error)); }
  };
  return <section className="chrome-login-notice" role="status" aria-live="polite">
    <span><strong>{zh ? "完成 Chrome 登入" : "Finish Chrome sign-in"}</strong>
      {waitingForClose
        ? zh ? "已收到繼續要求。請關閉專用 Chrome 登入視窗，關閉後將開始匯入；不必再次按繼續。" : "Continue received. Close the dedicated Chrome window to start importing; no need to choose Continue again."
        : zh ? "請在專用 Chrome 視窗中登入 ChatGPT，關閉該視窗，再按「繼續」。" : "Sign in to ChatGPT in the dedicated Chrome window, close that window, then choose Continue."}</span>
    <div className="chrome-login-actions">
      <button type="button" disabled={importing} onClick={() => void proceed()}>{waitingForClose
        ? zh ? "等待關閉 Chrome…" : "Waiting for Chrome to close…"
        : importing ? zh ? "正在驗證登入…" : "Verifying sign-in…"
        : zh ? "繼續" : "Continue"}</button>
      <button type="button" onClick={openBrowser}>{zh ? "開啟瀏覽器頁面" : "Open Browser"}</button>
    </div>
  </section>;
}
