"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.resolve(__dirname, "../src/features/NetworkProxySurface.tsx"),
  "utf8",
);

test("Network Proxy routes all visible controls through localization", () => {
  for (const pattern of [/>Proxy</, />Add proxy</, />Save</, />Cancel</, />Apply</, />Routes</, />Unreachable</]) {
    assert.doesNotMatch(source, pattern, `${pattern} bypasses the language catalogue`);
  }

  for (const phrase of ["代理", "新增代理", "儲存", "取消", "套用", "路由", "連唔到", "通訊協定", "主機", "連接埠", "使用者名稱", "密碼"]) {
    assert.match(source, new RegExp(phrase), `missing Traditional Chinese copy: ${phrase}`);
  }

  assert.match(source, /policyModeLabel\(language, item\)/);
});

test("Network Proxy keeps Claude traffic on a proxy and offers the app's protocols", () => {
  assert.match(source, /PROXY_PATH_PROVIDERS = new Set\(\["claude-oauth", "anthropic-api"\]\)/);
  assert.match(source, /PROTOCOLS: readonly ProxyProtocol\[\] = \["http", "https", "socks5", "socks4"\]/);
});
