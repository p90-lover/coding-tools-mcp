"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { X509Certificate } = require("node:crypto");

const caDistrust = require("../electron/ca-distrust.cjs");
const emSign = (pem) => /emSign|eMudhra/i.test(new X509Certificate(pem).subject);

test("loading it takes the emSign roots out of this process's CA list and leaves the rest", () => {
  // Node still ships the four emSign roots in its own list; requiring the module removed them.
  assert.ok(tls.rootCertificates.filter(emSign).length >= 1, "the bundled list still has them (the reason for this module)");
  const now = tls.getCACertificates("default");
  assert.equal(now.filter(emSign).length, 0);
  assert.ok(now.length > 100, "every other root is kept");
  assert.equal(caDistrust.distrustCompromisedCas(), 0, "a second run changes nothing");
});

test("Chromium refuses a chain through an eMudhra CA and keeps its own verdict otherwise", () => {
  const verdict = (certificate) => { let result; caDistrust.verifyCertificate({ hostname: "example.com", certificate }, (code) => { result = code; }); return result; };
  const leaf = (issuer) => ({ subjectName: "example.com", issuerName: issuer.subjectName, issuerCert: issuer });
  const compromised = { subjectName: "emSign SSL CA - G1", issuerName: "emSign Root CA - G1", issuerCert: { subjectName: "emSign Root CA - G1", issuerName: "emSign Root CA - G1" } };
  const normal = { subjectName: "R11", issuerName: "ISRG Root X1", issuerCert: { subjectName: "ISRG Root X1", issuerName: "ISRG Root X1" } };
  assert.equal(verdict(leaf(compromised)), -2);
  assert.equal(verdict({ subjectName: "x", issuerName: "eMudhra Technologies Limited CA" }), -2);
  assert.equal(verdict(leaf(normal)), -3);
  assert.equal(verdict(undefined), -3);
});

// "EM DV TLS CA - G3B" as cross-signed by Sectigo's AAA Certificate Services: neither its common name
// nor its issuer's says emSign (emudhra.we-have-a-problem.com/impacted-intermediates.json).
const CROSS_SIGNED = `-----BEGIN CERTIFICATE-----
MIIDzjCCAragAwIBAgIRAKAk/fS6Zlx4XOSgIEg4WLcwDQYJKoZIhvcNAQELBQAw
ezELMAkGA1UEBhMCR0IxGzAZBgNVBAgMEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4G
A1UEBwwHU2FsZm9yZDEaMBgGA1UECgwRQ29tb2RvIENBIExpbWl0ZWQxITAfBgNV
BAMMGEFBQSBDZXJ0aWZpY2F0ZSBTZXJ2aWNlczAeFw0yNTA1MTQwMDAwMDBaFw0y
ODEyMzEyMzU5NTlaMD8xCzAJBgNVBAYTAk5MMRMwEQYDVQQKDAplTXVkaHJhIEJW
MRswGQYDVQQDDBJFTSBEViBUTFMgQ0EgLSBHM0IwdjAQBgcqhkjOPQIBBgUrgQQA
IgNiAATnntnASpdzxHNeUREdqFrCvV5kqzdLgOEsvCA47B5PDjuBL8mFnh5nr7BO
L4vJf3SFumWqkR7opORbYtXMA9Vr5nizw4y03JN8okYOI4RTyJKTXSnUT5HhVga2
PM7atGijggE1MIIBMTAfBgNVHSMEGDAWgBSgEQojPpbxB+zirynvgqV/0DCktDAd
BgNVHQ4EFgQU4h4v5xwZOQ5VS2LBICRXNSSKJRQwDgYDVR0PAQH/BAQDAgEGMBIG
A1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMC
MDEGA1UdIAQqMCgwCAYGZ4EMAQIBMA0GCysGAQQBg44hAQABMA0GCysGAQQBg44h
AQJkMEMGA1UdHwQ8MDowOKA2oDSGMmh0dHA6Ly9jcmwuY29tb2RvY2EuY29tL0FB
QUNlcnRpZmljYXRlU2VydmljZXMuY3JsMDQGCCsGAQUFBwEBBCgwJjAkBggrBgEF
BQcwAYYYaHR0cDovL29jc3AuY29tb2RvY2EuY29tMA0GCSqGSIb3DQEBCwUAA4IB
AQBzQ1IoqpdotM6gFrR4Q3YrKifOLeaj5XXunldpVE/vZn2TxC2y0s8oYiLR5ICE
wqVXSB7N6BM1Mp+Nif7Jbhb2IswAfSR4Iik8+B0iRmi7lYoNlycCgHjmsjOmZaxM
QkPmjXAJbG5f4V41OsvJZmS7lI3r0IuvEDVX3GAZ13on6IImSs9ybNpHQ7NCqkMQ
7wH4uAO1dtpFycgJSdHaCOhHjrox2BTYGLdpUrYwY3EOAjlZ8UGgsxs7mG+xquMl
bN1LFURwfnkVMP3T/DBIZ/ys2+lNFyxK3FlArrV4/000uTnVB1lO8oGORYdXoT5V
GUyRCEIDhF5TBUuKF4E3kf1h
-----END CERTIFICATE-----`;

test("Chromium refuses a Sectigo cross-sign of a compromised key, which no common name names", () => {
  // Electron gives common names only: this is the chain it passed for dv-g3b-aaa-emudhra (2026-11-01).
  const verdict = (certificate) => { let result; caDistrust.verifyCertificate({ hostname: "example.com", certificate }, (code) => { result = code; }); return result; };
  const intermediate = (extra) => ({ subjectName: "EM DV TLS CA - G3B", issuerName: "AAA Certificate Services", ...extra,
    issuerCert: { subjectName: "AAA Certificate Services", issuerName: "AAA Certificate Services" } });
  const leaf = (issuer) => ({ subjectName: "example.com", issuerName: "EM DV TLS CA - G3B", issuerCert: issuer });
  assert.equal(verdict(leaf(intermediate({}))), -3, "by name alone the chain passed");
  assert.equal(verdict(leaf(intermediate({ subject: { organizations: ["eMudhra BV"] } }))), -2, "its organization names eMudhra");
  assert.equal(verdict(leaf(intermediate({ data: CROSS_SIGNED }))), -2, "and its key is a compromised one");
});

test("every TLS connection refuses a chain holding a compromised key, then runs Node's own check", () => {
  assert.equal(caDistrust.guardServerIdentity(), false, "loading the module already wrapped it");
  assert.equal(tls.checkServerIdentity.distrustsCompromisedCas, true);
  const raw = new X509Certificate(CROSS_SIGNED).raw;
  const leaf = { subject: { CN: "example.com" }, subjectaltname: "DNS:example.com", issuerCertificate: { raw } };
  leaf.issuerCertificate.issuerCertificate = leaf.issuerCertificate;
  assert.equal(tls.checkServerIdentity("example.com", leaf)?.code, "CERT_DISTRUSTED");
  const good = { subject: { CN: "example.com" }, subjectaltname: "DNS:example.com" };
  assert.equal(tls.checkServerIdentity("example.com", good), undefined);
  assert.equal(tls.checkServerIdentity("other.test", good)?.code, "ERR_TLS_CERT_ALTNAME_INVALID", "hostnames are still checked");
});

test("the compromised keys are the advisory's SubjectPublicKeyInfo hashes", () => {
  const { createHash } = require("node:crypto");
  const key = createHash("sha256").update(new X509Certificate(CROSS_SIGNED).publicKey.export({ type: "spki", format: "der" })).digest("hex").toUpperCase();
  assert.equal(caDistrust.COMPROMISED_KEYS.size, 8);
  assert.ok(caDistrust.COMPROMISED_KEYS.has(key));
  assert.equal(caDistrust.isDistrustedCertificate(CROSS_SIGNED), true);
  assert.equal(caDistrust.isDistrustedCertificate(Buffer.from("not a certificate")), false);
  assert.deepEqual([...caDistrust.COMPROMISED_KEYS], [...require("node:fs").readFileSync(require.resolve("../../runtime-web/src/ca-distrust.ts"), "utf8")
    .matchAll(/"([0-9A-F]{64})", \/\/ EM /g)].map((match) => match[1]), "the Bun bridge distrusts the same keys");
});

test("the Node runtimes the app starts preload it, with the options they already had", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca distrust "));
  try {
    const options = caDistrust.childNodeOptions(dir, "--max-old-space-size=4096");
    const copy = path.join(dir, "ca-distrust.cjs");
    assert.equal(fs.readFileSync(copy, "utf8"), fs.readFileSync(require.resolve("../electron/ca-distrust.cjs"), "utf8"));
    assert.equal(options, `--max-old-space-size=4096 --require "${copy.replace(/\\/g, "/")}"`, "quoted: the data folder's name has a space");
    assert.equal(caDistrust.childNodeOptions(dir, options), options, "set once, however often the app starts");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
