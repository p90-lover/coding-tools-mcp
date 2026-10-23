import { Component, type ErrorInfo, type ReactNode } from "react";

// The whole app sits inside this. Without it, any component throwing while it rendered unmounted
// the entire React tree and left the window black until the app was restarted by hand. It now
// says what happened and reloads the page by itself; a page that keeps failing (three reloads in
// two minutes) stops reloading and waits for the person, so it can never loop.

const RELOADS_KEY = "coding-tools:render-error-reloads";
const RELOAD_WINDOW_MS = 120_000;
const MAX_RELOADS = 3;
const RELOAD_DELAY_MS = 1500;

/** The reloads made for render errors in the last two minutes, this one included when `add`. */
function recentReloads(add: boolean): number {
  try {
    const now = Date.now();
    const saved: unknown = JSON.parse(sessionStorage.getItem(RELOADS_KEY) || "[]");
    const recent = (Array.isArray(saved) ? saved : []).filter((at): at is number => typeof at === "number" && now - at < RELOAD_WINDOW_MS);
    if (add) recent.push(now);
    sessionStorage.setItem(RELOADS_KEY, JSON.stringify(recent));
    return recent.length;
  } catch { return add ? 1 : 0; }
}

type State = { error: Error | null; reloading: boolean };

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, reloading: false };
  private timer: number | undefined;

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // The main process logs console errors (launcher.renderer_console_error), so this is the record.
    console.error("Coding Tools render error:", error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error),
      `\nComponent stack:${info.componentStack ?? ""}`);
    if (recentReloads(false) >= MAX_RELOADS) return;
    this.setState({ reloading: true });
    this.timer = window.setTimeout(() => this.reload(), RELOAD_DELAY_MS);
  }

  componentWillUnmount() { window.clearTimeout(this.timer); }

  private reload = () => {
    recentReloads(true);
    window.location.reload();
  };

  render() {
    const { error, reloading } = this.state;
    if (!error) return this.props.children;
    return <div role="alert" style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", padding: 24,
      background: "Canvas", color: "CanvasText", font: "14px/1.5 system-ui, sans-serif" }}>
      <div style={{ maxWidth: 520, display: "grid", gap: 10 }}>
        <strong style={{ fontSize: 16 }}>{reloading ? "Something went wrong. Reloading…" : "The same error keeps coming back"}</strong>
        <span style={{ opacity: 0.75 }}>{reloading
          ? "Your chats and running agents are safe. Only this window reloads."
          : "The window reloaded 3 times and still fails. Reload to try again. Details are in the app log."}</span>
        <code style={{ display: "block", maxHeight: 120, overflow: "auto", padding: 8, borderRadius: 6, background: "color-mix(in srgb, CanvasText 6%, transparent)",
          fontSize: 12, whiteSpace: "pre-wrap" }}>{error.message || error.name}</code>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={this.reload}>Reload now</button>
          <button type="button" onClick={() => void navigator.clipboard?.writeText(`${error.name}: ${error.message}\n${error.stack ?? ""}`)}>Copy details</button>
        </div>
      </div>
    </div>;
  }
}
