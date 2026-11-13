"use strict";

// What the Browser tab opens and how it names itself. These came from the GPT Browser
// (gpt-browser.cjs), which the Browser tab replaced on 2026-11-13.

const MAX_URL = 4096;

const IP_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

/**
 * A web page the address bar may open in the active account, or null. Only http(s) pages
 * without embedded credentials; a bare address such as "example.com/path" means https.
 */
function browsableUrl(value) {
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (!text || text.length > MAX_URL || /\s/.test(text)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let parsed;
  try { parsed = new URL(text); } catch { return null; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname;
  // A dotted name, localhost or an IP: rejects typos like "https://foo" that are not a site.
  if (!host || !(host.includes(".") || host === "localhost" || IP_HOST.test(host))) return null;
  return parsed.toString();
}

// Sign-in pages (Google in particular) refuse browsers that announce themselves as Electron, and
// Cloudflare checks a Chrome user agent that names another product ("CodingTools/0.8.81", 11-03).
function cleanUserAgent(value) {
  return String(value || "").replace(/\s+(?:Electron|coding-?tools[\w.-]*|Coding Tools)\/\S+/gi, "").trim();
}

module.exports = { browsableUrl, cleanUserAgent };
