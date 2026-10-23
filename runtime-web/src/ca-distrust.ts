// Certificate authorities this runtime no longer trusts, whatever Bun's built-in root list says.
//
// eMudhra (emSign): in October 2026 the private keys of eight eMudhra intermediate CAs were found
// to be guessable, so anyone could issue a valid-looking HTTPS certificate for any site under them
// (Google and Mozilla advisories, 2026-10-17/20). Bun 1.4 still shipped the four emSign roots and
// accepted the compromise test site (dv-g3b-emudhra.we-have-a-problem.com); with them removed it is
// refused and every other site still works. The desktop app does the same for itself and the Node
// runtimes it starts (desktop-electron/electron/ca-distrust.cjs).
//
// Imported first by cli.ts, so it runs before any module can open a connection.
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { X509Certificate } from "node:crypto";

const DISTRUSTED_NAME = /\b(?:emSign|eMudhra)\b/i;

/** Drops the distrusted roots from the default CA list; returns how many were removed. */
export function distrustCompromisedCas(): number {
  if (typeof getCACertificates !== "function" || typeof setDefaultCACertificates !== "function") return 0;
  const current = getCACertificates("default");
  const kept = current.filter((pem) => {
    try { return !DISTRUSTED_NAME.test(new X509Certificate(pem).subject); } catch { return true; }
  });
  if (kept.length !== current.length) setDefaultCACertificates(kept);
  return current.length - kept.length;
}

distrustCompromisedCas();
