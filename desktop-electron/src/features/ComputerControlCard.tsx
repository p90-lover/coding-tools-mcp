import { useEffect, useState } from "react";
import type { ComputerRequest } from "../api/contracts";
import { getCodingToolsClient } from "../api/client";

// A chat agent asking to use an app through computer use (electron/computer-control.cjs) is asked in
// that chat, on Codex's own app-approval card (computer-use-app-approval-request-card, Codex
// 26.1016): "Allow <agent> to use <app>?" with Always allow, Deny and Allow this conversation, and
// Codex's first-use notice until an app was ever allowed. It asked for a window and a duration
// until 2026-10-31.

// Codex's first-use disclosure (composer.computerUseAppApproval.disclosure), for this app's agents.
const DISCLOSURE = "Computer Use lets the agent use apps on your computer. It may take screenshots of app contents while working. "
  + "You can choose which apps it can access and stop actions at any time.";

/** The requests waiting for the person, kept current as they come and go. */
export function useComputerRequests(): ComputerRequest[] {
  const [requests, setRequests] = useState<ComputerRequest[]>([]);
  useEffect(() => {
    let computer: ReturnType<typeof getCodingToolsClient>["computer"] | undefined;
    try { computer = getCodingToolsClient().computer; } catch { return undefined; }
    if (typeof computer?.onRequests !== "function") return undefined;
    let live = true;
    const off = computer.onRequests((next) => { if (live) setRequests(Array.isArray(next) ? next : []); });
    void computer.requests().then((result) => { if (live) setRequests(Array.isArray(result?.requests) ? result.requests : []); }, () => undefined);
    return () => { live = false; off(); };
  }, []);
  return requests;
}

/** The requests a chat shows: those its own agents made, or, before its agent had a session, its project's. */
export function chatComputerRequests(requests: readonly ComputerRequest[], sessionIds: readonly string[], workspaceId?: string): ComputerRequest[] {
  const own = new Set(sessionIds);
  return requests.filter((request) => request.sessions.some((id) => own.has(id))
    || (!request.sessions.length && Boolean(workspaceId) && request.workspaceId === workspaceId));
}

/** Codex's computer-use mark: a screen with a pointer. */
function ComputerUseMark() {
  return <svg className="cx-computer-mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="1.5" y="2" width="13" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path d="M5.5 14h5M8 11v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M7 5l3.6 1.5-1.5.5-.5 1.5Z" fill="currentColor" />
  </svg>;
}

export function ComputerControlCard({ request }: { request: ComputerRequest }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async (decision: "always" | "conversation" | "deny") => {
    setBusy(true); setError("");
    try {
      const result = await getCodingToolsClient().computer.answer({ id: request.id, decision });
      if (!result.ok) setError(result.error || "That did not go through");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setBusy(false); }
  };
  // Codex's subtitle: the first-use notice, then what this request adds (here: the project's capture).
  const subtitle = [
    request.firstUse ? DISCLOSURE : "",
    request.window ? `Window: ${request.window}` : "",
    request.captureOff ? `Allowing it turns on screen capture for ${request.project}.` : "",
  ].filter(Boolean).join("\n\n");
  return <div className="cdx-card cx-computer-card" role="alert" aria-label={`Allow ${request.agent} to use ${request.app}?`}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); if (!busy) void send("deny"); }
    }}>
    <div className="cdx-body">
      <span className={request.elevated ? "cdx-kind cx-computer-head is-elevated" : "cdx-kind cx-computer-head"}>
        {request.elevated ? <><span aria-hidden="true">⚠</span><span>Elevated Risk</span></> : <><ComputerUseMark /><span>Computer Use</span></>}
      </span>
      <span className="cdx-title">Allow {request.agent} to use {request.app}?</span>
      {subtitle ? <span className="cdx-reason cx-computer-subtitle">{subtitle}</span> : null}
      {error ? <span className="cdx-reason cx-computer-error" role="status">{error}</span> : null}
    </div>
    <div className="cdx-foot">
      {request.persistModes.includes("always")
        ? <button type="button" className="cdx-button is-outline cx-computer-lead" disabled={busy} onClick={() => void send("always")}>Always allow</button>
        : null}
      <button type="button" className="cdx-button is-outline" disabled={busy} onClick={() => void send("deny")}>Deny</button>
      <button type="button" className="cdx-button is-primary" disabled={busy} onClick={() => void send("conversation")}>Allow this conversation</button>
    </div>
  </div>;
}
