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

function decodeBody(body, headers) {
  const encoding = (headers["content-transfer-encoding"] || "7bit").toLowerCase();
  if (encoding === "base64") {
    try { return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"); } catch { return body; }
  }
  if (encoding === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return body;
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
  const decoded = decodeBody(body, headers);
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
  const { headers } = splitHeadersBody(raw);
  out.from = headers.from ?? null;
  out.to = headers.to ?? null;
  out.subject = headers.subject ?? null;
  out.date = headers.date ?? null;
  parseSection(raw, out);
  return out;
}

// --- HTML sanitizer -----------------------------------------------------------------------

// The hard safety floor, always enforced regardless of the allowlist below:
// strip whole <script>/<style>/<iframe>/<object> subtrees, on* handlers, and javascript:/data:
// URLs, and neutralize external resource loads (src/href to remote hosts).
function stripDangerous(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base)\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src|xlink:href)\s*=\s*("|')?\s*javascript:[^"'>\s]*/gi, "$1=\"#\"")
    .replace(/(href|src|xlink:href)\s*=\s*("|')?\s*data:(?!image\/)[^"'>\s]*/gi, "$1=\"#\"");
}

// The element/attribute allowlist decides which formatting SURVIVES after the safety floor —
// a genuine policy choice with several valid answers (text-only vs. rich formatting).
// TODO(human): define ALLOWED_TAGS and ALLOWED_ATTRS below.
const ALLOWED_TAGS = new Set([]);
const ALLOWED_ATTRS = new Set([]);

function applyAllowlist(html) {
  if (ALLOWED_TAGS.size === 0) return html; // no allowlist yet: safety floor still applied above
  return html.replace(/<\s*\/?\s*([a-z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (whole, tag, attrs) => {
    if (!ALLOWED_TAGS.has(tag.toLowerCase())) return "";
    const kept = [];
    for (const m of attrs.matchAll(/([a-z0-9:-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) {
      if (ALLOWED_ATTRS.has(m[1].toLowerCase())) kept.push(`${m[1]}=${m[2]}`);
    }
    const close = whole.trim().startsWith("</") ? "/" : "";
    return `<${close}${tag.toLowerCase()}${kept.length ? " " + kept.join(" ") : ""}>`;
  });
}

function sanitizeHtml(html) {
  return applyAllowlist(stripDangerous(String(html)));
}

module.exports = { parseMessage, sanitizeHtml, stripDangerous };
