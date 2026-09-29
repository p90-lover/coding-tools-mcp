"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { tcpErrorText } = require("../electron/provider-network.cjs");

test("a proxy test names the per-address failure instead of an empty message", () => {
  const blocked = Object.assign(new AggregateError([
    Object.assign(new Error(""), { code: "EACCES", address: "149.102.253.118" }),
    Object.assign(new Error(""), { code: "EACCES", address: "149.102.253.120" }),
  ], ""), { code: "EACCES" });
  assert.equal(tcpErrorText(blocked), "Connection failed: EACCES 149.102.253.118, EACCES 149.102.253.120");
  assert.equal(tcpErrorText(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" })), "connect ECONNREFUSED 127.0.0.1:1");
  assert.equal(tcpErrorText(Object.assign(new Error(""), { code: "ETIMEDOUT" })), "ETIMEDOUT");
  assert.equal(tcpErrorText("boom"), "boom");
});
