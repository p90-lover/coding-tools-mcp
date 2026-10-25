import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";
test("preserves answer images and descriptive logos without forwarding transient image sources", () => {
  expect(chatGptHtmlToMarkdown(
    '<p>Diagram <img alt="Design diagram" src="https://assets.example.com/diagram.png?v=2"></p>'
    + '<p><picture><source srcset="https://assets.example.com/logo.webp">'
    + '<img alt="Brand logo" src="https://assets.example.com/logo.png"></picture></p>',
  )).toBe("Diagram ![Design diagram](<https://assets.example.com/diagram.png?v=2>)"
    + "\n\n![Brand logo](<https://assets.example.com/logo.png>)");

  expect(chatGptHtmlToMarkdown('<p><img alt="Private screenshot" src="blob:temporary-image">'
    + '<img alt="Embedded illustration" src="data:image/png;base64,ABC"></p>'))
    .toBe("[Image: Private screenshot][Image: Embedded illustration]");
});

test("browser answer extraction retains image descriptions but ignores preview widgets", () => {
  const { createDocument, createWindow } = require("@mixmark-io/domino");
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
  const source = worker.split("// CHATGPT_MARKDOWN_CONTENT_BEGIN")[1]?.split("// CHATGPT_MARKDOWN_CONTENT_END")[0];
  if (!source) throw new Error("ChatGPT Markdown content projection was not found");
  const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  const window = createWindow();
  const { contentFor, textFor } = new Function("HTMLElement", "Node",
    `${javascript}; return { contentFor: chatGptMarkdownContent, textFor: markdownText };`,
  )(window.HTMLElement, window.Node);
  const projected = contentFor(createDocument(
    '<p>Logo <img alt="Brand logo" src="https://assets.example.com/logo.png"></p>'
    + '<div class="chart-widget-container"><img alt="Chart spinner" src="https://assets.example.com/loading.png"></div>',
  ).body);
  expect(projected.querySelectorAll("img")).toHaveLength(1);
  expect(textFor(projected)).toContain("[Image: Brand logo]");
  expect(chatGptHtmlToMarkdown(projected.innerHTML))
    .toBe("Logo ![Brand logo](<https://assets.example.com/logo.png>)");
});


test("turns observed inline file path formats into Markdown links", () => {
  const cases = [
    {
      path: "output/path-format-probe/alpha-notes.md",
      target: "output/path-format-probe/alpha-notes.md",
    },
    {
      path: "output/path-format-probe/beta-report.json",
      target: "output/path-format-probe/beta-report.json",
    },
    {
      path: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
      target: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
    },
    {
      path: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
      target: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
    },
    {
      path: String.raw`C:\Users\Dev\Documents\Codex\path-format-probe\zeta-result.pdf`,
      target: "C:/Users/Dev/Documents/Codex/path-format-probe/zeta-result.pdf",
    },
    {
      path: "src/adapters/chatgpt-web/markdown.ts:47:3",
      target: "src/adapters/chatgpt-web/markdown.ts:47:3",
    },
  ];

  for (const { path, target } of cases) {
    expect(chatGptHtmlToMarkdown(`<p>Created <code>${path}</code>.</p>`))
      .toBe(`Created [${path}](<${target}>).`);
  }
});

test("preserves inline code that is not an unambiguous file path", () => {
  const html = [
    "<p>",
    "Run <code>bun test tests/example.test.ts</code>, inspect <code>FileChangeItem</code>, ",
    "and retain <code>turn/diff/updated</code>, <code>https://example.com/report.pdf</code>, ",
    "and <code>src/path without-extension</code>, <code>src/.</code>, and <code>src/..</code>.",
    "</p>",
    "<pre><code>src/example.ts</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Run `bun test tests/example.test.ts`, inspect `FileChangeItem`, and retain `turn/diff/updated`, `https://example.com/report.pdf`, and `src/path without-extension`, `src/.`, and `src/..`.",
    "",
    "```",
    "src/example.ts",
    "```",
  ].join("\n"));
});

test("does not nest a generated file link inside an existing link", () => {
  expect(chatGptHtmlToMarkdown(
    '<p>Open <a href="https://example.com/source"><code>src/example.ts</code></a>.</p>',
  )).toBe("Open [`src/example.ts`](https://example.com/source).");
});

test("converts Obsidian aliases and headings but preserves code examples and embeds", () => {
  const html = [
    "<p>Open [[Notes/weekly-review|review]] and [[Projects/sample#Status]].</p>",
    "<p>Keep <code>[[wiki/example]]</code> and ![[image.png]] literal.</p>",
    "<pre><code>\`\`\`not a closing fence\n[[wiki/fenced]]</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Open [review](<Notes/weekly-review.md>) and [Projects/sample#Status](<Projects/sample.md#Status>).",
    "",
    "Keep `[[wiki/example]]` and ![[image.png]] literal.",
    "",
    "````",
    "```not a closing fence",
    "[[wiki/fenced]]",
    "````",
  ].join("\n"));
});
