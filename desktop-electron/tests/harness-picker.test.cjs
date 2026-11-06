"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), ts = require("typescript");
const root = path.resolve(__dirname, "../src/features");
function logos() {
  const exports = {}, jsx = (type, props) => ({ type, props });
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, "HarnessLogo.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    // An asset import is an ES module: TypeScript 6 turns esModuleInterop on, and __importDefault
    // wrapped a plain { default } again, so `src` arrived as an object (CI on #1076).
  }).outputText, { exports, require: name => name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : { __esModule: true, default: name } });
  return exports;
}
const harnesses = {
  "claude-code": "claude-code.png", codex: "openai.png", "codex-native": "openai.png", agy: "antigravity.png", antigravity: "antigravity.png", opencode: "opencode.png",
  aider: "aider.png", amp: "amp.svg", auggie: "augment.png", autohand: "autohand.png", cline: "cline.svg", continue: "continue.png", crush: "charm.png", cursor: "cursor.svg",
  deepseek: "deepseek.svg", devin: "devin.svg", droid: "factory.png", gemini: "gemini.svg", "gemini-cli": "gemini.svg", copilot: "github-copilot.svg", goose: "goose.svg", grok: "grok.svg",
  kilocode: "kilocode.svg", kimi: "kimi.svg", kimchi: "kimchi.svg", kiro: "kiro.svg", muse: "meta.svg", omp: "omp.png", pi: "earendil.png", "prime-agent": "prime-agent.png", qwen: "qwen.svg", "unreal-agent": "unreal.svg", vibe: "mistral.svg",
};
test("every known harness has its bundled brand image, including missing agents", () => {
  const { harnessMark } = logos();
  for (const [id, asset] of Object.entries(harnesses)) {
    for (const key of [id, `ao:${id}`, `AO:${id.toUpperCase()}`]) {
      const mark = harnessMark(key, "Localized label")(18);
      assert.equal(mark.type, "img", `${key} must not fall back to a fake/lettered logo`);
      assert.equal(path.basename(mark.props.src), asset, key);
      assert.ok(fs.statSync(path.resolve(root, mark.props.src)).size > 0, `bundled asset exists: ${asset}`);
      assert.equal(mark.props.draggable, false);
    }
  }
});
test("display-name aliases identify known brands without guessing an unknown harness", () => {
  const { harnessMark } = logos();
  for (const [label, asset] of [["Gemini CLI", "gemini.svg"], ["DeepSeek", "deepseek.svg"], ["Prime Agent", "prime-agent.png"], ["Kilo Code", "kilocode.svg"], ["GitHub Copilot", "github-copilot.svg"]]) {
    assert.equal(path.basename(harnessMark("custom-id", label)(16).props.src), asset, label);
  }
  assert.equal(harnessMark("unknown-agent", "Unknown")(16).type, "svg", "unknown brands keep an honest neutral fallback");
});
test("dark-theme contrast preserves mixed-colour Kimi and monochrome Prime Agent", () => {
  const { harnessMark } = logos();
  assert.match(harnessMark("ao:kimi", "Kimi")(16).props.className, /is-backed/);
  assert.doesNotMatch(harnessMark("ao:kimi", "Kimi")(16).props.className, /is-mono/);
  assert.match(harnessMark("ao:prime-agent", "Prime Agent")(16).props.className, /is-mono/);
});
test("missing installation status never strips brand color or fades the image", () => {
  const css = fs.readFileSync(path.join(root, "agent-orchestrator.css"), "utf8");
  assert.doesNotMatch(css, /\.is-missing\s+\.ao-harness-logo\s*\{[^}]*(?:grayscale|opacity)/);
  assert.match(css, /\.ao-harness-list\s+\.ao-picker-option:disabled:has\(\.is-missing\)\s*\{\s*opacity:\s*1/);
});
test("available-height fitting only changes the two scrollable picker panels", () => {
  const exports = {}, properties = new Map();
  const source = fs.readFileSync(path.join(root, "AgentOrchestratorComposerControls.tsx"), "utf8") + "\nexports.fit = fitInPane;";
  const rectangle = { top: -100, bottom: 130.5, left: 20, right: 180 };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, require: () => ({}), window: { innerHeight: 420 }, getComputedStyle: () => ({ position: "fixed" }),
  });
  const menu = { getBoundingClientRect: () => rectangle, matches: () => true, style: { setProperty: (key, value) => properties.set(key, value) } };
  exports.fit(menu);
  assert.equal(properties.get("--ao-picker-room"), "122px");
  properties.clear(); menu.matches = () => false;
  exports.fit(menu);
  assert.equal(properties.size, 0, "permissions and branch popovers keep their existing sizing");
});
test("picker panels bound height to available space and keep model search above the scrolling rows", () => {
  const css = fs.readFileSync(path.join(root, "agent-orchestrator.css"), "utf8");
  assert.match(css, /--ao-picker-room/);
  assert.match(css, /\.ao-model-options\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
  const theme = fs.readFileSync(path.join(root, "claude-theme.css"), "utf8");
  assert.match(theme, /\.ao-composer-popover:is\(\.ao-harness-popup,\s*\.ao-model-popup\)[^{]*\{[^}]*transparent[^}]*backdrop-filter/s);
});
