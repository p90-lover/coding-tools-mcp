"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const Module = require("node:module");

// browser-host requires electron; only its pure helper is under test here.
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { app: {}, shell: {}, session: {}, WebContentsView: function () {} };
  return load.call(this, request, ...rest);
};
const { navigationFailurePage } = require(path.resolve(__dirname, "../electron/browser-host.cjs"));
Module._load = load;

const html = (page) => decodeURIComponent(page.slice("data:text/html;charset=utf-8,".length));

test("a ChatGPT page that fails to load shows why instead of a blank view", () => {
  const page = navigationFailurePage({ url: "https://chatgpt.com/?temporary-chat=true", errorCode: -130,
    errorDescription: "ERR_PROXY_CONNECTION_FAILED", proxy: "http://127.0.0.1:17891" });
  assert.ok(page.startsWith("data:text/html;charset=utf-8,"));
  const body = html(page);
  assert.match(body, /Can't reach chatgpt\.com/);
  assert.match(body, /proxy <b>http:\/\/127\.0\.0\.1:17891<\/b>, and nothing is answering there\. Start your proxy app \(ProxyBridge\)/);
  assert.match(body, /ERR_PROXY_CONNECTION_FAILED \(-130\)/);
  assert.match(body, /<a class="retry" href="https:\/\/chatgpt\.com\/\?temporary-chat=true">Retry<\/a>/);
});

test("a non-proxy failure gives a plain hint, and nothing from the page is injected", () => {
  const body = html(navigationFailurePage({ url: "https://chatgpt.com/<x>", errorCode: -105, errorDescription: "<script>alert(1)</script>" }));
  assert.match(body, /Check your connection, then retry\./);
  assert.doesNotMatch(body, /<script>alert/);
  assert.match(body, /&lt;script&gt;/);
  // Only an http(s) page gets a Retry link.
  assert.doesNotMatch(html(navigationFailurePage({ url: "javascript:alert(1)", errorCode: -105 })), /class="retry"/);
});

test("a proxy URL with credentials is named by scheme, host and port only", () => {
  const body = html(navigationFailurePage({ url: "https://chatgpt.com/", errorCode: -130,
    proxy: "http://coding-tools:GATEWAY_TOKEN_123@127.0.0.1:17894" }));
  assert.match(body, /proxy <b>http:\/\/127\.0\.0\.1:17894<\/b>/);
  assert.doesNotMatch(body, /GATEWAY_TOKEN_123|coding-tools:/, "neither the user name nor the token reaches the page");
  const unparsable = html(navigationFailurePage({ url: "https://chatgpt.com/", errorCode: -130, proxy: "user:secret@host:8080" }));
  assert.doesNotMatch(unparsable, /secret/, "a value that is not a URL is not shown at all");
  assert.match(unparsable, /the proxy set for this route/);
});
