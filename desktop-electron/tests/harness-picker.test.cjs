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
// Every harness shows the mark AO's own AgentAvatar shows for it (assets/harness/ao).
const harnesses = {
  "claude-code": "claude-code.svg", codex: "codex.svg", "codex-native": "codex.svg", agy: "agy.png", antigravity: "agy.png", opencode: "opencode.svg",
  "opencode-v2": "opencode.svg", aider: "aider.png", amp: "amp.svg", auggie: "auggie.svg", autohand: "autohand.svg", cline: "cline.svg", continue: "continue.png",
  crush: "crush.png", cursor: "cursor.svg", deepseek: "deepseek-harness.svg", "deepseek-harness": "deepseek-harness.svg", devin: "devin.png", droid: "droid.png",
  fx: "fx.svg", gemini: "gemini.svg", "gemini-cli": "gemini.svg", copilot: "copilot.svg", goose: "goose.svg", grok: "grok.png", kilocode: "kilocode.svg",
  kimi: "kimi.png", kimchi: "kimchi.svg", kiro: "kiro.png", "mimo-code": "mimo-code.svg", muse: "muse.png", omp: "omp.png", pi: "pi.png",
  "prime-agent": "prime-agent.png", qwen: "qwen.png", "unreal-agent": "unreal-agent.png", vibe: "vibe.png",
};
test("every harness shows AO's own mark for it, never another brand's", () => {
  const { harnessMark } = logos();
  for (const [id, asset] of Object.entries(harnesses)) {
    const src = harnessMark(`ao:${id}`, "Localized label")(18).props.src;
    assert.equal(path.dirname(src), "../assets/harness/ao", `${id} uses AO's agent logo`);
    const ao = path.resolve(__dirname, "../../module/agent-orchestrator/frontend/src/renderer/assets/agents", asset);
    // Byte-for-byte AO's file where the AO checkout is present (CI may not check the submodule out).
    if (fs.existsSync(ao)) assert.ok(fs.readFileSync(ao).equals(fs.readFileSync(path.resolve(root, src))), `${asset} is AO's file unmodified`);
  }
  // The marks that were wrong: the Claude app's starburst, OpenAI's knot, Earendil's avatar, Unreal Engine.
  for (const [id, wrong] of [["claude-code", "claude-code.png"], ["codex", "openai.png"], ["pi", "earendil.png"], ["unreal-agent", "unreal.svg"]]) {
    assert.notEqual(path.basename(harnessMark(`ao:${id}`, id)(16).props.src), wrong, id);
  }
});
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
  for (const [label, asset] of [["Gemini CLI", "gemini.svg"], ["DeepSeek", "deepseek-harness.svg"], ["Prime Agent", "prime-agent.png"], ["Kilo Code", "kilocode.svg"], ["GitHub Copilot", "copilot.svg"], ["Unreal Agent", "unreal-agent.png"]]) {
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
