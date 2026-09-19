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
    />\+ New profile</,
    />Proxy profiles</,
    />No proxy profiles\.</,
    /\{draft\.id \? "Edit proxy" : "New proxy"\}/,
    /<span>Name<\/span>/,
    /<span>Protocol<\/span>/,
    /<span>Host<\/span>/,
    /<span>Port<\/span>/,
    /<span>Username<\/span>/,
    /<span>Password<\/span>/,
    /<span>Bypass<\/span>/,
    /<span>Enabled<\/span>/,
    />Test connection</,
    />Save proxy</,
    />Provider routing</,
    />Account routing</,
  ];

  for (const pattern of rawEnglishControls) {
    assert.doesNotMatch(source, pattern, `${pattern} bypasses the language catalogue`);
  }

  for (const phrase of [
    "新增設定檔",
    "代理設定檔",
    "未有代理設定檔。",
    "編輯代理",
    "新增代理",
    "名稱",
    "通訊協定",
    "主機",
    "連接埠",
    "使用者名稱",
    "密碼",
    "略過位址",
    "已啟用",
    "測試連線",
    "儲存代理",
    "供應商路由",
    "帳戶路由",
  ]) {
    assert.match(source, new RegExp(phrase), `missing Traditional Chinese copy: ${phrase}`);
  }

  assert.match(source, /scopeLabel\(language, scope\)/);
  assert.match(source, /policyModeLabel\(language, item\)/);
  assert.match(source, /statusLabel\(language,/);
});

test("Network Proxy exposes and localizes the typed subagent routing scope", () => {
  assert.match(source, /const SCOPES:[\s\S]*"subagent"/);
  assert.match(source, /case "subagent":/);
  assert.match(source, /"Subagents"/);
  assert.match(source, /"子代理程式"/);
  assert.match(source, /"子代理"/);
  assert.match(source, /"サブエージェント"/);
});
