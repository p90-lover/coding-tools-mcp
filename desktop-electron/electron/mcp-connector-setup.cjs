"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateConnectorName } = require("./connector-identity.cjs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

function currentConnectorSettings(runtimeHost) {
  const snapshot = runtimeHost.runtimeConfigSnapshot();
  const config = snapshot.config;
  if (!snapshot.configured || snapshot.owner !== "launcher" || config?.mode !== "full"
    || config.browserInteractionMode === "manual" || !runtimeHost.mcpCredentialsConfigured("automatic")) {
    throw new Error("Connect the saved automatic MCP harness before creating its ChatGPT connector.");
  }
  const tunnel = config.automaticTunnel || (!config.manualTunnel ? config.tunnel : null);
  if (!tunnel || typeof tunnel.tunnelId !== "string" || !tunnel.tunnelId.trim()) {
    throw new Error("The active MCP configuration has no tunnel ID.");
  }
  // Deliberately select only public setup values; the runtime key and its file path stay local.
  return {
    name: validateConnectorName(runtimeHost.mcpConnectorName()),
    tunnelId: tunnel.tunnelId.trim(),
    transport: "tunnel",
    authentication: "none",
  };
}

// An extra tunnel's connector: the same connector name, in the ChatGPT account that owns the tunnel.
function extraConnectorSettings(runtimeHost, tunnelId) {
  if (typeof tunnelId !== "string" || !/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) {
    throw new Error("The tunnel has no valid tunnel ID.");
  }
  return {
    name: validateConnectorName(runtimeHost.mcpConnectorName()),
    tunnelId,
    transport: "tunnel",
    authentication: "none",
  };
}

function extensionHelpersSource() {
  const source = fs.readFileSync(path.join(__dirname, "extensions", "fast-access", "content.js"), "utf8");
  const boundary = source.indexOf("  // Test seam.");
  if (boundary < 0) throw new Error("The pinned MCP extension helper boundary is missing.");
  // Reuse the extension's detection/form logic without registering its Chrome worker or Sync flow.
  return source.slice(0, boundary).replace(
    "const canonicalAppIdentity = (value) => normalize(value).replace(/[^\\p{L}\\p{N}]+/gu, '');",
    "const canonicalAppIdentity = (value) => normalize(value);",
  ) + `
  function personalPluginsLoaded() {
    const selected = [...document.querySelectorAll('main [role="tab"][aria-selected="true"]')]
      .some(tab => textMatches(tab, PERSONAL_VIEW_LABELS, true));
    return selected && !document.querySelector('main [data-testid="plugin-source-tabs-placeholder"],main [data-testid="directory-section-heading-skeleton"],main [data-testid="plugin-row-skeleton-icon-frame"]');
  }
  function findManagedAppCard(name) {
    if (!personalPluginsLoaded()) return null;
    const wanted = canonicalAppIdentity(name);
    const openLabel = canonicalAppIdentity('open ' + name);
    const matches = pluginCardLinks().filter(link => {
      if (canonicalAppIdentity(link.getAttribute('aria-label')) === openLabel) return true;
      // Current cards use an empty overlay link labelled by a sibling title.
      const labelledTitle = (link.getAttribute('aria-labelledby') || '').trim().split(/\\s+/)
        .map(id => document.getElementById(id)?.textContent || '').join(' ');
      if (canonicalAppIdentity(labelledTitle) === wanted) return true;
      const card = link.closest('article,[role="article"]') || link;
      const heading = card.querySelector('h1,h2,h3,h4');
      return heading && canonicalAppIdentity(heading.innerText || heading.textContent) === wanted;
    });
    const identities = new Map(matches.map(link => [new URL(link.href, location.href).pathname, link]));
    if (identities.size > 1) throw new Error('More than one connector has the configured name.');
    return identities.values().next().value || null;
  }
  async function createTunnelConnector(settings) {
    if (/just a moment|verify you are human|checking your browser/i.test(document.title + ' ' + (document.body?.innerText || '').slice(0, 300))) {
      throw new Error('Complete Cloudflare verification in Coding Tools Browser, then try again.');
    }
    if (location.origin !== 'https://chatgpt.com' || !isPersonalPluginsPage()
      || !settings || typeof settings.name !== 'string' || !settings.name.trim()
      || !/^tunnel_[a-f0-9]{32}$/.test(settings.tunnelId)
      || settings.authentication !== 'none') {
      throw new Error('The current ChatGPT connector settings are invalid.');
    }
    const personal = await waitFor(() => {
      const tabs = [...document.querySelectorAll('main [role="tab"]')]
        .filter(tab => visible(tab) && textMatches(tab, PERSONAL_VIEW_LABELS, true));
      return tabs.length === 1 ? tabs[0] : null;
    }, 10_000);
    if (!personal) throw new Error('ChatGPT did not expose one Personal plugins tab.');
    // The URL can say view=personal while the rendered directory still selects Public.
    if (personal.getAttribute('aria-selected') !== 'true') personal.click();
    if (!await waitFor(() => personalPluginsLoaded(), 10_000)) {
      throw new Error('The Personal plugins tab did not finish loading.');
    }
    await clearPluginSearch();
    const listed = await waitFor(() => {
      if (!personalPluginsLoaded()) return null;
      const card = findManagedAppCard(settings.name);
      if (card) return { card };
      if (pluginCardLinks().length || pluginsPageRenderState(settings.name) === 'empty') return { absent: true };
      const main = document.querySelector('main');
      if (/no plugins found/i.test(main?.innerText || '')
        && allClickable(main).some(el => textMatches(el, ['Add'], true))) return { absent: true };
      return null;
    }, 40_000);
    if (!listed) throw new Error('The Personal plugins list did not finish loading, so the connector was not created.');
    if (listed.card) return { created: false, href: listed.card.getAttribute('href') };
    const add = allClickable(document.querySelector('main')).filter(el =>
      !el.closest('[role="dialog"],form') && textMatches(el, ['Add'], true)
      && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (add.length > 1) throw new Error('ChatGPT exposed more than one Add action.');
    if (add.length === 1) {
      await pointerActivateMenu(add[0]);
      const opened = await waitFor(() => {
        if (createFormPresent()) return { form: true };
        const entries = allClickable(document).filter(el => textMatches(el,
          ['Add MCP server', 'Add custom MCP server', 'Add a custom MCP server'], true));
        return entries.length === 1 ? { entry: entries[0] } : null;
      }, 5000);
      if (opened?.entry) await pointerActivateMenu(opened.entry);
      if (!opened || !await waitFor(() => createFormPresent(), 7000)) {
        throw new Error('ChatGPT did not open its custom MCP server form.');
      }
    } else if (!await openCreateFormStrict()) throw new Error('ChatGPT did not open its connector form.');
    let form = activeSurface();
    if (form === document) throw new Error('The connector form is not visible.');
    const tunnelModes = allClickable(form).filter(el => textMatches(el, ['Tunnel', 'Secure MCP Tunnel'], true)
      && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (tunnelModes.length !== 1) throw new Error('ChatGPT did not expose one Tunnel option.');
    pointerActivate(tunnelModes[0]);
    const useId = await waitFor(() => {
      const controls = allClickable(activeSurface()).filter(el => textMatches(el, ['Use tunnel ID instead'], true));
      return controls.length === 1 ? controls[0] : null;
    }, 4000);
    if (useId) pointerActivate(useId);
    const tunnelField = await waitFor(() => inputs(activeSurface()).find(el =>
      /tunnel.*id|^tunnel_[a-f0-9]/i.test([el.id, el.name, el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' '))), 4000);
    form = activeSurface();
    const nameField = findInput('name', form);
    if (!nameField || !tunnelField) throw new Error('ChatGPT did not expose the name and Tunnel ID fields.');
    setInputValue(nameField, settings.name);
    setInputValue(tunnelField, settings.tunnelId);
    await chooseAuth(settings.authentication);
    await acknowledgeCustomServerTrust();
    form = activeSurface();
    const auth = [...form.querySelectorAll('select')].find(select =>
      [...select.options].some(option => textMatches(option, STRINGS.noAuth, true)));
    const selectedAuth = auth?.selectedOptions?.[0];
    const trust = form.querySelector('#trust-checkbox,[role="checkbox"]');
    if (nameField.value !== settings.name || tunnelField.value !== settings.tunnelId
      || !selectedAuth || !textMatches(selectedAuth, STRINGS.noAuth, true)
      || (trust && !(trust.checked || trust.getAttribute('aria-checked') === 'true'))) {
      throw new Error('ChatGPT did not retain the configured connector values.');
    }
    const create = await waitFor(() => {
      const buttons = allClickable(activeSurface()).filter(el => textMatches(el, ['Create', 'Create as a plugin'], true)
        && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
      if (buttons.length > 1) throw new Error('ChatGPT exposed more than one Create action.');
      return buttons[0] || null;
    }, 15_000);
    if (!create) throw new Error('ChatGPT did not expose one enabled Create action.');
    const previousErrors = new Set([...form.querySelectorAll('[role="alert"],[data-slot="form-message"]')]
      .map(el => normalize(el.innerText || el.textContent)));
    create.click();
    const created = await waitFor(() => {
      const surface = activeSurface();
      if (surface !== document && createFormPresent()) {
        if (/the mcp server denied access/i.test(surface.innerText || '')) {
          throw new Error('The MCP server denied access. Check your authentication settings and, if using a tunnel, its workspace access.');
        }
        const error = [...surface.querySelectorAll('[role="alert"],[data-slot="form-message"]')]
          .find(el => visible(el) && normalize(el.innerText || el.textContent)
            && !previousErrors.has(normalize(el.innerText || el.textContent)));
        if (error) throw new Error('ChatGPT connector creation failed: ' + (error.innerText || error.textContent).trim().slice(0, 600));
      }
      const card = findManagedAppCard(settings.name);
      if (card) return { created: true, href: card.getAttribute('href') };
      if (location.pathname.startsWith('/plugins/')) {
        const heading = [...document.querySelectorAll('main h1,main h2,main h3')].find(el =>
          canonicalAppIdentity(el.innerText || el.textContent) === canonicalAppIdentity(settings.name));
        if (heading) return { created: true, href: location.pathname + location.search };
      }
      return null;
    }, 15000);
    if (!created) throw new Error('ChatGPT did not confirm connector creation.');
    return created;
  }
  async function ensureTunnelConnectorConnected(name) {
    if (location.origin !== 'https://chatgpt.com' || !isPluginDetailUrl(location.href)) {
      throw new Error('Open the exact ChatGPT plugin before connecting it.');
    }
    const wanted = canonicalAppIdentity(name);
    const connected = () => {
      const main = document.querySelector('main');
      if (!main || visibleDialogs().length || connectControlIn(main)
        || allClickable(main).some(el => textMatches(el, ['Connect'], true))) return false;
      const rows = [...main.querySelectorAll('[role="button"][tabindex]')].filter(row => visible(row)
        && [...row.querySelectorAll('[id]')].some(title => canonicalAppIdentity(title.textContent) === wanted));
      if (rows.length > 1) throw new Error('ChatGPT exposed more than one matching app row.');
      // Current plugin details replace Connect with an inspectable app row after consent.
      return observeAppConnection(name).connectionObserved || rows.length === 1;
    };
    const ready = await waitFor(() => {
      if (connected()) return { connected: true };
      const main = document.querySelector('main');
      if (!main || !exactNameIn(main, name)) return null;
      const controls = allClickable(main).filter(el => textMatches(el, ['Connect'], true)
        && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
      if (controls.length > 1) throw new Error('ChatGPT exposed more than one Connect action.');
      const connect = connectControlIn(main);
      return controls.length === 1 && controls[0] === connect ? { connect } : null;
    }, 15000);
    if (!ready) throw new Error('ChatGPT did not finish loading this plugin connection.');
    if (ready.connected) return;
    await pointerActivateMenu(ready.connect);
    const consent = await waitFor(() => {
      const dialog = visibleDialogs().at(-1);
      if (!dialog || ![...dialog.querySelectorAll('h1,h2,h3,[role="heading"]')]
        .some(heading => textMatches(heading, ['Connect ' + name], true))) return null;
      const controls = allClickable(dialog).filter(el => textMatches(el, ['Connect ' + name], true)
        && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
      return controls.length === 1 ? controls[0] : null;
    }, 9000);
    if (!consent) throw new Error('ChatGPT did not expose this plugin connection confirmation.');
    await pointerActivateMenu(consent);
    if (!await waitFor(connected, 15000)) throw new Error('ChatGPT did not confirm this plugin connection.');
  }
  createFormPresent = () => {
    const surface = activeSurface();
    return Boolean(findInput('name', surface) && (findInput('url', surface)
      || [...surface.querySelectorAll('select,[role="combobox"],[role="radio"],button,[role="button"]')].some(element =>
        /tunnel/i.test([element.id, element.name, element.getAttribute('data-testid'), element.textContent].join(' ')))));
  };
  globalThis.__codingToolsConnectorHelpers = Object.freeze({
    activeSurface, acknowledgeCustomServerTrust, allClickable, canonicalAppIdentity,
    cardDetailUrl, clearPluginSearch, connectControlIn, createTunnelConnector, elementLabels, ensurePersonalView, ensureTunnelConnectorConnected, findClickable, findExactAppNode,
    findGridArticle, findInput, findManagedAppCard, isPersonalPluginsPage, observeAppConnection, personalPluginsLoaded,
    openCreateFormStrict, pluginCardLinks, pointerActivate, setInputValue,
    textMatches, visible, waitFor, waitForPersonalPluginsPage, waitForPluginsPageReady
  });
})();`;
}

/**
 * Creates the ChatGPT connector for the main tunnel, or with `target` ({ tunnelId, partition }) for
 * an extra tunnel in its account's browser partition; the caller records an extra tunnel's connector.
 */
async function createConfiguredConnector({ app, BrowserWindow, browserHost, runtimeHost, target }) {
  const settings = target
    ? extraConnectorSettings(runtimeHost, target.tunnelId)
    : currentConnectorSettings(runtimeHost);
  const partition = target?.partition ?? browserHost.partition;
  return browserHost.withManualOperation("MCP connector creation", async () => {
    // Another account's sign-in is checked by the page itself: the Plugins page will not load.
    if (partition === browserHost.partition && !(await browserHost.probeAuthentication()).authenticated) {
      throw new Error("Complete ChatGPT verification in Coding Tools Browser before creating its connector.");
    }
    const popup = new BrowserWindow({
      show: false,
      width: 960,
      height: 720,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        offscreen: true,
      },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!popup.isDestroyed()) popup.destroy();
    }, 75_000);
    timer.unref?.();
    try {
      popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      popup.webContents.on("will-navigate", (event, url) => {
        try {
          if (new URL(url).origin === "https://chatgpt.com") return;
        } catch {}
        event.preventDefault();
      });
      await popup.loadURL("https://chatgpt.com/plugins?view=personal");
      await popup.webContents.executeJavaScript(extensionHelpersSource(), true);
      const result = await popup.webContents.executeJavaScript(
        `globalThis.__codingToolsConnectorHelpers.createTunnelConnector(${JSON.stringify(settings)})`, true,
      );
      const url = new URL(result?.href, "https://chatgpt.com");
      if (url.origin !== "https://chatgpt.com" || !url.pathname.startsWith("/plugins/")
        || typeof result.created !== "boolean") {
        throw new Error("ChatGPT returned an invalid connector identity.");
      }
      const href = url.pathname + url.search;
      await popup.loadURL(url.href);
      await popup.webContents.executeJavaScript(extensionHelpersSource(), true);
      await popup.webContents.executeJavaScript(
        `globalThis.__codingToolsConnectorHelpers.ensureTunnelConnectorConnected(${JSON.stringify(settings.name)})`, true,
      );
      if (result.created && !target) {
        writePrivateFileAtomic(path.join(app.getPath("userData"), "mcp-connector-binding.json"),
          JSON.stringify({ version: 1, name: settings.name, tunnelId: settings.tunnelId, href }));
      }
      return { created: result.created, name: settings.name, href };
    } catch (error) {
      if (timedOut) throw new Error("ChatGPT connector setup took too long. Retry from Configuration.");
      throw error;
    } finally {
      clearTimeout(timer);
      if (!popup.isDestroyed()) popup.destroy();
    }
  });
}

async function openConfiguredTunnelSettings({ BrowserWindow, browserHost, runtimeHost, partition = browserHost.partition }) {
  const settings = currentConnectorSettings(runtimeHost);
  // The owned chat page is refreshed by catalog verification; settings need their own surface.
  return browserHost.withManualOperation("MCP tunnel settings", async () => {
    // Offscreen composition keeps hidden Platform dialogs animating without a visible window.
    const popup = new BrowserWindow({
      show: false, width: 1100, height: 800,
      webPreferences: { partition, contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true },
    });
    const closed = new Promise(resolve => popup.once("closed", resolve));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!popup.isDestroyed()) popup.destroy();
    }, 15 * 60_000);
    timer.unref?.();
    try {
      popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const guardNavigation = (event, value) => {
        try {
          const url = new URL(value);
          if (url.protocol === "https:" && !url.username && !url.password && !url.port
            && ["platform.openai.com", "auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(url.hostname)) return;
        } catch {}
        event.preventDefault();
      };
      popup.webContents.on("will-navigate", guardNavigation);
      popup.webContents.on("will-redirect", guardNavigation);
      await popup.loadURL("https://platform.openai.com/settings/organization/tunnels");
      await closed;
      if (timedOut) throw new Error("MCP tunnel settings timed out");
      return { opened: true, name: settings.name };
    } finally {
      clearTimeout(timer);
      if (!popup.isDestroyed()) popup.destroy();
    }
  });
}

module.exports = { createConfiguredConnector, currentConnectorSettings, extensionHelpersSource, extraConnectorSettings, openConfiguredTunnelSettings };
