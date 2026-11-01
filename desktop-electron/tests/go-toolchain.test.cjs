"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { goVersion, safeGo, binaryGoVersion, assertSafeGo } = require("../scripts/go-toolchain.cjs");

/** A binary's build-info block as Go 1.18+ writes it: 32-byte header, then varint-prefixed strings. */
function withBuildInfo(version) {
  const header = Buffer.alloc(32);
  Buffer.from("\xff Go buildinf:", "latin1").copy(header);
  header[14] = 8; // pointer size
  header[15] = 0x2; // strings inline
  return Buffer.concat([Buffer.from("MZ...padding..."), header, Buffer.from([version.length]), Buffer.from(version), Buffer.from([0])]);
}

test("only a Go with the crypto/x509 fix for the leaked eMudhra CAs may build what the app ships", () => {
  assert.deepEqual(goVersion("go version go1.27.3 windows/amd64"), [1, 27, 3]);
  assert.deepEqual(goVersion("go1.28"), [1, 28, 0]);
  for (const ok of ["go1.27.3", "go1.27.10", "go1.26.10", "go1.28", "go1.29.1"]) assert.equal(safeGo(goVersion(ok)), true, ok);
  for (const old of ["go1.27.1", "go1.27.2", "go1.26.9", "go1.25.12", "devel"]) assert.equal(safeGo(goVersion(old)), false, old);
  assert.throws(() => assertSafeGo("go version go1.27.1 windows/amd64", "The Go toolchain"), /go1\.27\.1.*1\.27\.3 or later.*CODING_TOOLS_GO/);
  assert.deepEqual(assertSafeGo("go1.27.3", "The built AO daemon"), [1, 27, 3]);
});

test("a binary's Go version is read from its build-info block, with no toolchain at hand", () => {
  assert.deepEqual(binaryGoVersion(withBuildInfo("go1.27.1")), [1, 27, 1]);
  assert.deepEqual(binaryGoVersion(withBuildInfo("go1.27.3")), [1, 27, 3]);
  assert.equal(binaryGoVersion(Buffer.from("MZ no Go here go1.27.3")), null, "a stray string is not a build-info block");
  const pointerVersion = withBuildInfo("go1.27.3");
  pointerVersion[pointerVersion.indexOf("\xff Go buildinf:", 0, "latin1") + 15] = 0;
  assert.equal(binaryGoVersion(pointerVersion), null, "pre-1.18 pointer-based blocks are not guessed at");
});
