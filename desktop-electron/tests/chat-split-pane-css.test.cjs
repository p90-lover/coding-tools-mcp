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
  assert.match(container(300), /\.ao-composer-chip > \.ui-caret \{ display: none; \}/, "under 300 px the chips drop their carets to keep both rows whole");
  for (const px of [560, 400, 300]) assert.doesNotMatch(container(px), /\.ao-composer-controls \{[^}]*(order|flex-basis)/, `no ${px} px tier piles the chips onto rows of their own`);
  assert.match(container(300), /\[aria-label="Preview"\], \[aria-label="Show cards"\], \[aria-label="Show side panel"\]\) \{ display: none; \}/);
  assert.match(chat, /const NARROW_HEAD_PX = 300;/, "the More menu takes them over at the same width");
  for (const label of ['label: "Preview"', 'label: "Show cards"', 'label: "Side panel"']) assert.ok(chat.includes(label), `the More menu has ${label} when narrow`);
});

// The same day, after #914: under ~720 px the one-row chat box cut the permission and model names
// ("Ask fo…", "Opus 4…"), and #914's folding piled the chips onto up to four rows in a 340 px pane.
test("a narrow chat box has two rows: what runs it on top, attach, permissions, mode and Send under it", () => {
  const tier = container(720);
  assert.match(tier, /\.cx-composer-bar \.ao-composer-controls \{ display: contents; \}/, "its chips can sit on either row");
  assert.match(tier, /\.cx-composer-bar > \*, \.cx-composer-bar \.ao-composer-controls > \* \{ order: 2; \}/, "the bottom row by default");
  assert.match(tier, /\.ao-composer-controls > \.ao-composer-picker:not\(\.ao-permissions\) \{ order: 0; \}/, "the harness, model, effort and window on top");
  assert.match(tier, /\.cx-composer-bar::before \{ flex: 0 0 100%; order: 1; content: ""; \}/, "one break between them");
  assert.match(tier, /\[aria-label="Choose model"\], \[aria-label="Choose saved team"\]\)\) \{ flex: 1 1 0; min-width: 0; \}/,
    "the model starts from no width, so effort and window stay on its row instead of wrapping");
});

// Reported 2026-11-02: in a ~500 px pane the goal's objective fit on the first row, the state read "F"
// and the time sat alone on a second row.
test("a narrow goal bar always breaks before its objective, whatever the pane's width", () => {
  const tier = container(560);
  assert.match(tier, /\.cx-goal::before \{ flex: 0 0 100%; order: 1; content: ""; \}/, "one break after the state and buttons");
  assert.match(tier, /\.cx-goal-objective \{ order: 2; flex: 1 1 0;/, "the objective starts the second row, from no width");
  assert.match(tier, /\.cx-goal \.cx-goal-meta \{ order: 3; \}/, "its time beside it");
});
