"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");
const moduleRoot = process.env.MCP_CONNECTOR_TEST_APP_ROOT || path.resolve(__dirname, "../..");
const { createConfiguredConnector, openConfiguredTunnelSettings } = require(path.join(moduleRoot, "electron/mcp-connector-setup.cjs"));
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
console.log("MCP_NATIVE_START");

function fixture({ legacy, publicTab, menu, existing, denied, notification, labelledBy, unrelatedLabel, loadingPersonal, blockCreateToExisting, accountId }) {
  return `<!doctype html><meta charset="utf-8"><title>Plugins | ChatGPT</title><main>
    <div role="tablist"><button id="public" role="tab" aria-selected="${Boolean(publicTab)}">Public</button>
    <button id="personal" role="tab" aria-selected="${!publicTab}">Personal</button></div>
    <input type="text" aria-label="Search plugins" placeholder="Search plugins" value="filtered query">
    ${loadingPersonal || blockCreateToExisting ? '<section><h2>Installed</h2><div class="group/plugin-row"><a aria-label="Coding Tools Native2" href="/plugins/plugin_asdk_app_existing?directoryTab=personal" data-discover="true"><span aria-hidden="true">Coding Tools Native2</span></a></div></section>' : ''}
    <section id="list"></section><button id="add">${legacy ? "Create app" : "Add"}</button></main>
    ${notification ? '<div role="alert">Unrelated notification</div>' : ''}
    <script>
    void fetch('/backend-api/aip/connectors/mcp/list_accessible', { method: 'POST', headers: { 'chatgpt-account-id': ${JSON.stringify(accountId)} } });
    const scenario = ${JSON.stringify({ legacy, publicTab, menu, existing, denied, labelledBy, unrelatedLabel, loadingPersonal, blockCreateToExisting })};
    let personalClicks = 0, submits = 0, gridLoaded = !scenario.loadingPersonal;
    function card(id, name = 'Coding Tools Native2') {
      if (!scenario.labelledBy) return '<article><a aria-label="Open Coding Tools Native2" href="/plugins/plugins~Plugin_' + id + '"><h2>Coding Tools Native2</h2></a></article>';
      // Observed ChatGPT row: an empty overlay link names its sibling title, not its description.
      return '<div style="position:relative;width:320px;height:140px" tabindex="-1">'
        + '<a style="position:absolute;inset:0" aria-labelledby="_r_18_" href="/plugins/plugin_asdk_app_' + id + '?directoryTab=personal" data-discover="true"></a>'
        + '<div id="_r_18_" class="text-default truncate font-medium"><span class="inline-flex max-w-full flex-wrap items-center gap-2"><span class="truncate">' + name + '</span> </span></div>'
        + '<div class="line-clamp-1">Coding Tools Native2</div></div>';
    }
    function list() {
      if (!gridLoaded) {
        document.querySelector('#list').innerHTML = '<div>Loading plugins…</div>';
        return;
      }
      document.querySelector('#list').innerHTML = scenario.existing
        ? card('existing')
        : scenario.unrelatedLabel ? card('other', 'Build Web Apps')
          : '<p>' + (scenario.legacy ? 'No apps yet' : 'No plugins found') + '</p>';
    }
    if (!scenario.publicTab) list();
    else document.querySelector('#list').innerHTML = '<article><a aria-label="Open Coding Tools Native2" href="/plugins/plugins~Plugin_public"><h2>Coding Tools Native2</h2></a></article>';
    if (scenario.loadingPersonal) setTimeout(() => { gridLoaded = true; list(); }, 2500);
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
          // The duplicate POST is blocked, then the existing Personal card finishes loading.
          if (!scenario.loadingPersonal) document.querySelector('#list').innerHTML = card(scenario.blockCreateToExisting ? 'existing' : 'created');
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

function detailFixture({ connected, ambiguous, disabledConnect, accountId }) {
  return `<!doctype html><title>Coding Tools Native2 | ChatGPT</title><main>
    <h1>Coding Tools Native2</h1><button>Try in chat</button>
    <div role="button" tabindex="0"><div id="_r_t_">Coding Tools Native2</div><div>No description</div></div>
    ${ambiguous ? '<div role="button" tabindex="0"><div id="_r_u_">Coding Tools Native2</div><div>No description</div></div>' : ""}
    ${connected ? "" : '<button id="connect" ' + (disabledConnect ? 'disabled' : '') + '>Connect</button>'}</main><script>
    void fetch('/backend-api/aip/connectors/mcp/list_accessible', { method: 'POST', headers: { 'chatgpt-account-id': ${JSON.stringify(accountId)} } });
    ${disabledConnect ? "setTimeout(() => { document.querySelector('#connect').disabled = false; }, 250);" : ""}
    document.querySelector('#connect')?.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><h2>Connect Coding Tools Native2</h2><button id="consent">Connect Coding Tools Native2</button></div>');
      document.querySelector('#consent').onclick = async () => {
        await fetch('/__fixture/connection', { method: 'POST', body: JSON.stringify({ name: 'Coding Tools Native2' }) });
        document.querySelector('#connect').remove();
        document.querySelector('[role="dialog"]').remove();
      };
    });
    </script>`;
}

app.whenReady().then(async () => {
  console.log("MCP_NATIVE_READY");
  const cases = [
    { name: "personal-current" },
    { name: "business-current", publicTab: true, menu: true },
    { name: "legacy", legacy: true },
    { name: "existing-private", publicTab: true, existing: true },
    { name: "existing-labelled-title", existing: true, labelledBy: true },
    { name: "existing-personal-loading", existing: true, labelledBy: true, loadingPersonal: true },
    { name: "post-create-existing-identity", labelledBy: true, blockCreateToExisting: true },
    { name: "existing-connected", existing: true, labelledBy: true, connected: true },
    { name: "disabled-connect-loading", labelledBy: true, disabledConnect: true },
    { name: "ambiguous-connected-rows", labelledBy: true, connected: true, ambiguous: true },
    { name: "created-labelled-title", labelledBy: true },
    { name: "unrelated-labelled-description", labelledBy: true, unrelatedLabel: true },
    { name: "access-denied", denied: true },
    { name: "unrelated-notification", notification: true },
  ].filter(scenario => !process.env.MCP_CONNECTOR_TEST_CASE || scenario.name === process.env.MCP_CONNECTOR_TEST_CASE);
  for (const scenario of cases) {
    const data = path.join(root, scenario.name);
    fs.mkdirSync(data, { recursive: true });
    const partition = `mcp-setup-fixture-${scenario.name}`;
    const isolated = session.fromPartition(partition);
    const receipts = [], connections = [], windows = [];
    const userId = "user-fixture", organizationId = "org-fixture", tunnelId = "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const businessId = "602b5d8d-e211-49b1-9762-206108d52954", personalId = "6d4774fd-0e67-4b5b-a3b7-4c0e61357122";
    const accountId = scenario.name.startsWith("business") ? businessId : personalId;
    const accessToken = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": {
      chatgpt_user_id: userId, chatgpt_account_id: businessId, chatgpt_plan_type: "team",
    } })).toString("base64url")}.fixture`;
    let shown = 0, focused = 0, operations = 0;
    await isolated.protocol.handle("https", async request => {
      const url = new URL(request.url);
      if (url.origin === "https://platform.openai.com") return new Response(`<!doctype html><title>Platform fixture</title><script>
        void fetch('https://api.openai.com/v1/dashboard/onboarding/login', { method: 'POST' });
        void fetch('https://api.openai.com/v1/dashboard/organization/permissions', { headers: { 'openai-organization': '${organizationId}' } });
        void fetch('https://api.openai.com/v1/tunnels', { headers: { 'openai-organization': '${organizationId}' } });
        </script>`, { headers: { "Content-Type": "text/html" } });
      if (url.origin === "https://api.openai.com") {
        const headers = { "Access-Control-Allow-Origin": "https://platform.openai.com", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "openai-organization, content-type" };
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
        if (url.pathname === "/v1/dashboard/onboarding/login") return Response.json({ user: { id: userId, orgs: { data: [{ id: organizationId, role: "owner" }] } } }, { headers });
        if (url.pathname === "/v1/dashboard/organization/permissions") return Response.json({ data: ["api.organization.tunnel.read", "api.organization.tunnel.use"] }, { headers });
        if (url.pathname === "/v1/tunnels") return Response.json({ tunnels: [{ id: tunnelId, creator: userId, workspace_ids: [businessId], organization_ids: [] }] }, { headers });
        return new Response(null, { status: 404, headers });
      }
      assert.equal(url.origin, "https://chatgpt.com", "fixture must not contact another origin");
      if (url.pathname === "/api/auth/session") return Response.json({ user: { id: userId }, accessToken });
      if (url.pathname === "/backend-api/accounts/check/v4-2023-04-27") return Response.json({ accounts: Object.fromEntries([businessId, personalId].map(id => [id, {
        can_access_with_session: true, account: { account_id: id, account_user_role: "account-owner", structure: id === personalId ? "personal" : "workspace",
          plan_type: id === personalId ? "free" : "team", is_deactivated: false },
      }])) });
      if (url.pathname === "/backend-api/aip/connectors/mcp/list_accessible") return Response.json({});
      if (url.pathname === "/__fixture/receipt") {
        receipts.push(await request.json());
        return new Response("ok");
      }
      if (url.pathname === "/__fixture/connection") {
        connections.push(await request.json());
        return new Response("ok");
      }
      return new Response(url.pathname.startsWith("/plugins/") ? detailFixture({ ...scenario, accountId }) : fixture({ ...scenario, accountId }), {
        headers: { "Content-Type": "text/html" },
      });
    });
    function TrackedWindow(options) {
      assert.equal(options.show, false);
      assert.equal(options.webPreferences.partition, partition);
      assert.equal(options.webPreferences.offscreen, true);
      const window = new BrowserWindow(options);
      windows.push(window);
      window.on("show", () => shown++);
      window.on("focus", () => focused++);
      return window;
    }
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
    const expectedHref = `/plugins/${scenario.labelledBy ? "plugin_asdk_app_" : "plugins~Plugin_"}${scenario.existing ? "existing" : "created"}${scenario.labelledBy ? "?directoryTab=personal" : ""}`;
    try {
      if (scenario.existing) {
        await assert.rejects(command.request(), /existing connector.*tunnel.*unverified/i);
      } else if (scenario.denied) {
        await assert.rejects(command.request(), /MCP server denied access.*workspace access/);
      } else if (scenario.ambiguous) {
        await assert.rejects(command.request(), /more than one matching app row/);
      } else if (scenario.blockCreateToExisting) {
        await assert.rejects(command.request(), /existing connector.*Create/i);
      } else {
        const result = await command.request();
        assert.equal(result.created, !scenario.existing);
        assert.equal(result.href, expectedHref);
        assert.deepEqual(result.binding, { userId, workspaceId: accountId, tunnelId });
      }
      assert.equal(operations, 1);
      assert.equal(shown, 0, "setup must never show its window");
      assert.equal(focused, 0, "setup must never focus its window");
      assert.equal(windows.length, 1);
      assert(windows.every(window => window.isDestroyed()), "setup must dispose its window");
      assert.equal(receipts.length, scenario.existing ? 0 : 1, "only one submission is allowed");
      assert.equal(connections.length, scenario.existing || scenario.denied || scenario.connected || scenario.blockCreateToExisting ? 0 : 1, "connect only after fresh proof; existing identities remain frozen");
      if (connections.length) assert.deepEqual(connections[0], { name: "Coding Tools Native2" });
      const commandReport = JSON.parse(fs.readFileSync(path.join(data, "mcp-connector-command.json")));
      assert.equal(commandReport.status, scenario.existing || scenario.denied || scenario.ambiguous || scenario.blockCreateToExisting ? "failed" : "completed");
      if (scenario.denied) assert.equal(commandReport.error.code, "mcp_access_denied");
      if (receipts.length) assert.deepEqual(receipts[0], {
        name: "Coding Tools Native2", tunnelId, authentication: "NONE", trusted: true,
        search: "", personalClicks: scenario.publicTab ? 1 : 0, submits: 1,
      });
      const binding = path.join(data, "mcp-connector-binding.json");
      assert.equal(fs.existsSync(binding), !scenario.existing && !scenario.denied && !scenario.ambiguous && !scenario.blockCreateToExisting);
      if (fs.existsSync(binding)) assert.equal(JSON.parse(fs.readFileSync(binding)).href, expectedHref);
      console.log(`MCP_NATIVE_PASS ${scenario.name}`);
    } finally {
      for (const window of windows) if (!window.isDestroyed()) window.destroy();
      await isolated.protocol.unhandle("https");
    }
  }
  const partition = "mcp-platform-settings-fixture";
  const isolated = session.fromPartition(partition);
  let settingsWindow, shown = 0, focused = 0, held = false;
  await isolated.protocol.handle("https", request => {
    assert.equal(new URL(request.url).origin, "https://platform.openai.com");
    return new Response(`<!doctype html><title>MCP Platform frame verification</title>
      <button id="create" hidden>Create tunnel</button><script>
      window.frameCount = 0;
      function frame() { frameCount++; document.querySelector('#create').hidden = false; requestAnimationFrame(frame); }
      requestAnimationFrame(frame);
      </script>`, { headers: { "Content-Type": "text/html" } });
  });
  const settings = openConfiguredTunnelSettings({
    BrowserWindow: function (options) {
      assert.equal(options.show, false);
      assert.equal(options.webPreferences.partition, partition);
      assert.equal(options.webPreferences.offscreen, true);
      assert.equal(options.webPreferences.backgroundThrottling, false);
      settingsWindow = new BrowserWindow(options);
      settingsWindow.on("show", () => shown++);
      settingsWindow.on("focus", () => focused++);
      return settingsWindow;
    },
    browserHost: { partition, withManualOperation: async (_label, work) => {
      held = true;
      try { return await work(); } finally { held = false; }
    } },
    runtimeHost: {
      runtimeConfigSnapshot: () => ({ configured: true, owner: "launcher", config: {
        mode: "full", browserInteractionMode: "automatic", automaticTunnel: { tunnelId: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      } }),
      mcpCredentialsConfigured: () => true,
      mcpConnectorName: () => "Coding Tools Native2",
    },
  });
  try {
    let state;
    const until = Date.now() + 4000;
    do {
      await new Promise(resolve => setTimeout(resolve, 100));
      state = await settingsWindow.webContents.executeJavaScript(`({ frames: window.frameCount || 0, ready: document.querySelector('#create')?.hidden === false })`);
    } while (state.frames < 2 && Date.now() < until);
    assert(state.frames >= 2, `hidden settings must receive animation frames (observed ${state.frames})`);
    assert.equal(settingsWindow.webContents.isOffscreen(), true);
    assert.equal(settingsWindow.webContents.isPainting(), true);
    assert.equal(state.ready, true, "frame-dependent Platform controls must become ready");
    assert.equal(held, true, "the operation must stay owned until the settings window closes");
    await settingsWindow.webContents.executeJavaScript(`location.href = 'https://not-allowed.invalid/'`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(new URL(settingsWindow.webContents.getURL()).origin, "https://platform.openai.com");
    assert.equal(shown, 0);
    assert.equal(focused, 0);
    console.log(`MCP_NATIVE_PASS platform-settings frames=${state.frames} hidden=true focused=false offscreen=true`);
  } finally {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
    await settings;
    await isolated.protocol.unhandle("https");
  }
  assert.equal(held, false);
  clearTimeout(deadline);
  console.log(`MCP_NATIVE_ALL_PASS hidden=true focused=false cases=${cases.length + 1}`);
  app.exit(0);
}).catch(error => {
  console.error("MCP_NATIVE_FAILED", error.stack || error);
  clearTimeout(deadline);
  app.exit(1);
});
