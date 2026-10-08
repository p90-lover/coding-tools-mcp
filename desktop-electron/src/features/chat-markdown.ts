// A small Markdown reader for chat answers, Codex-style: headings, paragraphs, lists, quotes,
// rules and fenced code, with inline code, bold, italic and links. It returns plain data that
// React renders as elements, so model output never becomes HTML.

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "link"; text: string; href: string };

export type MdBlock =
  | { kind: "heading"; level: number; inline: MdInline[] }
  | { kind: "paragraph"; inline: MdInline[] }
  | { kind: "list"; ordered: boolean; start: number; items: MdInline[][] }
  | { kind: "quote"; inline: MdInline[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "rule" };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

/** Only web and mail links become clickable; anything else stays text. */
export function safeHref(href: string): string | null {
  const value = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(value) ? value : null;
}

export function parseInline(source: string): MdInline[] {
  const out: MdInline[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ kind: "text", text }); text = ""; } };
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const code = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest);
    if (code) { flush(); out.push({ kind: "code", text: code[2].replace(/^ (.*) $/, "$1") }); index += code[0].length; continue; }
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      const href = safeHref(link[2]);
      flush();
      out.push(href ? { kind: "link", text: link[1], href } : { kind: "text", text: link[1] });
      index += link[0].length; continue;
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) { flush(); out.push({ kind: "strong", children: parseInline(strong[2]) }); index += strong[0].length; continue; }
    const em = /^(\*|_)(?=\S)([^*_\n]*?\S)\1(?![\w*])/.exec(rest);
    if (em && (em[1] === "*" || !/\w/.test(source[index - 1] ?? ""))) {
      flush(); out.push({ kind: "em", children: parseInline(em[2]) }); index += em[0].length; continue;
    }
    const url = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest);
    if (url && !/\w/.test(source[index - 1] ?? "")) { flush(); out.push({ kind: "link", text: url[0], href: url[0] }); index += url[0].length; continue; }
    text += source[index];
    index += 1;
  }
  flush();
  return out;
}

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = FENCE.exec(line);
    if (fence) {
      endParagraph();
      const body: string[] = [];
      index += 1;
      const closes = (candidate: string) => {
        const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(candidate);
        return Boolean(close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length);
      };
      while (index < lines.length && !closes(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: "code", lang: fence[2] || "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) { endParagraph(); continue; }
    const heading = HEADING.exec(line);
    if (heading) { endParagraph(); blocks.push({ kind: "heading", level: heading[1].length, inline: parseInline(heading[2]) }); continue; }
    if (RULE.test(line)) { endParagraph(); blocks.push({ kind: "rule" }); continue; }
    const quote = QUOTE.exec(line);
    if (quote) {
      endParagraph();
      const body = [quote[1]];
      while (index + 1 < lines.length && QUOTE.test(lines[index + 1])) body.push(QUOTE.exec(lines[++index])![1]);
      blocks.push({ kind: "quote", inline: parseInline(body.join("\n")) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      endParagraph();
      const isOrdered = Boolean(ordered);
      const items: string[] = [(bullet ? bullet[1] : ordered![2])];
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        const nextItem = isOrdered ? ORDERED.exec(next) : BULLET.exec(next);
        if (nextItem) { items.push(isOrdered ? nextItem[2] : nextItem[1]); index += 1; continue; }
        // An indented line continues the item above it.
        if (/^\s{2,}\S/.test(next) && !FENCE.test(next)) { items[items.length - 1] += "\n" + next.trim(); index += 1; continue; }
        break;
      }
      blocks.push({ kind: "list", ordered: isOrdered, start: isOrdered ? Number(ordered![1]) : 1, items: items.map(parseInline) });
      continue;
    }
    paragraph.push(line);
  }
  endParagraph();
  return blocks;
}
