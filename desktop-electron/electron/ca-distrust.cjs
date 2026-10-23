"use strict";

// Certificate authorities this app no longer trusts, whatever a runtime's built-in root list says.
//
// eMudhra (emSign): in October 2026 the private keys of eight eMudhra intermediate CAs were found
// to be guessable, so anyone could issue a valid-looking HTTPS certificate for any site under them
// (Google and Mozilla advisories, 2026-10-17/20; Go CVE-2026-111943). Chrome and Firefox distrust
// them, but Node, Bun and Electron carry their own copies of the four emSign roots and kept
// trusting them: checked against the compromise test site, every runtime here accepted it.
//
// This file is loaded three ways, so it has no dependencies: required by Electron's main process,
// preloaded into the Node runtimes the app starts (NODE_OPTIONS --require, see childNodeOptions),
// and required by the Bun bridge (runtime-web) at its start.

const DISTRUSTED_NAME = /\b(?:emSign|eMudhra)\b/i;

/** Whether a certificate subject or issuer name belongs to a distrusted authority. */
function isDistrustedName(name) {
  return DISTRUSTED_NAME.test(String(name ?? ""));
}

/**
 * Drops the distrusted roots from this runtime's default CA list (Node 22.19+/24.5+, Bun 1.3+).
 * Returns how many were removed; 0 when the runtime cannot change its list.
 */
function distrustCompromisedCas() {
  const tls = require("node:tls");
  if (typeof tls.getCACertificates !== "function" || typeof tls.setDefaultCACertificates !== "function") return 0;
  const { X509Certificate } = require("node:crypto");
  const current = tls.getCACertificates("default");
  const kept = current.filter((pem) => {
    try { return !isDistrustedName(new X509Certificate(pem).subject); } catch { return true; }
  });
  if (kept.length !== current.length) tls.setDefaultCACertificates(kept);
  return current.length - kept.length;
}

/**
 * Electron's Chromium side (every window, the in-app browsers): a chain that passes through a
 * distrusted authority is refused; anything else keeps Chromium's own verdict (-3).
 */
function verifyCertificate(request, callback) {
  for (let cert = request.certificate, depth = 0; cert && depth < 10; cert = cert.issuerCert, depth += 1) {
    if (isDistrustedName(cert.issuerName) || isDistrustedName(cert.subjectName)) { callback(-2); return; }
  }
  callback(-3);
}

/**
 * NODE_OPTIONS for the Node runtimes the app starts, with this file preloaded. Node cannot preload
 * from inside app.asar, so a copy is written to `dir` (the app's data folder). Existing options are
 * kept; the path is quoted because the data folder's name has a space.
 */
function childNodeOptions(dir, existing = "") {
  const fs = require("node:fs");
  const path = require("node:path");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "ca-distrust.cjs");
  const source = fs.readFileSync(__filename, "utf8");
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== source) fs.writeFileSync(target, source);
  const preload = `--require "${target.replace(/\\/g, "/")}"`;
  return String(existing || "").includes(target.replace(/\\/g, "/")) ? existing : [existing, preload].filter(Boolean).join(" ");
}

module.exports = { isDistrustedName, distrustCompromisedCas, verifyCertificate, childNodeOptions };

// Loading this file protects the process at once (preloaded with --require, required at start);
// running it again changes nothing.
distrustCompromisedCas();
