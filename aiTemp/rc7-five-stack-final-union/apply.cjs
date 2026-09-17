"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const count = countOccurrences(source, before);
  if (count !== 1) {
    throw new Error(`${label}: expected one source anchor, found ${count}`);
  }
  return source.replace(before, after);
}

function replaceExactly(source, before, after, expected, label) {
  if (source.includes(after) && !source.includes(before)) return source;
  const count = countOccurrences(source, before);
  if (count !== expected) {
    throw new Error(`${label}: expected ${expected} source anchors, found ${count}`);
  }
  return source.split(before).join(after);
}

function edit(relativePath, transform) {
  const filePath = path.join(ROOT, relativePath);
  const current = fs.readFileSync(filePath, "utf8");
  const next = transform(current);
  if (next !== current) fs.writeFileSync(filePath, next, "utf8");
}

edit("desktop-electron/electron/provider-bootstrap.cjs", (source) => {
  source = replaceOnce(
    source,
    "let providerNetworkControllerPromise = null;\n",
    `let providerNetworkControllerPromise = null;\nlet providerBrowserHostResolver = () => null;\n\nfunction setProviderBrowserHostResolver(resolver) {\n  providerBrowserHostResolver = typeof resolver === "function" ? resolver : () => null;\n}\n`,
    "provider browser-host resolver",
  );

  source = replaceOnce(
    source,
    "      getBrowserHost: () => null,\n",
    "      getBrowserHost: () => providerBrowserHostResolver(),\n",
    "provider browser-host controller wiring",
  );

  const helperAnchor = "  handle(\"launcher:provider-snapshot\", (active) => active.store.snapshot());\n";
  const helperBlock = `  function browserProviderAccount(active, accountId) {\n    const account = active.store.snapshot().accounts.find((candidate) => (\n      candidate.id === accountId && !candidate.archivedAt\n    ));\n    return account && (account.providerId === "codex-oauth" || account.providerId === "chatgpt-web")\n      ? account\n      : null;\n  }\n\n  async function syncBrowserProviderAccount(active, accountId, { openLogin = false } = {}) {\n    const account = browserProviderAccount(active, accountId);\n    if (!account) throw new Error("Browser provider account was not found");\n    const browserHost = providerBrowserHostResolver();\n    if (!browserHost) throw new Error("Browser provider login is unavailable");\n\n    let browser;\n    try {\n      browser = openLogin\n        ? await browserHost.openLogin()\n        : await browserHost.probeAuthentication();\n    } catch (cause) {\n      const message = cause instanceof Error ? cause.message : String(cause);\n      const snapshot = active.store.updateAccountConnection(account.id, {\n        status: openLogin ? "pending" : "expired",\n        error: message,\n      });\n      const error = cause instanceof Error ? cause : new Error(message);\n      error.snapshot = snapshot;\n      throw error;\n    }\n\n    if (browser?.authenticated !== true) {\n      const message = "ChatGPT browser session is not authenticated";\n      const snapshot = active.store.updateAccountConnection(account.id, {\n        status: openLogin ? "pending" : "expired",\n        error: message,\n      });\n      const error = new Error(message);\n      error.snapshot = snapshot;\n      throw error;\n    }\n\n    const snapshot = active.store.updateAccountConnection(account.id, {\n      status: "connected",\n      error: undefined,\n    });\n    return { browser, snapshot };\n  }\n\n${helperAnchor}`;
  source = replaceOnce(
    source,
    helperAnchor,
    helperBlock,
    "browser provider synchronization helper",
  );

  const oldHandlers = `  handle("launcher:provider-login", async (active, _event, accountId) => {\n    const result = await active.openProviderLogin(accountId);\n    if (result?.snapshot) publish(result.snapshot);\n    return result;\n  });\n  handle("launcher:provider-account-probe", async (active, _event, accountId) => (\n    publish(await active.probeProviderAccount(accountId))\n  ));\n`;
  const newHandlers = `  handle("launcher:provider-login", async (active, _event, accountId) => {\n    if (browserProviderAccount(active, accountId)) {\n      try {\n        const result = await syncBrowserProviderAccount(active, accountId, { openLogin: true });\n        publish(result.snapshot);\n        return { opened: true, mode: "embedded", ...result };\n      } catch (error) {\n        if (error?.snapshot) publish(error.snapshot);\n        throw error;\n      }\n    }\n    const result = await active.openProviderLogin(accountId);\n    if (result?.snapshot) publish(result.snapshot);\n    return result;\n  });\n  handle("launcher:provider-account-probe", async (active, _event, accountId) => {\n    if (browserProviderAccount(active, accountId)) {\n      try {\n        return publish((await syncBrowserProviderAccount(active, accountId)).snapshot);\n      } catch (error) {\n        if (error?.snapshot) publish(error.snapshot);\n        throw error;\n      }\n    }\n    return publish(await active.probeProviderAccount(accountId));\n  });\n`;
  source = replaceOnce(
    source,
    oldHandlers,
    newHandlers,
    "browser provider login and probe handlers",
  );

  source = replaceOnce(
    source,
    `module.exports = {\n  installProviderNetwork,\n  providerNetworkReady,\n};\n`,
    `module.exports = {\n  installProviderNetwork,\n  providerNetworkReady,\n  setProviderBrowserHostResolver,\n};\n`,
    "provider bootstrap exports",
  );

  return source;
});

edit("desktop-electron/electron/main.cjs", (source) => {
  source = replaceOnce(
    source,
    `const { providerNetworkReady } = require("./provider-bootstrap.cjs");\n`,
    `const {\n  providerNetworkReady,\n  setProviderBrowserHostResolver,\n} = require("./provider-bootstrap.cjs");\n`,
    "provider bootstrap import",
  );

  source = replaceOnce(
    source,
    "let browserHost = null;\n",
    "let browserHost = null;\nsetProviderBrowserHostResolver(() => browserHost);\n",
    "live BrowserHost resolver installation",
  );

  source = replaceOnce(
    source,
    `function storedProviderCredential(secret) {\n  if (!secret || typeof secret !== "object") return "";\n  for (const key of ["apiKey", "token", "credential", "password"]) {\n    const value = secret[key];\n    if (typeof value === "string" && value.trim()) return value.trim();\n  }\n  return "";\n}\n\nfunction accountNeedsStoredCredential(auth) {\n  return auth === "api_key" || auth === "local_proxy";\n}\n\n`,
    "",
    "obsolete provider-secret extraction helpers",
  );

  source = replaceOnce(
    source,
    `    let settings = input.settings;\n    let credential = "";\n`,
    `    let settings = input.settings;\n`,
    "execution credential initialization",
  );

  source = replaceOnce(
    source,
    `      const secret = providerNetwork.store.accountSecret(plan.account.id);\n      credential = storedProviderCredential(secret);\n      if (accountNeedsStoredCredential(plan.account.auth) && !credential) {\n        throw new Error(\`Provider account \${plan.account.id} has no usable stored credential\`);\n      }\n`,
    "",
    "provider-secret control-plane leak",
  );

  source = replaceOnce(
    source,
    "      credential,\n",
    "      credential: input.controlCredential ?? \"\",\n",
    "separate orchestrator control credential",
  );

  return source;
});

edit("desktop-electron/electron/ipc-schema.cjs", (source) => {
  source = replaceOnce(
    source,
    `  "credential",\n`,
    `  "credential",\n  "control_credential",\n`,
    "control credential response redaction",
  );

  source = replaceOnce(
    source,
    `    allowProviderFallback: Object.freeze({ type: "boolean" }),\n    confirm: Object.freeze({ type: "boolean" }),\n`,
    `    allowProviderFallback: Object.freeze({ type: "boolean" }),\n    controlCredential: Object.freeze({ type: "string", maxLength: 4096 }),\n    confirm: Object.freeze({ type: "boolean" }),\n`,
    "bounded execution control credential schema",
  );

  return source;
});

edit("desktop-electron/src/api/contracts.ts", (source) => replaceOnce(
  source,
  `      readonly allowProviderFallback?: boolean;\n      readonly confirm: boolean;\n`,
  `      readonly allowProviderFallback?: boolean;\n      readonly controlCredential?: string;\n      readonly confirm: boolean;\n`,
  "typed execution control credential",
));

edit("desktop-electron/src/features/ProviderHubSaasSurface.tsx", (source) => {
  source = replaceOnce(
    source,
    `  const [secret, setSecret] = useState("");\n  const [selectedModel, setSelectedModel] = useState("");\n`,
    `  const [secret, setSecret] = useState("");\n  const [controlCredential, setControlCredential] = useState("");\n  const [selectedModel, setSelectedModel] = useState("");\n`,
    "Provider Hub control credential state",
  );

  source = replaceOnce(
    source,
    `  const activeAccounts = useMemo(\n`,
    `  useEffect(() => {\n    setControlCredential("");\n  }, [selectedAccountId, workload]);\n\n  const activeAccounts = useMemo(\n`,
    "control credential lifecycle",
  );

  source = replaceOnce(
    source,
    `        providerAccountId: selectedAccount.id,\n        allowProviderFallback,\n        settings: {\n`,
    `        providerAccountId: selectedAccount.id,\n        allowProviderFallback,\n        controlCredential: controlCredential.trim(),\n        settings: {\n`,
    "Provider Hub execution request credential",
  );

  source = replaceOnce(
    source,
    `      await refreshBindings();\n      setNotice(text(\n`,
    `      await refreshBindings();\n      setControlCredential("");\n      setNotice(text(\n`,
    "control credential clearing",
  );

  source = replaceOnce(
    source,
    `                    <label>\n                      <span>{text(language, "Engine endpoint", "引擎端點")}</span>\n                      <input value={engineEndpoint} onChange={(event) => setEngineEndpoint(event.target.value)} />\n                    </label>\n                    <label>\n                      <span>{text(language, "Mode", "模式")}</span>\n`,
    `                    <label>\n                      <span>{text(language, "Engine endpoint", "引擎端點")}</span>\n                      <input value={engineEndpoint} onChange={(event) => setEngineEndpoint(event.target.value)} />\n                    </label>\n                    <label className="provider-full-row">\n                      <span>{text(\n                        language,\n                        "Paseo / Anneal control credential",\n                        "Paseo／Anneal 控制憑證",\n                      )}</span>\n                      <input\n                        autoComplete="off"\n                        placeholder={text(\n                          language,\n                          "Optional token used only to authenticate the local orchestrator",\n                          "可選 Token，只用於驗證本機 Orchestrator",\n                        )}\n                        type="password"\n                        value={controlCredential}\n                        onChange={(event) => setControlCredential(event.target.value)}\n                      />\n                    </label>\n                    <label>\n                      <span>{text(language, "Mode", "模式")}</span>\n`,
    "Provider Hub control credential field",
  );

  return source;
});

edit(".github/workflows/provider-execution-gates-ci.yml", (source) => {
  source = replaceOnce(
    source,
    `      - 'fix/rc7-complete-five-stack-integration'\n`,
    `      - 'fix/rc7-complete-five-stack-integration'\n      - 'integration/rc7-five-stack-final-union'\n`,
    "provider gate union branch",
  );

  source = replaceExactly(
    source,
    `      - 'aiTemp/rc7-upstream-tools/apply_upstream_tools.py'\n`,
    `      - 'aiTemp/rc7-upstream-tools/apply_upstream_tools.py'\n      - 'aiTemp/rc7-five-stack-final-union/apply.cjs'\n`,
    2,
    "provider gate materializer paths",
  );

  source = replaceExactly(
    source,
    `      - 'desktop-electron/tests/five-stack-managed-integration.test.cjs'\n`,
    `      - 'desktop-electron/tests/five-stack-managed-integration.test.cjs'\n      - 'desktop-electron/tests/five-stack-final-union.test.cjs'\n`,
    2,
    "provider gate final-union test paths",
  );

  source = replaceOnce(
    source,
    `            desktop-electron/tests/five-stack-managed-integration.test.cjs \\\n`,
    `            desktop-electron/tests/five-stack-managed-integration.test.cjs \\\n            desktop-electron/tests/five-stack-final-union.test.cjs \\\n`,
    "provider gate final-union focused test",
  );

  return source;
});

console.log("rc.7 five-stack final-union materialization complete");
