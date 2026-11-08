import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Language } from "../types";
import { AgentOrchestratorSurface } from "./AgentOrchestratorSurface";
import {
  CHAT_PAGE_ACTIVE, CHAT_PAGE_LIMIT, ChatPagerContext, ChatPagesContext, PAGE_KEYS_PAUSED, adjacentChatPage, chatPageLayout,
  createChatPageRegistry, createPageSwipe, pageShortcutDirection, pageWheelDelta, useChatPagePreferences, type ChatPager,
} from "./chat-pages";
import { ChatGlyph } from "./ChatMenu";
import { NativeViewsCoveredContext, SurfaceHiddenContext, useSurfaceHidden } from "./page-visibility";
import "./chat-pages.css";

/**
 * The page tabs: numbers in the open page's title-bar strip (its surface's drag strip), so pages take
 * no height from the chats, and + for a new page. Only the open page draws them.
 */
function ChatPageTabs({ page }: { page: number }) {
  const pager = useContext(ChatPagerContext);
  const strip = useRef<HTMLElement>(null);
  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [pager?.active, pager?.count]);
  if (!pager || pager.active !== page) return null;
  const keys = pager.keys ? ` (${pager.keys.previous} / ${pager.keys.next})` : "";
  return <nav className="cx-page-tabs" aria-label="Chat pages" ref={strip}>
    <div role="tablist" aria-label="Chat pages" aria-keyshortcuts={pager.keys ? `${pager.keys.previous} ${pager.keys.next}` : undefined}
      onKeyDown={(event) => {
        const next = event.key === "Home" ? 1 : event.key === "End" ? pager.count
          : event.key === "ArrowRight" ? adjacentChatPage(page, 1, pager.count)
          : event.key === "ArrowLeft" ? adjacentChatPage(page, -1, pager.count) : null;
        if (next === null) return;
        event.preventDefault();
        pager.select(next);
      }}>
      {Array.from({ length: pager.count }, (_, index) => index + 1).map((item) => <button key={item} type="button" role="tab"
        id={`chat-page-tab-${item}`} data-page={item} aria-selected={item === page} aria-controls={`chat-page-${item}`}
        tabIndex={item === page ? 0 : -1} title={`Page ${item}${keys}`} onClick={() => pager.select(item)}>{item}</button>)}
    </div>
    {pager.canAdd ? <button type="button" className="cx-page-add" aria-label="New page" title="New page" onClick={pager.add}>
      <ChatGlyph name="plus" size={14} />
    </button> : null}
  </nav>;
}

/**
 * One page's chats as the same element while its inputs are, so turning a page redraws only the two
 * pages it hides and shows (their SurfaceHiddenContext changed), never the chats on the others.
 */
function PageSurface({ page, language, setError }: { page: number; language: Language; setError: (error: string | null) => void }) {
  return useMemo(() => <AgentOrchestratorSurface language={language} setError={setError} pageNumber={page} />, [page, language, setError]);
}

/** Something under the pointer that keeps a sideways swipe: typing, a dialog, or what scrolls sideways itself (a wide code block). */
function keepsSwipe(target: Element | null, host: Element): boolean {
  if (!target || target.closest(PAGE_KEYS_PAUSED)) return true;
  for (let node: Element | null = target; node && node !== host; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1 && /^(auto|scroll)$/.test(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}

/**
 * Chat pages: each holds a chat window with its own split view (up to ten screens). A full page's
 * New chat goes to the next page with room, or a page added for it. Visited pages stay mounted; a
 * page out of view is hidden and inert and its SurfaceHiddenContext pauses its polls and redraws,
 * while its chats' runs and queues go on in AO and the app.
 */
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
  const host = useRef<HTMLDivElement>(null);
  const shown = useRef(active);
  shown.current = active;
  const latest = useRef(preferences);
  latest.current = preferences;
  const selectPage = useCallback((page: number) => {
    setVisited((current) => current.includes(page) ? current : [...current, page]);
    setActive(page);
    shown.current = page;
    try { localStorage.setItem(CHAT_PAGE_ACTIVE, String(page)); } catch { /* Keep this selection for the session. */ }
  }, []);
  // A full page hands its new chat on: to another page, or one added for it, while pages are on.
  const layout = useMemo(() => chatPageLayout(latest, setError), [setError]);
  const registry = useMemo(() => ({ ...createChatPageRegistry(selectPage, layout), Tabs: ChatPageTabs }), [selectPage, layout]);
  // + : a new page, which starts with a new chat; that chat's composer takes the keyboard.
  const composeOn = useRef(0);
  const addPage = useCallback(() => {
    if (!layout.canAdd() || !layout.add()) return;
    composeOn.current = latest.current.pageCount;
    selectPage(latest.current.pageCount);
  }, [layout, selectPage]);
  const navigate = useCallback((direction: number) => {
    selectPage(adjacentChatPage(shown.current, direction, latest.current.pageCount));
  }, [selectPage]);
  const dialogOpen = () => Boolean(host.current?.querySelector('.cx-chat-page:not([hidden]) [role="dialog"]'));
  // Shift+Q / Shift+R (or the keys set in Settings): never while typing, in a dialog or a menu.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // The cheap checks first: this runs for every key typed anywhere in the app.
      const direction = pageShortcutDirection(event, latest.current);
      if (!direction || hidden() || covered || dialogOpen()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      navigate(direction);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [covered, hidden, navigate]);
  // Scrolling turns pages: any scroll over the page tabs, a sideways one (a touchpad swipe or
  // Shift+wheel) anywhere else. Passive, so scrolling a chat never waits for this.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const swipe = createPageSwipe();
    const wheel = (event: WheelEvent) => {
      const current = latest.current;
      if (!current.enabled || !current.wheel || current.pageCount < 2) return;
      const target = event.target instanceof Element ? event.target : null;
      const overTabs = Boolean(target?.closest(".cx-page-tabs"));
      const direction = swipe(pageWheelDelta(event, overTabs), event.timeStamp,
        () => hidden() || covered || dialogOpen() || (!overTabs && keepsSwipe(target, element)));
      if (direction) navigate(direction);
    };
    element.addEventListener("wheel", wheel, { passive: true });
    return () => element.removeEventListener("wheel", wheel);
  }, [covered, hidden, navigate]);
  // A turned page takes the keyboard on its tab unless something on it already has it (a chat
  // handed on focuses its composer), so Shift+Q / Shift+R keep turning and arrows move along.
  // A page + just added gives it to its new chat's composer once that is drawn (within ~1 s).
  const turned = useRef(false);
  useEffect(() => {
    if (!turned.current) { turned.current = true; return; }
    const compose = composeOn.current === active;
    composeOn.current = 0;
    const section = host.current?.querySelector<HTMLElement>(`#chat-page-${active}`);
    if (!section || hidden()) return;
    if (!section.contains(document.activeElement)) section.querySelector<HTMLButtonElement>(`.cx-page-tabs [data-page="${active}"]`)?.focus({ preventScroll: true });
    if (!compose) return;
    let frame = 0, frames = 0;
    const focus = () => {
      const input = section.querySelector<HTMLTextAreaElement>(".cx-composer textarea");
      if (input) input.focus();
      else if (++frames < 60) frame = window.requestAnimationFrame(focus);
    };
    frame = window.requestAnimationFrame(focus);
    return () => window.cancelAnimationFrame(frame);
  }, [active]);
  const pager = useMemo<ChatPager | null>(() => preferences.enabled ? {
    active, count: preferences.pageCount, canAdd: preferences.pageCount < CHAT_PAGE_LIMIT,
    keys: preferences.keyboard ? { previous: preferences.previous, next: preferences.next } : null,
    select: selectPage, add: addPage,
  } : null, [active, preferences, selectPage, addPage]);
  const pages = Array.from({ length: preferences.pageCount }, (_, index) => index + 1);
  return <div className="cx-chat-pages" ref={host}>
    <ChatPagesContext.Provider value={registry}>
      <ChatPagerContext.Provider value={pager}>
        {pages.map((page) => <section key={page} id={`chat-page-${page}`} className="cx-chat-page" hidden={page !== active} inert={page !== active}
          role={pager ? "tabpanel" : undefined} aria-label={`Chat page ${page}`}>
          <SurfaceHiddenContext.Provider value={parentHidden || page !== active}>
            {visited.includes(page) ? <PageSurface page={page} language={language} setError={setError} /> : null}
          </SurfaceHiddenContext.Provider>
        </section>)}
      </ChatPagerContext.Provider>
    </ChatPagesContext.Provider>
  </div>;
}
