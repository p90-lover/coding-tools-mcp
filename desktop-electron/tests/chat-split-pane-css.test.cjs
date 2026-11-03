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
  assert.match(css, /\n\.ao-workflow :is\(\.cx-composer \.ao-composer-chip, \.cx-branch-chip\) > \.ui-caret \{ display: none; \}/,
    "no down arrows on the chat box's chips or the branch, at any width (asked for 2026-11-03)");
  for (const px of [560, 400, 300]) assert.doesNotMatch(container(px), /\.ao-composer-controls \{[^}]*(order|flex-basis)/, `no ${px} px tier piles the chips onto rows of their own`);
  assert.match(container(300), /\[aria-label="Preview"\], \[aria-label="Show cards"\], \[aria-label="Show side panel"\]\) \{ display: none; \}/);
  assert.match(chat, /const NARROW_HEAD_PX = 300;/, "the More menu takes them over at the same width");
  for (const label of ['label: "Preview"', 'label: "Show cards"', 'label: "Side panel"']) assert.ok(chat.includes(label), `the More menu has ${label} when narrow`);
});

// The same day, after #914: under ~720 px the one-row chat box cut the permission and model names
// ("Ask fo…", "Opus 4…"), and #914's folding piled the chips onto up to four rows in a 340 px pane.
// Then two fixed rows left both half empty in a split pane and took two rows even at 700 px (2026-11-03).
// Then folding what didn't fit (#962) set side-by-side panes' chips differently, each by its model's
// name, and the user asked for every pane's on one row, names fading rather than buttons going (2026-11-03).
test("a narrow chat box keeps one row in every pane: the model's name gives up its room, fading out", () => {
  const tier = container(720);
  assert.doesNotMatch(tier, /flex-wrap: wrap/, "it never folds");
  assert.doesNotMatch(tier, /display: contents/, "the controls' box stays one block between attach and Send");
  assert.doesNotMatch(tier, /order: \d/, "the chips stay in reading order");
  assert.match(tier, /\.ao-composer-controls > \* \{ flex: none; \}/, "permissions, Single/Team, the harness and the window keep their size");
  assert.match(tier, /\[aria-label="Choose model"\], \[aria-label="Choose saved team"\]\)\) \{\s*flex: 0 1 auto; min-width: 40px; \}/, "the model gives up its room first");
  assert.match(tier, /\[aria-label\^="Reasoning effort"\]\) \{ flex: 0 0\.001 auto; min-width: 34px; \}/,
    "the effort only once the model is at its least: shrinking together, \"Max\" read \"Ma\"");
  assert.match(css, /\.ao-composer-chip > span:nth-last-child\(2\), \.ao-workflow \.cx-branch-chip > span:nth-of-type\(1\) \{\s*text-overflow: clip; animation: cx-cut-fade linear both; animation-timeline: scroll\(self inline\); \}/,
    "a cut name fades out, and only while it overflows (its scroll timeline exists only then)");
  assert.match(css, /@keyframes cx-cut-fade \{ from, to \{ mask-image: linear-gradient\(to right, #000 calc\(100% - 14px\), transparent\); \} \}/);
  // Measured live 2026-11-03 in ten split panes 392-513 px wide: one 32 px row each, nothing past the box's edge.
  const narrow = container(360);
  assert.match(narrow, /\.cx-composer-bar \{ flex-wrap: wrap; row-gap: 2px; \}/, "a pane too narrow for the row at all takes two");
  assert.match(narrow, /\.cx-composer-bar:has\(\.ao-composer-chip\[aria-label\^="Reasoning effort"\]\)::after \{ flex: 0 0 100%; order: 1; content: ""; \}/,
    "one break, right after the model, and only when there are effort and window chips to put under it");
  assert.match(narrow, /\[aria-label\^="Reasoning effort"\], \[aria-label\^="Context window"\]\)\),\s*\.cx-composer-bar > \.cx-composer-send \{ order: 2; \}/,
    "effort, window and Send take the second row");
  assert.match(narrow, /\[aria-label="Choose model"\]\) \{ flex: 1 1 0; \}/, "the model takes what the first row leaves");
  assert.match(css, /\n\.cx-composer-send \{ display: flex; flex: none; align-items: center; gap: 6px; margin-left: auto; \}/,
    "Send, the mic and the context ring move as one, at the right end of the row they end on");
  assert.match(chat, /<div className="cx-composer-send">\s*\{selectedTaskId \? <ChatContextMeter/, "the chat box groups them");
  const bar = chat.slice(chat.indexOf('<div className="cx-composer-bar">'), chat.indexOf('<div className="cx-composer-send">'));
  assert.ok(bar.includes("AgentOrchestratorComposerControls") && !bar.includes("cx-head-spacer"), "no spacer splits the row");
  assert.match(tier, /\.cx-composer-send > \.cx-mic \{ display: none; \}/, "the placeholder mic leaves a narrow chat box");
  assert.match(tier, /\.ao-permissions > \.ao-composer-chip > span \{ display: none; \}/, "the permission chip is its level's icon, its name on hover");
});

// Reported 2026-11-02: in a ~500 px pane the goal's objective fit on the first row, the state read "F"
// and the time sat alone on a second row.
test("a narrow goal bar always breaks before its objective, whatever the pane's width", () => {
  const tier = container(560);
  assert.match(tier, /\.cx-goal::before \{ flex: 0 0 100%; order: 1; content: ""; \}/, "one break after the state and buttons");
  assert.match(tier, /\.cx-goal-objective \{ order: 2; flex: 1 1 0;/, "the objective starts the second row, from no width");
  assert.match(tier, /\.cx-goal \.cx-goal-meta \{ order: 3; \}/, "its time beside it");
});

// Asked for 2026-11-03: the head fades into the chat, so a little more of it shows under the head.
// Asked again that day: more transparent still; the title and buttons keep plates so lines under them don't cross them.
test("the chat's head floats over the transcript as a thin veil, and the transcript starts below it", () => {
  const head = rule(".cx-thread-head");
  assert.match(head, /position: absolute; z-index: 1; top: 0; right: 0; left: 0;/);
  assert.match(head, /background: linear-gradient\(to bottom, color-mix\(in srgb, var\(--color-bg-primary\) 72%, transparent\),\s*color-mix\(in srgb, var\(--color-bg-primary\) 40%, transparent\) 55%, transparent\); pointer-events: none;/,
    "no solid band: the chat shows through all of it");
  assert.match(css, /\.cx-thread-head h2 \{ border-radius: 6px; background: color-mix\(in srgb, var\(--color-bg-primary\) 92%, transparent\); \}/, "the title's plate");
  assert.match(css, /\.cx-thread-head > :is\(\.cx-icon-button, \.cx-head-folder\) \{ background-color: color-mix\(in srgb, var\(--color-bg-primary\) 92%, transparent\);/, "the icons' plates");
  const theme = fs.readFileSync(path.resolve(__dirname, "../src/features/claude-theme.css"), "utf8");
  assert.doesNotMatch(theme, /\.cx-pane:not\(\[data-focused\]\) \.cx-thread-head > [^{]*\{ opacity: 0;/, "a pane not focused fades its buttons; they don't disappear");
  assert.match(theme, /\.cx-pane:not\(\[data-focused\]\):not\(:hover\) \.cx-thread-head > \.cx-icon-button \{ color: color-mix\(/, "by colour, so their plates stay whole");
  assert.match(rule(".cx-column"), /padding: 16px 24px 10px;/, "the last reply sits just above the branch bar");
  assert.match(theme, /\.ao-workflow \.cx-chat \.cx-column \{ gap: 22px; max-width: 788px; padding: 20px 24px 10px; \}/);
  assert.match(css, /\.cx-thread-head > :not\(\.cx-head-spacer\) \{ pointer-events: auto; \}/, "its buttons and title still take clicks");
  assert.match(rule(".cx-thread"), /position: relative;/, "it floats over its own pane only");
  assert.match(rule(".cx-scroll"), /padding-top: 48px; scroll-padding-top: 48px;/, "the first line and sticky headers start below the head");
});

// Asked for the same day: the objective holds one line, fades out into its time, and shrinks with the pane.
test("the goal's objective is one line that fades out before its time and shrinks with the pane", () => {
  const objective = rule(".cx-goal-objective");
  assert.match(objective, /white-space: nowrap;/);
  assert.doesNotMatch(objective, /text-overflow: ellipsis/, "a fade, not an ellipsis");
  assert.match(objective, /mask-image: linear-gradient\(to right, #000 calc\(100% - 32px\), transparent\);/);
  assert.match(objective, /font-size: clamp\(10px, 1\.6cqi \+ 4px, 12px\);/, "sized by the chat's width, not the window's");
});

test("Single or Team is one switch whose logos roll over, and stays still for reduced motion", () => {
  assert.match(css, /\.ao-mode-toggle\[data-mode="single"\] > \.is-team \{ opacity: 0; transform: translateY\(115%\)/, "Team waits below while Single is in use");
  assert.match(css, /\.ao-mode-toggle\[data-mode="team"\] > \.is-single \{ opacity: 0; transform: translateY\(-115%\)/, "Single leaves upward for Team");
  assert.match(css, /\.ao-mode-face \{[^}]*transition: transform/, "the logos move, they don't blink");
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.ao-workflow \.cx-composer :is\(\.ao-mode-toggle, \.ao-mode-face\) \{ transition: none; \}/);
  assert.doesNotMatch(css, /\.ao-mode-switch/, "the two-button switch is gone");
});
