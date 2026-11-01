import { expect, test } from "bun:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { X509Certificate, createHash } from "node:crypto";
import { COMPROMISED_KEYS, distrustCompromisedCas, distrustedChainError, guardFetch, isDistrustedCertificate } from "../src/ca-distrust";

// "EM DV TLS CA - G3B" as cross-signed by Sectigo's AAA Certificate Services: no emSign name in its
// common name or its issuer's (emudhra.we-have-a-problem.com/impacted-intermediates.json).
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
const crossSigned = new X509Certificate(CROSS_SIGNED);
// Sectigo's AAA Certificate Services root, the issuer of every cross-sign.
const AAA_ROOT = `-----BEGIN CERTIFICATE-----
MIIEMjCCAxqgAwIBAgIBATANBgkqhkiG9w0BAQUFADB7MQswCQYDVQQGEwJHQjEb
MBkGA1UECAwSR3JlYXRlciBNYW5jaGVzdGVyMRAwDgYDVQQHDAdTYWxmb3JkMRow
GAYDVQQKDBFDb21vZG8gQ0EgTGltaXRlZDEhMB8GA1UEAwwYQUFBIENlcnRpZmlj
YXRlIFNlcnZpY2VzMB4XDTA0MDEwMTAwMDAwMFoXDTI4MTIzMTIzNTk1OVowezEL
MAkGA1UEBhMCR0IxGzAZBgNVBAgMEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4GA1UE
BwwHU2FsZm9yZDEaMBgGA1UECgwRQ29tb2RvIENBIExpbWl0ZWQxITAfBgNVBAMM
GEFBQSBDZXJ0aWZpY2F0ZSBTZXJ2aWNlczCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAL5AnfRu4ep2hxxNRUSOvkbIgwadwSr+GB+O5AL686tdUIoWMQua
BtDFcCLNSS1UY8y2bmhGC1Pqy0wkwLxyTurxFa70VJoSCsN6sjNg4tqJVfMiWPPe
3M/vg4aijJRPn2jymJBGhCfHdr/jzDUsi14HZGWCwEiwqJH5YZ92IFCokcdmtet4
YgNW8IoaE+oxox6gmf049vYnMlhvB/VruPsUK6+3qszWY19zjNoFmag4qMsXeDZR
rOme9Hg6jc8P2ULimAyrL58OAd7vn5lJ8S3frHRNG5i1R8XlKdH5kBjHYpy+g8cm
ez6KJcfA3Z3mNWgQIJ2P2N7Sw4ScDV7oL8kCAwEAAaOBwDCBvTAdBgNVHQ4EFgQU
oBEKIz6W8Qfs4q8p74Klf9AwpLQwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQF
MAMBAf8wewYDVR0fBHQwcjA4oDagNIYyaHR0cDovL2NybC5jb21vZG9jYS5jb20v
QUFBQ2VydGlmaWNhdGVTZXJ2aWNlcy5jcmwwNqA0oDKGMGh0dHA6Ly9jcmwuY29t
b2RvLm5ldC9BQUFDZXJ0aWZpY2F0ZVNlcnZpY2VzLmNybDANBgkqhkiG9w0BAQUF
AAOCAQEACFb8AvCb6P+k+tZ7xkSAzk/ExfYAWMymtrwUSWgEdujm7l3sAg9g1o1Q
GE8mTgHj5rCl7r+8dFRBv/38ErjHT1r0iWAFf2C3BUrz9vHCv8S5dIa2LX1rzNLz
Rt0vxuBqw8M0Ayx9lt1awg6nCpnBBYurDC/zXDrPbDdVCYfeU0BsWO/8tqtlbgT2
G9w84FoVxp7Z8VlIMCFlA2zs6SFz7JsDoeA3raAVGI/6ugLOpyypEBMs1OUIJqsi
l2D4kF501KKaU73yqWjgom7C12yxow+ev+to51byrvLjKzg6CYG1a4XXvi3tPxq3
smPi9WIsgtRqAEFQ8TmDn5XpNpaYbg==
-----END CERTIFICATE-----`;

test("the compromised key is named by its SubjectPublicKeyInfo, as the advisory publishes it", () => {
  const key = createHash("sha256").update(crossSigned.publicKey.export({ type: "spki", format: "der" })).digest("hex").toUpperCase();
  expect(key).toBe("EBED6475C2C2D80FCB199F3FE8DD6E6B3CE60B77EB15D4E42C3DEC0C6F5B5105");
  expect(COMPROMISED_KEYS.has(key)).toBe(true);
  expect(COMPROMISED_KEYS.size).toBe(8);
  expect(isDistrustedCertificate(crossSigned.raw)).toBe(true);
  expect(isDistrustedCertificate(CROSS_SIGNED)).toBe(true);
  expect(isDistrustedCertificate(new Uint8Array([1, 2, 3]))).toBe(false);
});

test("a chain through a Sectigo cross-sign is refused although no common name says emSign", () => {
  const root = { subject: { CN: "AAA Certificate Services", O: "Comodo CA Limited" }, issuer: { CN: "AAA Certificate Services" } } as any;
  root.issuerCertificate = root;
  const intermediate = { subject: { CN: "EM DV TLS CA - G3B" }, issuer: { CN: "AAA Certificate Services" }, raw: crossSigned.raw, issuerCertificate: root };
  const leaf = { subject: { CN: "example.com" }, issuer: { CN: "EM DV TLS CA - G3B" }, issuerCertificate: intermediate } as any;
  expect(distrustedChainError("example.com", leaf)?.code).toBe("CERT_DISTRUSTED");
  const normal = { subject: { CN: "example.com" }, issuer: { CN: "R11" }, issuerCertificate: { subject: { CN: "R11" }, issuer: { CN: "ISRG Root X1" } } } as any;
  expect(distrustedChainError("example.com", normal)).toBeUndefined();
});

test("every fetch checks its chain, then the hostname, or the check the caller set", async () => {
  const seen: any[] = [];
  const target = { fetch: (async (_input: unknown, init: any) => { seen.push(init); return new Response("ok"); }) as unknown as typeof fetch };
  expect(guardFetch(target)).toBe(true);
  expect(guardFetch(target)).toBe(false);
  await target.fetch("https://example.com/", { method: "POST" });
  const check = seen[0].tls.checkServerIdentity;
  expect(seen[0].method).toBe("POST");
  const leaf = { subject: { CN: "example.com" }, subjectaltname: "DNS:example.com", issuer: { CN: "EM DV TLS CA - G3B" }, issuerCertificate: { raw: crossSigned.raw } };
  expect(check("example.com", leaf).code).toBe("CERT_DISTRUSTED");
  const good = { subject: { CN: "example.com" }, subjectaltname: "DNS:example.com", issuer: { CN: "R11" } };
  expect(check("example.com", good)).toBeUndefined();
  expect(check("other.test", good)?.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  let own = 0;
  await target.fetch("https://example.com/", { tls: { checkServerIdentity: () => { own += 1; return undefined; } } } as any);
  expect(seen[1].tls.checkServerIdentity("other.test", good)).toBeUndefined();
  expect(own).toBe(1);
  expect(seen[1].tls.checkServerIdentity("example.com", leaf).code).toBe("CERT_DISTRUSTED");
});

test("AAA leaves the CA list node:https uses when the system store or an extra CA file adds it", () => {
  const before = getCACertificates("default");
  try {
    expect(before.some((pem) => /AAA Certificate Services/.test(new X509Certificate(pem).subject))).toBe(false);
    setDefaultCACertificates([...before, AAA_ROOT, CROSS_SIGNED]);
    expect(distrustCompromisedCas()).toBe(2);
    expect(getCACertificates("default").length).toBe(before.length);
    expect(distrustCompromisedCas()).toBe(0);
  } finally {
    setDefaultCACertificates(before);
  }
});
