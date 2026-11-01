import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ChatGptBrowserWorker, ChatGptCompletionTracker, ChatGptTurnDomHealthTracker } from "../src/adapters/chatgpt-web/browser-worker";
import {
  formatChatGptRichOutput,
  mergeChatGptRichOutputs,
  normalizeChatGptRichOutput,
  type ChatGptRichOutput,
} from "../src/adapters/chatgpt-web/rich-output";

const sourceUrl = "https://chatgpt.com/c/owned-conversation";

function capture(html: string, source = sourceUrl): ChatGptRichOutput | undefined {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow(`<body>${html}</body>`);
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
  const sourceCode = worker.split("// CHATGPT_RICH_OUTPUT_BEGIN")[1]?.split("// CHATGPT_RICH_OUTPUT_END")[0];
  const classifierCode = worker.split("// CHATGPT_COMMENTARY_CLASSIFIER_BEGIN")[1]?.split("// CHATGPT_COMMENTARY_CLASSIFIER_END")[0];
  if (!sourceCode || !classifierCode) throw new Error("ChatGPT rich output capture/classifier is missing");
  const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(`${classifierCode}\n${sourceCode}`);
  const { collector, classify } = new Function("HTMLElement", "URL", `${javascript}; return { collector: captureChatGptRichOutput, classify: selectChatGptAnswerRoots };`)(window.HTMLElement, URL);
  const owned = window.document.querySelector("#owned") ?? window.document.body;
  const roots = Array.from(owned.querySelectorAll(".answer"));
  const statuses = Array.from(owned.querySelectorAll("[data-streaming-response-status]"));
  return normalizeChatGptRichOutput(collector(owned, roots, source,
    (candidate: HTMLElement) => classify([candidate], statuses).answerRoots.includes(candidate)));
}

test("captures all rich response families without importing renderer controls or old turns", () => {
  const output = capture('<article id="old"><div class="answer"><img alt="Old image" src="https://cdn.example/old.png"></div></article>'
    + '<article id="owned"><div class="answer">'
    + '<img alt="Architecture" src="https://cdn.example/architecture.png">'
    + '<a download="report.pdf" href="sandbox:/mnt/data/report.pdf">Report PDF</a>'
    + '<audio aria-label="Narration"><source src="https://cdn.example/narration.mp3"></audio>'
    + '<video aria-label="Animation" src="https://cdn.example/animation.mp4"></video>'
    + '<div class="chart-widget-container" aria-label="Revenue chart"><button><svg><path></path></svg></button><svg><text>Chart axes</text></svg></div>'
    + '<div data-code-block-preview-pane="html" aria-label="Calculator app"><iframe src="blob:temporary-app"></iframe></div>'
    + '<div data-artifact-id="report" aria-label="Report artifact"><button>Open report</button></div>'
    + '</div><button><img alt="Copy toolbar icon" src="https://cdn.example/icon.png"></button></article>');
  expect(output?.sourceUrl).toBe(sourceUrl);
  expect(output?.items.map(item => item.kind)).toEqual(["image", "file", "audio", "video", "chart", "app", "artifact"]);
  expect(output?.items.some(item => /old|toolbar|axes/i.test(item.label))).toBe(false);
  expect(output?.items.find(item => item.kind === "audio")?.url).toBe("https://cdn.example/narration.mp3");
  expect(output?.items.find(item => item.kind === "file")?.url).toBeUndefined();
  expect(output?.items.find(item => item.kind === "app")?.url).toBeUndefined();
});

test("keeps commentary, quoted code, hidden images and toolbar SVG out of rich output", () => {
  expect(capture('<article id="owned">'
    + '<div class="markdown commentary"><img src="https://cdn.example/commentary.png"></div>'
    + '<div class="answer"><p>Plain answer.</p><pre><code>&lt;svg&gt;code&lt;/svg&gt;</code></pre>'
    + '<button><svg aria-label="Like"><path></path></svg></button>'
    + '<img hidden alt="Hidden tracking image" src="https://cdn.example/hidden.png">'
    + '</div></article>')).toBeUndefined();
  expect(capture('<article id="owned"><div class="answer"><svg role="img" aria-label="System diagram"><title>System diagram</title><path></path></svg></div></article>')?.items)
    .toEqual([{ kind: "diagram", label: "System diagram" }]);
});

test("retains generated-image zoom content and multiple unnamed charts without toolbar icons", () => {
  const output = capture('<article id="owned"><div class="answer">'
    + '<button><img width="1024" alt="Generated scene" src="blob:generated"></button>'
    + '<button><img width="16" alt="Toolbar icon" src="https://cdn.example/icon.png"></button>'
    + '<div class="chart-widget-container"></div><div class="chart-widget-container"></div><div class="chart-widget-container"></div>'
    + '</div></article>');
  expect(output?.items).toEqual([
    { kind: "image", label: "Generated scene" },
    { kind: "chart", label: "Interactive chart" },
    { kind: "chart", label: "Interactive chart (2)" },
    { kind: "chart", label: "Interactive chart (3)" },
  ]);
});

test("standalone widgets obey the same status and later-activity boundaries as answer Markdown", () => {
  expect(capture('<article id="owned">'
    + '<div class="chart-widget-container" aria-label="Before tool"></div>'
    + '<div data-streaming-response-status>Calling a tool</div>'
    + '<div class="markdown answer"><div class="chart-widget-container" aria-label="Final chart"></div></div>'
    + '</article>')?.items).toEqual([{ kind: "chart", label: "Final chart" }]);
  const inProgress = '<article id="owned"><div data-talvt-turn-state="in_progress">'
    + '<div data-code-block-preview-pane="html" aria-label="Before next activity"></div>'
    + '<div class="group/activity-header">Calling another tool</div>'
    + '<div class="answer" data-markdown-text-style="assistant-message"><div class="chart-widget-container" aria-label="Final chart"></div></div>'
    + '</div></article>';
  expect(capture(inProgress)?.items).toEqual([{ kind: "chart", label: "Final chart" }]);
  expect(capture(inProgress.replace('data-talvt-turn-state="in_progress"', 'data-talvt-turn-state="complete"'))?.items)
    .toEqual([{ kind: "app", label: "Before next activity" }, { kind: "chart", label: "Final chart" }]);
});

test("identified widget host buttons preserve previews without admitting toolbars or ordinary actions", () => {
  const output = capture('<article id="owned"><div data-streaming-response-status>'
    + '<button data-artifact-id="old" aria-label="Old tool preview"></button></div>'
    + '<div class="markdown answer">'
    + '<button data-artifact-id="report" aria-label="Report"><svg role="img"><title>Icon</title></svg></button>'
    + '<button data-canvas-id="board" aria-label="Board"></button>'
    + '<button data-code-block-preview-pane="html" aria-label="App"></button>'
    + '<button aria-label="Ordinary action"><svg role="img"><title>Action icon</title></svg></button>'
    + '<div role="toolbar"><button data-artifact-id="toolbar" aria-label="Toolbar preview"></button></div>'
    + '</div></article>');
  expect(output?.items).toEqual([
    { kind: "artifact", label: "Report" }, { kind: "artifact", label: "Board" }, { kind: "app", label: "App" },
  ]);
});

test("normalizes a bounded manifest and rejects executable or nonportable direct references", () => {
  const output = normalizeChatGptRichOutput({
    sourceUrl,
    html: '<script>alert("never")</script>',
    items: [
      { kind: "image", label: "Embedded image", url: "data:image/png;base64,AAA" },
      { kind: "file", label: "Private report", url: "https://chatgpt.com/backend-api/files/file-123/download" },
      { kind: "app", label: "App", url: "javascript:alert(1)" },
      { kind: "video", label: "Clip", url: "https://user:secret@cdn.example/clip.mp4" },
      { kind: "file", label: "File", url: "file:///C:/private/file.txt" },
      { kind: "image", label: " Bad\u0000\nlabel ", url: "https://cdn.example/image.png" },
      { kind: "unknown", label: "Not a rich item", url: "https://cdn.example/other" },
    ],
  });
  expect(output?.items).toHaveLength(6);
  expect(output?.items.slice(0, 5).every(item => item.url === undefined)).toBe(true);
  expect(output?.items.at(-1)?.label).toBe("Bad label");
  expect(JSON.stringify(output)).not.toContain("<script>");
  expect(normalizeChatGptRichOutput({ sourceUrl: "https://example.com/not-owned", items: [{ kind: "chart", label: "Plot" }] })?.sourceUrl)
    .toBeUndefined();
  const bounded = normalizeChatGptRichOutput({ sourceUrl, items: Array.from({ length: 100 }, (_, index) => ({
    kind: "file", label: `${index}${"x".repeat(1_000)}`, url: `https://cdn.example/file-${index}.pdf`,
  })) });
  expect(bounded!.items.length).toBeLessThanOrEqual(32);
  expect(bounded!.items.every(item => item.label.length <= 240)).toBe(true);
});

test("deduplicates polling snapshots and preserves ordinary streamed Markdown", () => {
  const first = { sourceUrl, items: [{ kind: "image" as const, label: "Architecture", url: "https://cdn.example/architecture.png" }] };
  const second = { sourceUrl, items: [...first.items, { kind: "chart" as const, label: "Revenue chart" }] };
  const output = mergeChatGptRichOutputs(first, second, second);
  expect(output?.items).toHaveLength(2);
  const markdown = "Answer\n\n```js\nconst x = 1;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n![Architecture](<https://cdn.example/architecture.png>)";
  const footer = formatChatGptRichOutput(output, markdown);
  expect(footer).not.toContain("architecture.png");
  expect(footer.match(/Revenue chart/g)).toHaveLength(1);
  expect(footer).toContain(sourceUrl);
  expect(markdown).toContain("```js\nconst x = 1;\n```");
  expect(formatChatGptRichOutput(undefined, "Plain text")).toBe("");
});

test("formats direct media, downloads and source-backed previews with an explicit unavailable fallback", () => {
  const output = normalizeChatGptRichOutput({ sourceUrl, items: [
    { kind: "image", label: "Image", url: "https://cdn.example/image.png" },
    { kind: "audio", label: "Audio", url: "https://cdn.example/audio.mp3" },
    { kind: "video", label: "Video", url: "https://cdn.example/video.mp4" },
    { kind: "file", label: "Report", url: "https://cdn.example/report.pdf" },
    { kind: "chart", label: "Chart" }, { kind: "app", label: "App" }, { kind: "artifact", label: "Artifact" },
  ] });
  const footer = formatChatGptRichOutput(output);
  expect(footer).toContain("![Image](<https://cdn.example/image.png>)");
  expect(footer).toContain("![Audio](<https://cdn.example/audio.mp3>)");
  expect(footer).toContain("![Video](<https://cdn.example/video.mp4>)");
  expect(footer).toContain("[Report](<https://cdn.example/report.pdf>)");
  expect(footer.match(/https:\/\/chatgpt.com\/c\/owned-conversation/g)).toHaveLength(3);
  expect(formatChatGptRichOutput({ items: [{ kind: "app", label: "App" }] })).toContain("unavailable");
  expect(formatChatGptRichOutput({ sourceUrl, items: [{ kind: "app", label: "x](javascript:alert(1))<script>" }] }))
    .not.toMatch(/(?<!\\)\]\(javascript:|<script>/);
});

test("rich-only completion needs stable owned content and still respects in-flight tools", () => {
  const tracker = new ChatGptCompletionTracker(500, 2_000);
  const state = { responsePresent: true, running: false, currentText: "", currentRichContent: "chart:owned-final", completionActionVisible: true };
  expect(tracker.update(state, 0)).toBeFalse();
  expect(tracker.update(state, 500)).toBeTrue();
  expect(tracker.update({ ...state, externalToolCallsInFlight: true }, 1_000)).toBeFalse();
  expect(tracker.update(state, 1_001)).toBeFalse();
  expect(tracker.update(state, 1_501)).toBeTrue();
  expect(tracker.observeToolBatch(1, state.currentText)).toBeTrue();
  expect(tracker.update(state, 1_502)).toBeFalse();
  expect(() => tracker.update(state, 3_502)).toThrow(expect.objectContaining({ code: "browser_rich_preview_unreadable", retryable: false }));
});

test("rich-only replies do not become empty-completion health errors", () => {
  const tracker = new ChatGptTurnDomHealthTracker(1_000, 1_000, 1_000);
  const state = { responsePresent: true, running: false, currentText: "", currentRichContent: "image:owned-final", completionActionVisible: true };
  expect(tracker.update(state, 0)).toBeUndefined();
  expect(tracker.update(state, 10_000)).toBeUndefined();
  expect(tracker.update({ ...state, currentRichContent: undefined }, 10_001)).toBeUndefined();
  expect(tracker.update({ ...state, currentRichContent: undefined }, 11_001)).toContain("without a final answer");
});

test("every rich-only post-tool preview requires a fresh settled generation", () => {
  const tracker = new ChatGptCompletionTracker(5, 10);
  const state = { responsePresent: true, running: false, currentText: "", currentRichContent: "owned-preview",
    completionActionVisible: true, externalToolCallsInFlight: false };
  tracker.observeToolBatch(1, "");
  expect(tracker.update({ ...state, running: true, completionActionVisible: false, externalToolCallsInFlight: true }, 0)).toBeFalse();
  expect(tracker.update(state, 1)).toBeFalse();
  expect(() => tracker.update(state, 11)).toThrow(expect.objectContaining({ code: "browser_rich_preview_unreadable", retryable: false }));
  expect(tracker.update({ ...state, running: true, completionActionVisible: false }, 12)).toBeFalse();
  expect(tracker.update(state, 13)).toBeFalse();
  expect(tracker.update(state, 18)).toBeTrue();
  tracker.observeToolBatch(2, "");
  expect(tracker.update(state, 19)).toBeFalse();
  expect(() => tracker.update(state, 29)).toThrow(expect.objectContaining({ code: "browser_rich_preview_unreadable", retryable: false }));
  expect(tracker.update({ ...state, running: true, completionActionVisible: false }, 30)).toBeFalse();
  expect(tracker.update({ ...state, running: true, completionActionVisible: false, externalToolCallsInFlight: true }, 31)).toBeFalse();
  expect(tracker.update(state, 32)).toBeFalse();
  expect(() => tracker.update(state, 42)).toThrow(expect.objectContaining({ code: "browser_rich_preview_unreadable", retryable: false }));

  const opaque = new ChatGptCompletionTracker(5, 10);
  opaque.observeToolBatch(1, "");
  expect(opaque.update({ ...state, currentRichContent: "only-outer-metadata-changed" }, 0)).toBeFalse();
  expect(() => opaque.update({ ...state, currentRichContent: "only-outer-metadata-changed" }, 10))
    .toThrow(expect.objectContaining({ code: "browser_rich_preview_unreadable", retryable: false }));

  const prose = new ChatGptCompletionTracker(5, 10);
  prose.observeToolBatch(1, "Same answer");
  expect(prose.update({ ...state, currentText: "Same answer", running: true, completionActionVisible: false }, 0)).toBeFalse();
  expect(prose.update({ ...state, currentText: "Same answer" }, 1)).toBeFalse();
  expect(() => prose.update({ ...state, currentText: "Same answer", currentRichContent: "changed-reference" }, 11))
    .toThrow("without producing a final answer");
});

test("a completed source view can settle while its interactive canvas keeps animating", () => {
  const state = { responsePresent: true, running: false, currentText: "", completionActionVisible: true, externalToolCallsInFlight: false };
  const firstTurn = new ChatGptCompletionTracker(5, 10);
  expect(firstTurn.update({ ...state, currentRichContent: "frame-1" }, 0)).toBeFalse();
  expect(firstTurn.update({ ...state, currentRichContent: "frame-2" }, 5)).toBeTrue();
  const afterTool = new ChatGptCompletionTracker(5, 10);
  afterTool.observeToolBatch(1, "");
  expect(afterTool.update({ ...state, running: true, completionActionVisible: false, currentRichContent: "frame-1" }, 0)).toBeFalse();
  expect(afterTool.update({ ...state, currentRichContent: "frame-2" }, 1)).toBeFalse();
  expect(afterTool.update({ ...state, currentRichContent: "frame-3" }, 6)).toBeTrue();
});

test("owned SVG redraws stay source views until fresh model generation completes", async () => {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow('<body><article id="old"><img src="https://cdn.example/old.png"></article>'
    + '<article id="owned"><div class="chart-widget-container" aria-label="Revenue"><button>Copy chart</button><svg><text>100</text><path d="M0 100 L1 100"></path></svg></div>'
    + '<button data-testid="copy-turn-action-button">Copy</button></article></body>');
  Object.defineProperty(window.HTMLElement.prototype, "isConnected", { configurable: true, get() { return true; } });
  const root = window.document.querySelector("#owned");
  const globals = { documentId: "fixture" };
  const mutations: Array<{ changed: () => void; attributes: string[] }> = [];
  const notifyMutation = (attribute?: string) => mutations
    .filter(observer => !attribute || observer.attributes.includes(attribute))
    .forEach(observer => observer.changed());
  let evaluations = 0;
  const locator = {
    evaluate: async (callback: Function, options: unknown) => {
      evaluations += 1;
      const execute = new Function("element", "options", "globalThis", "document", "location", "performance", "MutationObserver", "HTMLElement", "Element", "Node", "NodeFilter", "getComputedStyle",
        `return (${callback.toString()})(element, options);`);
      return execute(root, options, globals, window.document, { href: sourceUrl }, { timeOrigin: 1 }, class {
        constructor(private readonly changed: () => void) {}
        observe(_root: unknown, options: { attributeFilter: string[] }) { mutations.push({ changed: this.changed, attributes: options.attributeFilter }); }
      },
        window.HTMLElement, window.Element, window.Node, window.NodeFilter,
        () => ({ display: "block", visibility: "visible", opacity: "1" }));
    },
    page: () => ({ isClosed: () => false }),
  };
  const worker = Object.create(ChatGptBrowserWorker.prototype);
  const cache: { cacheHits?: number } = {};
  const first = await worker.responseDomSnapshot(locator, cache);
  const second = await worker.responseDomSnapshot(locator, cache);
  expect(first.visibleText).toBe("");
  expect(first.markdownSegments).toEqual([]);
  expect(first.completionActionVisible).toBeTrue();
  expect(first.richOutput).toEqual({ sourceUrl, items: [{ kind: "chart", label: "Revenue" }] });
  expect(first.richContentKey).toBeTruthy();
  expect(second).toBe(first);
  expect(cache.cacheHits).toBe(1);
  expect(evaluations).toBe(2);

  const tracker = new ChatGptCompletionTracker(500);
  tracker.observeToolBatch(1, first.visibleText);
  const state = (snapshot: typeof first) => ({ responsePresent: true, running: false, currentText: snapshot.visibleText,
    currentHtml: snapshot.fullHtml, currentRichContent: snapshot.richContentKey, completionActionVisible: true, externalToolCallsInFlight: false });
  expect(tracker.update(state(first), 0)).toBeFalse();
  root.querySelector(".chart-widget-container button").textContent = "Copied";
  notifyMutation();
  const controlsOnly = await worker.responseDomSnapshot(locator, cache);
  expect(controlsOnly.richContentKey).toBe(first.richContentKey);
  expect(tracker.update(state(controlsOnly), 1)).toBeFalse();
  root.querySelector("svg text").textContent = "200";
  notifyMutation();
  const updated = await worker.responseDomSnapshot(locator, cache);
  expect(updated.richOutput).toEqual(first.richOutput);
  expect(updated.richContentKey).toBe(first.richContentKey);
  expect(tracker.update({ ...state(updated), externalToolCallsInFlight: true }, 1)).toBeFalse();
  expect(tracker.update(state(updated), 2)).toBeFalse();
  expect(tracker.update(state(updated), 502)).toBeFalse();
  expect(tracker.update({ ...state(updated), running: true, completionActionVisible: false }, 503)).toBeFalse();
  expect(tracker.update(state(updated), 504)).toBeFalse();
  expect(tracker.update(state(updated), 1_004)).toBeTrue();

  root.querySelector("svg path").setAttribute("d", "M0 200 L1 200");
  notifyMutation("d");
  const reshaped = await worker.responseDomSnapshot(locator, cache);
  expect(reshaped.richOutput).toEqual(updated.richOutput);
  expect(reshaped.richContentKey).toBe(updated.richContentKey);
  root.querySelector('[data-testid="copy-turn-action-button"]').remove();
  root.insertAdjacentHTML("beforeend", '<button data-artifact-id="report" data-testid="copy-turn-action-button" aria-label="Report">Copy artifact</button>');
  notifyMutation();
  expect((await worker.responseDomSnapshot(locator, cache)).completionActionVisible).toBeFalse();
});
