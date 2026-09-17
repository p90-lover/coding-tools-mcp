"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function write(relativePath, content) {
  fs.writeFileSync(path.join(root, relativePath), content, "utf8");
}

function replaceOnce(content, before, after, label) {
  const first = content.indexOf(before);
  if (first < 0) throw new Error(`Missing ${label} anchor`);
  if (content.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Ambiguous ${label} anchor`);
  }
  return `${content.slice(0, first)}${after}${content.slice(first + before.length)}`;
}

function patchMain() {
  const relativePath = "desktop-electron/electron/main.cjs";
  let content = read(relativePath);
  if (!content.includes("setProviderBrowserHostResolver")) {
    content = replaceOnce(
      content,
      'const { providerNetworkReady } = require("./provider-bootstrap.cjs");',
      'const { providerNetworkReady, setProviderBrowserHostResolver } = require("./provider-bootstrap.cjs");',
      "provider bootstrap import",
    );
    content = replaceOnce(
      content,
      "let browserHost = null;\n",
      "let browserHost = null;\nsetProviderBrowserHostResolver(() => browserHost);\n",
      "browser host declaration",
    );
  }

  if (!content.includes('managedRoot: path.join(app.getPath("userData"), "upstream")')) {
    content = replaceOnce(
      content,
      `  upstreamToolController = createUpstreamToolController({
    env: process.env,
    logger,
    openExternal: openWebUrl,
  });`,
      `  upstreamToolController = createUpstreamToolController({
    env: process.env,
    logger,
    managedRoot: path.join(app.getPath("userData"), "upstream"),
    openExternal: openWebUrl,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
  });`,
      "upstream controller construction",
    );
  }

  if (!content.includes('handle("launcher:upstream-tool-provision"')) {
    content = replaceOnce(
      content,
      `  handle("launcher:upstream-tools-snapshot", (event) => {
    assertFocusedMainWindow(event, false);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.snapshot();
  });
`,
      `  handle("launcher:upstream-tools-snapshot", (event) => {
    assertFocusedMainWindow(event, false);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.snapshot();
  });
  handle("launcher:upstream-tool-provision", (event, toolId) => {
    assertFocusedMainWindow(event, true);
    if (!upstreamToolController) throw new Error("Upstream tool controller is unavailable");
    return upstreamToolController.provision(toolId);
  });
`,
      "upstream provision IPC",
    );
  }
  write(relativePath, content);
}

function patchProviderNetwork() {
  const relativePath = "desktop-electron/electron/provider-network.cjs";
  let content = read(relativePath);

  if (!content.includes("async function syncBrowserProviderAccount")) {
    const oldProbe = `  async function probeProviderAccount(accountId) {
    const account = accountRecord(accountId);
    try {
      if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {
        return await inspectAntigravitySession(account);
      }
      if (account.providerId === COMMANDCODE_PROVIDER_ID) {
        return await inspectCommandCodeSession(account);
      }
      throw new Error("Provider account health probing is not configured for this provider");
    } catch (error) {
      store.updateAccountConnection(account.id, {
        status: providerSessionFailureStatus(error instanceof Error ? error.message : String(error)),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
`;
    const newProbe = `  async function syncBrowserProviderAccount(account) {
    const browserHost = getBrowserHost();
    if (!browserHost || typeof browserHost.snapshot !== "function") {
      throw new Error("Browser provider login is unavailable");
    }
    let browser = browserHost.snapshot() || {};
    if (browser.authenticated !== true && typeof browserHost.refreshAuthentication === "function") {
      browser = await browserHost.refreshAuthentication();
    }
    const authenticated = browser?.authenticated === true;
    const snapshot = store.updateAccountConnection(account.id, {
      status: authenticated ? "connected" : "expired",
      error: authenticated ? undefined : "ChatGPT browser session is not authenticated",
    });
    return { browser, snapshot };
  }

  async function probeProviderAccount(accountId) {
    const account = accountRecord(accountId);
    try {
      if (account.providerId === "chatgpt-web" || account.providerId === "codex-oauth") {
        return (await syncBrowserProviderAccount(account)).snapshot;
      }
      if (account.providerId === ANTIGRAVITY_PROVIDER_ID) {
        return await inspectAntigravitySession(account);
      }
      if (account.providerId === COMMANDCODE_PROVIDER_ID) {
        return await inspectCommandCodeSession(account);
      }
      throw new Error("Provider account health probing is not configured for this provider");
    } catch (error) {
      store.updateAccountConnection(account.id, {
        status: providerSessionFailureStatus(error instanceof Error ? error.message : String(error)),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
`;
    content = replaceOnce(content, oldProbe, newProbe, "provider probe implementation");

    const oldLogin = `    if (account.providerId === "chatgpt-web" || account.providerId === "codex-oauth") {
      const browser = await getBrowserHost()?.openLogin();
      return { opened: true, mode: "embedded", browser: browser || null };
    }
`;
    const newLogin = `    if (account.providerId === "chatgpt-web" || account.providerId === "codex-oauth") {
      const browserHost = getBrowserHost();
      if (!browserHost || typeof browserHost.openLogin !== "function") {
        throw new Error("Browser provider login is unavailable");
      }
      const browser = await browserHost.openLogin();
      if (!browser || browser.authenticated !== true) {
        const snapshot = store.updateAccountConnection(account.id, {
          status: "pending",
          error: "Complete ChatGPT sign-in before using this provider account",
        });
        const error = new Error("ChatGPT browser session is not authenticated");
        error.snapshot = snapshot;
        throw error;
      }
      const synchronized = await syncBrowserProviderAccount(accountRecord(account.id));
      return {
        opened: true,
        mode: "embedded",
        browser: synchronized.browser,
        snapshot: synchronized.snapshot,
      };
    }
`;
    content = replaceOnce(content, oldLogin, newLogin, "browser provider login implementation");

    content = replaceOnce(
      content,
      "    probeProviderAccount,\n    testProxyProfile,",
      "    probeProviderAccount,\n    syncBrowserProviderAccount,\n    testProxyProfile,",
      "browser provider controller export",
    );
  }

  write(relativePath, content);
}

function patchPreload() {
  const relativePath = "desktop-electron/electron/preload.cjs";
  let content = read(relativePath);
  if (!content.includes("provisionUpstreamTool:")) {
    content = replaceOnce(
      content,
      '  upstreamToolsSnapshot: () => ipcRenderer.invoke("launcher:upstream-tools-snapshot"),\n',
      '  upstreamToolsSnapshot: () => ipcRenderer.invoke("launcher:upstream-tools-snapshot"),\n  provisionUpstreamTool: (toolId) => ipcRenderer.invoke("launcher:upstream-tool-provision", toolId),\n',
      "upstream provision preload",
    );
  }
  write(relativePath, content);
}

function patchTypes() {
  const relativePath = "desktop-electron/src/types.ts";
  let content = read(relativePath);
  if (!content.includes('| "subagent";')) {
    content = replaceOnce(
      content,
      '  | "update";\n',
      '  | "update"\n  | "subagent";\n',
      "subagent proxy scope",
    );
  }
  if (!content.includes('ProviderExecutionWorkload = "subagent"')) {
    content = replaceOnce(
      content,
      'export type ProviderExecutionWorkload = "paseo" | "anneal";',
      'export type ProviderExecutionWorkload = "subagent" | "paseo" | "anneal";',
      "provider execution workload",
    );
  }
  if (!content.includes("export type UpstreamToolRuntimeMode")) {
    content = replaceOnce(
      content,
      'export type UpstreamToolId = "anneal" | "paseo";\n',
      'export type UpstreamToolId = "anneal" | "paseo";\nexport type UpstreamToolRuntimeMode = "packaged" | "managed" | "external" | "unavailable";\n',
      "upstream runtime mode type",
    );
  }
  if (!content.includes("runtimeMode: UpstreamToolRuntimeMode")) {
    content = replaceOnce(
      content,
      `  sourceConfigured: boolean;
  sourceAvailable: boolean;
}`,
      `  sourceConfigured: boolean;
  sourceAvailable: boolean;
  sourcePath: string | null;
  runtimeMode: UpstreamToolRuntimeMode;
  managedRoot: string;
  prerequisites: string[];
  platforms: string[];
  supported: boolean;
  provisionable: boolean;
  provisioning: boolean;
}`,
      "upstream snapshot runtime fields",
    );
  }
  if (!content.includes("provisionUpstreamTool(toolId")) {
    content = replaceOnce(
      content,
      '  upstreamToolsSnapshot(): Promise<UpstreamToolsSnapshot>;\n',
      '  upstreamToolsSnapshot(): Promise<UpstreamToolsSnapshot>;\n  provisionUpstreamTool(toolId: UpstreamToolId): Promise<UpstreamToolSnapshot>;\n',
      "upstream provision API type",
    );
  }
  write(relativePath, content);
}

patchMain();
patchProviderNetwork();
patchPreload();
patchTypes();
