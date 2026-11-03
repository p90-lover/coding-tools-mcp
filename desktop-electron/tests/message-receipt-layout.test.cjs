const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "../src/features/codex-chat.css"), "utf8");
const rule = selector => css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]+)\\}"))?.[1] ?? "";

test("the message tick stays after hidden hover actions at the footer's right edge", () => {
  const receipt = rule(".cx-msg-foot > .cx-receipt");
  assert.match(receipt, /\border:\s*1\s*;/);
  assert.match(receipt, /\bflex:\s*none\s*;/, "a narrow pane must not shrink the receipt");
  assert.match(rule(".cx-msg-foot"), /justify-content:\s*flex-end/);
});

test("the edge-aligned tick's tooltip stays inside a narrow message pane", () => {
  const tooltip = rule('.cx-msg-foot > .cx-receipt[data-tip]::after');
  assert.match(tooltip, /\bright:\s*0\s*;/);
  assert.match(tooltip, /\bleft:\s*auto\s*;/);
  assert.match(tooltip, /\btransform:\s*none\s*;/);
});

test("receipt placement does not remove hover actions or sending/read state styling", () => {
  assert.match(rule(".cx-msg-actions"), /opacity:\s*0/);
  assert.match(css, /\.cx-msg-actions:focus-within\s*\{\s*opacity:\s*1/);
  assert.match(css, /\.cx-receipt\[data-receipt="sending"\] svg/);
  assert.match(css, /\.cx-receipt:focus-visible/);
});
