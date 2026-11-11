"use strict";
const CHATGPT = "https://chatgpt.com/";
let checking = false, debounce, queued = false, generation = 0;
const bytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
async function pairing() { return (await chrome.storage.session.get("pairing")).pairing; }
async function update(patch, token, revision = generation) { const current = await pairing(); if (revision === generation && current && (!token || current.token === token)) await chrome.storage.session.set({ pairing: { ...current, ...patch } }); }
async function startChecking() {
  const pair = await pairing();
  if (!pair?.approved || pair.expiresAt <= Date.now()) return;
  if (!(await chrome.tabs.query({ url: ["https://chatgpt.com/*"] })).length) await chrome.tabs.create({ url: CHATGPT });
  schedule();
}
async function request(pair, route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${pair.port}${route}`, { ...options, cache: "no-store", redirect: "error", headers: { Authorization: `Bearer ${pair.token}`, ...options.headers } });
  if (!response.ok) throw new Error(`App connection HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 16384 || new URL(response.url).origin !== `http://127.0.0.1:${pair.port}`) throw new Error("Invalid app response");
  return JSON.parse(body);
}
async function verifyProof(pair, hello) {
  if (hello.version !== 1 || hello.port !== pair.port || !Number.isFinite(hello.expiresAt) || hello.expiresAt <= Date.now()
    || hello.expiresAt > Date.now() + 11 * 60_000 || typeof hello.publicKey !== "string" || hello.publicKey.length > 2048 || typeof hello.signature !== "string" || hello.signature.length > 1024 || (pair.publicKey && pair.publicKey !== hello.publicKey)) throw new Error("Invalid app identity");
  const key = await crypto.subtle.importKey("spki", bytes(hello.publicKey), { name: "RSA-PSS", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 32 }, key, bytes(hello.signature), new TextEncoder().encode(`1\n${pair.token}\n${pair.port}\n${hello.expiresAt}\n`))) throw new Error("App identity verification failed");
  const fingerprint = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${hello.publicKey}\n1\n${pair.token}\n${pair.port}\n${hello.expiresAt}\n`)));
  const code = Array.from(fingerprint, byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 16).toUpperCase().match(/.{4}/g).join("-");
  if (hello.code !== code) throw new Error("App pairing code does not match its signed identity");
}
async function encryptedCapture(pair, value) {
  const wrapping = await crypto.subtle.importKey("spki", bytes(pair.publicKey), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const key = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`1\n${pair.token}\n${pair.port}\n${pair.expiresAt}\n`) }, aes, new TextEncoder().encode(JSON.stringify(value)));
  const wrapped = await crypto.subtle.encrypt("RSA-OAEP", wrapping, key); key.fill(0);
  const base64 = value => { let text = ""; for (const byte of new Uint8Array(value)) text += String.fromCharCode(byte); return btoa(text); };
  return { version: 1, key: base64(wrapped), iv: base64(iv), data: base64(data) };
}
async function begin(message, sender) {
  const url = new URL(sender.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/connect" || url.username || url.password
    || Number(url.port) !== message.port || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535
    || !/^[a-f0-9]{64}$/.test(message.token)) throw new Error("Open a fresh connection from Coding Tools");
  const pair = { port: message.port, token: message.token };
  const hello = await request(pair, "/hello");
  await verifyProof(pair, hello);
  const trusted = (await chrome.storage.local.get("trustedAppKey")).trustedAppKey;
  if (trusted && trusted !== hello.publicKey) throw new Error("This is a different app identity. Remove the connector's saved pairing before trusting a replacement.");
  generation++;
  await chrome.storage.session.set({ pairing: { ...pair, ...hello, approved: Boolean(trusted), sent: false, status: trusted ? "Waiting for ChatGPT sign-in" : "Approve the matching code shown in Coding Tools" } });
  if (!trusted) await chrome.tabs.create({ url: chrome.runtime.getURL("confirm.html") });
  else queueMicrotask(() => { void startChecking().catch(() => {}); });
  return { ok: true, approvalRequired: !trusted };
}

// The ChatGPT login this tab's session is ({ id, email }), or null. Chrome can hold two ChatGPT
// logins at once; the app checks the copied session opens as this same one.
async function signedInUser(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
    if (location.origin !== "https://chatgpt.com") return false;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch("/api/auth/session", { credentials: "include", cache: "no-store", redirect: "error", signal: controller.signal });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return false;
      const session = await response.json();
      if (typeof session?.user?.id !== "string" || !session.user.id.length || (session.expires && !(Date.parse(session.expires) > Date.now()))) return false;
      return { id: session.user.id, email: typeof session.user.email === "string" ? session.user.email : null };
    } catch { return false; } finally { clearTimeout(timeout); }
  } });
  const found = results.find(result => typeof result.result?.id === "string" && /^user-[A-Za-z0-9_-]{1,120}$/.test(result.result.id));
  if (!found) return null;
  const email = found.result.email;
  return { id: found.result.id, email: typeof email === "string" && email.length <= 200 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null };
}
async function check() {
  if (checking) { queued = true; return; }
  checking = true;
  const revision = generation;
  let requestToken;
  try {
    const pair = await pairing();
    requestToken = pair?.token;
    if (!pair?.approved || pair.sent || pair.expiresAt <= Date.now()) return;
    let tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*"] });
    tabs = tabs.sort((a, b) => Number(b.active) - Number(a.active));
    if (!tabs.length) return; // The existing login tab may be on its identity provider; never open a tab per cookie event.
    let user = null;
    for (const tab of tabs) { if (Number.isInteger(tab.id) && (user = await signedInUser(tab.id))) break; }
    if (!user) { if (generation === revision) await update({ status: "Waiting for a verified ChatGPT session in this profile" }, pair.token); return; }
    const current = await pairing();
    if (generation !== revision || !current || current.token !== pair.token || !current.approved || current.sent || current.expiresAt <= Date.now()) return;
    await verifyProof(pair, await request(pair, "/hello"));
    if (generation !== revision) return;
    const found = [...await chrome.cookies.getAll({ domain: "chatgpt.com" }), ...await chrome.cookies.getAll({ domain: "openai.com" })];
    const cookies = found.filter(cookie => !cookie.partitionKey && /^(?:[a-z0-9-]+\.)*(?:chatgpt\.com|openai\.com)$/i.test(cookie.domain.replace(/^\./, "")))
      .map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
        sameSite: ({ strict: "Strict", lax: "Lax", no_restriction: "None", unspecified: "Lax" })[cookie.sameSite] || "Lax", expires: cookie.expirationDate ?? -1 }));
    if (!cookies.length || cookies.length > 256) throw new Error("No supported ChatGPT sign-in cookies are available");
    const owner = await pairing();
    if (generation !== revision || owner?.token !== pair.token || owner.sent || owner.expiresAt <= Date.now()) return;
    // Mark before submission: an uncertain delivery is not permission to replay a credential import.
    await update({ sent: true, status: "Coding Tools is independently verifying this sign-in" }, pair.token);
    if (generation !== revision) return;
    const encrypted = await encryptedCapture(pair, { version: 1, origin: "https://chatgpt.com", sessionAuthenticated: true, user, cookies });
    if (generation !== revision) return;
    const result = await request(pair, "/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(encrypted) });
    const latest = await pairing();
    if (generation === revision && latest?.token === pair.token) await update({ status: result.accepted === true ? "Session sent. Check Coding Tools or its connection tab for the independent verification result. Chrome can stay open." : "The app did not accept this sign-in. Check Coding Tools." }, pair.token);
  } catch {
    if (generation === revision && requestToken) await update({ status: "The connection ended or could not be verified. Check Coding Tools; open a new connection to retry." }, requestToken);
  } finally { checking = false; if (queued) { queued = false; schedule(); } }
}
function schedule() { clearTimeout(debounce); debounce = setTimeout(() => { void check().catch(() => { void update({ status: "The connection ended or could not be verified. Check Coding Tools; open a new connection to retry." }); }); }, 500); }
chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  if (message?.type !== "connect") return false;
  void begin(message, sender).then(reply, () => reply({ ok: false, error: "Connector pairing failed. Open a fresh connection from Coding Tools." }));
  return true;
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("confirm.html"))) return false;
  if (message?.type === "status") { void pairing().then(pair => reply({ status: pair?.status || "Start Chrome sign-in in Coding Tools", code: pair?.code, approvalRequired: Boolean(pair && !pair.approved), expiresAt: pair?.expiresAt })); return true; }
  if (message?.type === "approve") {
    void (async () => {
      const revision = generation, pair = await pairing();
      if (!pair || message.code !== pair.code || pair.expiresAt <= Date.now()) throw new Error("Changed or expired connection");
      const trusted = (await chrome.storage.local.get("trustedAppKey")).trustedAppKey;
      const current = await pairing();
      if (generation !== revision || current?.token !== pair.token || (trusted && trusted !== pair.publicKey)) throw new Error("Changed app connection");
      await chrome.storage.local.set({ trustedAppKey: pair.publicKey });
      await update({ approved: true, status: "Waiting for ChatGPT sign-in" }, pair.token, revision);
      if (generation === revision) void startChecking().catch(() => {});
      return { ok: true };
    })().then(reply, () => reply({ ok: false }));
    return true;
  }
  if (message?.type === "check") { schedule(); reply({ ok: true }); }
  return false;
});
chrome.tabs.onUpdated.addListener((_id, change, tab) => { if (change.status === "complete" && tab.url?.startsWith(CHATGPT)) schedule(); });
chrome.cookies.onChanged.addListener(({ cookie }) => { if (/^(?:[a-z0-9-]+\.)*(?:chatgpt\.com|openai\.com)$/i.test(cookie.domain.replace(/^\./, ""))) schedule(); });
