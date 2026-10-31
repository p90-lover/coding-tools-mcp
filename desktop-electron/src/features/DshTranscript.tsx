/**
 * A DeepSeek model's turn, laid out as DeepSeek Harness's web client lays one out
 * (deepseek-ai/deepseek-harness, packages/client/ui-chat and ui-tool; MIT License,
 * Copyright (c) 2026 DeepSeek). Its rows, groups, icons and words are ported as they are:
 * - every thought is its own "Think" row with its first line, opening on the whole thought;
 * - each tool call is a 24px row, "Bash · <what it does>", "Read · <path>", "Edit · <path> +3 -1";
 * - thinking and calls run together into groups between the replies, folded under one heading:
 *   "Running commands · npm test" while the group runs (Desktop's Standard view), "Ran commands,
 *   read files" once a reply follows it or the turn ends;
 * - "Deep diving for 1m 4s ···" sits under a running turn; once it ends, "Completed in 1m 4s"
 *   heads it and folds its work.
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChatMarkdown } from "./ChatMarkdown";
import { AnsweredRecord, ApprovedMark, EarlierRounds, EditDiff, SentMessageView, SteerReader, SteerReceiptMark, StreamingMarkdown, TurnRestart, ToolImages } from "./ChatToolParts";
import {
  dshActivity, dshCommandText, dshDuration, dshExitLabel, dshGroupActivity, dshItemDetail, dshLiveTitle, dshProcessTitle, dshQuietNote, dshRetryNote, dshSegments, dshThinkSummary, dshToolTitle,
  steerReader, steerReceipts, tidyTimeline, withoutReplied, cpaRefusalNote, waitsForPerson, type ChatLiveItem, type ChatStep, type ChatTurn, type CpaRefusal,
  type DshActivity, type SteerReceipt,
} from "./ao-chat";

// Icons: ui-primitives/src/icons, 1px strokes on a 16 box, drawn 14px inside a 16px leading box.
const glyph = (paths: ReactNode) => <svg width={14} height={14} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">{paths}</svg>;
const ICON = {
  think: glyph(<>
    <path d="M10.2854 5.71481C12.9673 8.39663 14.1182 11.5938 12.8562 12.8559C11.5942 14.1179 8.39706 12.9669 5.71518 10.2851C3.03333 7.60323 1.88236 4.40608 3.14441 3.14403C4.40644 1.882 7.6036 3.03297 10.2854 5.71481Z" stroke="currentColor" />
    <path d="M10.2854 10.2851C7.6036 12.9669 4.40644 14.1179 3.14441 12.8559C1.88236 11.5938 3.03333 8.39663 5.71518 5.71481C8.39706 3.03297 11.5942 1.882 12.8562 3.14403C14.1182 4.40608 12.9673 7.60323 10.2854 10.2851Z" stroke="currentColor" />
    <path d="M8.86291 8.0002C8.86291 8.47549 8.47762 8.86087 8.00224 8.86087C7.52694 8.86087 7.1416 8.47549 7.1416 8.0002C7.1416 7.52485 7.52694 7.13953 8.00224 7.13953C8.47762 7.13953 8.86291 7.52485 8.86291 8.0002Z" fill="currentColor" />
  </>),
  api: glyph(<><path d="M3 4L7 8L3 12" stroke="currentColor" /><path d="M9 12H13" stroke="currentColor" /></>),
  browse: glyph(<>
    <path d="M4.9375 5.90295H11.0625" stroke="currentColor" /><path d="M4.9375 9.02991H8.27841" stroke="currentColor" />
    <path d="M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z" fill="currentColor" />
  </>),
  edit: glyph(<>
    <path d="M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z" fill="currentColor" />
    <path d="M7.7849 8.23878L13.888 2.13574" stroke="currentColor" />
  </>),
  search: glyph(<>
    <path d="M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z" stroke="currentColor" />
    <path d="M10.2991 10.3933L14.7783 14.8725" stroke="currentColor" />
  </>),
  code: glyph(<>
    <path d="M6.27612 1.5L4.52612 14.5" stroke="currentColor" /><path d="M11.4739 1.5L9.72388 14.5" stroke="currentColor" />
    <path d="M2.39868 5.5H14.0681" stroke="currentColor" /><path d="M1.93188 10.5H13.6013" stroke="currentColor" />
  </>),
  sparkle: glyph(<>
    <path d="M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z" stroke="currentColor" />
    <path d="M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z" stroke="currentColor" />
    <path d="M12.375 10.4418C12.375 11.7751 13.0417 12.4418 14.375 12.4418C13.0417 12.4418 12.375 13.1084 12.375 14.4418C12.375 13.1084 11.7083 12.4418 10.375 12.4418C11.7083 12.4418 12.375 11.7751 12.375 10.4418Z" stroke="currentColor" />
  </>),
  down: glyph(<path d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" stroke="currentColor" />),
  up: glyph(<path d="M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10" stroke="currentColor" />),
  globe: glyph(<>
    <path d="M7.99986 14.0887C11.3626 14.0887 14.0886 11.3627 14.0886 7.99998C14.0886 4.63727 11.3626 1.91125 7.99986 1.91125C4.63715 1.91125 1.91113 4.63727 1.91113 7.99998C1.91113 11.3627 4.63715 14.0887 7.99986 14.0887Z" stroke="currentColor" />
    <path d="M2.34619 8H13.6538" stroke="currentColor" strokeLinecap="square" />
    <path d="M7.99976 14.0889C9.23509 14.0889 10.1743 11.3629 10.1743 8.00006C10.1743 4.63739 9.23509 1.91138 7.99976 1.91138" stroke="currentColor" />
    <path d="M7.99973 14.0889C6.76445 14.0889 5.8252 11.3629 5.8252 8.00006C5.8252 4.63739 6.76445 1.91138 7.99973 1.91138" stroke="currentColor" />
  </>),
  question: glyph(<>
    <path d="M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z" stroke="currentColor" />
    <path d="M5.75 6.69646C5.75 6.29865 5.88196 5.90976 6.12919 5.57899C6.37643 5.24821 6.72783 4.99041 7.13896 4.83817C7.5501 4.68593 8.0025 4.6461 8.43895 4.72371C8.87541 4.80132 9.27632 4.99289 9.59099 5.27419C9.90566 5.55549 10.12 5.91388 10.2068 6.30406C10.2936 6.69423 10.249 7.09866 10.0787 7.4662C9.90843 7.83373 9.62004 8.14787 9.25003 8.36889C9.19476 8.4019 9.13803 8.43262 9.08004 8.46099C8.52566 8.73217 8 9.20817 8 9.82532" stroke="currentColor" />
    <path d="M8 10.7416V11.7416" stroke="currentColor" />
  </>),
  plan: glyph(<>
    <path d="M4.9375 5.90295H11.0625" stroke="currentColor" /><path d="M4.9375 9.02991H8.27841" stroke="currentColor" />
    <path d="M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V7.61328L13 8.68164V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H8.32812L7.39258 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5Z" fill="currentColor" />
    <path d="M8.97212 14.3693C9.17511 14.5723 9.37811 14.7753 9.5811 14.9783C9.67012 14.8953 9.75914 14.8123 9.84815 14.7293C11.4505 13.2352 13.0528 11.7411 14.6551 10.247C14.7441 10.164 14.8331 10.081 14.9221 9.99803C14.5989 9.6748 14.2756 9.35157 13.9524 9.02834C13.8694 9.11736 13.7864 9.20637 13.7034 9.29539C12.2093 10.8977 10.7152 12.5 9.22113 14.1023C9.13813 14.1913 9.05513 14.2803 8.97212 14.3693Z" fill="currentColor" />
    <path d="M11.6323 13.7841C11.6323 14.0395 11.6323 14.295 11.6323 14.5504C11.6812 14.5523 11.7301 14.5543 11.779 14.5562C12.659 14.5913 13.539 14.6263 14.419 14.6614C14.4679 14.6633 14.5168 14.6653 14.5657 14.6672C14.5657 14.3339 14.5657 14.0006 14.5657 13.6672C14.5168 13.6692 14.4679 13.6711 14.419 13.6731C13.539 13.7081 12.659 13.7432 11.779 13.7783C11.7301 13.7802 11.6812 13.7821 11.6323 13.7841Z" fill="currentColor" />
  </>),
  agent: glyph(<>
    <path d="M6.51867 12.3282C7.29816 12.6011 8.16475 12.6514 9.02269 12.4216C9.57879 12.2726 10.0784 12.0185 10.5087 11.6888C10.7819 12.0555 11.1606 12.3304 11.5913 12.4805C10.9688 13.029 10.2149 13.4478 9.35911 13.6771C8.13946 14.0038 6.90632 13.8971 5.82126 13.4533C6.15821 13.1562 6.4021 12.7652 6.51867 12.3282ZM9.17629 2.89409C11.1101 3.34433 12.739 4.81872 13.2889 6.87043C13.4219 7.3665 13.4811 7.8649 13.4774 8.35466C13.0924 8.13213 12.6422 8.01837 12.1741 8.05276L12.1711 8.05257C12.1539 7.77199 12.109 7.48889 12.0334 7.20684C11.6363 5.72533 10.5048 4.6372 9.13549 4.22844C9.25559 3.87667 9.29214 3.49087 9.22309 3.09892C9.2108 3.02922 9.19451 2.96108 9.17629 2.89409ZM4.7311 3.89107L4.78302 4.11879C4.87648 4.4488 5.04146 4.74263 5.25579 4.98896C3.98078 6.01355 3.35848 7.72904 3.8089 9.41059C3.81828 9.44559 3.82866 9.48025 3.83885 9.51479C3.38217 9.61268 2.98548 9.84137 2.68107 10.1556C2.63414 10.022 2.5897 9.88632 2.55244 9.74726C1.93301 7.43489 2.86717 5.07173 4.71504 3.76697L4.7311 3.89107Z" fill="currentColor" />
    <path d="M7.99136 5.28105C8.87501 5.28105 9.59136 4.56471 9.59136 3.68105C9.59136 2.7974 8.87501 2.08105 7.99136 2.08105C7.1077 2.08105 6.39136 2.7974 6.39136 3.68105C6.39136 4.56471 7.1077 5.28105 7.99136 5.28105Z" stroke="currentColor" />
    <path d="M3.94009 12.9417C4.82374 12.9417 5.54009 12.2254 5.54009 11.3417C5.54009 10.458 4.82374 9.7417 3.94009 9.7417C3.05643 9.7417 2.34009 10.458 2.34009 11.3417C2.34009 12.2254 3.05643 12.9417 3.94009 12.9417Z" stroke="currentColor" />
    <path d="M12.0851 12.9417C12.9688 12.9417 13.6851 12.2254 13.6851 11.3417C13.6851 10.458 12.9688 9.7417 12.0851 9.7417C11.2015 9.7417 10.4851 10.458 10.4851 11.3417C10.4851 12.2254 11.2015 12.9417 12.0851 12.9417Z" stroke="currentColor" />
  </>),
};
/** ChatGroupSeat's PROCESS_ICONS: each kind of work's icon, used on its rows and its group's header. */
const ACTIVITY_ICON: Record<DshActivity | "thinking", ReactNode> = {
  thinking: ICON.think, read: ICON.browse, readImage: ICON.browse, search: ICON.search, edit: ICON.edit, write: ICON.edit,
  commands: ICON.api, code: ICON.code, webSearch: ICON.globe, webFetch: ICON.browse, subagents: ICON.agent,
  plan: ICON.plan, questions: ICON.question, tools: ICON.sparkle,
};
/** A group header draws thinking at its full 16px (`size: 16` in PROCESS_ICONS), the others at 14px. */
const GROUP_THINK = <svg width={16} height={16} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true">{ICON.think.props.children}</svg>;
/** The whale's tail at rest (RunningWhaleTail.tsx); the animated tail is a CSS mask over it. */
const WHALE = "M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742";

/** Reads a card's work (the chat's own cache and loader), only once the row showing it is open. */
export type UseStepWork = (step: ChatStep, wanted: boolean) => ChatLiveItem[] | null;
type Tone = "ok" | "running" | "error" | "stopped";

function toneOf(status: string): Tone {
  if (/cancel|interrupt|abort/i.test(status)) return "stopped";
  if (/fail|error|reject|denied/i.test(status)) return "error";
  return /complet|done|success/i.test(status) ? "ok" : "running";
}

/** A 1-second clock for the running label only, so the transcript around it never re-renders. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

/**
 * DisclosureRow: [16px leading] 6 [title 13/24] 8 [2px dot] 8 [summary], tertiary text that turns
 * secondary on hover; hovering a row that opens swaps its icon for a chevron, and an open row
 * keeps the up chevron.
 */
function DshRow({ icon, title, summary, suffix, running, tone = "ok", plainSummary, open, expandable, onToggle, children, className }: {
  icon: ReactNode; title: string; summary?: string; suffix?: ReactNode; running?: boolean; tone?: Tone; plainSummary?: boolean;
  open: boolean; expandable: boolean; onToggle: () => void; children?: ReactNode; className?: string;
}) {
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onToggle();
  };
  return <div className={`dsh-row-root${className ? ` ${className}` : ""}`} data-state={tone} data-open={open || undefined}>
    <div className="dsh-row" data-expandable={expandable || undefined} role={expandable ? "button" : undefined} tabIndex={expandable ? 0 : undefined}
      aria-expanded={expandable ? open : undefined} onClick={expandable ? onToggle : undefined} onKeyDown={key}>
      <span className="dsh-leading">
        {open ? ICON.up : expandable ? <><span className="dsh-icon-idle">{icon}</span><span className="dsh-chevron-hover">{ICON.down}</span></> : icon}
      </span>
      <span className={`dsh-row-text${running ? " dsh-shimmer" : ""}`}>
        <span className="dsh-title">{title}</span>
        {summary ? <><span className="dsh-sep" aria-hidden="true" />
          <span className={`dsh-summary${plainSummary ? "" : tone === "error" ? " is-error" : tone === "stopped" ? " is-stopped" : ""}`}>{summary}</span></> : null}
        {suffix}
      </span>
    </div>
    {open ? children : null}
  </div>;
}

/** ReasoningRow: "Think · <first line>", opening on the whole thought in secondary type. */
function DshThink({ item }: { item: ChatLiveItem }) {
  const [open, setOpen] = useState(false);
  const running = item.status === "running";
  const summary = open ? "" : dshThinkSummary(item.text, running);
  return <DshRow className="dsh-think" icon={ICON.think} title="Think" summary={summary} running={running} tone={running ? "running" : "ok"}
    open={open} expandable={Boolean(item.text.trim())} onToggle={() => setOpen(!open)}>
    <div className="dsh-think-body"><ChatMarkdown text={item.text} /></div>
  </DshRow>;
}

function prettyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

/**
 * ToolRow: its title ("Bash", "Read", "Edit", "Search", "Tool call") and one line, opening on a
 * terminal card for a command, the changed lines for an edit, or an IN/OUT card for anything else.
 * A failed command with an exit status keeps its own line and adds the neutral "exit code 1"
 * capsule (bash-sample.tsx, ExitCodeBadge); any other failed call's line is its first error line,
 * in red, and a stopped command reads "Stopped".
 */
function DshTool({ item }: { item: ChatLiveItem }) {
  const [open, setOpen] = useState(false);
  const tone = toneOf(item.status);
  const activity = item.kind === "edit" ? "edit" : dshActivity(item);
  const title = item.kind === "edit" ? "Edit" : dshToolTitle(item);
  const exitLabel = dshExitLabel(item);
  const failure = tone === "error" && !exitLabel ? (item.output ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() : undefined;
  const stopped = tone === "stopped" && (item.kind === "command" || activity === "commands") ? "Stopped" : undefined;
  const summary = failure || stopped || dshItemDetail(item);
  const files = item.files ?? [];
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const removed = files.reduce((sum, file) => sum + file.deletions, 0);
  const settled = tone === "error" || tone === "stopped";
  const suffix = <>
    {!settled && files.length ? <span className="dsh-suffix dsh-diff-stat"><span className="is-add">+{added}</span> <span className="is-del">-{removed}</span></span> : null}
    {exitLabel ? <span className="dsh-exit"><span className="dsh-exit-dot" aria-hidden="true" />{exitLabel}</span> : null}
    <ApprovedMark text={item.approval} />
  </>;
  const images = item.images ?? [];
  const expandable = item.kind === "command" || activity === "commands" || Boolean(item.input || item.output) || files.some((file) => file.diff) || images.length > 0;
  return <DshRow className="dsh-tool" icon={ACTIVITY_ICON[activity]} title={title} summary={summary} suffix={suffix}
    running={tone === "running"} tone={tone} plainSummary={Boolean(exitLabel)} open={open} expandable={expandable} onToggle={() => setOpen(!open)}>
    <div className="dsh-body">
      {/* A screenshot or a picture the call returned, read from disk only once the row is open. */}
      {open && images.length ? <ToolImages paths={images} /> : null}
      {item.kind === "command" || activity === "commands"
        ? <div className="dsh-terminal">
          <div className="dsh-terminal-cmd"><span aria-hidden="true">$ </span>{dshCommandText(item)}</div>
          {/* The status line the capsule now says is left out, as TerminalBlock leaves out its marker. */}
          {item.output ? <pre className="dsh-terminal-out">{exitLabel ? item.output.replace(/^\s*Exit code:? -?\d+[^\S\r\n]*\r?\n/, "") : item.output}</pre> : null}
        </div>
        : files.some((file) => file.diff)
          ? files.map((file) => <div key={file.path} className="dsh-diff">
            {files.length > 1 ? <div className="dsh-diff-path">{file.path}</div> : null}
            {/* Numbered as Claude Code numbers a change; dsh's tint and bar come from its CSS. */}
            {file.diff ? <EditDiff diff={file.diff} /> : null}
          </div>)
          : <div className="dsh-io">
            {item.input ? <div className="dsh-io-section"><span className="dsh-io-label">IN</span><span className="dsh-io-text">{prettyJson(item.input)}</span></div> : null}
            {item.input && item.output ? <span className="dsh-io-divider" aria-hidden="true" /> : null}
            {item.output ? <div className="dsh-io-section"><span className="dsh-io-label">OUT</span>
              <span className="dsh-io-text" data-error={tone === "error" || undefined}>{item.output}</span></div> : null}
          </div>}
    </div>
  </DshRow>;
}

/**
 * One row of a group (exported for its tests). A row of a turn that is no longer live is settled
 * whatever its stored status: reasoning items whose completion never arrived otherwise kept their
 * shimmer for good, and a long chat repainted a hundred of them every frame.
 */
export function DshItem({ item: stored, live = true }: { item: ChatLiveItem; live?: boolean }) {
  const item = live || stored.status !== "running" ? stored : { ...stored, status: "completed" as const };
  if (item.answered) return <AnsweredRecord question={item.answered.question} answer={item.answered.answer} />;
  if (item.kind === "reasoning") return <DshThink item={item} />;
  if (item.kind === "message") return <div className="dsh-reply"><StreamingMarkdown text={item.text} live={item.status === "running"} /></div>;
  if (item.kind === "steer") return <DshSteer text={item.text} receipt={item.receipt} />;
  return <DshTool item={item} />;
}

/** A message steered into the turn, drawn as the chat draws any message the person sent, with its read receipt. */
function DshSteer({ text, receipt }: { text: string; receipt?: SteerReceipt }) {
  const sent = useContext(SentMessageView);
  return <div className="cx-user cx-steer">{sent(text)}{receipt ? <div className="cx-msg-foot"><SteerReceiptMark receipt={receipt} /></div> : null}</div>;
}

/** How long a running group keeps a live heading before showing a newer one (ChatGroupSeat, 150ms). */
const LIVE_TITLE_MIN_MS = 150;

/**
 * useStableLiveProcessTitle: a live heading stays up at least 150ms, keeping only the newest one
 * waiting; a group that closes shows its finished heading at once.
 */
function useHeldTitle<T extends { label: string }>(title: T, live: boolean): T {
  const [shown, setShown] = useState(title);
  const shownAt = useRef(Date.now());
  const newest = useRef(title);
  newest.current = title;
  useEffect(() => {
    if (!live || title.label === shown.label) return;
    const timer = window.setTimeout(() => { shownAt.current = Date.now(); setShown(newest.current); }, Math.max(0, shownAt.current + LIVE_TITLE_MIN_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [live, title.label, shown.label]);
  return live ? shown : title;
}

/**
 * ChatGroupSeat: a run of thinking and tool calls under one heading, its kind of work's icon
 * turning into a chevron on hover. Open, it scrolls inside min(400px, 50vh) with faded edges.
 * A running group (`live`: nothing has closed it yet) reads what it is doing now and shimmers;
 * opened by hand it starts at its newest row and follows new rows while scrolled to the bottom
 * (use-process-scroll.ts), where a closed group opens at its top.
 */
function DshGroup({ items, live, turnLive }: { items: ChatLiveItem[]; live: boolean; turnLive: boolean }) {
  const [open, setOpen] = useState(false);
  const [edges, setEdges] = useState({ up: false, down: false });
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const start = useRef<"top" | "bottom" | null>(null);
  const following = useRef(false);
  const measure = () => {
    const box = body.current;
    if (!box) return;
    following.current = box.scrollTop >= box.scrollHeight - box.clientHeight - 1;
    setEdges({ up: box.scrollTop > 1, down: box.scrollTop < box.scrollHeight - box.clientHeight - 1 });
  };
  useLayoutEffect(() => {
    const box = body.current;
    if (!open || !box) return;
    if (start.current) box.scrollTop = start.current === "bottom" ? box.scrollHeight : 0;
    start.current = null;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current) box.scrollTop = box.scrollHeight;
      measure();
    });
    observer.observe(box);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [open]);
  const toggle = () => {
    if (!open) start.current = live ? "bottom" : "top";
    setOpen(!open);
  };
  const now = useHeldTitle(live ? dshLiveTitle(items) : { activity: dshGroupActivity(items), label: dshProcessTitle(items) }, live);
  return <div className="dsh-group" data-open={open || undefined}>
    <button type="button" className="dsh-group-title" aria-expanded={open} data-process-activity={now.activity} onClick={toggle}>
      <span className="dsh-group-leading" aria-hidden="true">
        <span className="dsh-group-icon">{now.activity === "thinking" ? GROUP_THINK : ACTIVITY_ICON[now.activity]}</span>
        <span className="dsh-group-chevron">{open ? ICON.up : ICON.down}</span>
      </span>
      <span className={`dsh-group-label${live ? " dsh-shimmer" : ""}`}>{now.label}</span>
    </button>
    {open ? <div ref={body} className={`dsh-group-body${edges.up ? " fade-top" : ""}${edges.down ? " fade-bottom" : ""}`} onScroll={measure}>
      <div ref={content} className="dsh-flow">{items.map((item) => <DshItem key={item.id} item={item} live={turnLive} />)}</div>
    </div> : null}
  </div>;
}

/**
 * A card's work as DeepSeek Desktop's Standard view lays it out: groups between the replies, each
 * folded under its heading. Only the last group of a running card is live; a reply or a steered
 * message after a group closes it.
 */
function DshFlow({ items, live, finished, hideReply }: { items: ChatLiveItem[]; live: boolean; finished: boolean; hideReply?: string }) {
  // The reply is the turn's messages joined: each one in it shows once, in the reply (withoutReplied).
  const tidy = withoutReplied(tidyTimeline(steerReceipts(items, finished)), hideReply);
  const segments = dshSegments(tidy);
  return <div className="dsh-flow">{segments.map((segment, index) => segment.kind === "item"
    ? <DshItem key={segment.item.id} item={segment.item} live={live} />
    : <DshGroup key={segment.key} items={segment.items} live={live && index === segments.length - 1} turnLive={live} />)}</div>;
}

function DshStepWork({ step, useWork, answer }: { step: ChatStep; useWork: UseStepWork; answer?: string }) {
  const work = useWork(step, true) ?? [];
  // A retried single card's earlier attempts come first, folded, as in a team card's row: they were
  // not shown at all here, and the other view drew them under the new attempt's work.
  const earlier = <EarlierRounds rounds={step.earlier} />;
  if (!work.length) return <>{earlier}{step.hasWork && !step.working ? <p className="dsh-hint">Loading…</p> : null}</>;
  return <>{earlier}<SteerReader.Provider value={steerReader(step)}>
    <DshFlow items={work} live={Boolean(step.working)} finished={!step.working && step.state === "finished"} hideReply={answer} />
  </SteerReader.Provider></>;
}

/** A team card as one row: its name and what it is doing or how it ended, opening on its own work. */
function DshAgent({ step, useWork, answer }: { step: ChatStep; useWork: UseStepWork; answer?: string }) {
  const live = Boolean(step.working);
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? (live || Boolean(step.error));
  const work = useWork(step, open);
  const tone: Tone = step.error ? "error" : live ? "running" : step.state === "cancelled" ? "stopped" : "ok";
  const summary = live ? (step.working!.activity || dshLiveTitle(work ?? []).label)
    : step.error ? step.error.split(/\r?\n/)[0] : step.verdict || (step.state === "finished" ? "Completed" : step.state);
  return <DshRow className="dsh-agent" icon={ICON.sparkle} title={step.name} summary={summary} running={live} tone={tone}
    open={open} expandable={Boolean(step.hasWork || work?.length || step.text || step.earlier?.length)} onToggle={() => setChosen(!open)}>
    <div className="dsh-agent-body">
      <EarlierRounds rounds={step.earlier} />
      {work?.length ? <SteerReader.Provider value={steerReader(step)}>
        <DshFlow items={work} live={live} finished={!live && step.state === "finished"} hideReply={answer} />
      </SteerReader.Provider> : null}
      {step.text && step.text.trim() !== answer?.trim() ? <div className="dsh-reply"><ChatMarkdown text={step.text} /></div> : null}
    </div>
  </DshRow>;
}

/** RunningStatus: a hairline over the whale's tail and "Deep diving for 1m 4s ···", in DeepSeek blue. */
function DshRunning({ since, divider, heardAt, retry = "", refusal = null, asking = false }: { since?: number; divider: boolean; heardAt?: number; retry?: string; refusal?: CpaRefusal | null; asking?: boolean }) {
  const now = useNow(true);
  // A long turn can go quiet for many minutes (a slow model request): say how long, so a quiet turn
  // does not look frozen, and say plainly when it has been quiet as long as a stuck one. A turn whose
  // agent is waiting out a model error says that instead (dshRetryNote), or CPA refusing its model
  // (a subagent's requests too, which post no retry notice). One waiting on the person's answer
  // (`asking`) is never "may be stuck".
  const quietNote = retry || `${cpaRefusalNote(refusal, now)}${dshQuietNote(heardAt, now, asking)}`;
  const { onRestart, restarting } = useContext(TurnRestart);
  return <div className="dsh-running" role="status" aria-live="polite">
    {divider ? <span className="dsh-running-divider" aria-hidden="true" /> : null}
    <span className="dsh-running-content">
      <span className="dsh-whale" aria-hidden="true">
        <span className="dsh-whale-animated" />
        <svg className="dsh-whale-still" width="100%" height="100%" viewBox="0 0 16 16" fill="none"><path d={WHALE} stroke="currentColor" strokeWidth={1} /></svg>
      </span>
      <span className="dsh-shimmer is-deep">{since ? `Deep diving for ${dshDuration(now - since)}${quietNote} ···` : `Deep diving${quietNote}`}</span>
      {/* A stuck turn has something to press here too (see TurnRunning). */}
      {quietNote.includes("may be stuck") && onRestart ? <button type="button" className="cx-turn-restart" onClick={onRestart} disabled={restarting}
        title="Stop this turn and have the same agent continue where it left off">{restarting ? "Restarting…" : "Restart"}</button> : null}
    </span>
  </div>;
}

/**
 * When each turn the chat saw end ended: AO keeps when a card started, not when it finished, so a
 * turn that ended while the chat was open says "Completed in 1m 4s" and an older one "Completed"
 * (DeepSeek Harness's own word when it has no time).
 */
const ENDED = new Map<string, number>();
/** Turns this chat watched running, so only a turn seen ending gets an end time. */
const WATCHED = new Set<string>();

/**
 * `errorShownBelow`: the chat's failed-step card shows this turn's error, so the turn leaves it out.
 * `refusal`: CPA refusing the running turn's model (cpaRefusalNote), said on its "Deep diving" line.
 * `beforeStatus`: what goes right above that line while the turn runs (the chat's steers on their
 * way): the line stays the turn's last row, as DeepSeek Harness keeps its status under everything.
 * `headed`: the chat's reply head (ChatReplyHead) already says how the turn ended and how long it
 * took, so the fold reads "Show work" and a failed or stopped turn, always open, has no line at all.
 */
export type DshTurnWorkProps = { turn: ChatTurn; live: boolean; expanded: boolean; useWork: UseStepWork; errorShownBelow?: boolean; refusal?: CpaRefusal | null; beforeStatus?: ReactNode; headed?: boolean };

/**
 * A DeepSeek turn's work. Running: its work in groups, the last one live, "Deep diving" under them. Ended: "Completed in
 * 1m 4s" heads it, folded unless the chat shows work details; a failed or stopped turn stays open.
 * The chat memoizes it with its own check of what a turn shows.
 */
export function DshTurnWork({ turn, live, expanded, useWork, errorShownBelow = false, refusal = null, beforeStatus = null, headed = false }: DshTurnWorkProps) {
  const steps = [...turn.steps, ...(turn.final ? [turn.final] : [])];
  const failed = steps.some((step) => step.error);
  const stopped = turn.status === "stopped";
  const [chosen, setChosen] = useState<boolean | null>(null);
  if (live) ENDED.delete(turn.key);
  else if (turn.startedAtMs && !ENDED.has(turn.key) && WATCHED.has(turn.key)) ENDED.set(turn.key, Date.now());
  if (live) WATCHED.add(turn.key);
  // The newest sign of life across the turn's working cards.
  const heardAt = Math.max(0, ...steps.map((step) => step.working?.heardAtMs ?? 0)) || undefined;
  if (!steps.length) return live ? <>{beforeStatus}<DshRunning since={turn.startedAtMs} divider={false} /></> : null;
  const alwaysOpen = live || failed || stopped;
  const open = alwaysOpen || (chosen ?? expanded);
  const answer = turn.final?.text;
  const single = steps.length === 1;
  const work = single
    ? <DshStepWork step={steps[0]} useWork={useWork} answer={answer} />
    : steps.map((step) => <DshAgent key={step.key} step={step} useWork={useWork} answer={step === turn.final ? answer : undefined} />);
  // The end its cards kept, or the moment this window saw it end (cards saved before builds that kept one).
  const ended = turn.endedAtMs ?? ENDED.get(turn.key);
  const label = headed ? (open ? "Hide work" : "Show work")
    : stopped ? "Stopped" : failed ? "Failed" : ended && turn.startedAtMs ? "Completed in " : "Completed";
  return <div className="dsh-turn-work">
    {!live && !(headed && alwaysOpen) ? <button type="button" className="dsh-turn-process" data-open={open || undefined} disabled={alwaysOpen}
      aria-expanded={open} onClick={() => setChosen(!open)}>
      <span className="dsh-turn-process-label">{label}{label === "Completed in " ? <span className="dsh-num">{dshDuration(ended! - turn.startedAtMs!)}</span> : null}</span>
      {alwaysOpen ? null : <span className="dsh-turn-process-chevron">{ICON.down}</span>}
    </button> : null}
    {open ? <div className="dsh-process">{work}</div> : null}
    {errorShownBelow ? null : steps.filter((step) => step.error).map((step) => <div key={`error:${step.key}`} className="dsh-turn-error">
      <span className="dsh-turn-error-title">This turn failed</span><span className="dsh-turn-error-message">{step.error}</span>
    </div>)}
    {live ? beforeStatus : null}
    {live ? <DshRunning since={turn.startedAtMs} divider heardAt={heardAt} retry={dshRetryNote(steps)} refusal={refusal}
      asking={steps.some((step) => waitsForPerson(step.working?.activity))} /> : null}
  </div>;
}
