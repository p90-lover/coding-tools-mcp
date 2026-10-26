const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const app = fs.readFileSync(path.resolve(__dirname, "../src/App.tsx"), "utf8").replace(/\r\n/g, "\n");

function loadFormatTime() {
  const start = app.indexOf("const timeFormats = ");
  const end = app.indexOf("\n}\n", app.indexOf("function formatTime(")) + 3;
  assert.ok(start > 0 && end > start, "formatTime and its cache are in App.tsx");
  const context = { Intl, Date, Map };
  vm.runInNewContext(ts.transpileModule(`${app.slice(start, end)}\nglobalThis.formatTime = formatTime;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.formatTime;
}

test("activity times read as before, from one cached formatter per language", () => {
  const formatTime = loadFormatTime();
  const at = "2026-10-26T09:41:07.000Z";
  for (const [language, locale] of [["en", "en"], ["ja", "ja-JP"], ["zh-TW", "zh-TW"], ["zh-CN", "zh-CN"]]) {
    assert.equal(formatTime(at, language), new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  }
  assert.equal(formatTime("not a time", "en"), "not a time");
  const original = Intl.DateTimeFormat;
  let built = 0;
  Intl.DateTimeFormat = function (...args) { built += 1; return new original(...args); };
  try {
    const fresh = loadFormatTime();
    for (let i = 0; i < 50; i += 1) fresh(at, "en");
    assert.equal(built, 1, "300 rows must not build 300 formatters");
  } finally { Intl.DateTimeFormat = original; }
});

test("each activity row renders once per record, not once per new log line", () => {
  assert.match(app, /const ActivityRow = memo\(function ActivityRow\(\{ record, language \}/);
  assert.match(app, /\.map\(\(record\) => <ActivityRow key=\{logKey\(record\)\} record=\{record\} language=\{language\} \/>\)/);
});
