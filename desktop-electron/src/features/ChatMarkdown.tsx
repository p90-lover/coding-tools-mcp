import { memo, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { parseMarkdown, type MdInline } from "./chat-markdown";

function Inline({ parts }: { parts: MdInline[] }) {
  return <>{parts.map((part, index) => {
    switch (part.kind) {
      case "code": return <code key={index}>{part.text}</code>;
      case "strong": return <strong key={index}><Inline parts={part.children} /></strong>;
      case "em": return <em key={index}><Inline parts={part.children} /></em>;
      case "link": return <a key={index} href={part.href} target="_blank" rel="noreferrer noopener">{part.text}</a>;
      case "image": return <a key={index} href={part.src} target="_blank" rel="noreferrer noopener"><img className="cx-md-image" src={part.src} alt={part.alt} loading="lazy" referrerPolicy="no-referrer" /></a>;
      case "annotation": return <span key={index} className="cx-annotation-ref" title={`Your annotation ${part.index}`}>{part.index}</span>;
      default: return <span key={index}>{part.text}</span>;
    }
  })}</>;
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="cx-code">
    <div className="cx-code-head"><span>{lang || "text"}</span>
      <button type="button" onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>
        {copied ? "Copied" : "Copy"}</button></div>
    <pre><code>{text}</code></pre>
  </div>;
}

/**
 * An agent's answer rendered as Markdown (headings, lists, code, links), never as raw HTML.
 * Memoized on its text: the chat re-renders every second while an agent works, and re-parsing
 * every earlier answer each time made long chats lag; an unchanged answer now skips both.
 */
export const ChatMarkdown = memo(function ChatMarkdown({ text, onVisualize }: { text: string; onVisualize?: () => void }) {
  const visualizations = Boolean(onVisualize);
  const blocks = useMemo(() => parseMarkdown(text, visualizations), [text, visualizations]);
  return <div className="cx-md">{blocks.map((block, index): ReactNode => {
    switch (block.kind) {
      case "visualize": return <p key={index}><button type="button" className="cx-chip" onClick={onVisualize}>{block.title}</button><small> · Open in Preview when chat previews are enabled. Offline fragments up to 128 KiB.</small></p>;
      case "heading": {
        const Tag = (`h${Math.min(6, block.level + 2)}`) as "h3" | "h4" | "h5" | "h6";
        return <Tag key={index}><Inline parts={block.inline} /></Tag>;
      }
      case "list": return block.ordered
        ? <ol key={index} start={block.start}>{block.items.map((item, at) => <li key={at}><Inline parts={item} /></li>)}</ol>
        : <ul key={index}>{block.items.map((item, at) => <li key={at}><Inline parts={item} /></li>)}</ul>;
      case "quote": return <blockquote key={index}><Inline parts={block.inline} /></blockquote>;
      case "code": return <CodeBlock key={index} lang={block.lang} text={block.text} />;
      case "table": return <div key={index} className="cx-md-table"><table>
        <thead><tr>{block.headers.map((cell, column) => <th key={column} scope="col" style={{ textAlign: block.align[column] }}><Inline parts={cell} /></th>)}</tr></thead>
        <tbody>{block.rows.map((row, at) => <tr key={at}>{row.map((cell, column) => <td key={column} style={{ textAlign: block.align[column] }}><Inline parts={cell} /></td>)}</tr>)}</tbody>
      </table></div>;
      case "rule": return <hr key={index} />;
      default: return <p key={index}><Inline parts={block.inline} /></p>;
    }
  })}</div>;
});
