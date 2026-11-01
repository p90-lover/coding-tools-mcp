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

// The eight compromised intermediates' keys: SHA-256 of each SubjectPublicKeyInfo, from
// emudhra.we-have-a-problem.com/impacted-intermediates.json. Every one is also cross-signed by
// Sectigo's "AAA Certificate Services", so a chain can reach them with no emSign name in any common
// name and without the roots removed below. Wherever AAA is trusted (the Windows store through
// --use-system-ca or NODE_USE_SYSTEM_CA, or NODE_EXTRA_CA_CERTS), Bun 1.4.3 and Node before 24.22.1
// accepted all seven of the test site's cross-signed hosts even with those roots gone (2026-11-01).
// The key names the CA whichever certificate carries it.
const COMPROMISED_KEYS = new Set([
  "EBED6475C2C2D80FCB199F3FE8DD6E6B3CE60B77EB15D4E42C3DEC0C6F5B5105", // EM DV TLS CA - G3B
  "43BFFA19D6EF651451F6841E019931E96F6F2EAEFF28AB4B6F1CE4576DE2717B", // EM OV TLS CA - G3B
  "E0254C7FCDC265E2F0F8A428DABB75AB4AE039B4872D62F5EE57F0877D5A8A41", // EM EV TLS CA - G3B
  "49DD353DC2B919A3770645117D0E60C16115E7D1BC259EEFE734B00EA434FE5F", // EM DV TLS CA - G3C
  "63ECEFEE431D49523BC1136C4E72D0206A477086CAF606CD5CF025686C109CF8", // EM OV TLS CA - G3C
  "5C0660A2B164910D8FF589C18E14552E9E0EC237DCEFE2CB736D41A4811F81A0", // EM EV TLS CA - G3C
  "EC4FFA1AD0AC88081314B7AAFFEF6A91F97CD57291BB5BA686C5415F5EB4F6B6", // EM OV CS CA - G3B
  "92C063D67E8F14DB71D288E11266FFDAF69CBF115F7BAB14F3BC2F68D25E0E30", // EM OV CS CA - G3C
]);

/** Whether a certificate subject or issuer name belongs to a distrusted authority. */
function isDistrustedName(name) {
  return DISTRUSTED_NAME.test(String(name ?? ""));
}

// One verdict per certificate: every handshake brings the same few intermediates again.
const verdicts = new Map();

/** Whether a certificate (PEM or DER) carries a compromised key or names a distrusted authority. */
function isDistrustedCertificate(certificate) {
  if (!certificate) return false;
  const { X509Certificate, createHash } = require("node:crypto");
  const id = createHash("sha256").update(certificate).digest("hex");
  if (verdicts.has(id)) return verdicts.get(id);
  let distrusted = false;
  try {
    const parsed = new X509Certificate(certificate);
    const key = createHash("sha256").update(parsed.publicKey.export({ type: "spki", format: "der" })).digest("hex").toUpperCase();
    distrusted = COMPROMISED_KEYS.has(key) || isDistrustedName(parsed.subject) || isDistrustedName(parsed.issuer);
  } catch { /* not a certificate this runtime can read: TLS keeps its own verdict */ }
  if (verdicts.size >= 512) verdicts.clear();
  verdicts.set(id, distrusted);
  return distrusted;
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
 * Every TLS connection's chain is checked too, whatever root it ends at: the server identity check
 * that tls.connect (and with it https and fetch) runs on each verified handshake refuses a chain
 * holding a distrusted certificate, then runs Node's own check. Returns false when already wrapped.
 */
function guardServerIdentity() {
  const tls = require("node:tls");
  if (typeof tls.checkServerIdentity !== "function" || tls.checkServerIdentity.distrustsCompromisedCas) return false;
  const original = tls.checkServerIdentity;
  const checkServerIdentity = function checkServerIdentity(hostname, cert) {
    const seen = new Set();
    for (let link = cert; link && !seen.has(link); link = link.issuerCertificate) {
      seen.add(link);
      if (isDistrustedCertificate(link.raw)) {
        const error = new Error(`The certificate chain for ${hostname} passes through a compromised certificate authority (eMudhra)`);
        error.code = "CERT_DISTRUSTED";
        return error;
      }
    }
    return original(hostname, cert);
  };
  checkServerIdentity.distrustsCompromisedCas = true;
  tls.checkServerIdentity = checkServerIdentity;
  return true;
}

/**
 * Electron's Chromium side (every window, the in-app browsers): a chain that passes through a
 * distrusted authority is refused; anything else keeps Chromium's own verdict (-3). Electron gives
 * only common names as subjectName/issuerName, so the organization and the certificate itself are
 * checked as well (a Sectigo cross-sign reads "EM DV TLS CA - G3B" under "AAA Certificate Services").
 */
function verifyCertificate(request, callback) {
  for (let cert = request.certificate, depth = 0; cert && depth < 10; cert = cert.issuerCert, depth += 1) {
    const names = [cert.issuerName, cert.subjectName, ...(cert.subject?.organizations ?? []), ...(cert.issuer?.organizations ?? [])];
    if (names.some(isDistrustedName) || isDistrustedCertificate(cert.data)) { callback(-2); return; }
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

module.exports = { COMPROMISED_KEYS, isDistrustedName, isDistrustedCertificate, distrustCompromisedCas, guardServerIdentity, verifyCertificate, childNodeOptions };

// Loading this file protects the process at once (preloaded with --require, required at start);
// running it again changes nothing.
distrustCompromisedCas();
guardServerIdentity();
