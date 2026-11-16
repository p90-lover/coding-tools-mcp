"use strict";

// 0.8.122's signed relay is retired: the egress router signs in to the proxy for all of the app's
// traffic (egress-router.test.cjs, proxy-routing-controller.test.cjs). Its path stays and points at
// the router, so nothing can start the old relay, which accepted any local program without a sign-in.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("the retired relay's path re-exports the egress router and nothing else", () => {
  const retired = require(path.join(root, "electron/signed-proxy-relay.cjs"));
  const router = require(path.join(root, "electron/egress-router.cjs"));
  assert.equal(retired, router);
  assert.equal(typeof retired.startEgressRouter, "function");
  assert.equal(retired.startSignedProxyRelay, undefined, "the old relay can't be started");
});

test("no app code requires the retired relay", () => {
  const electron = path.join(root, "electron");
  const users = fs.readdirSync(electron)
    .filter((name) => name.endsWith(".cjs") && name !== "signed-proxy-relay.cjs")
    .filter((name) => /require\(["']\.\/signed-proxy-relay\.cjs["']\)/.test(fs.readFileSync(path.join(electron, name), "utf8")));
  assert.deepEqual(users, []);
});
