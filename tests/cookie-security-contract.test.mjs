import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// SvelteKit 3 depends on cookie ^2.0.1 itself, so the 0.7.2 override that patched SvelteKit 2's
// copy is gone. cookie 2 renamed parse/serialize to parseCookie/stringifySetCookie.
const kit = JSON.parse(await readFile(new URL("../node_modules/@sveltejs/kit/package.json", import.meta.url), "utf8"));
const installed = JSON.parse(await readFile(new URL("../node_modules/cookie/package.json", import.meta.url), "utf8"));
const { parseCookie, stringifySetCookie } = await import(new URL("../node_modules/cookie/dist/index.js", import.meta.url));

test("SvelteKit's cookie preserves normal serialization and rejects attribute injection", () => {
  assert.equal(kit.dependencies.cookie, "^2.0.1");
  assert.equal(Number(installed.version.split(".")[0]) >= 2, true, `cookie ${installed.version} is at least 2.0.1`);
  assert.equal(parseCookie("session=ok; theme=light").session, "ok");
  assert.equal(stringifySetCookie({ name: "session", value: "ok", httpOnly: true, sameSite: "lax", path: "/" }),
    "session=ok; Path=/; HttpOnly; SameSite=Lax");
  assert.throws(() => stringifySetCookie({ name: "session; injected", value: "ok" }));
  assert.throws(() => stringifySetCookie({ name: "session", value: "ok", path: "/; injected=value" }));
  assert.throws(() => stringifySetCookie({ name: "session", value: "ok", domain: "example.com; injected=value" }));
});
