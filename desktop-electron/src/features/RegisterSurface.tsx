import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Language, LauncherApi, RegisterStatus } from "../types";
import "./original-ui.css";

const labels = {
  en: { start: "Start service", stop: "Stop service", reload: "Reload view", refresh: "Refresh status", connected: "Connected", offline: "Offline", starting: "Starting", empty: "Register in Coding Tools", hint: "Register opens automatically. Use Start service to retry if it could not start.", maintenance: "Register is included with Coding Tools. Your accounts and settings stay in its application data.", attached: "Using an existing service. Coding Tools will leave it running.", loading: "Loading Register" },
  "zh-CN": { start: "启动服务", stop: "停止服务", reload: "重新加载", refresh: "刷新状态", connected: "已连接", offline: "离线", starting: "启动中", empty: "Coding Tools 注册工作区", hint: "注册工作区会自动打开。若启动失败，可点击启动服务重试。", maintenance: "注册功能已内置，账号和设置保存在 Coding Tools 的应用数据中。", attached: "正在使用已有服务，Coding Tools 不会将其停止。", loading: "正在加载注册界面" },
  "zh-TW": { start: "啟動服務", stop: "停止服務", reload: "重新載入", refresh: "重新整理狀態", connected: "已連線", offline: "離線", starting: "啟動中", empty: "Coding Tools 註冊工作區", hint: "註冊工作區會自動開啟。若啟動失敗，可點擊啟動服務重試。", maintenance: "註冊功能已內建，帳號和設定儲存在 Coding Tools 的應用程式資料中。", attached: "正在使用既有服務，Coding Tools 不會將其停止。", loading: "正在載入註冊介面" },
  ja: { start: "サービスを起動", stop: "サービスを停止", reload: "再読み込み", refresh: "状態を更新", connected: "接続済み", offline: "オフライン", starting: "起動中", empty: "Coding Tools 登録ワークスペース", hint: "登録画面は自動的に開きます。起動できない場合はサービスを起動して再試行できます。", maintenance: "登録機能は内蔵されています。アカウントと設定は Coding Tools のアプリデータに保存されます。", attached: "既存のサービスに接続しています。Coding Tools はこのサービスを停止しません。", loading: "登録画面を読み込み中" },
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
  const openingRequested = useRef(false);

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
        if (alive && !openingRequested.current) {
          openingRequested.current = true;
          if (!next.ready && !next.starting) next = await api.startRegister();
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
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
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

  const state = status?.starting ? "starting" : ready ? "ready" : "offline";

  return (
    <section className="original-ui-surface register-surface" aria-label="Register">
      <header className="original-ui-hostbar">
        <strong>Register</strong>
        <span className={`original-ui-status status-${state}`} role="status">
          {state === "starting" ? copy.starting : ready ? copy.connected : copy.offline}
        </span>
        <div className="original-ui-hostbar-actions">
          <button type="button" className="primary" disabled={busy || status?.starting}
            onClick={() => void run(() => ready ? api.reloadRegister() : api.startRegister())}>
            {status?.starting ? copy.starting : ready ? copy.reload : copy.start}
          </button>
          <button type="button" disabled={busy || !status?.owned} onClick={() => void run(() => api.stopRegister())}>{copy.stop}</button>
          <button type="button" disabled={busy} onClick={() => void run(() => api.registerStatus())}>{copy.refresh}</button>
        </div>
      </header>
      {error || status?.error ? <p className="original-ui-error" role="alert">{error || status?.error}</p> : null}
      <p className="original-ui-note">{ready && !status?.owned ? copy.attached : copy.maintenance}</p>
      <div className="original-ui-frame-shell" ref={setSlot} data-register-slot="true">
        <div className="original-ui-frame-empty">
          <strong>{ready ? copy.loading : copy.empty}</strong>
          {!ready ? <span>{copy.hint}</span> : null}
        </div>
      </div>
    </section>
  );
}
