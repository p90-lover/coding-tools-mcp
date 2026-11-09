import { useContext, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import type { Copy } from "../i18n";
import type { ActionTimes, ActionTimeSeries, LauncherApi, Surface } from "../types";
import { pageHidden, SurfaceHiddenContext, useSurfaceHidden } from "./page-visibility";
import "./action-times.css";

const POLL_MS = 2_000;

/**
 * Reports each tab the app shows and how long it took to draw: from the switch (`startedAt`, set
 * where the tab is chosen) until the frame with the new tab has been painted. A rAF callback runs
 * before that paint; a message posted from it runs after. A switch left before it painted, or a
 * window that is not visible (no frames), reports nothing.
 */
export function useTabRenderTiming(api: LauncherApi | undefined, surface: Surface, startedAt: MutableRefObject<number>) {
  const reported = useRef(new Set<Surface>());
  useLayoutEffect(() => {
    if (!api) return;
    const started = startedAt.current;
    const first = !reported.current.has(surface);
    reported.current.add(surface);
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        if (cancelled || pageHidden()) return;
        void api.reportTabRender({ tab: surface, ms: performance.now() - started, first }).catch(() => undefined);
      };
      channel.port2.postMessage(null);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [api, surface, startedAt]);
}

function tabLabel(tab: string, copy: Copy): string {
  const labels: Record<string, string> = {
    "agent-orchestrator": "Chat",
    "agent-orchestrator-teams": "Orchestrator Team",
    "agent-orchestrator-original": "Agent Orchestrator",
    subagents: "Subagents",
    "native-codex": copy.nativeCodex,
    browser: copy.browser,
    "gpt-browser": "GPT Browser",
    "chatgpt-browser-management": "ChatGPT browser management",
    "chatgpt-desktop": "ChatGPT Desktop",
    email: "Email",
    setup: copy.setup,
    mcp: "MCP",
    plugins: "Plugins",
    "instant-mcp": copy.liveMcpTools,
    "app-plugins": copy.appPlugins,
    oauth: copy.providerOAuth,
    register: copy.register,
    "workspace-auth": copy.workspaceAuth,
    activity: copy.activity,
    rtk: "RTK",
    "antigravity-cli": "Antigravity CLI",
    cpa: "CPA",
    network: copy.networkProxy,
    providers: copy.providers,
    integrations: copy.integrations,
    settings: copy.settings,
  };
  return labels[tab] ?? tab;
}

const counted = (template: string, count: number) => template.replace("{count}", String(count));

export function formatMs(value: number | null): string {
  if (value === null) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

// Colour by how it feels: a tab should show within a frame or two, a page within a few seconds.
function tone(value: number | null, warnMs: number, slowMs: number): string {
  if (value === null) return "";
  return value >= slowMs ? " is-slow" : value >= warnMs ? " is-warn" : "";
}

function Timing({ series, warnMs, slowMs, copy, last = false }: {
  series: ActionTimeSeries;
  warnMs: number;
  slowMs: number;
  copy: Copy;
  last?: boolean;
}) {
  return (
    <span className="atp-timing">
      <strong className={`atp-value${tone(series.medianMs, warnMs, slowMs)}`}>{formatMs(series.medianMs)}</strong>
      <small>
        {last ? `${copy.actionTimeLast} ${formatMs(series.lastMs)} · ` : ""}
        {`p95 ${formatMs(series.p95Ms)} · ${copy.actionTimeSlowest} `}
        <span className={tone(series.maxMs, warnMs, slowMs).trim()}>{formatMs(series.maxMs)}</span>
      </small>
    </span>
  );
}

/** Activity > Action time: tab and page timings from the main process, refreshed while shown. */
export function ActionTimesPanel({ api, copy, setError }: {
  api: LauncherApi;
  copy: Copy;
  setError: (error: string | null) => void;
}) {
  // Polls only while this tab is shown and the window is visible (page-visibility.ts).
  const hidden = useContext(SurfaceHiddenContext);
  const skipTick = useSurfaceHidden();
  const [times, setTimes] = useState<ActionTimes | null>(null);

  useEffect(() => {
    if (hidden) return;
    let live = true;
    const read = () => {
      if (skipTick()) return;
      void api.actionTimes().then((next) => { if (live) setTimes(next); }).catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [api, hidden, skipTick]);

  const clear = () => void api.clearActionTimes().then(setTimes).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  const tabs = times?.tabs ?? [];
  const pages = times?.pages ?? [];

  return (
    <section className="atp" aria-label={copy.actionTime}>
      <div className="section-heading activity-heading">
        <span>{copy.actionTime}</span>
        <button className="button-secondary" disabled={!tabs.length && !pages.length} onClick={clear} type="button">
          {copy.actionTimeClear}
        </button>
      </div>
      <p className="atp-hint">{copy.actionTimeHint}</p>

      <h3 className="atp-title">{copy.actionTimeTabs}</h3>
      {tabs.length ? (
        <div className="atp-table atp-tabs" role="table" aria-label={copy.actionTimeTabs}>
          <div className="atp-row atp-head" role="row">
            <span role="columnheader">{copy.actionTimeTab}</span>
            <span role="columnheader">{copy.actionTimeRender}</span>
            <span role="columnheader">{copy.actionTimeFirstOpen}</span>
            <span role="columnheader">{copy.actionTimeResponse}</span>
            <span role="columnheader">{copy.actionTimeSlowestRequest}</span>
          </div>
          {tabs.map((item) => (
            <div className={`atp-row${item.tab === times?.currentTab ? " is-current" : ""}`} key={item.tab} role="row">
              <span className="atp-name" role="cell">
                <strong>{tabLabel(item.tab, copy)}</strong>
                <small>{counted(copy.actionTimeShown, item.render.count + (item.firstMs === null ? 0 : 1))}</small>
              </span>
              <span role="cell"><Timing copy={copy} last series={item.render} slowMs={1_000} warnMs={300} /></span>
              <span role="cell" className={`atp-value${tone(item.firstMs, 1_000, 3_000)}`}>{formatMs(item.firstMs)}</span>
              <span role="cell"><Timing copy={copy} series={item.response} slowMs={2_000} warnMs={500} /></span>
              <span className="atp-name" role="cell">
                {item.slowest ? <>
                  <strong className={`atp-value${tone(item.slowest.ms, 500, 2_000)}`}>{formatMs(item.slowest.ms)}</strong>
                  <small title={item.slowest.channel}>{item.slowest.channel.replace(/^launcher:/, "")}</small>
                </> : "—"}
              </span>
            </div>
          ))}
        </div>
      ) : <p className="atp-empty">{copy.actionTimeNoTabs}</p>}

      <h3 className="atp-title">{copy.actionTimePages}</h3>
      {pages.length ? (
        <div className="atp-table atp-pages" role="table" aria-label={copy.actionTimePages}>
          <div className="atp-row atp-head" role="row">
            <span role="columnheader">{copy.actionTimePage}</span>
            <span role="columnheader">{copy.actionTimeResponse}</span>
            <span role="columnheader">{copy.actionTimeRender}</span>
            <span role="columnheader">{copy.actionTimeStatus}</span>
          </div>
          {pages.map((item) => (
            <div className="atp-row" key={`${item.group}|${item.account ?? ""}|${item.page}`} role="row">
              <span className="atp-name" role="cell">
                <strong title={item.page}>{item.page}</strong>
                <small>{[item.group, item.account, counted(copy.actionTimeLoaded, item.render.count)].filter(Boolean).join(" · ")}</small>
              </span>
              <span role="cell"><Timing copy={copy} last series={item.response} slowMs={3_000} warnMs={1_000} /></span>
              <span role="cell"><Timing copy={copy} last series={item.render} slowMs={8_000} warnMs={3_000} /></span>
              <span className="atp-name" role="cell">
                <strong className={item.lastStatus !== null && item.lastStatus >= 400 ? "atp-value is-slow" : "atp-value"}>{item.lastStatus ?? "—"}</strong>
                {item.failures ? <small title={item.lastError ?? undefined}>{counted(copy.actionTimeFailed, item.failures)}</small> : null}
              </span>
            </div>
          ))}
        </div>
      ) : <p className="atp-empty">{copy.actionTimeNoPages}</p>}
    </section>
  );
}
