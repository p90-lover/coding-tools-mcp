"use strict";
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes, generateKeyPair, createHash, sign, privateDecrypt, createDecipheriv, constants, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const { validatePasskeyLoginState } = require("./passkey-login-state.cjs");

const EXTENSION_ID = "kcolhpapmkdnjjcepadadoajhikfokgn";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const CONNECTOR_FILES = ["manifest.json", "background.js", "confirm.html", "confirm.js", "README.md"];
const MAX_BODY_BYTES = 1024 * 1024;
const CONNECT_PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Coding Tools Chrome sign-in</title></head><body><h1>Connect this Chrome profile</h1><p id="status">Connecting to the Coding Tools Chrome connector…</p><p>If the connector is not installed, return to Coding Tools, choose Install connector, then load that folder from chrome://extensions using Load unpacked. Open this connection again afterwards.</p><script src="/connect.js"></script></body></html>';
const CONNECT_SCRIPT = `(() => {
 const status = document.getElementById('status');
 const token = location.hash.slice(1);
 if (!/^[a-f0-9]{64}$/.test(token)) { status.textContent = 'This connection link expired. Open Chrome again from Coding Tools.'; return; }
 if (!globalThis.chrome?.runtime?.sendMessage) { status.textContent = 'Open this link in the Chrome profile where you installed the Coding Tools connector.'; return; }
 chrome.runtime.sendMessage('${EXTENSION_ID}', {type:'connect', port:Number(location.port), token}, reply => {
  const error = chrome.runtime.lastError;
  if (error || !reply?.ok) { status.textContent = reply?.error || 'Install the Coding Tools connector in this Chrome profile, then open the connection again.'; return; }
  history.replaceState(null, '', '/connect');
  status.textContent = 'If asked, approve the matching connection code in the connector tab. Sign in to ChatGPT in this profile; verification is automatic. Keep Chrome open.';
  fetch('/result', {headers:{Authorization:'Bearer '+token},cache:'no-store'}).then(r=>r.json()).then(result => {
   status.textContent = result.verified ? 'Verified in Coding Tools. You can keep using Chrome normally.' : 'The app did not verify this sign-in. Return to Coding Tools to retry.';
  },()=>{status.textContent='The app connection ended. Return to Coding Tools to check its result.';});
 });
})();`;

async function prepareChromeConnector(sourceRoot, userData) {
  if (!path.isAbsolute(sourceRoot) || !path.isAbsolute(userData)) throw new Error("Chrome connector needs explicit application paths");
  const folder = path.join(userData, "chrome-profile-connector");
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  for (const name of CONNECTOR_FILES) await fs.writeFile(path.join(folder, name), await fs.readFile(path.join(sourceRoot, name)), { mode: 0o600 });
  return folder;
}

async function chromeConnectorIdentity(userData, safeStorage) {
  if (!path.isAbsolute(userData) || !safeStorage?.isEncryptionAvailable?.()) throw new Error("OS-protected storage is required to pair your Chrome profile");
  const file = path.join(userData, "chrome-profile-identity.json");
  try {
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    if (saved.version !== 1 || typeof saved.publicKey !== "string" || typeof saved.privateKey !== "string") throw new Error("Invalid Chrome connector identity");
    return { publicKey: saved.publicKey, privateKey: safeStorage.decryptString(Buffer.from(saved.privateKey, "base64")) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const pair = await promisify(generateKeyPair)("rsa", { modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const identity = { publicKey: pair.publicKey.toString("base64"), privateKey: pair.privateKey };
  await fs.mkdir(userData, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(file, JSON.stringify({ version: 1, publicKey: identity.publicKey,
      privateKey: safeStorage.encryptString(identity.privateKey).toString("base64") }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") return chromeConnectorIdentity(userData, safeStorage);
    throw error;
  }
  return identity;
}

function validCapture(body) {
  if (!body || body.version !== 1 || body.origin !== "https://chatgpt.com" || body.sessionAuthenticated !== true
    || !Array.isArray(body.cookies) || body.cookies.length > 256 || body.cookies.length === 0) throw new Error("Invalid Chrome sign-in capture");
  for (const cookie of body.cookies) {
    const domain = cookie?.domain?.replace(/^\./, "").toLowerCase();
    if (typeof domain !== "string" || !/^(?:[a-z0-9-]+\.)*(?:chatgpt\.com|openai\.com)$/.test(domain)
      || cookie.partitionKey !== undefined || typeof cookie.name !== "string" || typeof cookie.value !== "string"
      || /[\u0000-\u001f\u007f]/.test(cookie.name + cookie.value) || cookie.name.length > 1024 || cookie.value.length > 65536) {
      throw new Error("Chrome capture contains unsupported cookie state");
    }
  }
  const state = { cookies: body.cookies, origins: [] };
  validatePasskeyLoginState(state);
  return state;
}

function pairingCode(publicKey, challenge) {
  return createHash("sha256").update(`${publicKey}\n${challenge}`).digest("hex").slice(0, 16).toUpperCase().match(/.{4}/g).join("-");
}

function decryptCapture(envelope, identity, challenge) {
  const decode = (value, max) => {
    if (typeof value !== "string" || value.length > max || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("Invalid encrypted Chrome capture");
    return Buffer.from(value, "base64");
  };
  if (envelope?.version !== 1) throw new Error("Invalid encrypted Chrome capture");
  const wrapped = decode(envelope.key, 1024), iv = decode(envelope.iv, 32), data = decode(envelope.data, MAX_BODY_BYTES);
  if (wrapped.length !== 256 || iv.length !== 12 || data.length < 17) throw new Error("Invalid encrypted Chrome capture");
  const key = privateDecrypt({ key: identity.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, wrapped);
  try {
    if (key.length !== 32) throw new Error("Invalid encrypted Chrome capture");
    const cipher = createDecipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(challenge)); cipher.setAuthTag(data.subarray(-16));
    const plaintext = Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]);
    try { return JSON.parse(plaintext.toString("utf8")); } finally { plaintext.fill(0); }
  } finally { key.fill(0); }
}

/** Only the approved extension may submit a one-use capture. Browser appearance is never proof of app authentication. */
async function createChromeProfileCapture({ identity, onPhase = () => {}, timeoutMs = 10 * 60_000 }) {
  if (!identity?.privateKey || !identity.publicKey || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Invalid Chrome connector options");
  const token = randomBytes(32).toString("hex"), expiresAt = Date.now() + timeoutMs;
  let captureResolve, captureReject, verificationResolve;
  const result = new Promise((resolve, reject) => { captureResolve = resolve; captureReject = reject; });
  result.catch(() => {});
  const verification = new Promise(resolve => { verificationResolve = resolve; });
  let consumed = false, finished = false, timer, cleanupTimer, host;
  const server = http.createServer((request, response) => { void handle(request, response).catch(() => send(response, 400, { error: "Invalid Chrome connector request" })); });
  server.maxConnections = 8; server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.keepAliveTimeout = 500;
  function send(response, status, value) { if (!response.writableEnded && !response.destroyed) { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); } }
  function finish(verified, cancelled = false, reason) {
    if (finished) return false;
    finished = true; clearTimeout(timer); clearTimeout(cleanupTimer);
    verificationResolve({ verified: verified === true });
    if (!consumed) { const error = new Error(reason || (cancelled ? "Chrome profile sign-in cancelled" : "Chrome profile sign-in expired")); error.code = reason ? "CHROME_LOGIN_FAILED" : cancelled ? "CHROME_LOGIN_CANCELLED" : "CHROME_LOGIN_EXPIRED"; captureReject(error); }
    onPhase(verified ? "verified" : cancelled ? "cancelled" : "failed");
    server.close(); server.unref();
    return true;
  }
  function authorized(request) {
    const supplied = request.headers.authorization;
    return typeof supplied === "string" && supplied.length === token.length + 7
      && timingSafeEqual(Buffer.from(supplied), Buffer.from(`Bearer ${token}`));
  }
  async function handle(request, response) {
    if (request.headers.host !== host || request.socket.remoteAddress !== "127.0.0.1") return send(response, 403, { error: "Local connection required" });
    const origin = request.headers.origin;
    if (origin && origin !== EXTENSION_ORIGIN && origin !== `http://${host}`) return send(response, 403, { error: "Connector origin required" });
    if (origin === EXTENSION_ORIGIN) {
      response.setHeader("Access-Control-Allow-Origin", EXTENSION_ORIGIN); response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); response.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    if (request.method === "OPTIONS") { response.writeHead(origin === EXTENSION_ORIGIN ? 204 : 403); response.end(); return; }
    if (request.method === "GET" && ["/connect", "/connect.js"].includes(request.url)) {
      response.setHeader("Cache-Control", "no-store"); response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
      response.setHeader("Content-Type", request.url === "/connect" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8");
      response.end(request.url === "/connect" ? CONNECT_PAGE : CONNECT_SCRIPT); return;
    }
    if (!authorized(request) || finished || Date.now() >= expiresAt) return send(response, 403, { error: "Connection expired or not authorized" });
    if (request.method === "GET" && request.url === "/hello" && origin === EXTENSION_ORIGIN) {
      const port = server.address().port;
      const challenge = `1\n${token}\n${port}\n${expiresAt}\n`;
      return send(response, 200, { version: 1, port, expiresAt, publicKey: identity.publicKey,
        signature: sign("sha256", Buffer.from(challenge), { key: identity.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString("base64"),
        code: pairingCode(identity.publicKey, challenge) });
    }
    if (request.method === "GET" && request.url === "/result") return send(response, 200, await verification);
    if (request.method !== "POST" || request.url !== "/capture" || origin !== EXTENSION_ORIGIN) return send(response, 404, { error: "Unknown connector request" });
    if (consumed) return send(response, 409, { error: "Capture already submitted; check its verification result" });
    if (request.headers["content-type"] !== "application/json") return send(response, 415, { error: "JSON capture required" });
    let bytes = 0; const chunks = [];
    for await (const chunk of request) { bytes += chunk.length; if (bytes > MAX_BODY_BYTES) { send(response, 413, { error: "Capture is too large" }); request.resume(); return; } chunks.push(chunk); }
    const challenge = `1\n${token}\n${server.address().port}\n${expiresAt}\n`;
    const storageState = validCapture(decryptCapture(JSON.parse(Buffer.concat(chunks).toString("utf8")), identity, challenge));
    if (finished || consumed || Date.now() >= expiresAt) return send(response, 409, { error: "Capture no longer current" });
    consumed = true; onPhase("verifying");
    captureResolve({ storageState, source: "approved-chrome-profile-connector",
      assertCurrent: () => { if (finished || Date.now() >= expiresAt) throw new Error("The Chrome profile connection is no longer current"); },
      // BrowserHost completes this only after its existing fresh authentication and inspection.
      complete: verified => finish(verified),
      cleanup: async () => { cleanupTimer = setTimeout(() => finish(false), 0); cleanupTimer.unref?.(); } });
    // MV3 workers have a short fetch-response lifetime. Acknowledge receipt, not authentication;
    // the normal connection page and desktop keep waiting for independent app verification.
    return send(response, 202, { accepted: true });
  }
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  host = `127.0.0.1:${server.address().port}`; server.unref();
  timer = setTimeout(() => finish(false), timeoutMs); timer.unref?.();
  return { result, url: `http://${host}/connect#${token}`, code: pairingCode(identity.publicKey, `1\n${token}\n${server.address().port}\n${expiresAt}\n`), cancel: () => finish(false, true), fail: () => finish(false, false, "Could not open Chrome. Check its executable and reconnect the profile.") };
}

module.exports = { EXTENSION_ID, EXTENSION_ORIGIN, CONNECTOR_FILES, prepareChromeConnector, chromeConnectorIdentity, validCapture, createChromeProfileCapture };
