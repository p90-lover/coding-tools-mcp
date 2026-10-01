"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const filename = path.join(__dirname, "..", "src", "features", "UpstreamToolSurface.tsx");
const styles = fs.readFileSync(path.join(__dirname, "..", "src", "features", "upstream-tool.css"), "utf8");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: filename,
});

function mount(toolId) {
  const state = [];
  let cursor = 0;
  let mountEffect;
  let status = "offline";
  const openedSections = [];
  const errors = [];
  const tool = () => ({
    id: toolId, name: toolId === "paseo" ? "Paseo" : "Anneal", status,
    endpoint: "http://127.0.0.1:5173/", commit: "123456789abc", license: "MIT",
    sections: toolId === "paseo" ? ["agents", "settings"] : ["tasks", "inbox"], error: null,
  });
  const api = {
    upstreamToolsSnapshot: async () => ({ tools: [tool()] }),
    openEmbeddedTool: async (id, section) => {
      assert.equal(id, toolId);
      openedSections.push(section);
      return status === "ready"
        ? { url: `http://127.0.0.1:5173/#/${section}`, unavailable: false, dependency: null }
        : { url: "", unavailable: true, dependency: toolId === "anneal" ? "postgres" : null };
    },
  };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (next) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
    },
    useMemo: (compute) => compute(),
    useEffect: (effect) => { mountEffect ??= effect; },
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const moduleUnderTest = { exports: {} };
  Function("require", "module", "exports", compiled.outputText)(
    (specifier) => specifier === "react" ? react
      : specifier === "react/jsx-runtime" ? { jsx, jsxs: jsx }
        : {},
    moduleUnderTest, moduleUnderTest.exports,
  );
  const previousWindow = global.window;
  global.window = {
    codexWebLauncher: api,
    codingTools: { apps: { call: async ({ operation }) => { if (operation === "start") status = "ready"; } } },
  };
  const render = () => {
    cursor = 0;
    return moduleUnderTest.exports.UpstreamToolSurface({ toolId, language: "en", setError: (error) => errors.push(error) });
  };
  return { render, startEffect: () => mountEffect(), openedSections, errors, restore: () => { global.window = previousWindow; } };
}

function find(node, predicate) {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean) || null;
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

for (const [toolId, selectedSection] of [["paseo", "settings"], ["anneal", "inbox"]]) {
  test(`${toolId} Start opens the selected embedded section after an offline placeholder`, async () => {
    const surface = mount(toolId);
    try {
      surface.render();
      await surface.startEffect();
      await settle();
      let tree = surface.render();
      assert.equal(find(tree, (node) => node.type === "iframe"), null);
      find(tree, (node) => node.type === "button" && node.props.children ===
        (selectedSection === "settings" ? "Settings" : "Inbox")).props.onClick();
      await settle();
      tree = surface.render();
      assert.equal(find(tree, (node) => node.type === "iframe"), null);

      await find(tree, (node) => node.type === "button" && node.props.className === "primary").props.onClick();
      await settle();
      tree = surface.render();
      assert.equal(find(tree, (node) => node.type === "iframe")?.props.src,
        `http://127.0.0.1:5173/#/${selectedSection}`);
      assert.equal(find(tree, (node) => node.type === "button" && node.props.className === "is-active")?.props.children,
        selectedSection === "settings" ? "Settings" : "Inbox");
      assert.equal(find(tree, (node) => node.props?.["data-dependency"] === "postgres"), null);
      assert.deepEqual(surface.openedSections, [toolId === "paseo" ? "agents" : "tasks", selectedSection, selectedSection]);
      assert.deepEqual(surface.errors.filter(Boolean), []);
    } finally {
      surface.restore();
    }
  });
}

test("Paseo embedded visual fills the workspace and connection controls remain reachable", () => {
  assert.ok(/\.upstream-tool-surface\s*\{[^}]*height:\s*100%;/s.test(styles), "surface spans its workspace");
  assert.ok(/\.upstream-tool-surface\.is-immersive\s*\{[^}]*padding:\s*var\(--height-titlebar\) 0 0;/s.test(styles), "frame starts below the titlebar");
  assert.ok(/\.upstream-tool-surface\.is-immersive\.chrome-open\s*\{[^}]*overflow-y:\s*auto;/s.test(styles), "connection controls can scroll");
  assert.ok(/\.upstream-tool-surface\.is-immersive\.chrome-open \.upstream-tool-frame-shell\s*\{[^}]*display:\s*none;/s.test(styles), "open controls do not compete with iframe scrolling");
  assert.ok(/\.upstream-tool-surface\.is-immersive:not\(\.chrome-open\) \.upstream-original-function\s*\{[^}]*display:\s*none;/s.test(styles), "collapsed controls leave space for the frame");
});
