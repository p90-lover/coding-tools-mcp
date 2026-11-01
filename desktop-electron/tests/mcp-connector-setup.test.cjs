const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const path = require("node:path");
const { createConfiguredConnector, currentConnectorSettings, extensionHelpersSource } = require("../electron/mcp-connector-setup.cjs");

function runtime() {
  const config = {
    mode: "full", browserHost: "launcher", browserInteractionMode: "automatic",
    automaticAppName: "Team Harness A",
    automaticTunnel: { tunnelId: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", runtimeKeyFile: "private-key-file", runtimeKey: "DO_NOT_EXPORT" },
    manualTunnel: { tunnelId: "tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  };
  return {
    config,
    runtimeConfigSnapshot: () => ({ configured: true, owner: "launcher", config }),
    mcpCredentialsConfigured: mode => mode === "automatic",
    mcpConnectorName: () => config.automaticAppName,
  };
}

test("connector setup reads current names and tunnel keys on every action without exporting secrets", () => {
  const host = runtime();
  assert.deepEqual(currentConnectorSettings(host), {
    name: "Team Harness A", tunnelId: host.config.automaticTunnel.tunnelId, transport: "tunnel", authentication: "none",
  });
  host.config.automaticAppName = "Renamed workspace / tools";
  host.config.automaticTunnel.tunnelId = "tunnel_cccccccccccccccccccccccccccccccc";
  const renewed = currentConnectorSettings(host);
  assert.equal(renewed.name, host.config.automaticAppName);
  assert.equal(renewed.tunnelId, host.config.automaticTunnel.tunnelId);
  assert.deepEqual(Object.keys(renewed).sort(), ["authentication", "name", "transport", "tunnelId"]);
  assert.doesNotMatch(JSON.stringify(renewed), /private-key-file|DO_NOT_EXPORT/);
});

test("automatic setup cannot borrow a manual profile or an external runtime", () => {
  const host = runtime();
  host.config.browserInteractionMode = "manual";
  assert.throws(() => currentConnectorSettings(host), /automatic MCP harness/);
  host.config.browserInteractionMode = "automatic";
  host.config.automaticTunnel = undefined;
  assert.throws(() => currentConnectorSettings(host), /no tunnel ID/);
  host.runtimeConfigSnapshot = () => ({ configured: true, owner: "external", config: host.config });
  assert.throws(() => currentConnectorSettings(host), /automatic MCP harness/);
});

test("the adapted extension exposes form helpers without the destructive Sync or Chrome listener", () => {
  const context = {};
  const script = extensionHelpersSource();
  vm.runInNewContext(script, context);
  const helpers = context.__codingToolsConnectorHelpers;
  assert.equal(typeof helpers.openCreateFormStrict, "function");
  assert.equal(typeof helpers.findInput, "function");
  assert.equal(typeof helpers.acknowledgeCustomServerTrust, "function");
  assert.equal(context.__codingToolsMcpInternals, undefined);
  assert(!Object.keys(helpers).some(key => /delete|remove|sync|oauth/i.test(key)));
  assert(!script.includes("chrome.runtime.onMessage.addListener"));
  assert.notEqual(helpers.canonicalAppIdentity("MCP-2"), helpers.canonicalAppIdentity("MCP 2"));
  assert.equal(helpers.canonicalAppIdentity("🔧 Shared tools"), "🔧 shared tools");
});

test("managed connector matching ignores an unrelated plugin card mentioning its name", async () => {
  const { chromium } = require(require.resolve("playwright-core", { paths: [path.join(__dirname, "../../runtime-web")] }));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--no-proxy-server"],
  });
  try {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/plugins?view=personal", route => route.fulfill({
      contentType: "text/html",
      body: `<main><div role="tablist"><button role="tab" aria-selected="true">Personal</button></div><article style="width:320px;height:140px"><a aria-label="Open Build Web Apps" href="/plugins/plugins~Plugin_build">
        <h2>Build Web Apps</h2><span>Coding Tools Native2</span></a></article></main>`,
    }));
    await page.goto("https://chatgpt.com/plugins?view=personal");
    await page.evaluate(extensionHelpersSource());
    const first = await page.evaluate(() => {
      const helpers = globalThis.__codingToolsConnectorHelpers;
      return { available: typeof helpers.findManagedAppCard, href: helpers.findManagedAppCard?.("Coding Tools Native2")?.getAttribute("href") ?? null };
    });
    assert.equal(first.available, "function");
    assert.equal(first.href, null);
    await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend', '<div data-testid="plugin-source-tabs-placeholder"></div>'));
    assert.equal(await page.evaluate(() => globalThis.__codingToolsConnectorHelpers.personalPluginsLoaded?.()), false);
    await page.evaluate(() => document.querySelector('[data-testid="plugin-source-tabs-placeholder"]').remove());
    await page.evaluate(() => document.querySelector("main").insertAdjacentHTML("beforeend",
      '<section><h2>Installed</h2><a aria-label="Open Coding Tools Native2" href="/plugins/plugins~Plugin_managed"><span>Coding Tools Native2</span></a></section><section><h2>Created by me</h2><a aria-label="Open Coding Tools Native2" href="/plugins/plugins~Plugin_managed"><span>Coding Tools Native2</span></a></section>'));
    assert.equal(await page.evaluate(() => globalThis.__codingToolsConnectorHelpers.findManagedAppCard("Coding Tools Native2")?.getAttribute("href")),
      "/plugins/plugins~Plugin_managed");
  } finally {
    await browser.close();
  }
});

test("current configuration creates a Tunnel connector from the observed ChatGPT form", async () => {
  const { chromium } = require(require.resolve("playwright-core", { paths: [path.join(__dirname, "../../runtime-web")] }));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--no-proxy-server"],
  });
  try {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/plugins?view=personal", route => route.fulfill({
      contentType: "text/html",
      body: '<main><div role="tablist"><button role="tab" aria-selected="true">Personal</button></div><section><h2>Created by me</h2><article style="width:320px;height:140px"><a href="/plugins/plugins~Plugin_other"><h2>Other App</h2></a></article></section><button id="open">Create app</button></main>',
    }));
    await page.goto("https://chatgpt.com/plugins?view=personal");
    await page.evaluate(() => {
      document.querySelector("#open").onclick = () => {
        document.body.insertAdjacentHTML("beforeend", `<div role="dialog" style="width:420px;height:400px">
          <input id="custom-connector-name" aria-label="Name" type="text">
          <button role="radio" aria-label="Server URL">Server URL</button>
          <button role="radio" aria-label="Tunnel">Tunnel</button>
          <select id="custom-connector-tunnel-select"><option>Loading tunnels...</option></select>
          <button id="use-id">Use tunnel ID instead</button>
          <select id="custom-connector-auth"><option value="OAUTH">OAuth</option><option value="NONE">No Auth</option></select>
          <label>I understand <input id="trust-checkbox" type="checkbox"></label>
          <button id="save">Create</button></div>`);
        const dialog = document.querySelector('[role="dialog"]');
        dialog.querySelector('[aria-label="Tunnel"]').onclick = event => event.currentTarget.setAttribute("aria-checked", "true");
        dialog.querySelector("#use-id").onclick = () => {
          dialog.querySelector("#custom-connector-tunnel-select").outerHTML = '<input id="custom-connector-tunnel-id" type="text" placeholder="tunnel_0123456789abcdef0123456789abcdef">';
          dialog.querySelector("#use-id").remove();
        };
        dialog.querySelector("#save").onclick = () => {
          globalThis.submittedConnector = {
            name: dialog.querySelector("#custom-connector-name").value,
            tunnelId: dialog.querySelector("#custom-connector-tunnel-id").value,
            authentication: dialog.querySelector("#custom-connector-auth").value,
            trusted: dialog.querySelector("#trust-checkbox").checked,
          };
          dialog.remove();
          document.querySelector("main section").insertAdjacentHTML("beforeend", `<article style="width:320px;height:140px"><a aria-label="Open ${globalThis.submittedConnector.name}" href="/plugins/plugins~Plugin_created"><h2>${globalThis.submittedConnector.name}</h2></a></article>`);
        };
      };
    });
    await page.evaluate(extensionHelpersSource());
    const settings = currentConnectorSettings(runtime());
    const result = await page.evaluate(async settings => {
      const helpers = globalThis.__codingToolsConnectorHelpers;
      const available = typeof helpers.createTunnelConnector;
      if (available !== "function") return { available };
      return { available, ...(await helpers.createTunnelConnector(settings)), submitted: globalThis.submittedConnector };
    }, settings);
    assert.equal(result.available, "function");
    assert.equal(result.created, true);
    assert.equal(result.href, "/plugins/plugins~Plugin_created");
    assert.deepEqual(result.submitted, { name: settings.name, tunnelId: settings.tunnelId, authentication: "NONE", trusted: true });
  } finally {
    await browser.close();
  }
});

test("account setup uses its own partition and only returns connected after positive observation", async () => {
  const windows = [];
  let observed = true;
  class Window {
    constructor(options) {
      this.options = options;
      this.urls = [];
      this.closed = false;
      this.webContents = {
        setWindowOpenHandler() {}, on() {},
        executeJavaScript: async script => {
          if (script.startsWith("globalThis.__codingToolsConnectorHelpers.createTunnelConnector(")) {
            return { created: false, href: "/plugins/plugins~Plugin_managed" };
          }
          if (script.startsWith("globalThis.__codingToolsConnectorHelpers.connectTunnelConnector(")) return { connected: observed };
        },
      };
      windows.push(this);
    }
    async loadURL(url) { this.urls.push(url); }
    isDestroyed() { return this.closed; }
    destroy() { this.closed = true; }
  }
  const options = {
    app: { getPath() { throw new Error("Account setup must not overwrite the main binding"); } },
    BrowserWindow: Window,
    browserHost: { partition: "persist:active", withManualOperation: (_label, action) => action() },
    runtimeHost: runtime(),
    target: { partition: "persist:other" },
    verifyConnection: true,
  };
  const result = await createConfiguredConnector(options);
  assert.equal(result.connected, true);
  assert.equal(windows[0].options.webPreferences.partition, "persist:other");
  assert.equal(windows[0].urls.length, 2);
  assert.equal(windows[0].closed, true);
  observed = false;
  await assert.rejects(createConfiguredConnector(options), /did not confirm/);
  assert.equal(windows[1].closed, true, "failed setup closes only its own popup");
  const legacy = await createConfiguredConnector({ ...options, target: undefined, verifyConnection: false,
    browserHost: { ...options.browserHost, probeAuthentication: async () => ({ authenticated: true }) } });
  assert.equal(legacy.connected, undefined, "Configuration retains its create-only behavior");
  assert.equal(windows[2].urls.length, 1);
});

test("the account IPC routes and reconnects only the requested account and records its result", async () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const snippet = source.slice(source.indexOf('  handle("launcher:mcp-create-connector"'), source.indexOf('  handle("launcher:doctor"'));
  let handler, failure = null, signedIn = true;
  const calls = [], records = [], tunnels = [{ id: "extra", accountId: "other", tunnelId: "tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", state: "stopped" }];
  vm.runInNewContext(snippet, {
    Error,
    handle: (_name, action) => { handler = action; },
    assertFocusedMainWindow() {}, IS_DEV_PROFILE: false,
    browserAccounts: {
      partitionOf(id) { assert(["main", "other"].includes(id)); return `persist:${id}`; },
      recordConnector(id, result) { records.push({ id, ...result }); return true; },
    },
    session: { fromPartition: partition => ({ cookies: { get: async () => { calls.push(partition); return []; } } }) },
    signedInFromCookies: () => signedIn,
    routeIdleAccountPartition: async partition => calls.push(`route:${partition}`), logger: {},
    runtimeSupervisor: { extraTunnels: {
      status: () => tunnels, reconnect: async id => calls.push(`reconnect:${id}`), setConnector: id => calls.push(`connector:${id}`),
    } },
    createConfiguredConnector: async options => {
      calls.push(JSON.parse(JSON.stringify(options)));
      if (failure) throw new Error(failure);
      return { created: false, href: "/plugins/plugins~Plugin_managed", name: "Coding Tools", connected: true };
    },
    app: {}, BrowserWindow: {}, browserHost: {}, runtimeHost: {}, publishBrowserAccounts() {}, publishOperation() {},
    stateStore: { update() { throw new Error("Account setup cannot alter global setup flags"); } },
  });
  await handler({}, "other");
  const setup = calls.find(entry => typeof entry === "object");
  assert.deepEqual(setup.target, { partition: "persist:other", tunnelId: tunnels[0].tunnelId });
  assert.equal(setup.verifyConnection, true);
  assert(calls.includes("route:persist:other") && calls.includes("reconnect:extra"));
  assert.deepEqual(records, [{ id: "other", bound: true }]);
  calls.length = 0;
  failure = "ChatGPT refused this connector";
  await assert.rejects(handler({}, "main"), /refused/);
  assert.deepEqual(calls.find(entry => typeof entry === "object").target, { partition: "persist:main" });
  assert.deepEqual(records[1], { id: "main", error: failure });
  calls.length = 0;
  signedIn = false;
  await assert.rejects(handler({}, "other"), /Sign in to this account/);
  assert.equal(calls.some(entry => typeof entry === "object"), false, "signed-out accounts never create a connector");
});

test("connection setup ignores another app's Connected status and connects the exact configured app", async () => {
  const { chromium } = require(require.resolve("playwright-core", { paths: [path.join(__dirname, "../../runtime-web")] }));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true, args: ["--no-proxy-server"],
  });
  try {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/plugins?view=personal", route => route.fulfill({ contentType: "text/html", body:
      `<main><div role="tablist"><button role="tab" aria-selected="true">Personal</button></div><section><h2>Installed</h2>
      <article style="width:320px;height:140px"><a aria-label="Open Other App" href="/plugins/other"><h2>Other App</h2></a><button>Disconnect</button></article>
      <article style="width:320px;height:140px"><a aria-label="Open Team Harness A" href="/plugins/managed"><h2>Team Harness A</h2></a><button id="connect">Connect</button></article>
      </section></main>` }));
    await page.goto("https://chatgpt.com/plugins?view=personal");
    await page.evaluate(() => { globalThis.connectClicks = 0; document.querySelector("#connect").onclick = event => {
      globalThis.connectClicks += 1; event.currentTarget.textContent = "Disconnect";
    }; });
    await page.evaluate(extensionHelpersSource());
    assert.equal(await page.evaluate(() => globalThis.__codingToolsConnectorHelpers.observeAppConnection("Team Harness A").connectionObserved), false);
    assert.deepEqual(await page.evaluate(() => globalThis.__codingToolsConnectorHelpers.connectTunnelConnector("Team Harness A")), { connected: true });
    assert.deepEqual(await page.evaluate(() => globalThis.__codingToolsConnectorHelpers.connectTunnelConnector("Team Harness A")), { connected: true });
    assert.equal(await page.evaluate(() => globalThis.connectClicks), 1, "rechecking cannot disconnect an already connected app");
  } finally {
    await browser.close();
  }
});
