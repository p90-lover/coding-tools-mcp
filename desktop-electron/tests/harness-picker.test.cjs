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
// Every harness shows the icon its own product site or repository shows (paths under assets/harness;
// see SOURCES.md): brand/ holds files copied byte for byte from the product, ao/ the Agent
// Orchestrator avatars that are the product's own icon, and Kimi, Qwen and Muse (Meta) share their
// maker's mark with the model lists.
const assets = path.resolve(root, "../assets/harness");
const harnesses = {
  "claude-code": "brand/claude-code.png", codex: "ao/codex.svg", "codex-native": "ao/codex.svg", agy: "ao/agy.png", antigravity: "ao/agy.png",
  opencode: "brand/opencode.png", "opencode-v2": "brand/opencode.png", aider: "ao/aider.png", amp: "brand/amp.svg", auggie: "ao/auggie.svg",
  autohand: "ao/autohand.svg", cline: "brand/cline.svg", continue: "ao/continue.png", crush: "ao/crush.png", cursor: "brand/cursor.svg",
  deepseek: "ao/deepseek-harness.svg", "deepseek-harness": "ao/deepseek-harness.svg", devin: "ao/devin.png", droid: "ao/droid.png", fx: "ao/fx.svg",
  gemini: "brand/gemini-cli.svg", "gemini-cli": "brand/gemini-cli.svg", copilot: "ao/copilot.svg", goose: "ao/goose.svg", grok: "brand/grok-build.png",
  kilocode: "brand/kilocode.svg", kimi: "kimi.svg", kimchi: "ao/kimchi.svg", kiro: "ao/kiro.png", "mimo-code": "ao/mimo-code.svg", muse: "meta.svg",
  omp: "ao/omp.png", pi: "brand/pi.svg", "prime-agent": "ao/prime-agent.png", qwen: "qwen.svg", "unreal-agent": "ao/unreal-agent.png", vibe: "ao/vibe.png",
};
const assetOf = (src) => path.relative(assets, path.resolve(root, src)).split(path.sep).join("/");
// A logo's bytes, with an SVG's line endings read as LF: core.autocrlf checks a text SVG out with
// CRLF in the app's checkout but kept the AO submodule's copy LF, and 0.8.100's release build
// failed on codex.svg though the two differ by nothing else. Images are compared byte for byte.
const logoBytes = (file) => (file.endsWith(".svg") ? Buffer.from(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")) : fs.readFileSync(file));
test("every harness shows its own product's icon, never another brand's", () => {
  const { harnessMark } = logos();
  for (const [id, asset] of Object.entries(harnesses)) {
    assert.equal(assetOf(harnessMark(`ao:${id}`, "Localized label")(18).props.src), asset, id);
    if (!asset.startsWith("ao/")) continue;
    // AO's file unmodified where the AO checkout is present (CI may not check the submodule out).
    const ao = path.resolve(__dirname, "../../module/agent-orchestrator/frontend/src/renderer/assets/agents", path.basename(asset));
    if (fs.existsSync(ao)) assert.ok(logoBytes(ao).equals(logoBytes(path.join(assets, asset))), `${asset} is AO's file unmodified`);
  }
  // The marks the user saw as wrong (2026-11-10), and the ones before them.
  for (const [id, wrong] of [["claude-code", "ao/claude-code.svg"], ["claude-code", "claude-code.png"], ["qwen", "ao/qwen.png"], ["kimi", "ao/kimi.png"],
    ["grok", "ao/grok.png"], ["gemini", "gemini.svg"], ["muse", "ao/muse.png"], ["pi", "ao/pi.png"], ["amp", "ao/amp.svg"], ["codex", "openai.png"],
    ["unreal-agent", "unreal.svg"]]) {
    assert.notEqual(assetOf(harnessMark(`ao:${id}`, id)(16).props.src), wrong, id);
  }
});
test("brand/ marks are the product's files byte for byte, as SOURCES.md records them", () => {
  const sources = fs.readFileSync(path.join(assets, "SOURCES.md"), "utf8");
  const recorded = new Map([...sources.matchAll(/`brand\/([^`]+)`[^\n]*?SHA-256 `([0-9a-f]{64})`/g)].map(m => [m[1], m[2]]));
  const files = fs.readdirSync(path.join(assets, "brand"));
  assert.deepEqual([...recorded.keys()].sort(), files.sort(), "every brand/ file is listed with its source and hash");
  for (const file of files) {
    const hash = require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(assets, "brand", file))).digest("hex");
    assert.equal(hash, recorded.get(file), `brand/${file} is unchanged from its source (no line-ending rewrite)`);
  }
  assert.match(fs.readFileSync(path.resolve(__dirname, "../../.gitattributes"), "utf8"), /^desktop-electron\/src\/assets\/harness\/brand\/\*\* -text\r?$/m);
});
test("every known harness has its bundled brand image, including missing agents", () => {
  const { harnessMark } = logos();
  for (const [id, asset] of Object.entries(harnesses)) {
    for (const key of [id, `ao:${id}`, `AO:${id.toUpperCase()}`]) {
      const mark = harnessMark(key, "Localized label")(18);
      assert.equal(mark.type, "img", `${key} must not fall back to a fake/lettered logo`);
      assert.equal(assetOf(mark.props.src), asset, key);
      assert.ok(fs.statSync(path.join(assets, asset)).size > 0, `bundled asset exists: ${asset}`);
      assert.equal(mark.props.draggable, false);
    }
  }
});
test("display-name aliases identify known brands without guessing an unknown harness", () => {
  const { harnessMark } = logos();
  for (const [label, asset] of [["Gemini CLI", "brand/gemini-cli.svg"], ["DeepSeek", "ao/deepseek-harness.svg"], ["Prime Agent", "ao/prime-agent.png"],
    ["Kilo Code", "brand/kilocode.svg"], ["GitHub Copilot", "ao/copilot.svg"], ["Unreal Agent", "ao/unreal-agent.png"], ["Grok Build", "brand/grok-build.png"],
    ["Qwen Code", "qwen.svg"], ["Muse Code", "meta.svg"], ["Claude Code", "brand/claude-code.png"]]) {
    assert.equal(assetOf(harnessMark("custom-id", label)(16).props.src), asset, label);
  }
  assert.equal(harnessMark("unknown-agent", "Unknown")(16).type, "svg", "unknown brands keep an honest neutral fallback");
});
test("dark-theme contrast: Kimi's black K keeps a backing, black glyphs invert", () => {
  const { harnessMark } = logos();
  assert.match(harnessMark("ao:kimi", "Kimi")(16).props.className, /is-backed/);
  assert.doesNotMatch(harnessMark("ao:kimi", "Kimi")(16).props.className, /is-mono/);
  for (const id of ["prime-agent", "cline", "grok"]) assert.match(harnessMark(`ao:${id}`, id)(16).props.className, /is-mono/, id);
  // Tiles and colour marks keep their own colours.
  for (const id of ["claude-code", "opencode", "pi", "amp", "kilocode", "cursor", "gemini"]) assert.doesNotMatch(harnessMark(`ao:${id}`, id)(16).props.className, /is-mono/, id);
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
