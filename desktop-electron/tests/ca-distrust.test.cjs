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
