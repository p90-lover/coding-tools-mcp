import { useState } from "react";
import type { ReactNode } from "react";
import { parseMarkdown, type MdInline } from "./chat-markdown";

function Inline({ parts }: { parts: MdInline[] }) {
  return <>{parts.map((part, index) => {
    switch (part.kind) {
      case "code": return <code key={index}>{part.text}</code>;
      case "strong": return <strong key={index}><Inline parts={part.children} /></strong>;
      case "em": return <em key={index}><Inline parts={part.children} /></em>;
      case "link": return <a key={index} href={part.href} target="_blank" rel="noreferrer noopener">{part.text}</a>;
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

/** An agent's answer rendered as Markdown (headings, lists, code, links), never as raw HTML. */
export function ChatMarkdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return <div className="cx-md">{blocks.map((block, index): ReactNode => {
    switch (block.kind) {
      case "heading": {
        const Tag = (`h${Math.min(6, block.level + 2)}`) as "h3" | "h4" | "h5" | "h6";
        return <Tag key={index}><Inline parts={block.inline} /></Tag>;
      }
      case "list": return block.ordered
        ? <ol key={index} start={block.start}>{block.items.map((item, at) => <li key={at}><Inline parts={item} /></li>)}</ol>
        : <ul key={index}>{block.items.map((item, at) => <li key={at}><Inline parts={item} /></li>)}</ul>;
      case "quote": return <blockquote key={index}><Inline parts={block.inline} /></blockquote>;
      case "code": return <CodeBlock key={index} lang={block.lang} text={block.text} />;
      case "rule": return <hr key={index} />;
      default: return <p key={index}><Inline parts={block.inline} /></p>;
    }
  })}</div>;
}
