import { useEffect, useState } from "react";
import type { ChatGptLocalPreview, LauncherApi } from "../types";

// The user's own ChatGPT desktop app, beside the docked copy: a live preview of its window and,
// once the user turns the send extension on, a box that types a message into it and sends it.
// Nothing is ever sent without the user's Send click or Enter.

export const LOCAL_PANEL_KEY = "coding-tools:chatgpt-desktop:local-panel";
export const SEND_EXTENSION_KEY = "coding-tools:chatgpt-desktop:send-extension";
const PREVIEW_MS = 1_500;
// Found but not capturable (minimized, hidden in the tray): look again now and then.
const WAITING_MS = 4_000;
const MAX_MESSAGE_CHARS = 4_000;
const SENDABLE: ReadonlyArray<ChatGptLocalPreview["state"]> = ["ok", "minimized", "blank"];

export function readFlag(key: string, fallback: boolean) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

export function writeFlag(key: string, value: boolean) {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* Kept for this session only. */ }
}

/** Milliseconds until the next capture, or null to stop until the user checks again. */
export function nextPreviewDelay(state: ChatGptLocalPreview["state"] | "error"): number | null {
  if (state === "ok") return PREVIEW_MS;
  if (state === "minimized" || state === "hidden" || state === "blank") return WAITING_MS;
  return null;
}

// Electron wraps a main-process error as "Error invoking remote method '<channel>': Error: …".
function errorText(cause: unknown) {
  const message = cause && typeof cause === "object" && "message" in cause ? String(cause.message) : String(cause);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

function emptyText(preview: ChatGptLocalPreview | null, installed: boolean | null) {
  if (!preview) return "Looking for your ChatGPT app…";
  switch (preview.state) {
    case "unsupported": return "The preview works on Windows only.";
    case "not-running": return installed === false
      ? "Install the ChatGPT app from the Microsoft Store, open it, then check again."
      : "Your ChatGPT app isn't open. Open it, then check again.";
    case "minimized": return "Your ChatGPT app is minimized. Restore it to see the preview.";
    case "hidden": return "Your ChatGPT app is in the background. Open its window to see the preview.";
    default: return "Windows returned a blank image of the ChatGPT window.";
  }
}

export function ChatGptLocalPanel({ api, active, installed }: {
  api: LauncherApi;
  /** The page is shown; the preview refreshes only then. */
  active: boolean;
  installed: boolean | null;
}) {
  const [extension, setExtension] = useState(() => readFlag(SEND_EXTENSION_KEY, false));
  const [preview, setPreview] = useState<ChatGptLocalPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  // Bumped by "Check again" to restart the preview loop.
  const [round, setRound] = useState(0);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  // One capture at a time; the next is scheduled only after the previous one answered.
  useEffect(() => {
    if (!active || !pageVisible) return;
    let alive = true;
    let timer = 0;
    setStopped(false);
    const tick = async () => {
      let delay: number | null;
      try {
        const next = await api.chatGptLocalPreview();
        if (!alive) return;
        setPreview(next);
        setPreviewError(null);
        delay = nextPreviewDelay(next.state);
      } catch (cause) {
        if (!alive) return;
        setPreviewError(errorText(cause));
        delay = nextPreviewDelay("error");
      }
      if (delay === null) setStopped(true);
      else timer = window.setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [active, api, pageVisible, round]);

  const toggleExtension = () => {
    const next = !extension;
    setExtension(next);
    writeFlag(SEND_EXTENSION_KEY, next);
    setResult(null);
  };

  const canSend = extension && !sending && draft.trim().length > 0
    && Boolean(preview && SENDABLE.includes(preview.state));

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setResult(null);
    try {
      await api.sendChatGptLocalMessage(draft);
      setDraft("");
      setResult({ ok: true, text: "Sent to your ChatGPT app." });
    } catch (cause) {
      setResult({ ok: false, text: errorText(cause) });
    } finally {
      setSending(false);
    }
  };

  const showImage = preview?.state === "ok" && Boolean(preview.image);

  return (
    <aside className="cgd-local" aria-label="Your ChatGPT app">
      <header className="cgd-local-head">
        <strong>Your ChatGPT app</strong>
        <span className="cgd-muted">{showImage ? "Live preview" : stopped ? "Stopped" : ""}</span>
      </header>

      <div className="cgd-local-view">
        {showImage
          ? <img src={preview!.image!} alt={`Preview of ${preview!.title || "ChatGPT"}`} />
          : <p className="cgd-muted">{previewError ?? emptyText(preview, installed)}</p>}
        {stopped ? (
          <button type="button" className="button-secondary" onClick={() => setRound((value) => value + 1)}>Check again</button>
        ) : null}
      </div>

      <div className="cgd-local-ext">
        <button
          type="button"
          role="switch"
          aria-checked={extension}
          aria-label="Send extension"
          className={`switch${extension ? " is-on" : ""}`}
          onClick={toggleExtension}
        >
          <span />
        </button>
        <div>
          <strong>Send extension</strong>
          <p className="cgd-muted">
            {extension
              ? "Send types your message into your ChatGPT app and presses Enter. ChatGPT briefly comes to the front."
              : "Turn on to message your ChatGPT app from here."}
          </p>
        </div>
      </div>

      {extension ? (
        <form className="cgd-local-send" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <textarea
            aria-label="Message for your ChatGPT app"
            placeholder="Message your ChatGPT app"
            rows={3}
            maxLength={MAX_MESSAGE_CHARS}
            value={draft}
            disabled={sending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter is a new line; never while an IME is composing.
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void send();
            }}
          />
          <button type="submit" className="button-primary" disabled={!canSend}>{sending ? "Sending…" : "Send"}</button>
        </form>
      ) : null}

      {result ? <p className={`cgd-local-result ${result.ok ? "is-ok" : "is-error"}`} role="status">{result.text}</p> : null}
    </aside>
  );
}
