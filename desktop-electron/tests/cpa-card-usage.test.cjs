"use strict";

// The usage lines the app adds to CPA's Auth Files cards (cpa-panel-session.cjs authFilesUsageScript),
// run against a small stand-in for the CPA console's page.

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { authFilesUsageScript } = require("../electron/cpa-panel-session.cjs");

const MARKER = `coding-tools-${"a".repeat(48)}`;

class Node {
  constructor(tag, className = "", text = "") {
    Object.assign(this, { tagName: tag.toUpperCase(), className, ownText: text, children: [], parentElement: null, style: {}, dataset: {}, title: "" });
  }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  after(node) {
    const siblings = this.parentElement.children;
    node.parentElement = this.parentElement;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
  }
  closest(tag) {
    for (let node = this; node; node = node.parentElement) if (node.tagName === tag.toUpperCase()) return node;
    return null;
  }
  querySelector(selector) {
    if (selector === ":scope > [data-coding-tools-usage]") return this.children.find((child) => "codingToolsUsage" in child.dataset) ?? null;
    const part = /^:scope > \[class\*="([^"]+)"\]$/.exec(selector)?.[1];
    return part ? this.children.find((child) => child.className.includes(part)) ?? null : null;
  }
  get innerLines() { return this.children.map((child) => child.textContent); }
}

function page(fileNames, answer, { storage = new Map() } = {}) {
  let at = NOW;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return at; } }
  const cards = fileNames.map((name) => {
    const card = new Node("article", "AuthFileCard-module__card___x");
    card.append(new Node("header", "AuthFileCard-module__head___x"), new Node("p", "AuthFileCard-module__fileName___x", name),
      new Node("div", "AuthFileCard-module__metaRow___x", "3.88 KB"), new Node("footer", "AuthFileCard-module__actions___x"));
    return card;
  });
  const listeners = {}, asked = [];
  let tick;
  const parent = {
    postMessage(message) {
      asked.push(message.range);
      setImmediate(() => listeners.message({ source: parent, data: { type: "cpm:usage:result", id: message.id, usage: answer(message.range) } }));
    },
  };
  const context = {
    location: { hash: "#/auth-files" },
    sessionStorage: { getItem: () => MARKER },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: {
      visibilityState: "visible", body: new Node("body"), addEventListener() {},
      createElement: (tag) => new Node(tag),
      querySelectorAll: () => cards.map((card) => card.children[1]),
    },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    MutationObserver: class { observe() {} },
    setInterval: (fn) => { tick = fn; return 0; }, setTimeout: (fn, ms) => (ms >= 1000 ? 0 : setImmediate(fn)),
    Date: Clock, Math, Number, String, Object, Array, Map, Promise, JSON,
  };
  context.window = Object.assign(context, { parent });
  return { cards, asked, storage, tick: () => tick(), clock: (value) => { at = value; },
    run: () => vm.runInNewContext(authFilesUsageScript(MARKER), context) };
}

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const settle = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
const row = (file, extra = {}) => ({ file, requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0,
  reasoningTokens: 0, totalTokens: 0, cost: 0, costSource: null, costPartial: false,
  window: { from: NOW - HOUR, to: NOW + 4 * HOUR }, usageAvailable: true, ...extra });

test("each Auth Files card shows its own current windows, matched by auth file name", async () => {
  // Two Codex files of the same email: the email alone could not tell them apart.
  const p = page(["codex-7b2243b3-me@example.com-team", "codex-90a3ad01-me@example.com-team", "antigravity-quiet@example.com"], (range) => ({
    available: true, range,
    accounts: range === "session" || range === "5h"
      ? [row("codex-7b2243b3-me@example.com-team", { requests: 12, failed: 2, totalTokens: 1_250_000, inputTokens: 1_200_000, outputTokens: 50_000, cost: 0.8421, costSource: "estimate" })]
      : [row("codex-7b2243b3-me@example.com-team", { requests: 340, totalTokens: 45_100_000, cost: 21.3, costSource: "cpa-helper" }),
        row("codex-90a3ad01-me@example.com-team", { requests: 1, totalTokens: 900, cost: 0.004, costSource: "estimate", costPartial: true })],
  }));
  assert.equal(p.run(), "started");
  await settle();
  assert.deepEqual(p.asked.sort(), ["5h", "7d", "session", "week"]);

  const [first, second, quiet] = p.cards.map((card) => card.children.find((child) => "codingToolsUsage" in child.dataset));
  assert.equal(p.cards[0].children.indexOf(first), 3, "the lines sit right under the card's size and date line");
  assert.deepEqual(first.innerLines, [
    "5-hour12 requests · 1.3M tokens · ≈$0.842",
    "Weekly340 requests · 45M tokens · $21.30",
  ]);
  assert.match(first.children[0].title, /Input 1\.2M · output 50K/);
  assert.match(first.children[0].title, /Since last limit reset/);
  assert.match(first.children[0].title, /2 failed requests/);
  assert.doesNotMatch(first.textContent, /Last|Current|failed|reset/);
  assert.deepEqual(second.innerLines, ["5-hourPending reset", "Weekly1 request · 900 tokens · ≈$0.004+"]);
  assert.deepEqual(quiet.innerLines, ["Last 5 h0 requests", "Last 7 days0 requests"], "non-Codex cards retain rolling history");
  assert.ok(p.storage.has("coding-tools-card-usage-v2"), "only reset-aligned answers are kept for the next page load");
});

test("unavailable usage adds nothing, and an unseeded or already running page is left alone", async () => {
  const p = page(["codex-a-me@example.com-team"], () => ({ available: false, reason: "Usage history is temporarily unavailable" }));
  p.run();
  await settle();
  assert.equal(p.cards[0].children.length, 4);
  assert.equal(p.run(), "running");
  assert.match(authFilesUsageScript(MARKER), /if \(sessionStorage\.getItem\('coding-tools-cpa-session'\) !== marker\) return 'unseeded';/);
});

test("an active window with unknown price displays Null, and a failed history read is not zero", async () => {
  const p = page(["codex-unknown", "codex-unreadable"], (range) => ({ available: true, range, accounts: [
    row("codex-unknown", { requests: 2, totalTokens: 30, cost: null, costPartial: true }),
    row("codex-unreadable", { usageAvailable: false }),
  ] }));
  p.run(); await settle();
  assert.match(p.cards[0].textContent, /30 tokens · Null/);
  assert.doesNotMatch(p.cards[0].textContent, /cost unknown|cost unavailable/);
  assert.match(p.cards[1].textContent, /Unavailable/);
  assert.match(p.cards[1].children.find((child) => 'codingToolsUsage' in child.dataset).innerLines[0], /Unavailable/);
});

test("cached totals expire at each reset even before the next scheduled refresh and after reload", async () => {
  const p = page(["codex-a"], (range) => ({ available: true, range, accounts: [row("codex-a", { requests: 7,
    window: { from: NOW - HOUR, to: range === "session" ? NOW + 1000 : NOW + 7 * HOUR } })] }));
  p.run(); await settle();
  assert.match(p.cards[0].textContent, /7 requests/);
  p.clock(NOW + 1000); p.tick();
  const box = p.cards[0].children.find((child) => "codingToolsUsage" in child.dataset);
  assert.equal(box.children.length, 2);
  assert.match(box.innerLines[0], /Pending reset/);
  assert.match(box.innerLines[1], /7 requests/, "weekly total does not reset with the short-hour total");
  const reloaded = page(["codex-a"], () => ({ available: false }), { storage: p.storage });
  reloaded.clock(NOW + 1000); reloaded.run();
  assert.match(reloaded.cards[0].textContent, /Pending reset/);
});

test("the old rolling cache is ignored, never relabelled as since-reset usage", async () => {
  const storage = new Map([["coding-tools-card-usage", JSON.stringify({ at: NOW, byRange: { "5h": [row("a", { requests: 999 })] } })]]);
  const p = page(["a"], () => ({ available: false }), { storage });
  p.run(); await settle();
  assert.doesNotMatch(p.cards[0].textContent, /999|Last 5|Current/);
});

test("provider metadata selects the two concise rows even for a custom Codex filename", async () => {
  const p = page(["custom-account"], (range) => ({ available: true, range,
    accounts: [row("custom-account", { provider: "codex", requests: 3 })] }));
  p.run(); await settle();
  const box = p.cards[0].children.find((child) => 'codingToolsUsage' in child.dataset);
  assert.equal(box.children.length, 2);
  assert.deepEqual(box.innerLines, ["5-hour3 requests · 0 tokens · ≈$0.000", "Weekly3 requests · 0 tokens · ≈$0.000"]);
});
