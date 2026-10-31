"use strict";

// A small, dependency-free MIME parse + HTML sanitize pass for Runtime -> Email previews.
//
// This is the no-dependency baseline the design's implementation plan can later swap for
// postal-mime + DOMPurify (see docs/specs/runtime-cloudflare-email/design.md, "Safe preview").
// It handles single-part text/plain and text/html plus multipart/alternative and multipart/mixed
// with base64 / quoted-printable transfer encodings. The real containment for the rendered HTML
// is the renderer's sandboxed, script-disabled, network-blocked iframe; this sanitizer is
// defense-in-depth, not the only line.

function splitHeadersBody(section) {
  const boundary = section.search(/\r?\n\r?\n/);
  if (boundary === -1) return { headers: parseHeaders(section), body: "" };
  const headerText = section.slice(0, boundary);
  const body = section.slice(boundary).replace(/^\r?\n\r?\n/, "");
  return { headers: parseHeaders(headerText), body };
}

function parseHeaders(text) {
  const headers = {};
  // Unfold RFC 5322 continuation lines (a header wrapped onto an indented next line).
  const unfolded = text.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

function contentType(headers) {
  const raw = headers["content-type"] || "text/plain";
  const [type, ...params] = raw.split(";").map((s) => s.trim());
  const attrs = {};
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq === -1) continue;
    attrs[param.slice(0, eq).trim().toLowerCase()] = param.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return { type: type.toLowerCase(), attrs };
}

// Transfer encodings produce BYTES in the part's declared charset. Turning each =XX into its own
// character (the old approach) split multi-byte UTF-8, so "©" (=C2=A9) rendered as "Â©".
function decodeCharset(bytes, charset) {
  try { return new TextDecoder(charset || "utf-8").decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); } // unknown label: best effort
}

function quotedPrintableBytes(text) {
  const s = text.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s[i] === "=" ? s.slice(i + 1, i + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; continue; }
    const code = s.codePointAt(i);
    if (code < 0x80) { bytes.push(code); continue; }
    // A literal non-ASCII character (the Worker hands us text): keep it as UTF-8.
    if (code > 0xffff) i++;
    bytes.push(...Buffer.from(String.fromCodePoint(code), "utf8"));
  }
  return Buffer.from(bytes);
}

function decodeBody(body, headers, charset) {
  const encoding = (headers["content-transfer-encoding"] || "7bit").toLowerCase();
  if (encoding === "base64") {
    try { return decodeCharset(Buffer.from(body.replace(/\s+/g, ""), "base64"), charset); } catch { return body; }
  }
  if (encoding === "quoted-printable") return decodeCharset(quotedPrintableBytes(body), charset);
  return body;
}

// RFC 2047 encoded words, e.g. "=?UTF-8?B?5L2g5aW9?=" or "=?utf-8?Q?caf=C3=A9?=".
function decodeHeaderWords(value) {
  if (!value) return value ?? null;
  return decodeEncodedWords(value).replace(/\s+/g, " ").trim(); // a sender's "\n\n" in a subject is one space
}

function decodeEncodedWords(value) {
  return value
    .replace(/(\?=)\s+(?==\?)/g, "$1") // whitespace between adjacent encoded words is not content
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g, (whole, charset, kind, data) => {
      try {
        const bytes = kind.toUpperCase() === "B"
          ? Buffer.from(data, "base64")
          : quotedPrintableBytes(data.replace(/_/g, " "));
        return decodeCharset(bytes, charset);
      } catch { return whole; }
    });
}

function parseSection(section, out) {
  const { headers, body } = splitHeadersBody(section);
  const { type, attrs } = contentType(headers);
  if (type.startsWith("multipart/") && attrs.boundary) {
    const marker = `--${attrs.boundary}`;
    const parts = body.split(marker).slice(1);
    for (const part of parts) {
      if (part.startsWith("--")) break; // closing boundary
      parseSection(part.replace(/^\r?\n/, ""), out);
    }
    return;
  }
  const decoded = decodeBody(body, headers, attrs.charset);
  if (type === "text/html" && !out.html) out.html = decoded;
  else if (type === "text/plain" && !out.text) out.text = decoded;
  else if (headers["content-disposition"]?.includes("attachment")) {
    const nameMatch = /filename="?([^";]+)"?/i.exec(headers["content-disposition"]);
    out.attachments.push({ filename: nameMatch?.[1] ?? null, mimeType: type, size: decoded.length });
  }
}

// Async to match the postal-mime interface the design names, so swapping it later is a drop-in.
async function parseMessage(raw) {
  const out = { text: null, html: null, attachments: [], from: null, to: null, subject: null, date: null };
  Object.assign(out, parseHeaderSummary(raw));
  parseSection(raw, out);
  return out;
}

// A list row's one-line preview: the body's first words (plain text, else the HTML's text), not its
// headers. Parses at most the first PREVIEW_SCAN characters, so a large message costs no more.
const PREVIEW_SCAN = 256 * 1024;
const PREVIEW_BODIES = new Set(["style", "script", "head"]);
const HTML_SPACE = /\s/;
const HTML_NAME = /[a-z0-9:_-]/i;

// Move forward once through tags and quoted attributes. A missing body close is searched only
// once per blocked name: repeated unclosed <style> tags must not rescan the remaining message.
function* htmlParts(html, blockedBodies) {
  const unclosed = new Set();
  const endTag = /<\s*\/\s*([a-z0-9:_-]+)\s*>/gi;
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf("<", index);
    if (start === -1) { yield html.slice(index); return; }
    if (start > index) yield html.slice(index, start);
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      yield null;
      if (end === -1) return; // An unterminated comment hides the remainder.
      index = end + 3; continue;
    }
    let cursor = start + 1;
    while (HTML_SPACE.test(html[cursor] ?? "")) cursor += 1;
    const declaration = html[cursor] === "!" || html[cursor] === "?";
    const closing = html[cursor] === "/";
    if (declaration || closing) cursor += 1;
    while (HTML_SPACE.test(html[cursor] ?? "")) cursor += 1;
    const nameStart = cursor;
    if (!declaration && !/[a-z]/i.test(html[cursor] ?? "")) {
      yield { literal: true }; index = start + 1; continue;
    }
    while (HTML_NAME.test(html[cursor] ?? "")) cursor += 1;
    const name = html.slice(nameStart, cursor).toLowerCase();
    const attrsStart = cursor;
    let quote = "";
    for (; cursor < html.length; cursor += 1) {
      const char = html[cursor];
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">" || char === "<") break;
    }
    if (cursor === html.length) { yield null; return; } // Incomplete markup is neutralized.
    index = cursor + 1;
    if (html[cursor] === "<") { yield null; index = cursor; continue; }
    if (declaration) { yield null; continue; }
    if (!closing && blockedBodies?.has(name)) {
      if (!unclosed.has(name)) {
        endTag.lastIndex = index;
        let end;
        while ((end = endTag.exec(html))) if (end[1].toLowerCase() === name) break;
        if (end) index = endTag.lastIndex;
        else unclosed.add(name);
      }
      yield null; continue;
    }
    yield { name, closing, attrs: html.slice(attrsStart, cursor) };
  }
}

// Unlike an unanchored attribute regex, a bare name with no '=' is consumed as one token.
function htmlAttributes(source, allowedOnly = false) {
  const kept = [];
  let index = 0;
  while (index < source.length) {
    while (HTML_SPACE.test(source[index] ?? "")) index += 1;
    const start = index;
    while (HTML_NAME.test(source[index] ?? "")) index += 1;
    const name = source.slice(start, index), lower = name.toLowerCase();
    if (!name) { while (index < source.length && !HTML_SPACE.test(source[index])) index += 1; continue; }
    while (HTML_SPACE.test(source[index] ?? "")) index += 1;
    if (source[index] !== "=") continue;
    index += 1;
    while (HTML_SPACE.test(source[index] ?? "")) index += 1;
    const valueStart = index, quote = source[index] === '"' || source[index] === "'" ? source[index] : "";
    if (quote) {
      const end = source.indexOf(quote, index + 1);
      if (end === -1) break;
      index = end + 1;
    } else while (index < source.length && !HTML_SPACE.test(source[index])) index += 1;
    let raw = source.slice(valueStart, index);
    if (!raw || /^on[a-z]+$/i.test(name) || (allowedOnly && !ALLOWED_ATTRS.has(lower))) continue;
    const value = quote ? raw.slice(1, -1) : raw;
    if (["href", "src", "xlink:href"].includes(lower) && /^(?:javascript:|data:(?!image\/))/i.test(value.trimStart())) raw = '"#"';
    kept.push(`${name}=${raw}`);
  }
  return kept.length ? ` ${kept.join(" ")}` : "";
}

function bodyPreview(raw, max = 200) {
  const out = { text: null, html: null, attachments: [] };
  try { parseSection(String(raw ?? "").slice(0, PREVIEW_SCAN), out); } catch { return null; }
  let text = out.text;
  if (text === null) {
    const parts = [];
    for (const part of htmlParts(out.html || "", PREVIEW_BODIES)) parts.push(typeof part === "string" ? part : part?.literal ? "<" : " ");
    text = parts.join("").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, "\"");
  }
  const line = text.replace(/\s+/g, " ").trim();
  return line ? line.slice(0, max) : null;
}

// Headers only — cheap enough to run on every list row without touching a large body.
function parseHeaderSummary(raw) {
  const text = String(raw ?? "");
  const end = text.search(/\r?\n\r?\n/);
  const headers = parseHeaders(end === -1 ? text : text.slice(0, end));
  return {
    from: decodeHeaderWords(headers.from),
    to: decodeHeaderWords(headers.to),
    subject: decodeHeaderWords(headers.subject),
    date: headers.date ?? null,
  };
}

// --- HTML sanitizer -----------------------------------------------------------------------

// The hard safety floor, always enforced regardless of the allowlist below:
// strip whole <script>/<style>/<iframe>/<object> subtrees, on* handlers, and javascript:/data:
// URLs, and neutralize external resource loads (src/href to remote hosts).
const BLOCKED_BODIES = new Set(["script", "style", "iframe", "object"]);
const BLOCKED_TAGS = new Set([...BLOCKED_BODIES, "embed", "link", "meta", "base"]);

function stripDangerous(html) {
  const parts = [];
  for (const part of htmlParts(html, BLOCKED_BODIES)) {
    if (typeof part === "string") parts.push(part);
    else if (part?.literal) parts.push("&lt;");
    else if (part && !BLOCKED_TAGS.has(part.name)) parts.push(`<${part.closing ? "/" : ""}${part.name}${htmlAttributes(part.attrs)}>`);
  }
  return parts.join("");
}

// The element/attribute allowlist decides which formatting SURVIVES after the safety floor —
// a genuine policy choice with several valid answers (text-only vs. rich formatting).
// Rich formatting: the preview iframe is sandboxed without scripts and its CSP allows no
// network loads (img-src data: only), so inline style and layout markup are safe to keep.
// Forms, SVG/MathML, and unknown elements go; class/id are dropped since no stylesheet survives.
const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite",
  "code", "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption",
  "figure", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark",
  "ol", "p", "pre", "q", "s", "samp", "small", "span", "strike", "strong", "sub", "summary", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "var",
]);
const ALLOWED_ATTRS = new Set([
  "href", "src", "alt", "title", "width", "height", "style", "align", "valign", "bgcolor", "border",
  "cellpadding", "cellspacing", "colspan", "rowspan", "color", "face", "size", "dir", "lang", "start", "type",
]);

function applyAllowlist(html) {
  if (ALLOWED_TAGS.size === 0) return html; // no allowlist yet: safety floor still applied above
  const parts = [];
  for (const part of htmlParts(html)) {
    if (typeof part === "string") parts.push(part);
    else if (part?.literal) parts.push("&lt;");
    else if (part && ALLOWED_TAGS.has(part.name)) parts.push(`<${part.closing ? "/" : ""}${part.name}${htmlAttributes(part.attrs, true)}>`);
  }
  return parts.join("");
}

function sanitizeHtml(html) {
  return applyAllowlist(stripDangerous(String(html)));
}

module.exports = { parseMessage, parseHeaderSummary, bodyPreview, decodeHeaderWords, sanitizeHtml, stripDangerous };
