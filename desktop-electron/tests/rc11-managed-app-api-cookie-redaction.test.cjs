"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { sanitizePublic } = require("../electron/managed-app-api.cjs");

test("managed app API removes generic cookie fields and cookie headers", () => {
  const projected = sanitizePublic({
    cookie: "session=plain-cookie-secret",
    cookies: ["refresh=plain-cookie-list-secret"],
    setCookie: "session=plain-set-cookie-secret; Path=/; HttpOnly",
    nested: {
      "Set-Cookie": "oauth=plain-header-cookie-secret; Secure",
    },
    message: "Cookie: sid=plain-message-cookie-secret; Set-Cookie: rid=plain-message-set-cookie-secret; Path=/",
    safe: true,
  });

  assert.deepEqual(Object.keys(projected).sort(), ["message", "nested", "safe"]);
  assert.deepEqual(projected.nested, {});
  assert.equal(projected.safe, true);
  assert.doesNotMatch(
    JSON.stringify(projected),
    /plain-(?:cookie|set-cookie|header-cookie|message-cookie|message-set-cookie)-secret/,
  );
  assert.match(projected.message, /Cookie=\[REDACTED\]/);
  assert.match(projected.message, /Set-Cookie=\[REDACTED\]/);
});
