import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ChatGptMarkdownBuffer, chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";

test("preserves native visualize JSON through HTML and streamed or final Markdown", () => {
  const references = [
    ...["G:/task/counter.html", String.raw`G:\task\counter.html`, "G:/task/counter_panel.html",
      String.raw`\\server\share\counter_panel.html`].map(path => "visualize" + JSON.stringify({
        path, title: "Counter", mode: "wide",
      }) + ""),
    "visualize" + JSON.stringify({ path: "G:/task/counter_panel.html",
      title: 'Counter  _set_ [[Notes/review]] "quotes" \n\t\b\f\r \\ / <b>&', mode: "wide" }) + "",
    "visualize" + String.raw`{"path":"G:\\task\\counter_\u0070anel.html","title":"\u005f \uD83D\uDE00","mode":"wide"}` + "",
  ];
  for (const reference of references) {
    const encoded = reference.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    const html = `<p>${encoded}</p>`;
    const markdown = chatGptHtmlToMarkdown(html);
    expect(markdown).toBe(reference);
    expect(JSON.parse(markdown.slice("visualize".length, -"".length)))
      .toEqual(JSON.parse(reference.slice("visualize".length, -"".length)));
    for (const streamable of [true, false]) {
      const buffer = new ChatGptMarkdownBuffer(undefined, 0);
      const delta = buffer.observe([{ key: "visualize", tag: "P", html, text: reference, streamable }], 0);
      const final = buffer.finish();
      expect(delta + final.delta).toBe(reference);
      expect(final.markdown).toBe(reference);
    }
  }
});

test("native visualize preservation keeps ordinary Markdown and code examples intact", () => {
  const reference = "visualize" + JSON.stringify({ path: String.raw`G:\task\counter_panel.html`, title: "Counter `code`", mode: "wide" }) + "";
  const encoded = reference.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  expect(chatGptHtmlToMarkdown(`<p>Keep _plain_ <strong>bold</strong> ${encoded} ${encoded}</p>`))
    .toBe(`Keep \\_plain\\_ **bold** ${reference} ${reference}`);
  expect(chatGptHtmlToMarkdown(`<p><code>${encoded}</code></p><pre><code>${encoded}</code></pre>`))
    .toBe(`\`\`${reference}\`\`\n\n\`\`\`\n${reference}\n\`\`\``);
});

test("native ChatGPT code surfaces keep block fences and exact newlines", () => {
  const { createDocument, createWindow } = require("@mixmark-io/domino");
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
  const source = worker.split("// CHATGPT_MARKDOWN_CONTENT_BEGIN")[1]?.split("// CHATGPT_MARKDOWN_CONTENT_END")[0];
  if (!source) throw new Error("ChatGPT Markdown projection is absent");
  const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  const window = createWindow();
  const { project, text } = new Function("HTMLElement", "Node", `${javascript};return {project:chatGptMarkdownContent,text:markdownText}`)(window.HTMLElement, window.Node);
  // Observed on the actual formatting probe: the native code renderer uses a
  // source div rather than PRE and keeps its language label in a copy-excluded bar.
  const nativeCode = (button: string) => createDocument('<p>FENCED_CODE_PROBE_X</p><div class="code-wrapper"><div data-code-block="true" data-start="20" data-end="60">'
    + `<div data-markdown-copy="exclude"><div>Plain text</div><button>${button}</button></div>`
    + '<div data-code-block-source="true"><code class="whitespace-pre! block"><span><span>alpha</span>\n<span>beta</span></span></code></div></div></div>').body;
  const original = nativeCode("Copy");
  const before = original.innerHTML;
  const projected = project(original);
  expect(chatGptHtmlToMarkdown(projected.innerHTML)).toBe("FENCED\\_CODE\\_PROBE\\_X\n\n```text\nalpha\nbeta\n```");
  expect(projected.querySelector("pre code")?.textContent).toBe("alpha\nbeta");
  expect(projected.querySelector("pre")?.getAttribute("data-start")).toBe("20");
  expect(text(projected)).not.toContain("Plain text");
  expect(projected.innerHTML).toBe(project(nativeCode("Copied")).innerHTML);
  expect(original.innerHTML).toBe(before);
  const nestedFence = nativeCode("Copy");
  nestedFence.querySelector("code").className = "language-c++";
  nestedFence.querySelector("code").textContent = "  alpha\n\nbeta\n```\n";
  expect(chatGptHtmlToMarkdown(project(nestedFence).innerHTML))
    .toContain("````c++\n  alpha\n\nbeta\n```\n````");
});
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

test("atomic summaries accept a revised draft while ordinary streamed answers still reject changes", () => {
  const first = { key: "a", tag: "p", html: "<p>Earlier summary.</p>", text: "Earlier summary.", streamable: true };
  const second = { key: "b", tag: "p", html: "<p>Final detail.</p>", text: "Final detail.", streamable: true };
  const revised = { ...first, html: "<p>Corrected summary.</p>", text: "Corrected summary." };
  const summary = new ChatGptMarkdownBuffer(undefined, 0, "complete");
  const answer = new ChatGptMarkdownBuffer(undefined, 0);
  for (const draft of [[first, second], [first, second], [second, revised]]) {
    expect(summary.observe(draft)).toBe("");
    answer.observe(draft);
  }
  expect(summary.finish()).toEqual({
    markdown: "Final detail.\n\nCorrected summary.", delta: "Final detail.\n\nCorrected summary.",
  });
  expect(() => answer.finish()).toThrow("completed text block");
});

function katex(source: string, display = false): string {
  const escaped = source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const math = '<span class="katex"><span class="katex-mathml"><math><semantics>'
    + '<mrow><mi>ACCESSIBLE_COPY</mi><mo>\u2061</mo></mrow>'
    + `<annotation encoding="application/x-tex">${escaped}</annotation>`
    + '</semantics></math></span><span class="katex-html" aria-hidden="true">VISUAL_COPY\u200b</span></span>';
  return display ? `<span class="katex-display">${math}</span>` : math;
}

test("KaTeX inline and display formulas preserve exactly one original LaTeX expression", () => {
  const inline = String.raw`E = mc^2`;
  const display = String.raw`r_{\mathrm{eff}} = \exp\left(-\sum_i q_i \log q_i\right)`;
  expect(chatGptHtmlToMarkdown(`<p>Inline: ${katex(inline)}.</p>${katex(display, true)}`)).toBe(
    `Inline: \\(${inline}\\).\n\n\\[\n${display}\n\\]`,
  );
});

test("math source survives lists, links, nested braces, Unicode, and wiki-shaped expressions", () => {
  const source = String.raw`\operatorname{rank}\left(\frac{α_{i}}{1+β}\right) < 2 \quad [[x]]`;
  expect(chatGptHtmlToMarkdown(
    `<ul><li>Value ${katex(source)}; <a href="https://example.com">reference</a>.</li></ul>`
      + '<p>Open [[Notes/math|notes]].</p>' + katex(`${source}\n+ γ`, true),
  )).toBe(`- Value \\(${source}\\); [reference](https://example.com).\n\n`
    + `Open [notes](<Notes/math.md>).\n\n\\[\n${source}\n+ γ\n\\]`);
  const code = String.raw`\frac{a_b}{c} [[literal]]`;
  expect(chatGptHtmlToMarkdown(`<p><code>${code}</code></p><pre><code>${code}</code></pre>`))
    .toBe(`\`${code}\`\n\n\`\`\`\n${code}\n\`\`\``);
});

test("LaTeX comment newlines survive generic HTML whitespace normalization", () => {
  const source = "a % comment\n+ b";
  expect(chatGptHtmlToMarkdown(katex(source, true))).toBe(`\\[\n${source}\n\\]`);
});

test("unknown or ambiguous KaTeX source fails instead of inventing a formula", () => {
  const formula = katex("x");
  expect(() => chatGptHtmlToMarkdown(formula.replace(/<annotation[^>]*>.*?<\/annotation>/, "")))
    .toThrow("one unambiguous LaTeX source");
  expect(() => chatGptHtmlToMarkdown(formula.replace("</semantics>",
    '<annotation encoding="application/x-tex">y</annotation></semantics>')))
    .toThrow("one unambiguous LaTeX source");
});

test("streaming formulas once still rejects a rewrite of committed math", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const segment = (source: string) => ({
    key: "formula", tag: "p", text: `ACCESSIBLE_COPY${source}VISUAL_COPY`,
    html: `<p>${katex(source)}</p>`, streamable: true,
  });
  expect(buffer.observe([segment("x_1")], 0)).toBe(String.raw`\(x_1\)`);
  expect(buffer.observe([segment("x_1")], 1)).toBe("");
  buffer.observe([segment("x_2")], 2);
  expect(() => buffer.finish()).toThrow("changed a completed text block");
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
      path: String.raw`C:\Codex_Project_Unity\_Editor\file.cs`,
      target: "C:/Codex_Project_Unity/_Editor/file.cs",
    },
    {
      path: String.raw`C:\Codex_Project_Unity\_file.cs`,
      target: "C:/Codex_Project_Unity/_file.cs",
    },
    {
      path: String.raw`\\server\share_name\_Editor\file.cs`,
      target: "//server/share_name/_Editor/file.cs",
    },
    {
      path: "src/_private_/file_name.ts",
      target: "src/_private_/file_name.ts",
    },
    {
      path: "src/adapters/chatgpt-web/markdown.ts:47:3",
      target: "src/adapters/chatgpt-web/markdown.ts:47:3",
    },
  ];

  for (const { path, target } of cases) {
    const markdown = chatGptHtmlToMarkdown(`<p>Created <code>${path}</code>.</p>`);
    expect(markdown).toContain(`](<${target}>)`);
    expect(Bun.markdown.html(markdown))
      .toBe(`<p>Created <a href="${target}">${path}</a>.</p>\n`);
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

test("preserves standalone Codex plan markers in paragraphs and list continuations", () => {
  expect(chatGptHtmlToMarkdown([
    "<p>&lt;proposed_plan&gt;</p>",
    "<h2>Plan</h2>",
    "<ul><li><p>Keep snake_case.</p><p>&lt;/proposed_plan&gt;</p></li></ul>",
  ].join(""))).toBe([
    "<proposed_plan>", "", "## Plan", "", "- Keep snake\\_case.", "  ", "  </proposed_plan>",
  ].join("\n"));
  expect(chatGptHtmlToMarkdown("<p>&lt;proposed_plan&gt;<br>Step<br>&lt;/proposed_plan&gt;</p>"))
    .toBe("<proposed_plan>  \nStep  \n</proposed_plan>");
});

test("preserving plan markers does not rewrite mentions or literal code", () => {
  expect(chatGptHtmlToMarkdown([
    "<p>Mention &lt;proposed_plan&gt; and &lt;/proposed_plan&gt; inline.</p>",
    "<p><code>&lt;proposed_plan&gt;</code> <code>&lt;/proposed_plan&gt;</code></p>",
    "<pre><code>&lt;proposed\\_plan&gt;\n&lt;/proposed\\_plan&gt;</code></pre>",
  ].join(""))).toBe([
    "Mention <proposed\\_plan> and </proposed\\_plan> inline.", "",
    "`<proposed_plan>` `</proposed_plan>`", "",
    "```", "<proposed\\_plan>", "</proposed\\_plan>", "```",
  ].join("\n"));
});


test("repeated report headings can first appear after an earlier copy was committed", () => {
  for (const { count, repeated, tag, text } of [
    { count: 93, repeated: [15, 20, 25, 29], tag: "p", text: "変更済み:" },
    { count: 199, repeated: [40, 83], tag: "h2", text: "Functions" },
  ]) {
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    const report = Array.from({ length: count }, (_, index) => {
      const blockTag = repeated.includes(index) ? tag : "p";
      const value = repeated.includes(index) ? text : `Unique block ${index}`;
      return { key: `${index}:${blockTag}`, tag: blockTag, text: value,
        html: `<${blockTag}>${value}</${blockTag}>`, streamable: true };
    });
    for (let length = 2; length <= report.length; length += 1) {
      buffer.observe(report.slice(0, length).map((block, index) => ({
        ...block, streamable: index < length - 1,
      })), length);
      expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
    }
    const expected = report.map(block => chatGptHtmlToMarkdown(block.html)).join("\n\n");
    expect(buffer.finish().markdown).toBe(expected);
    buffer.observe([report[0]!, report[0]!], count + 1);
    expect(() => buffer.finish()).toThrow("changed a completed text block");
  }
});
