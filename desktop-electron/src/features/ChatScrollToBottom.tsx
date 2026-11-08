// Codex desktop's B6l/je: a fixed 32px circle, 24px above the composer, with working dots
// until hover/focus reveals the arrow. Hidden controls stay out of keyboard navigation.
// `lift` raises it above whatever floats over the thread's foot (the approval dock), in px.
export function ChatScrollToBottom({ show, working, lift = 0, onClick }: { show: boolean; working: boolean; lift?: number; onClick: () => void }) {
  return <div className="cx-scroll-bottom-anchor">
    <button type="button" className={`cx-to-bottom${show ? " is-visible" : ""}${working ? " is-working" : ""}`}
      style={lift > 24 ? { bottom: lift } : undefined}
      aria-label="Scroll to bottom" aria-hidden={!show} tabIndex={show ? undefined : -1} onClick={show ? onClick : undefined}>
      {working ? <span className="cx-scroll-working" aria-hidden="true"><span /><span /><span /></span> : null}
      <svg className="cx-scroll-arrow" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M10 4.167v11.666m0 0 4.583-4.583M10 15.833 5.417 11.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  </div>;
}
