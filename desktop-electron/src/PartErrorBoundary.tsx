import { Component, type ErrorInfo, type ReactNode } from "react";

// One part of the window (a tab, a chat message) that throws while it renders shows this in its
// place; the rest of the app keeps working. Without it, a single chat row's bad data reached
// AppErrorBoundary, which replaces the whole window and reloads it: queued messages and drafts
// were lost, and a chat that kept failing reopened into the same reload loop.

type Props = { children: ReactNode; label: string; resetKey?: string };
type State = { error: string | null; resetKey?: string };

export class PartErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  // Another chat or tab in the same place starts clean.
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // The main process logs console errors (launcher.renderer_console_error), so this is the record.
    console.error(`Coding Tools render error in ${this.props.label}:`,
      error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error),
      `\nComponent stack:${info.componentStack ?? ""}`);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="part-error" role="alert">
        <span>{this.props.label} couldn't be shown: {this.state.error.slice(0, 300)}</span>
        <button type="button" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
