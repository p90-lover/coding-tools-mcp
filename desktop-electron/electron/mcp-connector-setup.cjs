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
    const listed = await waitFor(() => {
      if (!personalPluginsLoaded()) return null;
      const card = findManagedAppCard(settings.name);
      if (card) return { card };
      if (pluginCardLinks().length || pluginsPageRenderState(settings.name) === 'empty') return { absent: true };
      return null;
    }, 40_000);
    if (!listed) throw new Error('The Personal plugins list did not finish loading; connector creation was stopped.');
    if (listed.card) return { created: false, href: listed.card.getAttribute('href') };
    if (!await openCreateFormStrict()) throw new Error('ChatGPT did not open its connector form.');
    let form = activeSurface();
    if (form === document) throw new Error('The connector form is not visible.');
    const tunnelModes = allClickable(form).filter(el => el.getAttribute('role') === 'radio' && textMatches(el, ['Tunnel'], true));
    if (tunnelModes.length !== 1) throw new Error('ChatGPT did not expose one Tunnel option.');
    tunnelModes[0].click();
    const useId = allClickable(activeSurface()).filter(el => textMatches(el, ['Use tunnel ID instead'], true));
    if (useId.length === 1) useId[0].click();
    const tunnelField = await waitFor(() => [...activeSurface().querySelectorAll('input[type="text"]')].find(el =>
      visible(el) && /tunnel.*id|^tunnel_[a-f0-9]/i.test([el.id, el.name, el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' '))), 4000);
    form = activeSurface();
    const nameField = findInput('name', form);
    if (!nameField || !tunnelField) throw new Error('ChatGPT did not expose the name and Tunnel ID fields.');
    setInputValue(nameField, settings.name);
    setInputValue(tunnelField, settings.tunnelId);
    await chooseAuth(settings.authentication);
    await acknowledgeCustomServerTrust();
    const auth = [...form.querySelectorAll('select')].find(select =>
      [...select.options].some(option => normalize(option.textContent) === 'no auth'));
    const selectedAuth = auth?.selectedOptions?.[0];
    const trust = form.querySelector('#trust-checkbox,[role="checkbox"]');
    if (nameField.value !== settings.name || tunnelField.value !== settings.tunnelId
      || !selectedAuth || normalize(selectedAuth.textContent) !== 'no auth'
      || (trust && !(trust.checked || trust.getAttribute('aria-checked') === 'true'))) {
      throw new Error('ChatGPT did not retain the configured connector values.');
    }
    const finalButtons = allClickable(form).filter(el => textMatches(el, ['Create'], true)
      && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (finalButtons.length !== 1) throw new Error('ChatGPT did not expose one enabled Create action.');
    finalButtons[0].click();
    const created = await waitFor(() => {
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
  createFormPresent = () => {
    const surface = activeSurface();
    return Boolean(findInput('name', surface) && (findInput('url', surface)
      || [...surface.querySelectorAll('select,[role="combobox"],[role="radio"]')].some(element =>
        /tunnel/i.test([element.id, element.name, element.getAttribute('data-testid'), element.textContent].join(' ')))));
  };
  globalThis.__codingToolsConnectorHelpers = Object.freeze({
    activeSurface, acknowledgeCustomServerTrust, allClickable, canonicalAppIdentity,
    cardDetailUrl, clearPluginSearch, connectControlIn, createTunnelConnector, elementLabels, ensurePersonalView, findClickable, findExactAppNode,
    findGridArticle, findInput, findManagedAppCard, isPersonalPluginsPage, observeAppConnection, personalPluginsLoaded,
    openCreateFormStrict, pluginCardLinks, pointerActivate, setInputValue,
    textMatches, visible, waitFor, waitForPersonalPluginsPage, waitForPluginsPageReady
  });
})();`;
}

async function createConfiguredConnector({ app, BrowserWindow, browserHost, runtimeHost }) {
  const settings = currentConnectorSettings(runtimeHost);
  return browserHost.withManualOperation("MCP connector creation", async () => {
    if (!(await browserHost.probeAuthentication()).authenticated) {
      throw new Error("Complete ChatGPT verification in Coding Tools Browser before creating its connector.");
    }
    const popup = new BrowserWindow({
      show: false,
      width: 960,
      height: 720,
      webPreferences: {
        partition: browserHost.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
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
      if (result.created) {
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

module.exports = { createConfiguredConnector, currentConnectorSettings, extensionHelpersSource };
