"use strict";

// A chat reply is plain text with its summary under it, not a framed card (user, 2026-11-07: the box
// "placed the response message inside the box").

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "../src/features/codex-chat.css"), "utf8");

test("a chat reply has no box around it, in any chat style", () => {
  const rules = [...css.matchAll(/(^|\n)([^{}\n]*\.cx-reply(?![-\w])[^{}]*)\{([^}]*)\}/g)]
    .map((match) => ({ selector: match[2].trim(), body: match[3] }));
  const base = rules.find((rule) => rule.selector === ".cx-reply");
  assert.ok(base, "the reply's own rule exists");
  assert.match(base.body, /border:\s*0/);
  assert.match(base.body, /background:\s*transparent/);
  assert.match(base.body, /padding:\s*0/);
  // No other rule on the reply itself (a state, a chat style) draws an edge, a fill or a corner again.
  for (const rule of rules.filter((item) => item.selector.split(",").some((part) => /\.cx-reply(?:[.[][^\s>+~]*)?\s*$/.test(part.trim())))) {
    assert.doesNotMatch(rule.body, /\bborder(?:-left|-top|-right|-bottom)?\s*:\s*(?!0\b)[^;]*solid/, `${rule.selector} draws no border`);
    assert.doesNotMatch(rule.body, /\bbackground\s*:\s*(?![\s]|transparent)/, `${rule.selector} has no fill`);
  }
});
