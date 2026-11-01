"use strict";

// The oldest Go that may build what the app ships. Before 1.27.3 / 1.26.10, crypto/x509 trusted
// chains through the leaked eMudhra intermediates (CVE-2026-111943). The AO build used to pick
// .tools/go1.27.3 when present and otherwise any `go` on PATH, and nothing checked which one ran:
// the AO daemon installed on 2026-10-31 was still built with go1.27.1.
const MINIMUM = { "1.27": 3, "1.26": 10 };

/** The Go version in a `go version` or `go env GOVERSION` line, as [major, minor, patch]. */
function goVersion(text) {
  const match = /\bgo(\d+)\.(\d+)(?:\.(\d+))?\b/.exec(String(text ?? ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

/** Whether a Go release has the crypto/x509 fixes; any release after 1.27 does. */
function safeGo(version) {
  if (!version) return false;
  const [major, minor, patch] = version;
  if (major !== 1) return major > 1;
  if (minor > 27) return true;
  const floor = MINIMUM[`${major}.${minor}`];
  return floor !== undefined && patch >= floor;
}

const BUILD_INFO_MAGIC = Buffer.from("\xff Go buildinf:", "latin1");

/**
 * The Go version a binary was built with, from its build-info block (Go 1.18+: a 32-byte header,
 * then the version as a varint-prefixed string), so a package check needs no Go toolchain.
 */
function binaryGoVersion(bytes) {
  const at = bytes.indexOf(BUILD_INFO_MAGIC);
  if (at < 0 || at + 33 > bytes.length || (bytes[at + 15] & 0x2) === 0) return null;
  let offset = at + 32;
  let length = 0;
  for (let shift = 0; offset < bytes.length && shift < 28; shift += 7) {
    const byte = bytes[offset++];
    length |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return length > 0 && length < 64 ? goVersion(bytes.subarray(offset, offset + length).toString("latin1")) : null;
  }
  return null;
}

/** Throws unless `text` names a safe Go release; `what` says which toolchain or binary it was. */
function assertSafeGo(text, what) {
  const version = goVersion(text);
  if (safeGo(version)) return version;
  throw new Error(`${what} is ${version ? `go${version.join(".")}` : "an unknown Go version"}; `
    + "the app needs Go 1.27.3 or later (or 1.26.10): set CODING_TOOLS_GO to a newer go.exe");
}

module.exports = { goVersion, safeGo, binaryGoVersion, assertSafeGo };
