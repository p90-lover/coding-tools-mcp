"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("the UI font puts a Latin font before the Japanese ones, so a backslash isn't drawn as a yen sign", () => {
  const tokens = fs.readFileSync(path.resolve(__dirname, "../src/tokens.css"), "utf8");
  const stack = /--font-ui:\s*([^;]+);/.exec(tokens)[1].split(",").map((font) => font.trim().replace(/"/g, ""));
  const first = (names) => Math.min(...names.map((name) => stack.indexOf(name)).filter((at) => at >= 0));
  // Yu Gothic, Meiryo and Hiragino map U+005C to "¥": Windows paths read C:¥Users¥… with them first.
  assert.ok(stack.indexOf("Segoe UI") >= 0 && stack.indexOf("Segoe UI") < first(["Yu Gothic UI", "Meiryo", "Hiragino Sans"]));
  assert.ok(stack.includes("Yu Gothic UI") && stack.includes("Meiryo"), "Japanese fonts stay as fallbacks for Japanese text");
});
