"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const css = fs.readFileSync(path.join(__dirname, "../src/features/codex-chat.css"), "utf8");
const theme = fs.readFileSync(path.join(__dirname, "../src/features/claude-theme.css"), "utf8");
const chat = fs.readFileSync(path.join(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");

test("the branch bar shares the composer's column and leaves only a two-pixel gap", () => {
  const branch = css.match(/\.ao-workflow \.cx-branch-bar \{([^}]+)\}/)[1];
  assert.match(branch, /flex:\s*0 0 auto/);
  assert.match(branch, /width:\s*calc\(100% - 48px\)/);
  assert.match(branch, /max-width:\s*780px/);
  assert.match(branch, /margin:\s*0 auto 2px/);
  assert.match(css, /\.ao-workflow \.cx-branch-bar\.is-inline \{[^}]*width:\s*auto[^}]*max-width:\s*40%[^}]*margin:\s*0/);
});

test("the narrow and Claude-themed branch bars track their composer's width without changing inline chips", () => {
  const narrow = css.slice(css.indexOf("@container cx-thread (max-width: 560px)"));
  assert.match(narrow, /\.ao-workflow \.cx-branch-bar:not\(\.is-inline\) \{\s*width:\s*calc\(100% - 24px\)/);
  assert.match(theme, /\.ao-workflow \.cx-chat \.cx-branch-bar:not\(\.is-inline\)[^{]*\{\s*max-width:\s*740px/);
});

test("composer height stays content-sized and optional goal controls do not reserve an empty row", () => {
  const textarea = css.match(/\.cx-composer textarea \{([^}]+)\}/)[1];
  assert.match(textarea, /field-sizing:\s*content/);
  assert.match(textarea, /max-height:\s*240px/);
  assert.match(chat, /<textarea ref=\{input\}[^>]*rows=\{1\}/);
  assert.match(chat, /commands\?\.goal \|\| commands\?\.planMode \|\| commands\?\.wakeup \|\| commands\?\.loop \|\| commands\?\.schedule \? <div className="cx-composer-modes">/);
});
