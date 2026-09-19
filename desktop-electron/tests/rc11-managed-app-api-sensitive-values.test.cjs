"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  sanitizePublic,
  validateReconcileReason,
} = require("../electron/managed-app-api.cjs");

const TOKEN_FIXTURES = Object.freeze({
  openai: `sk-proj-${"A".repeat(32)}`,
  github: `ghp_${"b".repeat(36)}`,
  githubPat: `github_pat_${"C".repeat(30)}`,
  google: `AIza${"d".repeat(35)}`,
  googleOauth: `ya29.${"e".repeat(32)}`,
  slack: `xoxb-${"1234567890-".repeat(3)}secret`,
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtYW5hZ2VkLWFwcCJ9.c2lnbmF0dXJlMTIzNDU2Nzg5MA",
});

test("managed app public projection redacts bare credential-shaped values under safe keys", () => {
  const projected = sanitizePublic({
    detail: Object.values(TOKEN_FIXTURES).join(" "),
    nested: {
      value: TOKEN_FIXTURES.openai,
      stdout: `completed ${TOKEN_FIXTURES.github}`,
    },
    safe: "normal-managed-app-message",
  });

  const serialized = JSON.stringify(projected);
  for (const secret of Object.values(TOKEN_FIXTURES)) {
    assert.equal(serialized.includes(secret), false, `public output leaked ${secret.slice(0, 12)}`);
  }
  assert.equal(projected.safe, "normal-managed-app-message");
  assert.match(serialized, /\[REDACTED\]/);
});

test("managed app reconcile reasons reject credential-shaped values before logging or persistence", () => {
  assert.equal(typeof validateReconcileReason, "function");
  assert.equal(validateReconcileReason(undefined), "managed-app-api");
  assert.equal(validateReconcileReason("user-request"), "user-request");
  assert.equal(validateReconcileReason("repair.after-update"), "repair.after-update");

  for (const secret of Object.values(TOKEN_FIXTURES)) {
    assert.throws(
      () => validateReconcileReason(secret),
      /reason.*(?:credential|sensitive|token)/i,
    );
  }
  assert.throws(
    () => validateReconcileReason(`Authorization=Bearer ${TOKEN_FIXTURES.openai}`),
    /reason.*(?:credential|sensitive|token)/i,
  );
});
