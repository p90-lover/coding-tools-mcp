"use strict";

// Settings › Chat › Local auto-review: the switch (on by default) and the plugin's stats, beside the
// other Approve for me settings. Main loads the plugin (auto-review-host.cjs), gives it to the
// workflow and pushes its stats to the window; the page never polls.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

test("main loads the plugin host, hands it to the workflow, pushes its stats and closes it on quit", () => {
  const main = read("electron/main.cjs");
  assert.match(main, /require\("\.\/auto-review-host\.cjs"\)/);
  assert.match(main, /createAgentOrchestratorWorkflow\(\{[\s\S]{0,400}autoReview: autoReviewHost,/);
  assert.match(main, /autoReviewHost\.onStats\(\(stats\) => send\("launcher:auto-review-stats", stats\)\)/);
  assert.match(main, /autoReviewHost\?\.close\(\)/);
  // Reading the switch and stats is passive (no focus needed), like the other chat switches; turning it is not.
  assert.match(main, /input\.operation === "chat_auto_review" && input\.arguments\?\.enabled === undefined/);
  assert.doesNotMatch(main, /autoReviewHost\.(?:call|editBlocklist|editRule|reset|setEnabled)\b/, "main never offers the plugin's admin calls");
});

test("the operation is declared for the apps host, and the window hears the stats push", () => {
  assert.match(read("../app-handler/agent-orchestrator/handler.cjs"), /chat_auto_review: \{ readOnly: false,/);
  assert.match(read("electron/preload.cjs"), /onAutoReviewStats: \(listener\) => subscription\("launcher:auto-review-stats", listener\)/);
  assert.match(read("src/types.ts"), /onAutoReviewStats\?\(listener: \(stats: unknown\) => void\): \(\) => void;/);
});

test("Settings › Chat shows the switch and the stats with the Approve for me settings", () => {
  const page = read("src/features/ChatSettingsPage.tsx");
  assert.ok(page.includes('chatCall("chat_auto_review")'), "read from the bridge");
  assert.ok(page.includes('setChatPreference("chat_auto_review", { enabled: next })'), "set through the bridge");
  assert.match(page, /<Toggle label="Local auto-review" checked=\{chat\?\.autoReview !== false\}/);
  assert.match(page, /<AutoReviewStatsPanel /);
  const turns = page.slice(page.indexOf('<Group title="Turns">'), page.indexOf('<Group title="Keyboard shortcuts">'));
  assert.ok(turns.includes("Local auto-review") && turns.includes("Let the model judge"), "in the same group as Let the model judge");
  const panel = read("src/features/AutoReviewStats.tsx");
  assert.match(panel, /onAutoReviewStats/);
  assert.doesNotMatch(panel, /setInterval|setTimeout/, "no polling");
});

test("the stats read as today, 7 days and all time, with the trend and the commands still reaching the person", async () => {
  const { summarizeAutoReview } = await import("../src/features/auto-review-stats.ts");
  assert.equal(summarizeAutoReview(null), null);
  const window = (total, autoRate, wrongRate, reachedUser) => ({ total, autoSettled: total - reachedUser, autoRate, reachedUser, wrong: 0, wrongRate });
  const summary = summarizeAutoReview({
    enabled: true,
    commands: { today: window(10, 80, 0, 2), last7Days: window(70, 75.5, 1.25, 17), allTime: window(300, 60, 2, 120) },
    trend: { direction: "up", deltaPoints: 4.2, last7AutoRate: 75.5, prev7AutoRate: 71.3 },
    topReachingUser: [{ pattern: "python * @cwd", count: 9, example: "python tools/migrate.py --apply", lastSeen: 1 },
      { pattern: "docker build", count: 4, example: "docker build .", lastSeen: 2 }],
  });
  assert.deepEqual(summary.windows, [
    { label: "Today", total: 10, auto: "80%", wrong: "0%", reachedUser: 2 },
    { label: "7 days", total: 70, auto: "75.5%", wrong: "1.3%", reachedUser: 17 },
    { label: "All time", total: 300, auto: "60%", wrong: "2%", reachedUser: 120 },
  ]);
  assert.equal(summary.trend, "Up 4.2 points on the 7 days before (71.3% to 75.5% settled by itself)");
  assert.deepEqual(summary.top, [{ pattern: "python * @cwd", count: 9, example: "python tools/migrate.py --apply" },
    { pattern: "docker build", count: 4, example: "docker build ." }]);
  assert.equal(summarizeAutoReview({ enabled: false, commands: {}, trend: { direction: "flat", deltaPoints: 0 } }).trend, "No change on the 7 days before");
});
