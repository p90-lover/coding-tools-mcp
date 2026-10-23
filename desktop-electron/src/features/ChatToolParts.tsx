import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChatMarkdown } from "./ChatMarkdown";
import { chatMessageReadable, numberedDiff, type ChatStepRound, type SteerReceipt, type ChatSentAttachment } from "./ao-chat";

// Parts of a chat turn both transcripts draw: the Claude Code one (AgentOrchestratorChat) and the
// DeepSeek Harness one (DshTranscript), so a fix to one is a fix to both.

/** Reads an attached image for its thumbnail and shows a file in its folder (the desktop app's). */
export type AttachmentAccess = { preview?: (path: string) => Promise<string>; reveal?: (path: string) => void };
export const Attachments = createContext<AttachmentAccess>({});
/** Thumbnails already read, by path: a poll re-renders every message, and each image is read once. */
const PREVIEWS = new Map<string, Promise<string>>();

export function SentImage({ item, onOpen }: { item: ChatSentAttachment; onOpen: (url: string) => void }) {
  const { preview } = useContext(Attachments);
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!item.path || !preview) return;
    let current = true;
    let read = PREVIEWS.get(item.path);
    if (!read) { read = preview(item.path); PREVIEWS.set(item.path, read); }
    read.then((value) => { if (current) setUrl(value); }, () => { PREVIEWS.delete(item.path!); if (current) setMissing(true); });
    return () => { current = false; };
  }, [item.path, preview]);
  return <button type="button" className={`cx-sent-image${missing ? " is-missing" : ""}`} title={item.path} disabled={!url} onClick={() => url && onOpen(url)}>
    {url ? <img src={url} alt={item.name} /> : <span>{missing ? "Image not found" : item.name}</span>}
  </button>;
}

/** An image shown full size over the chat; a click outside it or Escape closes it. */
export function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return <div className="cx-lightbox" role="dialog" aria-label="Image preview" onClick={onClose}>
    <img src={url} alt="" onClick={(event) => event.stopPropagation()} />
    <button type="button" className="cx-lightbox-close" aria-label="Close image preview" onClick={onClose}>×</button>
  </div>;
}

/**
 * The images a tool call returned (a screenshot, a picture it read), as thumbnails that open full
 * size. Render it only once the call's row is open: each thumbnail reads its file from disk.
 */
export function ToolImages({ paths }: { paths: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return <div className="cx-sent-attachments cx-tool-images">
    {paths.map((path, index) => <SentImage key={`${path}:${index}`} item={{ image: true, name: path.split(/[\\/]/).pop() || path, path }} onOpen={setOpen} />)}
    {open ? <ImageLightbox url={open} onClose={() => setOpen(null)} /> : null}
  </div>;
}

/**
 * How a message the person sent is drawn (AgentOrchestratorChat provides its SentMessage: attached
 * images as thumbnails). A steer in the DeepSeek transcript showed "Attached image: <path>" as text.
 */
export const SentMessageView = createContext<(text: string) => ReactNode>(
  (text) => <div className="cx-bubble"><p>{chatMessageReadable(text)}</p></div>);

/**
 * A stuck turn's Restart (AgentOrchestratorChat's restartTurn), for a running footer drawn inside a
 * memoized transcript (DshTurnWork) that a prop would not reach.
 */
export const TurnRestart = createContext<{ onRestart?: () => void; restarting: boolean }>({ restarting: false });

/** Who reads the person's steers in this card ("Read by Claude"), from steerReader. */
export const SteerReader = createContext("Claude");

/**
 * Claude Code's read receipt under a message sent mid-turn (claude.ai's epitaxy user rows): a check
 * at half strength, "Unread", while the agent holds it, and a double check, "Read by Claude", once its
 * model has read it. Its tooltip shows at once (delay 0), and the mark stays shown, not only on hover.
 */
export function SteerReceiptMark({ receipt }: { receipt?: SteerReceipt }) {
  const reader = useContext(SteerReader);
  if (!receipt) return null;
  const words = receipt === "read" ? `Read by ${reader}` : receipt === "sending" ? "Sending…" : "Unread";
  return <span className="cx-receipt" data-receipt={receipt} role="img" aria-label={words} data-tip={words} tabIndex={0}>
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {receipt === "read" ? <><path d="M18 6 7 17l-5-5" /><path d="m22 10-7.5 7.5L13 16" /></> : <path d="M20 6 9 17l-5-5" />}
    </svg>
  </span>;
}

/**
 * A card's earlier rounds (a reviewer's past cycles, a retried card's past attempts), oldest first,
 * each folded under its label and verdict: the history of a review stays traceable without crowding
 * out the round in progress.
 */
export function EarlierRounds({ rounds }: { rounds?: ChatStepRound[] }) {
  if (!rounds?.length) return null;
  return <div className="cx-step-earlier">
    {rounds.map((round) => <details key={round.label} className="cx-step-round">
      <summary><span>{round.label}</span>{round.verdict ? <span className={`cx-step-round-verdict is-${round.verdict.toLowerCase()}`}>{round.verdict.replace(/_/g, " ")}</span> : null}</summary>
      <ChatMarkdown text={round.text} />
    </details>)}
  </div>;
}

/**
 * A shield on a tool call that needed approval, saying who let it run ("Allowed by the reviewer:
 * …"): with "Approve for me" no card asks any more, so this is where the answer shows.
 */
export function ApprovedMark({ text }: { text?: string }) {
  if (!text) return null;
  const denied = /^Denied/.test(text);
  return <span className={`cx-approved${denied ? " is-denied" : ""}`} title={text} aria-label={text} role="img">
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M8 1.5 13 3.4v4.2c0 3-2.1 5.6-5 6.9-2.9-1.3-5-3.9-5-6.9V3.4L8 1.5Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      {denied ? <path d="m6 6 4 4m0-4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        : <path d="m5.6 8.1 1.7 1.7 3.2-3.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  </span>;
}

/**
 * An edit's changed lines as Claude Code shows them: old and new line numbers in two columns, then
 * the line with its +/− mark; unchanged lines around the change give it its place. Parsed once per
 * diff text, since a poll rebuilds the row every second.
 */
export function EditDiff({ diff }: { diff: string }) {
  const lines = useMemo(() => numberedDiff(diff), [diff]);
  return <div className="cx-edit-diff"><table><tbody>{lines.map((line, index) => line.kind === "hunk"
    ? <tr key={index} className="is-hunk"><td colSpan={3}>{line.text}</td></tr>
    : <tr key={index} className={`is-${line.kind}`}>
      <td className="cx-edit-num">{line.old ?? ""}</td><td className="cx-edit-num">{line.new ?? ""}</td>
      <td className="cx-edit-code"><span className="cx-edit-mark" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>{line.text}</td>
    </tr>)}</tbody></table></div>;
}

/**
 * A question the person answered, as Claude Code shows one in its transcript: the question, and
 * under it the answer they chose in quieter type, in a rounded box.
 */
export function AnsweredRecord({ question, answer }: { question: string; answer: string }) {
  return <div className="cx-answered" role="group" aria-label="Answered question">
    <p className="cx-answered-question">{question}</p>
    <p className="cx-answered-answer">{answer}</p>
  </div>;
}

// How often a message that is still streaming redraws. A fast model (200+ tokens a second) grew
// its text on every poll, and each change parsed the whole message as Markdown again.
const STREAM_REDRAW_MS = 250;
/** `text` as shown: while `live`, at most once per STREAM_REDRAW_MS (always its latest); then as it is. */
function useThrottledText(text: string, live: boolean): string {
  const [shown, setShown] = useState(text);
  const last = useRef(0);
  useEffect(() => {
    if (!live) { setShown(text); return undefined; }
    const wait = STREAM_REDRAW_MS - (Date.now() - last.current);
    if (wait <= 0) { last.current = Date.now(); setShown(text); return undefined; }
    const timer = window.setTimeout(() => { last.current = Date.now(); setShown(text); }, wait);
    return () => window.clearTimeout(timer);
  }, [text, live]);
  return live ? shown : text;
}

/** A message as Markdown, redrawn at most every STREAM_REDRAW_MS while it still streams. */
export function StreamingMarkdown({ text, live }: { text: string; live: boolean }) {
  return <ChatMarkdown text={useThrottledText(text, live)} />;
}
