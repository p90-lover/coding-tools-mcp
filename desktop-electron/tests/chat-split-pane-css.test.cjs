const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.resolve(__dirname, "../src/features/codex-chat.css"), "utf8");
const rule = (selector) => {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `${selector} has a rule`);
  return css.slice(at, css.indexOf("}", at));
};

// Seen 2026-10-27 in a five-pane split (panes 337-469 px wide): a code block's 1,800 px line made an
// answer 1,841 px wide, and a failed step's one-line meta pushed its card 160 px past the pane.
test("chat grids in the transcript shrink to a narrow split pane", () => {
  for (const selector of [".cx-answer", ".cx-steps", ".cx-step-earlier", ".cx-live", ".cx-tool-body", ".cx-card",
    ".cx-approval-dock", ".cx-command-card dl", ".cx-command-card ul"]) {
    assert.match(rule(selector), /grid-template-columns: minmax\(0, 1fr\)/, `${selector} uses a column that can shrink`);
  }
  assert.match(rule(".cx-live-item > .cx-tool"), /min-width: 0/, "an edit row's tool card can shrink in its flex row");
});

test("the chat never scrolls sideways; wide content scrolls in its own box", () => {
  assert.match(rule(".cx-scroll"), /overflow-x: hidden; overflow-y: auto;/);
  assert.match(rule(".cx-code pre"), /overflow: auto/);
});
