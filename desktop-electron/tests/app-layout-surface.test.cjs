"use strict";
// Runtime > App layout (src/features/AppLayoutSurface.tsx + electron/app-layout.cjs):
// verifies the whole-picture architecture view, the 6 categories, the 4 layers, the overlaps,
// and live editing by both the user UI and chat models via the `app_layout` MCP tool.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const {
  DEFAULT_APP_LAYOUT,
  applyAppLayoutAction,
  createAppLayoutStore,
  formatAppLayoutSummary,
  selectAppLayoutSection,
} = require("../electron/app-layout.cjs");
const { createChatAgentTools } = require("../electron/chat-agent-tools.cjs");

const SOURCE = path.resolve(__dirname, "../src/features/AppLayoutSurface.tsx");
const TMP_ROOT = path.resolve(__dirname, "../.tmp-app-layout-tests");

function load({ states = [], launcher = {} } = {}) {
  const effects = [];
  const setters = [];
  const queue = [...states];
  const element = (type, props) => ({ type, props: props ?? {} });
  const modules = {
    react: {
      useState: (initial) => {
        const value = queue.length ? queue.shift() : initial;
        const calls = [];
        setters.push(calls);
        return [value, (next) => calls.push(next)];
      },
      useCallback: (fn) => fn,
      useEffect: (fn, deps) => effects.push({ fn, deps }),
    },
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: "Fragment" },
    "./app-layout.css": {},
  };
  const { outputText } = ts.transpileModule(fs.readFileSync(SOURCE, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  const window = {
    codexWebLauncher: launcher,
    confirm: () => true,
  };
  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    window,
    require: (name) => {
      if (!(name in modules)) throw new Error(`unexpected import ${name}`);
      return modules[name];
    },
  });
  return { api: module.exports, effects, setters };
}

function render(node) {
  if (Array.isArray(node)) return node.flatMap(render);
  if (!node || typeof node !== "object") return node === null || node === undefined || node === false ? [] : [node];
  if (typeof node.type === "function") return render(node.type(node.props));
  return [{ ...node, props: { ...node.props, children: render(node.props.children) } }];
}

const walk = (nodes, visit) => {
  for (const node of nodes) {
    if (node && typeof node === "object") {
      visit(node);
      walk(node.props.children ?? [], visit);
    }
  }
};

const text = (nodes) => {
  const out = [];
  const visit = (list) => {
    for (const node of list) {
      if (typeof node === "string" || typeof node === "number") out.push(String(node));
      else if (node?.props) visit(node.props.children ?? []);
    }
  };
  visit(nodes);
  return out.join("");
};

const buttons = (nodes) => {
  const found = [];
  walk(nodes, (node) => {
    if (node.type === "button") found.push(node);
  });
  return found;
};

test("DEFAULT_APP_LAYOUT includes all 6 categories, 4 layers, and 7 overlaps", () => {
  assert.equal(DEFAULT_APP_LAYOUT.categories.length, 6);
  assert.deepEqual(
    DEFAULT_APP_LAYOUT.layers.map((layer) => layer.id),
    ["sidebar", "settings", "mcp-tools", "services"],
  );
  assert.equal(DEFAULT_APP_LAYOUT.overlaps.length, 7);
  const summary = formatAppLayoutSummary(DEFAULT_APP_LAYOUT, "all");
  assert.match(summary, /1\. Chats & Agents/);
  assert.match(summary, /Layer 1: Sidebar Navigation/);
  assert.match(summary, /Layer 2: Unified Settings Map/);
  assert.match(summary, /Layer 3: Built-in coding-tools MCP Server/);
  assert.match(summary, /Layer 4: Background Services & Component Categories/);
  assert.match(summary, /Current Overlaps & Misplacements/);
});

test("applyAppLayoutAction and createAppLayoutStore persist and broadcast edits", async () => {
  await fsp.mkdir(TMP_ROOT, { recursive: true });
  const filePath = path.join(TMP_ROOT, `app-layout-${Date.now()}.json`);
  const changes = [];
  try {
    const store = createAppLayoutStore({
      filePath,
      onChange: (next) => changes.push(next),
    });
    const initial = await store.get();
    assert.equal(initial.categories.length, 6);

    const updated = await store.edit({
      action: "upsert_layer_row",
      layerId: "sidebar",
      row: {
        id: "sidebar-custom",
        category: "1. Chats & Agents",
        title: "Custom Architecture Layer Row",
        surfaceId: "app-layout",
        currentLocation: "Runtime › App layout",
        belongsIn: "1. Chats & Agents",
        items: ["App layout (app-layout — Live architecture & layer editor)"],
        note: "Added by model test",
      },
    });
    await store.saved();
    const sidebar = selectAppLayoutSection(updated, "sidebar").layer;
    assert.ok(sidebar.rows.some((row) => row.id === "sidebar-custom" && row.title === "Custom Architecture Layer Row"));
    assert.equal(changes.length, 1);

    const reloaded = createAppLayoutStore({ filePath });
    const persisted = await reloaded.get();
    assert.ok(
      persisted.layers
        .find((layer) => layer.id === "sidebar")
        .rows.some((row) => row.id === "sidebar-custom"),
    );

    const afterReset = await store.reset();
    assert.ok(
      !afterReset.layers
        .find((layer) => layer.id === "sidebar")
        .rows.some((row) => row.id === "sidebar-custom"),
    );
    assert.equal(changes.length, 2);
  } finally {
    await fsp.rm(TMP_ROOT, { recursive: true, force: true });
  }
});

test("chat-agent-tools exposes app_layout so models can read and edit any layer", async () => {
  const http = require("node:http");
  let state = DEFAULT_APP_LAYOUT;
  const appLayout = {
    get: async (section) => selectAppLayoutSection(state, section),
    act: async (input) => {
      state = applyAppLayoutAction(state, input);
      return state;
    },
    reset: async () => {
      state = DEFAULT_APP_LAYOUT;
      return state;
    },
  };
  const tools = createChatAgentTools({
    enabled: () => true,
    appLayout,
    sessionWorkspace: async () => ({ root: TMP_ROOT }),
    requestHeadless: async (endpoint) => {
      if (endpoint === "/api/v1/workspaces") return { ok: true, workspaces: [{ id: "ws1", path: TMP_ROOT }] };
      if (endpoint.startsWith("/api/v1/tools/catalog?")) return { ok: true, workspace_id: "ws1", tool_profile: "core", tools: [] };
      throw new Error(`unexpected ${endpoint}`);
    },
  });

  function post(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  }

  try {
    const lease = await tools.lease({ agent: "codex", workspaceId: "ws1" });
    assert.equal(lease.bind("ao-app-layout-1"), true);
    const [{ url, headers }] = lease.servers;
    const auth = { authorization: headers.Authorization };

    const initRes = await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, auth);
    assert.match(initRes.result.instructions, /app_layout/);

    const listRes = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, auth);
    assert.ok(listRes.result.tools.some((tool) => tool.name === "app_layout"));

    const readRes = await post(
      url,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "app_layout", arguments: { action: "get", section: "mcp-tools" } } },
      auth,
    );
    assert.equal(readRes.result.isError, undefined);
    assert.equal(readRes.result.structuredContent.layer.id, "mcp-tools");

    const editRes = await post(
      url,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "app_layout",
          arguments: {
            action: "upsert_overlap",
            overlap: {
              id: "model-spotted-overlap",
              item: "Model-added overlap",
              currentLocation: "Runtime",
              belongsIn: "Tools & MCP",
              why: "Model verified this placement.",
            },
          },
        },
      },
      auth,
    );
    assert.equal(editRes.result.isError, undefined);
    assert.ok(editRes.result.structuredContent.overlaps.some((item) => item.id === "model-spotted-overlap"));
  } finally {
    await tools.close();
  }
});

test("AppLayoutSurface renders the whole picture, filters layers, navigates surfaces, and saves edits", async () => {
  const calls = [];
  const navigated = [];
  const launcher = {
    appLayout: async () => DEFAULT_APP_LAYOUT,
    editAppLayout: async (input) => {
      calls.push(["edit", input]);
      return applyAppLayoutAction(DEFAULT_APP_LAYOUT, input);
    },
    resetAppLayout: async () => {
      calls.push(["reset"]);
      return DEFAULT_APP_LAYOUT;
    },
    onAppLayoutChanged: () => () => undefined,
  };

  const { api } = load({
    states: [DEFAULT_APP_LAYOUT, "all", "", null, false],
    launcher,
  });
  const tree = render(
    api.AppLayoutSurface({
      active: true,
      navigateSurface: (surface) => navigated.push(surface),
      setError: (err) => {
        if (err) throw new Error(err);
      },
    }),
  );
  const all = text(tree);
  for (const expected of [
    "App layout",
    "1. Chats & Agents (The Workbench)",
    "2. Tools, MCP & Permissions (The Agent's Hands)",
    "3. Models, Accounts & Providers (The Brains & Keys)",
    "4. Browser & ChatGPT Web Bridge (The WebGPT Engine)",
    "5. Network, Components & Updates (The Plumbing)",
    "6. Settings & Diagnostics (The Control Room)",
    "Layer 1: Sidebar Navigation",
    "Layer 2: Unified Settings Map",
    "Layer 3: Built-in coding-tools MCP Server",
    "Layer 4: Background Services & Component Categories",
    "Current Overlaps & Misplacements",
    "mcp__coding-tools__app_layout",
  ]) {
    assert.ok(all.includes(expected), `missing ${expected}`);
  }

  const openChatBtn = buttons(tree).find((button) => text([button]) === "Open agent-orchestrator");
  assert.ok(openChatBtn);
  openChatBtn.props.onClick();
  assert.deepEqual(navigated, ["agent-orchestrator"]);

  const resetBtn = buttons(tree).find((button) => text([button]) === "Reset layout");
  assert.ok(resetBtn);
  await resetBtn.props.onClick();
  assert.deepEqual(calls, [["reset"]]);
});

test("Runtime sidebar includes the App layout tab and keeps it mounted", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "../src/App.tsx"), "utf8");
  assert.match(
    app,
    /<SidebarItem active=\{surface === "app-layout"\} icon="layers" label="App layout" onClick=\{\(\) => navigateSurface\("app-layout"\)\} \/>/,
  );
  assert.match(
    app,
    /keepAlive\("app-layout", \(\) => \(\s*<AppLayoutSurface\s+active=\{surface === "app-layout"\}/,
  );
  const types = fs.readFileSync(path.resolve(__dirname, "../src/types.ts"), "utf8");
  assert.match(types, /"computer-use" \| "app-layout"/);
});
