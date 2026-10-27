"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function load(file, imports = {}) {
  const output = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/features", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(source, { exports: output, URL, require: name => imports[name] ?? require(name) });
  return output;
}
const parser = load("chat-markdown.ts");
const { ChatMarkdown } = load("ChatMarkdown.tsx", { "./chat-markdown": parser });
const render = text => renderToStaticMarkup(React.createElement(ChatMarkdown, { text }));

test("WebGPT tables render cells and retain pipes inside inline code or escaped text", () => {
  const html = render("| Name | Value |\n| :- | --: |\n| a\\|b | `x|y` |\n| **Result** | [391](<https://example.com/result>) |");
  assert.match(html, /<table>/);
  assert.match(html, /text-align:right/);
  assert.match(html, /a\|b/);
  assert.match(html, /<code>x\|y<\/code>/);
  assert.match(html, /<strong>.*Result.*<\/strong>/);
  assert.match(html, /href="https:\/\/example.com\/result"/);
  assert.equal((html.match(/<td/g) ?? []).length, 4);
});

test("portable image references render secure images while other protocols stay inert", () => {
  const html = render("![Diagram](<https://assets.example.com/diagram.png>) [Source](<https://example.com/source>)");
  assert.match(html, /<img[^>]*src="https:\/\/assets.example.com\/diagram.png"/);
  assert.match(html, /alt="Diagram"/);
  assert.match(html, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
  assert.match(html, /href="https:\/\/example.com\/source"/);
  for (const url of ["javascript:alert", "data:image/png;base64,AAAA", "file:///private.png", "https://user:password@example.com/private.png", "http://127.0.0.1/image.png"]) {
    assert.doesNotMatch(render(`![Image](${url})`), /<img/);
  }
  const literal = render('<img src=x onerror="alert(1)">');
  assert.doesNotMatch(literal, /<img/);
  assert.match(literal, /&lt;img/);
});

test("escaped transport markers and code examples keep their original visible text", () => {
  const html = render("CODEX\\_WEBGPT\\_RICH\\_OK\n\n````text\n  alpha\n\nbeta\n```\n![example](https://example.com/image.png)\n````");
  assert.match(html, /CODEX_WEBGPT_RICH_OK/);
  assert.match(html, /<pre><code>  alpha\n\nbeta\n```/);
  assert.doesNotMatch(html, /<img/);
});

test("backslashes in table code remain literal and preserve the following columns", () => {
  const html = render("| Path | Value |\n| --- | --- |\n| `C:\\` | ok |");
  assert.match(html, /<code>C:\\<\/code>/);
  assert.match(html, /<td>.*ok.*<\/td>/);
  assert.equal((html.match(/<td/g) ?? []).length, 2);
});

test("oversized tables keep the complete text without expanding missing cells", () => {
  const header = `|${Array(512).fill("h").join("|")}|`;
  const divider = `|${Array(512).fill("---").join("|")}|`;
  const markdown = [header, divider, ...Array(4_096).fill("x")].join("\n");
  const blocks = parser.parseMarkdown(markdown);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "code");
  assert.equal(blocks[0].text, markdown);
});

test("the launcher policy permits the HTTPS images accepted by the chat renderer", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const images = /img-src\s+([^;]+)/.exec(html)?.[1].split(/\s+/) ?? [];
  assert.ok(images.includes("https:"));
});
