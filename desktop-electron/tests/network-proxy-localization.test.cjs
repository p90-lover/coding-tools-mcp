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
  const rawEnglishControls = [
    />Proxies</,
    />Rules</,
    />Applications</,
    />Connections</,
    />Start routing</,
    />Stop routing</,
    /<span>Protocol<\/span>/,
    /<span>Host<\/span>/,
    /<span>Port<\/span>/,
    /<span>Username<\/span>/,
    /<span>Password<\/span>/,
    />Check</,
    />Save proxy</,
    />Save rules</,
    />Provider routing</,
    />Account routing</,
  ];

  for (const pattern of rawEnglishControls) {
    assert.doesNotMatch(source, pattern, `${pattern} bypasses the language catalogue`);
  }

  for (const phrase of [
    "代理",
    "規則",
    "應用程式",
    "連線",
    "啟用路由",
    "停止路由",
    "安裝路由",
    "啟動 ProxyBridge Nova",
    "通訊協定",
    "主機",
    "連接埠",
    "使用者名稱",
    "密碼",
    "儲存代理",
    "儲存規則",
    "供應商路由",
    "帳戶路由",
  ]) {
    assert.match(source, new RegExp(phrase), `missing Traditional Chinese copy: ${phrase}`);
  }

  assert.match(source, /routingLabel\(language, routing\?\.state\)/);
  assert.match(source, /policyModeLabel\(language, item\)/);
  assert.match(source, /appStateLabel\(language, app\.state\)/);
});

test("Network Proxy keeps Claude traffic on a proxy and offers Nova's protocols", () => {
  assert.match(source, /PROXY_PATH_PROVIDERS = new Set\(\["claude-oauth", "anthropic-api"\]\)/);
  assert.match(source, /<option value="socks5">socks5<\/option><option value="http">http<\/option><option value="https">https<\/option>/);
  assert.doesNotMatch(source, /socks4/, "Nova has no SOCKS4 proxies");
});
