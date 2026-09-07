import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.resolve("@sveltejs/kit/package.json"));
const { parse, serialize } = require("cookie");

test("patched cookie preserves normal serialization and rejects attribute injection", () => {
  assert.equal(require("cookie/package.json").version, "0.7.2");
  assert.equal(parse("session=ok; theme=light").session, "ok");
  assert.equal(serialize("session", "ok", { httpOnly: true, sameSite: "lax", path: "/" }),
    "session=ok; Path=/; HttpOnly; SameSite=Lax");
  assert.throws(() => serialize("session; injected", "ok"));
  assert.throws(() => serialize("session", "ok", { path: "/; injected=value" }));
  assert.throws(() => serialize("session", "ok", { domain: "example.com; injected=value" }));
});
