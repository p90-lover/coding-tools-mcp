import { useEffect, useState } from "react";
import type { ComputerRequest } from "../api/contracts";
import { getCodingToolsClient } from "../api/client";

// A chat agent asking to control a window (electron/computer-control.cjs) is asked in that chat, on
// a card like the agent's other requests: the window it may click and type in, for how long, and
// Start. It was a window of its own that came up on top and took the focus from whatever the person
// was doing (2026-10-31).

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

export function ComputerControlCard({ request }: { request: ComputerRequest }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [duration, setDuration] = useState(request.durations[0]?.id ?? "");
  const [capture, setCapture] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = picked !== null && (!request.captureOff || capture) && !busy;
  const send = async (input: { cancel?: boolean; window?: number; duration?: string; capture?: boolean }) => {
    setBusy(true); setError("");
    try {
      const result = await getCodingToolsClient().computer.answer({ id: request.id, ...input });
      if (!result.ok) setError(result.error || "Control did not start");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setBusy(false); }
  };
  const start = () => { if (ready && picked !== null) void send({ window: picked, duration, ...(request.captureOff ? { capture } : {}) }); };
  return <div className="cdx-card cx-computer-card" role="alert" aria-label="Let the agent control a window"
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); void send({ cancel: true }); }
      else if (event.key === "Enter" && !(event.target instanceof HTMLSelectElement)) { event.preventDefault(); start(); }
    }}>
    <div className="cdx-body">
      <span className="cdx-title">Let the agent control a window?</span>
      <span className="cdx-reason">{request.chat} asked to control your screen in {request.project}. Pick the one window it may
        click and type in. A bar stays on screen while control is on; Stop there or Ctrl+Alt+Escape ends it.</span>
      {request.windows.length ? <div className="cdx-options cx-computer-windows" role="radiogroup" aria-label="Window">
        {request.windows.map((item, index) => <button key={`${item.pid}:${index}`} type="button" role="radio" aria-checked={picked === index}
          className={`cdx-option${picked === index ? " is-selected" : ""}`} disabled={busy} title={item.title} onClick={() => setPicked(index)}>
          <span className="cdx-option-label">{item.title}</span>
          <span className="cdx-option-description">pid {item.pid}</span>
        </button>)}
      </div> : <span className="cdx-reason">No window can be controlled right now.</span>}
      {request.captureOff ? <label className="cx-computer-check">
        <input type="checkbox" checked={capture} disabled={busy} onChange={(event) => setCapture(event.target.checked)} />
        Turn on screen capture for {request.project} (control needs it)</label> : null}
      {error ? <span className="cdx-reason cx-computer-error" role="status">{error}</span> : null}
    </div>
    <div className="cdx-foot">
      <select className="cdx-input cx-computer-duration" aria-label="For how long" value={duration} disabled={busy} onChange={(event) => setDuration(event.target.value)}>
        {request.durations.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      <button type="button" className="cdx-button is-ghost" disabled={busy} onClick={() => void send({ cancel: true })}>Deny</button>
      <button type="button" className="cdx-button is-primary" disabled={!ready} onClick={start}>Start</button>
    </div>
  </div>;
}
