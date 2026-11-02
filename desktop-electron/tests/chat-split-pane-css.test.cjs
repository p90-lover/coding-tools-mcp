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

// Reported 2026-11-02 after resizing split panes: the head's buttons shrank with the title to their
// 16 px icons (17 px even in a 640 px pane), the chat box's permission, model and effort chips shrank
// to 0 px, and under ~480 px the head ran over into the next pane.
const chat = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
const container = (px) => {
  const at = css.indexOf(`@container cx-thread (max-width: ${px}px) {`);
  assert.ok(at >= 0, `a ${px} px tier`);
  return css.slice(at, css.indexOf("\n}", at));
};
test("a narrow chat keeps its buttons whole: they never shrink, and what the head drops is in its More menu", () => {
  assert.match(css, /\.cx-thread \{ container: cx-thread \/ inline-size; \}/, "measured on the chat, not the window: split panes share one window width");
  assert.match(css, /\.cx-thread-head > :is\(\.cx-icon-button, \.cx-browser-chip\), \.cx-composer-bar > :is\(\.cx-icon-button, \.cx-send\) \{ flex: none; \}/);
  assert.match(container(560), /\.cx-compact-toggle, \[aria-label="Open Mission Board"\]\) \{ display: none; \}/);
  for (const label of ['label: "Compact activity"', 'label: "Mission Board"']) assert.ok(chat.includes(label), `the More menu has ${label}`);
  assert.match(container(560), /\.cx-composer-bar \.ao-composer-controls \{ flex-wrap: wrap;/, "the chips fold onto a second row, not to 0 px");
  assert.match(container(400), /\.ao-composer-controls \{ order: -1; flex-basis: 100%; \}/, "then take rows of their own above the buttons");
  assert.match(container(300), /\[aria-label="Preview"\], \[aria-label="Show cards"\], \[aria-label="Show side panel"\]\) \{ display: none; \}/);
  assert.match(chat, /const NARROW_HEAD_PX = 300;/, "the More menu takes them over at the same width");
  for (const label of ['label: "Preview"', 'label: "Show cards"', 'label: "Side panel"']) assert.ok(chat.includes(label), `the More menu has ${label} when narrow`);
});
