// Certificate authorities this runtime no longer trusts, whatever Bun's built-in root list says.
//
// eMudhra (emSign): in October 2026 the private keys of eight eMudhra intermediate CAs were found
// to be guessable, so anyone could issue a valid-looking HTTPS certificate for any site under them
// (Google and Mozilla advisories, 2026-10-17/20). Bun 1.4 still shipped the four emSign roots and
// accepted the compromise test site (dv-g3b-emudhra.we-have-a-problem.com). The desktop app does the
// same for itself and the Node runtimes it starts (desktop-electron/electron/ca-distrust.cjs).
//
// Removing the roots was not enough (2026-11-01): Bun 1.4.3's fetch ignores the default CA list, so
// it still accepted all six emSign test hosts, and each compromised intermediate is also
// cross-signed by Sectigo's "AAA Certificate Services", which the Windows store (with
// NODE_USE_SYSTEM_CA) or NODE_EXTRA_CA_CERTS trusts. So every fetch checks its chain by key, and AAA
// leaves the list that node:https uses (Mozilla's list no longer has it; Bun's node:https ignores a
// replaced tls.checkServerIdentity).
//
// Imported first by cli.ts, so it runs before any module can open a connection.
import { checkServerIdentity, getCACertificates, setDefaultCACertificates, type PeerCertificate } from "node:tls";
import { X509Certificate, createHash } from "node:crypto";

const DISTRUSTED_NAME = /\b(?:emSign|eMudhra)\b/i;

// SHA-256 of each compromised intermediate's SubjectPublicKeyInfo
// (emudhra.we-have-a-problem.com/impacted-intermediates.json), whichever certificate carries it.
export const COMPROMISED_KEYS: ReadonlySet<string> = new Set([
  "EBED6475C2C2D80FCB199F3FE8DD6E6B3CE60B77EB15D4E42C3DEC0C6F5B5105", // EM DV TLS CA - G3B
  "43BFFA19D6EF651451F6841E019931E96F6F2EAEFF28AB4B6F1CE4576DE2717B", // EM OV TLS CA - G3B
  "E0254C7FCDC265E2F0F8A428DABB75AB4AE039B4872D62F5EE57F0877D5A8A41", // EM EV TLS CA - G3B
  "49DD353DC2B919A3770645117D0E60C16115E7D1BC259EEFE734B00EA434FE5F", // EM DV TLS CA - G3C
  "63ECEFEE431D49523BC1136C4E72D0206A477086CAF606CD5CF025686C109CF8", // EM OV TLS CA - G3C
  "5C0660A2B164910D8FF589C18E14552E9E0EC237DCEFE2CB736D41A4811F81A0", // EM EV TLS CA - G3C
  "EC4FFA1AD0AC88081314B7AAFFEF6A91F97CD57291BB5BA686C5415F5EB4F6B6", // EM OV CS CA - G3B
  "92C063D67E8F14DB71D288E11266FFDAF69CBF115F7BAB14F3BC2F68D25E0E30", // EM OV CS CA - G3C
]);
// Sectigo's "AAA Certificate Services" root: the issuer of every cross-sign above.
const CROSS_SIGNING_ROOT_KEY = "BD153ED7B0434F6886B17BCE8BBE84ED340C7132D702A8F4FA318F756ECBD6F3";

function keyOf(certificate: X509Certificate): string {
  return createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("hex").toUpperCase();
}

/** Whether a certificate (PEM or DER) carries a compromised key or names a distrusted authority. */
export function isDistrustedCertificate(certificate: string | Uint8Array | undefined): boolean {
  if (!certificate || certificate.length === 0) return false;
  try {
    const parsed = new X509Certificate(certificate);
    return COMPROMISED_KEYS.has(keyOf(parsed)) || DISTRUSTED_NAME.test(parsed.subject) || DISTRUSTED_NAME.test(parsed.issuer);
  } catch {
    return false;
  }
}

function namesOf(part: unknown): string {
  return part && typeof part === "object" ? Object.values(part).flat().join(" ") : String(part ?? "");
}

/** An error when a peer chain passes through a distrusted certificate, else undefined. */
export function distrustedChainError(hostname: string, cert: PeerCertificate | undefined): (Error & { code: string }) | undefined {
  const seen = new Set<unknown>();
  for (let link: any = cert; link && !seen.has(link); link = link.issuerCertificate) {
    seen.add(link);
    if (isDistrustedCertificate(link.raw) || DISTRUSTED_NAME.test(namesOf(link.subject)) || DISTRUSTED_NAME.test(namesOf(link.issuer))) {
      return Object.assign(new Error(`The certificate chain for ${hostname} passes through a compromised certificate authority (eMudhra)`), { code: "CERT_DISTRUSTED" });
    }
  }
  return undefined;
}

/** Drops the distrusted roots and AAA from the default CA list; returns how many were removed. */
export function distrustCompromisedCas(): number {
  if (typeof getCACertificates !== "function" || typeof setDefaultCACertificates !== "function") return 0;
  const current = getCACertificates("default");
  const kept = current.filter((pem) => {
    try {
      const parsed = new X509Certificate(pem);
      return !DISTRUSTED_NAME.test(parsed.subject) && keyOf(parsed) !== CROSS_SIGNING_ROOT_KEY;
    } catch {
      return true;
    }
  });
  if (kept.length !== current.length) setDefaultCACertificates(kept);
  return current.length - kept.length;
}

type BunTls = { checkServerIdentity?: (hostname: string, cert: PeerCertificate) => Error | undefined };
const guarded = Symbol.for("coding-tools.ca-distrust.fetch");

/**
 * Wraps fetch so every request checks its chain (Bun's per-request tls.checkServerIdentity). A
 * custom check replaces Bun's own, so the hostname check runs next, then any check the caller set.
 */
export function guardFetch(target: { fetch: typeof fetch } = globalThis): boolean {
  const original = target.fetch as typeof fetch & { [guarded]?: true };
  if (typeof original !== "function" || original[guarded]) return false;
  const wrapped = function fetch(input: string | URL | Request, init: (RequestInit & { tls?: BunTls }) = {}) {
    const own = init?.tls?.checkServerIdentity;
    const tls: BunTls = {
      ...(init?.tls ?? {}),
      checkServerIdentity(hostname, cert) {
        return distrustedChainError(hostname, cert) ?? (own ? own(hostname, cert) : checkServerIdentity(hostname, cert));
      },
    };
    return original(input, { ...init, tls } as RequestInit);
  };
  target.fetch = Object.assign(wrapped, original, { [guarded]: true as const }) as typeof fetch;
  return true;
}

distrustCompromisedCas();
guardFetch();
