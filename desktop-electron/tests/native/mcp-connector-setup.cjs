"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");
const moduleRoot = process.env.MCP_CONNECTOR_TEST_APP_ROOT || path.resolve(__dirname, "../..");
const { createConfiguredConnector } = require(path.join(moduleRoot, "electron/mcp-connector-setup.cjs"));
const { createMcpConnectorCommand } = require(path.join(moduleRoot, "electron/mcp-connector-command.cjs"));

const root = process.env.MCP_CONNECTOR_TEST_ROOT;
if (!root || !path.isAbsolute(root) || !root.split(path.sep).includes("aiTemp")) {
  throw new Error("Set MCP_CONNECTOR_TEST_ROOT to an absolute project aiTemp directory.");
}
fs.mkdirSync(root, { recursive: true });
app.setName("Coding Tools MCP setup verification");
app.setPath("userData", path.join(root, "profile"));
app.setPath("sessionData", path.join(root, "session"));
app.setPath("logs", path.join(root, "logs"));
app.setPath("crashDumps", path.join(root, "crashes"));
app.on("window-all-closed", () => {});
const deadline = setTimeout(() => { console.error("MCP_NATIVE_TIMEOUT"); app.exit(2); }, 180_000);

function fixture({ legacy, publicTab, menu, existing, denied, notification }) {
  return `<!doctype html><title>Plugins | ChatGPT</title><main>
    <div role="tablist"><button id="public" role="tab" aria-selected="${Boolean(publicTab)}">Public</button>
    <button id="personal" role="tab" aria-selected="${!publicTab}">Personal</button></div>
    <input type="text" aria-label="Search plugins" placeholder="Search plugins" value="filtered query">
    <section id="list"></section><button id="add">${legacy ? "Create app" : "Add"}</button></main>
    ${notification ? '<div role="alert">Unrelated notification</div>' : ''}
    <script>
    const scenario = ${JSON.stringify({ legacy, publicTab, menu, existing, denied })};
    let personalClicks = 0, submits = 0;
    function list() {
      document.querySelector('#list').innerHTML = scenario.existing
        ? '<article><a aria-label="Open Coding Tools Native2" href="/plugins/plugins~Plugin_existing"><h2>Coding Tools Native2</h2></a></article>'
        : '<p>' + (scenario.legacy ? 'No apps yet' : 'No plugins found') + '</p>';
    }
    if (!scenario.publicTab) list();
    else document.querySelector('#list').innerHTML = '<article><a aria-label="Open Coding Tools Native2" href="/plugins/plugins~Plugin_public"><h2>Coding Tools Native2</h2></a></article>';
    document.querySelector('#personal').onclick = () => {
      personalClicks++;
      document.querySelector('#public').setAttribute('aria-selected', 'false');
      document.querySelector('#personal').setAttribute('aria-selected', 'true');
      list();
    };
    function form() {
      document.querySelector('[role="menu"]')?.remove();
      document.body.insertAdjacentHTML('beforeend', '<div role="dialog">'
        + '<input id="custom-connector-name" aria-label="Name" type="text">'
        + '<button id="server-url" ${legacy ? 'role="radio"' : ''}>Server URL</button>'
        + '<button id="tunnel-mode" ${legacy ? 'role="radio" aria-label="Tunnel"' : 'aria-label="Secure MCP Tunnel"'}>Tunnel</button>'
        + '<select id="custom-connector-tunnel-select"><option>Loading tunnels...</option></select>'
        + '<button id="use-id" hidden>Use tunnel ID instead</button>'
        + '<select id="custom-connector-auth"><option value="OAUTH">OAuth</option><option value="NONE">${legacy ? 'No Auth' : 'No authentication'}</option></select>'
        + '<label>I understand <input id="trust-checkbox" type="checkbox"></label>'
        + '<button id="save" disabled>${legacy ? 'Create' : 'Create as a plugin'}</button></div>');
      const dialog = document.querySelector('[role="dialog"]');
      let tunnelSelected = false;
      const ready = () => {
        dialog.querySelector('#save').disabled = !(tunnelSelected
          && dialog.querySelector('#custom-connector-name').value
          && dialog.querySelector('#custom-connector-tunnel-id')?.value
          && dialog.querySelector('#custom-connector-auth').value === 'NONE'
          && dialog.querySelector('#trust-checkbox').checked);
      };
      dialog.addEventListener('input', ready);
      dialog.addEventListener('change', ready);
      const selectTunnel = () => {
        tunnelSelected = true;
        queueMicrotask(() => { dialog.querySelector('#use-id').hidden = false; ready(); });
      };
      if (scenario.legacy) dialog.querySelector('#tunnel-mode').onclick = selectTunnel;
      else dialog.querySelector('#tunnel-mode').onmousedown = selectTunnel;
      dialog.querySelector('#use-id').onclick = () => {
        dialog.querySelector('#custom-connector-tunnel-select').outerHTML = '<input id="custom-connector-tunnel-id" placeholder="tunnel_0123456789abcdef0123456789abcdef"' + (scenario.legacy ? ' type="text"' : '') + '>';
        dialog.querySelector('#use-id').remove();
      };
      dialog.querySelector('#save').onclick = async () => {
        submits++;
        const values = {
          name: dialog.querySelector('#custom-connector-name').value,
          tunnelId: dialog.querySelector('#custom-connector-tunnel-id').value,
          authentication: dialog.querySelector('#custom-connector-auth').value,
          trusted: dialog.querySelector('#trust-checkbox').checked,
          search: document.querySelector('[aria-label="Search plugins"]').value,
          personalClicks, submits,
        };
        await fetch('/__fixture/receipt', { method: 'POST', body: JSON.stringify(values) });
        if (scenario.denied) {
          dialog.insertAdjacentHTML('beforeend', '<div role="alert">The MCP server denied access. Check your authentication settings and, if using a tunnel, its workspace access.</div>');
        } else {
          dialog.remove();
          document.querySelector('#list').innerHTML = '<article><a aria-label="Open Coding Tools Native2" href="/plugins/plugins~Plugin_created"><h2>Coding Tools Native2</h2></a></article>';
        }
      };
    }
    const add = document.querySelector('#add');
    if (!scenario.menu) add.onclick = form;
    else {
      let openedAt = 0;
      add.onpointerdown = () => {
        openedAt = performance.now();
        document.body.insertAdjacentHTML('beforeend', '<div role="menu"><button role="menuitem">Add a custom MCP server</button></div>');
        document.querySelector('[role="menuitem"]').onclick = form;
      };
      add.onclick = () => {
        if (performance.now() - openedAt < 100) document.querySelector('[role="menu"]')?.remove();
      };
    }
    </script>`;
}

app.whenReady().then(async () => {
  const cases = [
    { name: "personal-current" },
    { name: "business-current", publicTab: true, menu: true },
    { name: "legacy", legacy: true },
    { name: "existing-private", publicTab: true, existing: true },
    { name: "access-denied", denied: true },
    { name: "unrelated-notification", notification: true },
  ];
  for (const scenario of cases) {
    const data = path.join(root, scenario.name);
    fs.mkdirSync(data, { recursive: true });
    const partition = `mcp-setup-fixture-${scenario.name}`;
    const isolated = session.fromPartition(partition);
    const receipts = [], windows = [];
    let shown = 0, focused = 0, operations = 0;
    await isolated.protocol.handle("https", async request => {
      const url = new URL(request.url);
      assert.equal(url.origin, "https://chatgpt.com", "fixture must not contact another origin");
      if (url.pathname === "/__fixture/receipt") {
        receipts.push(await request.json());
        return new Response("ok");
      }
      return new Response(fixture(scenario), { headers: { "Content-Type": "text/html" } });
    });
    function TrackedWindow(options) {
      assert.equal(options.show, false);
      assert.equal(options.webPreferences.partition, partition);
      const window = new BrowserWindow(options);
      windows.push(window);
      window.on("show", () => shown++);
      window.on("focus", () => focused++);
      return window;
    }
    const tunnelId = "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const options = {
      app: { getPath: kind => { assert.equal(kind, "userData"); return data; }, getVersion: () => app.getVersion() },
      BrowserWindow: TrackedWindow,
      browserHost: {
        partition,
        probeAuthentication: async () => ({ authenticated: true }),
        withManualOperation: async (_label, work) => { operations++; return work(); },
      },
      runtimeHost: {
        runtimeConfigSnapshot: () => ({ configured: true, owner: "launcher", config: {
          mode: "full", browserInteractionMode: "automatic", automaticTunnel: { tunnelId },
        } }),
        mcpCredentialsConfigured: () => true,
        mcpConnectorName: () => "Coding Tools Native2",
      },
    };
    const command = createMcpConnectorCommand({ app: options.app, run: () => createConfiguredConnector(options) });
    try {
      if (scenario.denied) {
        await assert.rejects(command.request(), /MCP server denied access.*workspace access/);
      } else {
        const result = await command.request();
        assert.equal(result.created, !scenario.existing);
        assert.equal(result.href, `/plugins/plugins~Plugin_${scenario.existing ? "existing" : "created"}`);
      }
      assert.equal(operations, 1);
      assert.equal(shown, 0, "setup must never show its window");
      assert.equal(focused, 0, "setup must never focus its window");
      assert.equal(windows.length, 1);
      assert(windows.every(window => window.isDestroyed()), "setup must dispose its window");
      assert.equal(receipts.length, scenario.existing ? 0 : 1, "only one submission is allowed");
      const commandReport = JSON.parse(fs.readFileSync(path.join(data, "mcp-connector-command.json")));
      assert.equal(commandReport.status, scenario.denied ? "failed" : "completed");
      if (scenario.denied) assert.equal(commandReport.error.code, "mcp_access_denied");
      if (receipts.length) assert.deepEqual(receipts[0], {
        name: "Coding Tools Native2", tunnelId, authentication: "NONE", trusted: true,
        search: "", personalClicks: scenario.publicTab ? 1 : 0, submits: 1,
      });
      const binding = path.join(data, "mcp-connector-binding.json");
      assert.equal(fs.existsSync(binding), !scenario.existing && !scenario.denied);
      if (fs.existsSync(binding)) assert.equal(JSON.parse(fs.readFileSync(binding)).href, "/plugins/plugins~Plugin_created");
      console.log(`MCP_NATIVE_PASS ${scenario.name}`);
    } finally {
      for (const window of windows) if (!window.isDestroyed()) window.destroy();
      await isolated.protocol.unhandle("https");
    }
  }
  clearTimeout(deadline);
  console.log(`MCP_NATIVE_ALL_PASS hidden=true focused=false cases=${cases.length}`);
  app.exit(0);
}).catch(error => {
  console.error("MCP_NATIVE_FAILED", error.stack || error);
  clearTimeout(deadline);
  app.exit(1);
});
