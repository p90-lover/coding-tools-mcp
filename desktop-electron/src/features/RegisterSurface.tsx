import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Language, LauncherApi, RegisterStatus } from "../types";
import "./original-ui.css";

// Register is the reg-machine project's own page, full size: the app adds no bar above it. Until it
// is ready, one card says where it stands and holds the actions (choose the project, start, retry).
const labels = {
  en: { choose: "Choose project", other: "Choose another project", start: "Start", retry: "Try again", starting: "Starting Register…", loading: "Loading Register…", stopped: "Register is stopped", empty: "Choose the reg-machine project", hint: "Its service starts when you open Register.", failed: "Register didn't start" },
  "zh-CN": { choose: "选择项目", other: "选择其他项目", start: "启动", retry: "重试", starting: "正在启动注册服务…", loading: "正在加载注册界面…", stopped: "注册服务已停止", empty: "选择 reg-machine 项目", hint: "打开注册工作区时会自动启动其服务。", failed: "注册服务未能启动" },
  "zh-TW": { choose: "選擇專案", other: "選擇其他專案", start: "啟動", retry: "重試", starting: "正在啟動註冊服務…", loading: "正在載入註冊介面…", stopped: "註冊服務已停止", empty: "選擇 reg-machine 專案", hint: "開啟註冊工作區時會自動啟動其服務。", failed: "註冊服務未能啟動" },
  ja: { choose: "プロジェクトを選択", other: "別のプロジェクトを選択", start: "起動", retry: "再試行", starting: "登録サービスを起動中…", loading: "登録画面を読み込み中…", stopped: "登録サービスは停止しています", empty: "reg-machine プロジェクトを選択", hint: "登録画面を開くとサービスが自動起動します。", failed: "登録サービスを起動できませんでした" },
};

export function RegisterSurface({ api, active, language, setError }: {
  api: LauncherApi;
  active: boolean;
  language: Language;
  setError: (error: string | null) => void;
}) {
  const copy = labels[language];
  const [status, setStatus] = useState<RegisterStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setLocalError] = useState("");
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const mounted = useRef(true);
  const autoStartedProjects = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void api.setRegisterSurfaceActive(false).catch(() => undefined);
    };
  }, [api]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let reading = false;
    const refresh = async () => {
      if (reading || document.hidden) return;
      reading = true;
      try {
        let next = await api.registerStatus();
        if (!alive || document.hidden) return;
        if (next.projectRoot && !autoStartedProjects.current.has(next.projectRoot)) {
          // A manual Stop must stay stopped across polling and tab switches.
          if (next.ready || next.starting || next.error) autoStartedProjects.current.add(next.projectRoot);
          else if (document.hasFocus()) {
            autoStartedProjects.current.add(next.projectRoot);
            next = await api.startRegister();
          }
        }
        if (alive) setStatus(next);
      } catch (cause) {
        if (alive) setLocalError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    const unsubscribe = api.onRegisterChanged((next) => { if (alive) setStatus(next); });
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      unsubscribe();
    };
  }, [active, api]);

  const ready = status?.ready === true;
  useLayoutEffect(() => {
    let alive = true;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      if (!active || !ready || !slot || document.hidden) {
        void api.setRegisterSurfaceActive(false).catch(() => undefined);
        return;
      }
      frame = requestAnimationFrame(() => {
        const rect = slot.getBoundingClientRect();
        void api.setRegisterBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
          .then(() => { if (alive) return api.setRegisterSurfaceActive(true); })
          .catch(() => undefined);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (slot) observer.observe(slot);
    window.addEventListener("resize", measure);
    document.addEventListener("visibilitychange", measure);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("visibilitychange", measure);
      void api.setRegisterSurfaceActive(false).catch(() => undefined);
    };
  }, [active, api, ready, slot]);

  const run = useCallback(async (action: () => Promise<RegisterStatus | null>) => {
    setBusy(true);
    setError(null);
    setLocalError("");
    try {
      const next = await action();
      if (mounted.current && next) setStatus(next);
    } catch (cause) {
      if (mounted.current) setLocalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [setError]);

  const choose = () => run(async () => {
    const folder = await api.chooseFolder?.();
    if (!folder) return null;
    const configured = await api.configureRegister(folder);
    autoStartedProjects.current.add(configured.projectRoot);
    return api.startRegister();
  });
  const problem = error || status?.error || "";
  const project = status?.projectRoot || "";
  const starting = Boolean(status?.starting) || (busy && !ready);
  const title = ready ? copy.loading : starting ? copy.starting : problem ? copy.failed : project ? copy.stopped : copy.empty;

  return (
    <section className="register-surface" aria-label="Register">
      <div className="register-dragstrip" aria-hidden="true" />
      <div className="register-frame" ref={setSlot} data-register-slot="true">
        <div className={`register-card${starting || ready ? " is-waiting" : ""}`} role="status">
          <strong>{title}</strong>
          {problem ? <p className="register-error" role="alert">{problem}</p> : !project ? <p>{copy.hint}</p> : null}
          {project ? <code title={project}>{project}</code> : null}
          {!ready && !starting ? <div className="register-actions">
            {project ? <button type="button" className="is-primary" disabled={busy} onClick={() => void run(() => api.startRegister())}>{problem ? copy.retry : copy.start}</button> : null}
            <button type="button" className={project ? "" : "is-primary"} disabled={busy || status?.owned} onClick={() => void choose()}>{project ? copy.other : copy.choose}</button>
          </div> : null}
        </div>
      </div>
    </section>
  );
}
