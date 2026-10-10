import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "./ChatMarkdown";
import type { ChatTurn } from "./ao-chat";

/**
 * The page shown by "Open in new window": a read-only, live copy of one chat. The window runs no
 * app code (no preload, sandboxed, page scripts blocked by its CSP); the main window re-renders this
 * markup and pushes it whenever the chat changes. Sending stays in the main window, which owns the
 * focus-guarded app API.
 */
function Transcript({ turns }: { turns: ChatTurn[] }) {
  return <>{turns.map((turn) => <section key={turn.key} className="turn">
    {turn.user ? <div className="user">{turn.user.text}</div> : null}
    {turn.steps.length ? <ol className="steps">{turn.steps.map((step) => <li key={step.key} className={step.working ? "working" : step.error ? "error" : ""}>
      <span className="step-name">{step.name}</span>
      <span className="step-meta">{step.working ? (step.working.activity || "working…") : step.error ? "failed" : step.verdict || step.state}</span>
    </li>)}</ol> : null}
    {turn.final?.text ? <div className="answer"><ChatMarkdown text={turn.final.text} /></div>
      : turn.status === "running" || turn.status === "queued" ? <p className="live">Working…</p> : null}
  </section>)}</>;
}

/** The body markup alone, for in-place updates that keep the reader's scroll position. */
export function chatWindowBody(title: string, turns: ChatTurn[]): string {
  return renderToStaticMarkup(<><h1>{title}</h1><Transcript turns={turns} /></>);
}

/** The whole page for a new window. */
export function chatWindowPage(title: string, turns: ChatTurn[]): string {
  const escapedTitle = title.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapedTitle}</title><style>${CHAT_WINDOW_CSS}</style></head>
<body><main>${chatWindowBody(title, turns)}</main></body></html>`;
}

const CHAT_WINDOW_CSS = `
:root { color-scheme: light dark; --bg: #fff; --fg: #16243a; --muted: #748198; --line: #e4eaf1; --bubble: #f2f4f7; --red: #ed4356; }
@media (prefers-color-scheme: dark) { :root { --bg: #181818; --fg: #e8e8e8; --muted: #9a9a9a; --line: rgb(255 255 255 / 9%); --bubble: #262626; --red: #f85149; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.6 system-ui, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 24px 20px 48px; }
h1 { margin: 0 0 20px; font-size: 16px; font-weight: 600; }
.turn { display: grid; gap: 10px; margin-bottom: 28px; }
.user { justify-self: end; max-width: 80%; padding: 8px 12px; border-radius: 14px; background: var(--bubble); white-space: pre-wrap; overflow-wrap: anywhere; }
.steps { margin: 0; padding: 0 0 0 10px; list-style: none; border-left: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.steps li { display: flex; gap: 8px; } .steps li.error { color: var(--red); } .step-name { color: var(--fg); font-weight: 500; }
.answer { overflow-wrap: anywhere; } .live { margin: 0; color: var(--muted); }
pre, code { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
pre { padding: 10px 12px; border-radius: 8px; background: var(--bubble); overflow-x: auto; }
.cx-code-head button { display: none; } a { color: inherit; }
`;
