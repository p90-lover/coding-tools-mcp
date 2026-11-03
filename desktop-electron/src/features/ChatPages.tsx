import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Language } from "../types";
import { AgentOrchestratorSurface } from "./AgentOrchestratorSurface";
import {
  CHAT_PAGE_ACTIVE, CHAT_PAGE_LIMIT, ChatPagesContext, adjacentChatPage, createChatPageRegistry,
  pageShortcutDirection, saveChatPagePreferences, useChatPagePreferences,
} from "./chat-pages";
import { NativeViewsCoveredContext, SurfaceHiddenContext, useSurfaceHidden } from "./page-visibility";
import "./chat-pages.css";

/** Visited pages stay mounted; the existing visibility context pauses their UI work. */
export function ChatPages({ language, setError }: { language: Language; setError: (error: string | null) => void }) {
  const preferences = useChatPagePreferences();
  const parentHidden = useContext(SurfaceHiddenContext);
  const covered = useContext(NativeViewsCoveredContext);
  const hidden = useSurfaceHidden();
  const [active, setActive] = useState(() => {
    try {
      const page = Number(localStorage.getItem(CHAT_PAGE_ACTIVE));
      if (Number.isInteger(page) && page >= 1 && page <= preferences.pageCount) return page;
    } catch { /* Start with the original page. */ }
    return 1;
  });
  const [visited, setVisited] = useState(() => [active]);
  const tabs = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const lastWheel = useRef(-Infinity);
  const selectPage = useCallback((page: number) => {
    setVisited((current) => current.includes(page) ? current : [...current, page]);
    setActive(page);
    try { localStorage.setItem(CHAT_PAGE_ACTIVE, String(page)); } catch { /* Keep this selection for the session. */ }
  }, []);
  // A full page hands its new chat on: to another page, or one added for it, only while tabs show.
  const latest = useRef(preferences);
  latest.current = preferences;
  const registry = useMemo(() => createChatPageRegistry(selectPage, {
    count: () => latest.current.enabled ? latest.current.pageCount : 0,
    canAdd: () => latest.current.enabled && latest.current.pageCount < CHAT_PAGE_LIMIT,
    add: () => {
      try { saveChatPagePreferences({ pageCount: latest.current.pageCount + 1 }); return true; }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    },
  }), [selectPage]);
  const navigate = (direction: number) => {
    const page = adjacentChatPage(active, direction, preferences.pageCount);
    selectPage(page);
    tabs.current?.querySelector<HTMLButtonElement>(`[data-page="${page}"]`)?.focus();
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (hidden() || covered || host.current?.querySelector('.cx-chat-page:not([hidden]) [role="dialog"]')) return;
      const direction = pageShortcutDirection(event, preferences);
      if (!direction) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      navigate(direction);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [active, preferences, covered, hidden]);
  // Anywhere over the page bar (its arrows and + too): up the previous page, down the next.
  useEffect(() => {
    const element = bar.current;
    if (!element || !preferences.enabled || !preferences.wheel || preferences.pageCount < 2) return;
    const wheel = (event: WheelEvent) => {
      if (hidden() || covered || event.ctrlKey || event.metaKey) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      const now = performance.now();
      const previous = lastWheel.current;
      lastWheel.current = now;
      if (now - previous < 300) return;
      navigate(delta > 0 ? 1 : -1);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [active, preferences, covered, hidden]);
  const addPage = () => {
    try {
      if (preferences.pageCount >= CHAT_PAGE_LIMIT) return;
      saveChatPagePreferences({ pageCount: preferences.pageCount + 1 });
      selectPage(preferences.pageCount + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const pages = Array.from({ length: preferences.pageCount }, (_, index) => index + 1);
  return <div className="cx-chat-pages" ref={host}>
    {preferences.enabled ? <nav className="cx-pages-bar" aria-label="Chat pages" ref={bar}>
      <button type="button" className="cx-page-step" aria-label="Previous chat page" aria-keyshortcuts={preferences.keyboard ? preferences.previous : undefined}
        title={preferences.keyboard ? `Previous page (${preferences.previous})` : "Previous page"} disabled={preferences.pageCount < 2} onClick={() => navigate(-1)}>‹</button>
      <div className="cx-page-tabs" ref={tabs} role="tablist" aria-label="Chat pages" onKeyDown={(event) => {
        const page = event.key === "Home" ? 1 : event.key === "End" ? preferences.pageCount
          : event.key === "ArrowRight" ? adjacentChatPage(active, 1, preferences.pageCount)
          : event.key === "ArrowLeft" ? adjacentChatPage(active, -1, preferences.pageCount) : null;
        if (page === null) return;
        event.preventDefault();
        selectPage(page);
        tabs.current?.querySelector<HTMLButtonElement>(`[data-page="${page}"]`)?.focus();
      }}>
        {pages.map((page) => <button key={page} type="button" role="tab"
          id={`chat-page-tab-${page}`} data-page={page} aria-selected={page === active} aria-controls={`chat-page-${page}`} tabIndex={page === active ? 0 : -1}
          onClick={() => selectPage(page)}>Page {page}</button>)}
      </div>
      <button type="button" className="cx-page-step" aria-label="Next chat page" aria-keyshortcuts={preferences.keyboard ? preferences.next : undefined}
        title={preferences.keyboard ? `Next page (${preferences.next})` : "Next page"} disabled={preferences.pageCount < 2} onClick={() => navigate(1)}>›</button>
      <button type="button" className="cx-page-step" aria-label="Add chat page" title="Add chat page" disabled={preferences.pageCount >= CHAT_PAGE_LIMIT} onClick={addPage}>+</button>
    </nav> : null}
    <ChatPagesContext.Provider value={registry}>
      {pages.map((page) => <section key={page} id={`chat-page-${page}`} className="cx-chat-page" hidden={page !== active} inert={page !== active}
        role="tabpanel" aria-label={`Chat page ${page}`}>
        <SurfaceHiddenContext.Provider value={parentHidden || page !== active}>
          {visited.includes(page) ? <AgentOrchestratorSurface language={language} setError={setError} pageNumber={page} /> : null}
        </SurfaceHiddenContext.Provider>
      </section>)}
    </ChatPagesContext.Provider>
  </div>;
}
