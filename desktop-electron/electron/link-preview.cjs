"use strict";

/**
 * The chat's link hover card: what a web page says about itself (title, description, site name,
 * icon and share image), read from the top of its HTML when someone rests the pointer on a link.
 *
 * - Fetched here, on the App route without cookies (`fetchPage` is the launcher's network fetch),
 *   never by the window, whose own session is not routed.
 * - Only public web addresses: a loopback, private-network, link-local or single-label host is
 *   never asked, on the first request or on any redirect, so hovering a link to a local service
 *   cannot make a request to it. A link with a user name or password in it is not fetched either.
 * - Only the page's head is read (at most 512 KiB), and only images small enough to send are kept.
 * - Answers, refusals included, are cached for a while so hovering the same link again costs nothing.
 */

const MAX_HTML_BYTES = 512 * 1024;
const MAX_ICON_BYTES = 48 * 1024;
const MAX_IMAGE_BYTES = 320 * 1024;
const MAX_REDIRECTS = 5;
const PAGE_TIMEOUT_MS = 8_000;
const IMAGE_TIMEOUT_MS = 5_000;
const CACHE_LIMIT = 200;
const CACHE_TTL_MS = 30 * 60_000;
const FAILURE_TTL_MS = 2 * 60_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)\b/i;
// Raster and SVG formats an <img> draws. An SVG in an <img> runs no script.
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/i;
const TEXT_LIMITS = Object.freeze({ title: 300, description: 600, siteName: 120 });
// Bidi overrides and isolates could make a card's title read as something else.
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮⁦-⁩]/g;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

function ipv4Parts(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

function privateIpv4([a, b]) {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19));
}

/** An IPv6 address as its eight 16-bit groups, or null when it is not one. */
function ipv6Groups(address) {
  let text = address;
  // A trailing dotted IPv4 (::ffff:127.0.0.1) is its last two groups.
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const v4 = ipv4Parts(dotted[2]);
    if (!v4) return null;
    text = `${dotted[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const part = (half) => (half ? half.split(":") : []);
  const head = part(halves[0]), tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

function privateIpv6(host) {
  const g = ipv6Groups(host.toLowerCase());
  if (!g) return true; // not an address this can read: never asked
  const v4 = (high, low) => privateIpv4([high >> 8, high & 255, low >> 8, low & 255]);
  const zero = (from, to) => g.slice(from, to).every((group) => group === 0);
  // ::, ::1 and IPv4-compatible ::a.b.c.d (the URL parser writes ::127.0.0.1 as ::7f00:1).
  if (zero(0, 6)) return g[6] === 0 ? true : v4(g[6], g[7]);
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-translated ::ffff:0:a.b.c.d.
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7]);
  // NAT64 64:ff9b::a.b.c.d and 6to4 2002:aabb:ccdd::, which carry an IPv4 address inside.
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  return (g[0] & 0xfe00) === 0xfc00 // unique local fc00::/7
    || (g[0] & 0xffc0) === 0xfe80 // link-local fe80::/10
    || (g[0] & 0xff00) === 0xff00; // multicast
}

// Public names that always answer with this computer's address.
const LOOPBACK_NAMES = ["localtest.me", "lvh.me"];

/**
 * Whether a public name spells out a local address for wildcard DNS (127.0.0.1.nip.io,
 * 10-0-0-5.sslip.io) or is a well-known name for this computer. A name that merely resolves to a
 * local address (DNS rebinding) is not caught here: the App route resolves names, not the app, and
 * a lookup of its own would send every hovered host to the local resolver around the person's proxy.
 */
function localByName(host) {
  if (LOOPBACK_NAMES.some((name) => host === name || host.endsWith(`.${name}`))) return true;
  const labels = host.split(".");
  if (labels.includes("localhost")) return true;
  for (let index = 0; index + 4 <= labels.length; index += 1) {
    const window = labels.slice(index, index + 4);
    const v4 = window.every((label) => /^\d{1,3}$/.test(label)) ? ipv4Parts(window.join(".")) : null;
    if (v4 && privateIpv4(v4)) return true;
  }
  return labels.some((label) => {
    const dashed = /^(?:.*-)?(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/.exec(label);
    const v4 = dashed && ipv4Parts(dashed.slice(1, 5).join("."));
    return Boolean(v4 && privateIpv4(v4));
  });
}

/** Whether a host is this computer, its network or an intranet name rather than a public site. */
function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (host.includes(":")) return privateIpv6(host);
  const v4 = ipv4Parts(host);
  if (v4) return privateIpv4(v4);
  if (host === "localhost" || !host.includes(".")) return true;
  return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix)) || localByName(host);
}

/** The URL a preview may be fetched for, or the reason it is not. */
function previewTarget(value) {
  let url;
  try { url = new URL(String(value)); } catch { return { reason: "invalid" }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { reason: "unsupported" };
  if (url.username || url.password) return { reason: "credentials" };
  if (isPrivateHost(url.hostname)) return { reason: "private" };
  url.hash = "";
  return { url };
}

const NAMED_ENTITIES = Object.freeze({
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  middot: "·", bull: "•", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  copy: "©", reg: "®", trade: "™", times: "×", rarr: "→", larr: "←", euro: "€", pound: "£", yen: "¥",
});

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function cleanText(value, limit) {
  if (typeof value !== "string") return "";
  const text = decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(UNSAFE_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function attributesOf(tag) {
  const attributes = new Map();
  const pattern = /([^\s=/>"']+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const match of tag.replace(/^<[a-z]+/i, "").matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function charsetOf(contentType, head) {
  const declared = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || "")?.[1]
    || /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  return declared ? declared.toLowerCase() : "utf-8";
}

function decodeHtml(bytes, contentType) {
  const charset = charsetOf(contentType, bytes.subarray(0, 4096).toString("latin1"));
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

function resolveImage(value, base) {
  if (!value) return null;
  const target = previewTarget((() => { try { return new URL(decodeEntities(value.trim()), base).href; } catch { return ""; } })());
  return target.url ? target.url.href : null;
}

/** What a page's head says about it, from its meta, title and icon tags. */
function parseHead(html, pageUrl) {
  const head = html.slice(0, (() => { const end = html.search(/<\/head\s*>|<body[\s>]/i); return end < 0 ? html.length : end; })());
  const meta = new Map();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = attributesOf(tag);
    const key = (attributes.get("property") || attributes.get("name") || attributes.get("itemprop") || "").toLowerCase();
    if (key && attributes.has("content") && !meta.has(key)) meta.set(key, attributes.get("content"));
  }
  const icons = [];
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const attributes = attributesOf(tag);
    const rel = (attributes.get("rel") || "").toLowerCase().split(/\s+/);
    if (!attributes.get("href") || !rel.some((word) => word === "icon" || word === "apple-touch-icon")) continue;
    const sizes = /(\d+)x\d+/i.exec(attributes.get("sizes") || "");
    const svg = /svg/i.test(attributes.get("type") || "") || /\.svg(?:$|[?#])/i.test(attributes.get("href"));
    // A small, sharp icon first: an SVG, then the size nearest 32 px, then Apple's large icon.
    const size = svg ? 32 : sizes ? Number(sizes[1]) : rel.includes("apple-touch-icon") ? 180 : 24;
    icons.push({ href: attributes.get("href"), score: Math.abs(size - 32) + (rel.includes("apple-touch-icon") ? 100 : 0) });
  }
  icons.sort((a, b) => a.score - b.score);
  const pick = (...keys) => keys.map((key) => meta.get(key)).find((value) => value && value.trim()) || "";
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] || "";
  let origin = "";
  try { origin = new URL(pageUrl).origin; } catch {}
  return {
    title: cleanText(pick("og:title", "twitter:title") || titleTag, TEXT_LIMITS.title),
    description: cleanText(pick("og:description", "twitter:description", "description"), TEXT_LIMITS.description),
    siteName: cleanText(pick("og:site_name", "application-name", "apple-mobile-web-app-title"), TEXT_LIMITS.siteName),
    imageUrl: resolveImage(pick("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"), pageUrl),
    iconUrl: resolveImage(icons[0]?.href, pageUrl) || (origin ? resolveImage("/favicon.ico", origin) : null),
  };
}

/** Reads at most `limit` bytes; `stop(text)` ends early. Returns null past the limit when `whole`. */
async function readBody(response, limit, { whole = false, stop = null } = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return whole && bytes.length > limit ? null : bytes.subarray(0, limit);
  }
  const chunks = [];
  let size = 0, tail = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        if (whole) return null;
        break;
      }
      if (stop) {
        const text = tail + chunk.toString("latin1");
        if (stop(text)) break;
        tail = text.slice(-16);
      }
    }
  } finally {
    try { reader.cancel().catch(() => {}); } catch {}
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

// Lets a body go without waiting for it: a cancel can wait on the other half of a cloned stream.
function discard(response) {
  try { response.body?.cancel?.()?.catch?.(() => {}); } catch {}
}

/**
 * The fetch, or its timeout, whichever is first. The launcher's fetch first waits for the app's
 * network to be ready, which no signal reaches: a hover while the app starts would wait for it.
 * A response that arrives after the timeout is let go.
 */
function racing(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error("timeout"));
    if (signal.aborted) {
      aborted();
      void Promise.resolve(promise).then(discard, () => {});
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then((value) => {
      signal.removeEventListener("abort", aborted);
      if (signal.aborted) discard(value);
      else resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", aborted);
      reject(error);
    });
  });
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
  timer.unref?.();
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * @param {{ fetchPage: (url: string, init: object) => Promise<Response>, now?: () => number,
 *   pageTimeoutMs?: number, imageTimeoutMs?: number }} deps
 *   `fetchPage` must not follow redirects itself (each hop is checked here) and must omit cookies.
 */
function createLinkPreviewService({
  fetchPage, now = () => Date.now(), pageTimeoutMs = PAGE_TIMEOUT_MS, imageTimeoutMs = IMAGE_TIMEOUT_MS,
}) {
  if (typeof fetchPage !== "function") throw new TypeError("fetchPage is required");
  const cache = new Map();

  // Follows redirects here, refusing any hop to a private host.
  async function request(url, init) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await racing(fetchPage(current.href, { ...init, method: "GET", redirect: "manual" }), init.signal);
      const location = REDIRECT_STATUSES.has(response.status) ? response.headers?.get?.("location") : null;
      if (!location) return { response, url: current };
      discard(response);
      let next;
      try { next = new URL(location, current); } catch { throw Object.assign(new Error("bad redirect"), { reason: "network" }); }
      const target = previewTarget(next.href);
      if (!target.url) throw Object.assign(new Error("redirect refused"), { reason: target.reason });
      current = target.url;
    }
    throw Object.assign(new Error("too many redirects"), { reason: "network" });
  }

  async function imageData(url, limit) {
    if (!url) return null;
    const target = previewTarget(url);
    if (!target.url) return null;
    const timer = withTimeout(imageTimeoutMs);
    try {
      const { response } = await request(target.url, { signal: timer.signal, headers: { accept: "image/*" } });
      const type = (response.headers?.get?.("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!response.ok || !IMAGE_TYPE.test(type)) {
        discard(response);
        return null;
      }
      const bytes = await readBody(response, limit, { whole: true });
      return bytes && bytes.length ? `data:${type};base64,${bytes.toString("base64")}` : null;
    } catch {
      return null;
    } finally {
      timer.done();
    }
  }

  async function load(target) {
    const host = target.url.hostname;
    const timer = withTimeout(pageTimeoutMs);
    let page;
    try {
      page = await request(target.url, {
        signal: timer.signal,
        headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "accept-language": "en,*;q=0.5" },
      });
    } catch (error) {
      timer.done();
      return { ok: false, url: target.url.href, host, reason: error?.reason || (timer.signal.aborted ? "timeout" : "network") };
    }
    const { response, url } = page;
    const finalUrl = url.href;
    const contentType = (response.headers?.get?.("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!response.ok) {
      timer.done();
      discard(response);
      return { ok: false, url: finalUrl, host: url.hostname, reason: `http-${response.status}` };
    }
    if (!HTML_TYPE.test(contentType)) {
      timer.done();
      discard(response);
      const length = Number(response.headers?.get?.("content-length"));
      return {
        ok: true, kind: "file", url: finalUrl, host: url.hostname, contentType: contentType || "unknown",
        ...(Number.isFinite(length) && length >= 0 ? { size: length } : {}),
      };
    }
    let html;
    try {
      const bytes = await readBody(response, MAX_HTML_BYTES, { stop: (text) => /<\/head\s*>|<body[\s>]/i.test(text) });
      html = decodeHtml(bytes, response.headers?.get?.("content-type"));
    } catch {
      return { ok: false, url: finalUrl, host: url.hostname, reason: timer.signal.aborted ? "timeout" : "network" };
    } finally {
      timer.done();
    }
    const head = parseHead(html, finalUrl);
    const [icon, image] = await Promise.all([
      imageData(head.iconUrl, MAX_ICON_BYTES),
      imageData(head.imageUrl, MAX_IMAGE_BYTES),
    ]);
    return {
      ok: true, kind: "page", url: finalUrl, host: url.hostname,
      title: head.title, description: head.description, siteName: head.siteName,
      icon, image,
    };
  }

  function remember(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }

  /** The preview for `value`, never throwing: a refused or failed link answers `{ ok: false, reason }`. */
  async function preview(value) {
    const target = previewTarget(value);
    if (!target.url) {
      let host = "";
      try { host = new URL(String(value)).hostname; } catch {}
      return { ok: false, url: String(value), host, reason: target.reason };
    }
    const key = target.url.href;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) {
      remember(key, cached);
      return cached.result;
    }
    const result = load(target).catch(() => ({ ok: false, url: key, host: target.url.hostname, reason: "network" }));
    remember(key, { result, expires: now() + CACHE_TTL_MS });
    const settled = await result;
    const entry = cache.get(key);
    if (entry?.result === result) entry.expires = now() + (settled.ok ? CACHE_TTL_MS : FAILURE_TTL_MS);
    return settled;
  }

  return Object.freeze({ preview });
}

module.exports = Object.freeze({
  createLinkPreviewService,
  isPrivateHost,
  parseHead,
  previewTarget,
  MAX_HTML_BYTES,
  MAX_ICON_BYTES,
  MAX_IMAGE_BYTES,
});
