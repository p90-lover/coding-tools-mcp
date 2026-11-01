// A small Markdown reader for chat answers, Codex-style: headings, paragraphs, lists, quotes,
// rules, tables and fenced code, with inline code, bold, italic, links and images. It returns plain data that
// React renders as elements, so model output never becomes HTML.

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "link"; text: string; href: string }
  | { kind: "image"; alt: string; src: string }
  // An answer citing the person's Nth annotation (:codex-annotation{index="N"}, as Codex asks for).
  | { kind: "annotation"; index: number };

export type MdBlock =
  | { kind: "heading"; level: number; inline: MdInline[] }
  | { kind: "paragraph"; inline: MdInline[] }
  | { kind: "list"; ordered: boolean; start: number; items: MdInline[][] }
  | { kind: "quote"; inline: MdInline[] }
  | { kind: "visualize"; title: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; headers: MdInline[][]; rows: MdInline[][][]; align: ("left" | "center" | "right" | undefined)[] }
  | { kind: "rule" };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

/** Only web/mail links become clickable; images use credential-free HTTPS. */
export function safeHref(href: string, image = false): string | null {
  const wrapped = href.trim();
  const value = wrapped.startsWith("<") && wrapped.endsWith(">") ? wrapped.slice(1, -1) : wrapped;
  if (image) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  return /^(https?:\/\/|mailto:)/i.test(value) ? value : null;
}

export function parseInline(source: string): MdInline[] {
  const out: MdInline[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ kind: "text", text }); text = ""; } };
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const escaped = source.charCodeAt(index + 1);
    if (source[index] === "\\" && ((escaped >= 33 && escaped <= 47) || (escaped >= 58 && escaped <= 64)
      || (escaped >= 91 && escaped <= 96) || (escaped >= 123 && escaped <= 126))) {
      text += source[index + 1]; index += 2; continue;
    }
    const cite = /^:codex-annotation\{index="?(\d{1,3})"?\}/.exec(rest);
    if (cite) { flush(); out.push({ kind: "annotation", index: Number(cite[1]) }); index += cite[0].length; continue; }
    const code = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest);
    if (code) { flush(); out.push({ kind: "code", text: code[2].replace(/^ (.*) $/, "$1") }); index += code[0].length; continue; }
    const image = /^!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s]+)\)/.exec(rest);
    if (image) {
      const src = safeHref(image[2], true);
      flush();
      out.push(src ? { kind: "image", alt: image[1], src } : { kind: "text", text: image[1] || "Image" });
      index += image[0].length; continue;
    }
    const link = /^\[([^\]\n]+)\]\((<[^>\n]+>|[^)\s]+)\)/.exec(rest);
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

function tableCells(line: string): string[] {
  const source = line.trim();
  const cells: string[] = [];
  let start = 0;
  let ticks = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\" && !ticks) { index += 1; continue; }
    if (source[index] === "`") {
      let end = index + 1;
      while (source[end] === "`") end += 1;
      const count = end - index;
      if (!ticks) ticks = count;
      else if (ticks === count) ticks = 0;
      index = end - 1;
    } else if (source[index] === "|" && !ticks) {
      cells.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  cells.push(source.slice(start).trim());
  if (source.startsWith("|") && cells[0] === "") cells.shift();
  if (source.endsWith("|") && cells.at(-1) === "") cells.pop();
  return cells;
}

export function parseMarkdown(source: string, visualizations = false): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) {
      const inline = parseInline(paragraph.join("\n"));
      const only = inline.filter((part) => !(part.kind === "text" && !part.text.trim()));
      if (only.length === 1 && only[0].kind === "code" && only[0].text.length > 80) blocks.push({ kind: "code", lang: "", text: only[0].text });
      else blocks.push({ kind: "paragraph", inline });
    }
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
    const reference = visualizations && !/^ {4}|^\t/.test(line) ? /^\s*visualize([^\r\n]+)\s*$/.exec(line) : null;
    if (reference) {
      try {
        const value: unknown = JSON.parse(reference[1]);
        if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { path?: unknown }).path === "string") {
          const title = (value as { title?: unknown }).title;
          endParagraph();
          blocks.push({ kind: "visualize", title: typeof title === "string" && title.trim() ? title.slice(0, 250) : "Interactive panel" });
          continue;
        }
      } catch { /* Malformed and partial references remain inert text. */ }
    }
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
    if (line.includes("|") && index + 1 < lines.length) {
      const headers = tableCells(line);
      const divider = tableCells(lines[index + 1]);
      if (headers.length && divider.length === headers.length && divider.every(cell => /^:?-+:?$/.test(cell))) {
        endParagraph();
        const tableStart = index;
        index += 1;
        const rowLines: string[] = [];
        while (index + 1 < lines.length) {
          const next = lines[index + 1];
          if (!next.trim() || FENCE.test(next) || HEADING.test(next) || RULE.test(next)
            || QUOTE.test(next) || BULLET.test(next) || ORDERED.test(next)) break;
          rowLines.push(next);
          index += 1;
        }
        // Sparse untrusted tables must not multiply a small reply into millions of React cells.
        if (headers.length * (rowLines.length + 1) > 4_096) {
          blocks.push({ kind: "code", lang: "text", text: lines.slice(tableStart, index + 1).join("\n") });
          continue;
        }
        const rows = rowLines.map(next => {
          const row = tableCells(next);
          return headers.map((_, column) => parseInline(row[column] ?? ""));
        });
        const align = divider.map(cell => cell.endsWith(":") ? cell.startsWith(":") ? "center" as const : "right" as const
          : cell.startsWith(":") ? "left" as const : undefined);
        blocks.push({ kind: "table", headers: headers.map(parseInline), rows, align });
        continue;
      }
    }
    paragraph.push(line);
  }
  endParagraph();
  return blocks;
}
