"use strict";

const { chatGptMcpContextScript, observeMcpSetupContext, extensionHelpersSource, createConfiguredConnector,
  requireAutomaticConnectorSetup, WORKSPACE_OWNER_REQUIRED } = require("./mcp-connector-setup.cjs");

const ADMIN_REQUIRED = WORKSPACE_OWNER_REQUIRED;
const PUBLISH_REQUIRED = "The workspace owner created the MCP connector, but ChatGPT did not make it available to this member. Publish the connector in that workspace's app settings, then retry.";
const isWorkspaceOwner = context => context?.workspaceStructure === "workspace" && context.workspaceRole === "account-owner";
const CONTEXT_CHANGED = "The MCP account or workspace context changed. Retry in the intended workspace.";
const isWorkspaceAdmin = context => context?.workspaceStructure === "workspace"
  && ["account-owner", "account-admin"].includes(context.workspaceRole);

// Names are UI navigation hints only. The observer must confirm the selected workspace id.
function workspaceUiScript(action, input) {
  return `(${workspaceUi.toString()})(${JSON.stringify(action)}, ${JSON.stringify(input)})`;
}

async function workspaceUi(action, input) {
  const h = globalThis.__codingToolsConnectorHelpers;
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const enabled = element => h.visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true";
  const controls = (scope, labels) => (scope ? h.allClickable(scope) : []).filter(element => enabled(element)
    && labels.some(label => normalize(element.innerText || element.textContent) === normalize(label)
      || normalize(element.getAttribute("aria-label")) === normalize(label)));
  const one = values => values.length === 1 ? values[0] : null;
  if (location.origin !== "https://chatgpt.com" || !h) throw new Error("ChatGPT workspace controls are unavailable.");
  if (action === "creation-access") {
    const personal = await h.waitFor(() => one([...document.querySelectorAll('main [role="tab"]')]
      .filter(tab => h.visible(tab) && h.textMatches(tab, ['Personal'], true))), 5000);
    if (!personal) return { allowed: null };
    if (personal.getAttribute('aria-selected') !== 'true') h.pointerActivate(personal);
    if (!await h.waitFor(() => h.personalPluginsLoaded(), 10_000)) return { allowed: null };
    const main = document.querySelector('main');
    if (h.findManagedAppCard(input.name)) return { allowed: null };
    const add = one(controls(main, ['Add']));
    if (!add) return { allowed: false };
    h.pointerActivate(add);
    const menu = await h.waitFor(() => {
      const entries = controls(document, ['Add MCP server', 'Add custom MCP server', 'Add a custom MCP server']);
      if (entries.length === 1) return { allowed: true };
      return [...document.querySelectorAll('[role="menu"]')].some(h.visible) ? { allowed: false } : null;
    }, 5000);
    return menu || { allowed: null };
  }
  if (action === "select") {
    return h.selectWorkspace(input.name);
  }
  const url = new URL(location.href);
  if (url.pathname !== input.path || !url.pathname.startsWith("/plugins/")) throw new Error("The exact workspace connector page changed.");
  const title = () => [...(document.querySelector("main")?.querySelectorAll("h1,h2,h3") || [])].some(element => normalize(element.textContent) === normalize(input.name));
  if (!await h.waitFor(title, 10_000)) throw new Error("ChatGPT did not expose the exact workspace connector.");
  if (action === "prepare-publish") {
    const publish = await h.waitFor(() => one(controls(document.querySelector("main"), ["Publish to workspace"])), 10_000);
    if (!publish) return { available: false };
    h.pointerActivate(publish);
    const dialog = await h.waitFor(() => one([...document.querySelectorAll('[role="dialog"]')].filter(h.visible)), 5000);
    if (!dialog || !normalize(dialog.innerText).includes(normalize(input.workspaceName))
      || !normalize(dialog.innerText).includes(normalize(input.name))
      || !one(controls(dialog, ["Publish", "Publish to workspace"]))) {
      throw new Error("ChatGPT did not confirm the connector and target workspace for publishing.");
    }
    return { available: true, prepared: true };
  }
  if (action === "confirm-publish") {
    const dialog = one([...document.querySelectorAll('[role="dialog"]')].filter(h.visible));
    const publish = dialog && one(controls(dialog, ["Publish", "Publish to workspace"]));
    if (!input.workspaceName || !publish || !normalize(dialog.innerText).includes(normalize(input.workspaceName))
      || !normalize(dialog.innerText).includes(normalize(input.name))) {
      throw new Error("The prepared workspace publishing controls changed.");
    }
    const notices = () => [...document.querySelectorAll('[role="status"],[role="alert"]')].filter(h.visible);
    const previousNotices = new Set(notices().map(element => normalize(element.innerText || element.textContent)));
    const alreadyUnpublishable = controls(document.querySelector("main"), ["Unpublish", "Unpublish from workspace"]).length > 0;
    h.pointerActivate(publish);
    const completed = await h.waitFor(() => {
      if (new URL(location.href).pathname !== input.path) throw new Error("The exact workspace connector page changed.");
      const updates = notices().map(element => normalize(element.innerText || element.textContent)).filter(text => !previousNotices.has(text));
      if (updates.some(text => /failed|denied|error|could not/.test(text))) throw new Error("ChatGPT did not confirm workspace publication.");
      return updates.some(text => /\bpublished\b/.test(text))
        || (!alreadyUnpublishable && controls(document.querySelector("main"), ["Unpublish", "Unpublish from workspace"]).length > 0);
    }, 20_000);
    if (!completed) throw new Error("ChatGPT did not confirm workspace publication.");
    // Keep this window alive through publication; member verification is still the connection proof.
    return { submitted: true, published: true };
  }
  throw new Error("Unsupported workspace action.");
}

async function inspectChatGptAccount({ BrowserWindow, partition, workspaceId, assertCurrent, expectedContext, onContext, metadataOnly = false }, action) {
  if (metadataOnly && (action || workspaceId || expectedContext)) throw new Error("Subscription inspection cannot perform MCP actions.");
  assertCurrent?.();
  const popup = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, offscreen: true } });
  let observer, loading = false, changed = false, version = 0, timedOut = false, expectedPath = null;
  const timer = setTimeout(() => { timedOut = true; if (!popup.isDestroyed()) popup.destroy(); }, action ? 90_000 : 35_000);
  timer.unref?.();
  const navigation = (_event, value, inPlace, mainFrame) => {
    if (mainFrame === false) return;
    version++;
    if (loading) return;
    try {
      const url = new URL(value);
      if (inPlace && url.origin === "https://chatgpt.com" && url.pathname === expectedPath) return;
    } catch {}
    changed = true;
  };
  const check = () => {
    assertCurrent?.();
    if (popup.isDestroyed() || changed) throw new Error(CONTEXT_CHANGED);
  };
  try {
    popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // CDP Network.enable waits for a renderer; an untouched hidden window has none yet.
    await popup.loadURL("about:blank");
    check();
    const guard = (event, value) => {
      try { const url = new URL(value);
        if (url.origin === "https://chatgpt.com" && !url.username && !url.password) return;
      } catch {}
      changed = true; event.preventDefault();
    };
    popup.webContents.on("will-navigate", guard);
    popup.webContents.on("will-redirect", guard);
    popup.webContents.on("did-start-navigation", navigation);
    observer = await observeMcpSetupContext(popup.webContents, null);
    const load = async url => {
      check(); loading = true; expectedPath = new URL(url).pathname;
      try { await popup.loadURL(url); } finally { loading = false; }
      check();
    };
    const selected = async (id, navigationAfter = null) => {
      const end = Date.now() + 12_000;
      while (Date.now() < end) {
        check(); const snapshot = observer.snapshot();
        if (snapshot.error) throw new Error(snapshot.error);
        // Normal account navigation can identify a subscription without granting MCP authority.
        const accountId = metadataOnly ? snapshot.navigationAccountId || snapshot.activeAccountId : snapshot.activeAccountId;
        if (accountId && (!id || accountId === id)) return { ...snapshot, accountId };
        if (navigationAfter !== null && snapshot.navigationVersion > navigationAfter && snapshot.navigationAccountId === id) return snapshot;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("ChatGPT did not confirm the selected workspace.");
    };
    await load("https://chatgpt.com/plugins?view=personal");
    let selection = await selected();
    let context = await popup.webContents.executeJavaScript(chatGptMcpContextScript(selection.accountId), true);
    check();
    if (workspaceId && workspaceId !== context.workspaceId) {
      // This fetch proves membership, not active selection. Only the ensuing normal list request
      // can establish that the popup actually selected the intended workspace.
      const membership = await popup.webContents.executeJavaScript(chatGptMcpContextScript(workspaceId), true);
      check();
      if (membership.userId !== context.userId || !isWorkspaceAdmin(membership)) throw new Error(ADMIN_REQUIRED);
      await popup.webContents.executeJavaScript(extensionHelpersSource(), true);
      const navigationBefore = observer.snapshot().navigationVersion;
      loading = true;
      try { await popup.webContents.executeJavaScript(workspaceUiScript("select", { name: membership.workspaceName }), true);
        await selected(workspaceId, navigationBefore);
      } finally { loading = false; }
      await load("https://chatgpt.com/plugins?view=personal");
      selection = await selected(workspaceId);
      context = await popup.webContents.executeJavaScript(chatGptMcpContextScript(selection.accountId), true);
      check();
      if (context.userId !== membership.userId || context.workspaceRole !== membership.workspaceRole) throw new Error(CONTEXT_CHANGED);
    }
    const original = expectedContext || context;
    const fresh = async () => {
      check();
      const before = observer.snapshot(), beforeVersion = version;
      const accountId = metadataOnly ? before.navigationAccountId || before.activeAccountId : before.activeAccountId;
      if (before.error || accountId !== context.workspaceId) throw new Error(CONTEXT_CHANGED);
      const current = await popup.webContents.executeJavaScript(chatGptMcpContextScript(accountId), true);
      check(); const after = observer.snapshot();
      if (beforeVersion !== version || before.selectionVersion !== after.selectionVersion || after.error
        || (metadataOnly && (before.navigationVersion !== after.navigationVersion
          || (after.navigationAccountId || after.activeAccountId) !== accountId))
        || current.userId !== original.userId || current.workspaceId !== original.workspaceId
        || current.workspaceRole !== original.workspaceRole || current.workspaceStructure !== original.workspaceStructure) {
        throw new Error(CONTEXT_CHANGED);
      }
      return current;
    };
    context = await fresh();
    await onContext?.(partition, context);
    if (!action) return context;
    const result = await action({ context, fresh, contents: popup.webContents, load });
    await fresh();
    return result;
  } catch (error) {
    if (timedOut) throw new Error("ChatGPT workspace inspection timed out. Retry this account's action.");
    throw error;
  } finally {
    clearTimeout(timer); observer?.dispose();
    if (!popup.isDestroyed()) {
      popup.webContents.removeListener("did-start-navigation", navigation);
      popup.destroy();
    }
  }
}

async function createWorkspaceConnector(options) {
  const { browserHost, target, accountCandidates, onContext } = options;
  // Legacy Configuration and command callers keep their existing behavior.
  if (!accountCandidates) return createConfiguredConnector(options);
  const assertCurrent = () => { requireAutomaticConnectorSetup(options.runtimeHost, browserHost); options.assertCurrent?.(); };
  assertCurrent();
  return browserHost.withManualOperation("MCP connector creation", async () => {
    const member = await inspectChatGptAccount({ ...options, partition: target.partition, assertCurrent });
    const connect = (partition, context, shared) => createConfiguredConnector({ ...options,
      operationHeld: true, expectedContext: context, shared, assertCurrent,
      target: { ...target, partition }, onContext });
    if (member.workspaceStructure !== "workspace" || isWorkspaceOwner(member)) return connect(target.partition, member);
    if (!["account-admin", "standard-user"].includes(member.workspaceRole)) throw new Error(ADMIN_REQUIRED);
    // A visible Add control does not grant creation authority. Only a freshly verified owner of
    // this exact workspace may publish for the member; saved bindings never supply that proof.
    const candidates = await accountCandidates();
    const admins = [];
    for (const candidate of candidates.slice(0, 12)) {
      assertCurrent?.();
      if (candidate.partition === target.partition) continue;
      try {
        await candidate.prepare();
        const context = await inspectChatGptAccount({ ...options, partition: candidate.partition,
          workspaceId: member.workspaceId, assertCurrent: () => { assertCurrent?.(); candidate.assertCurrent(); } });
        if (context.workspaceId === member.workspaceId && isWorkspaceOwner(context) && context.userId !== member.userId) {
          admins.push({ ...candidate, context });
        }
      } catch {
        // An unavailable or signed-out candidate cannot lend its cached identity or authority.
        assertCurrent?.();
      }
    }
    if (!admins.length) throw new Error(ADMIN_REQUIRED);
    let admin, created, preflightError;
    for (const candidate of admins) {
      const checkCandidate = () => { assertCurrent?.(); candidate.assertCurrent(); };
      try {
        created = await createConfiguredConnector({ ...options, operationHeld: true,
          assertCurrent: checkCandidate, expectedContext: candidate.context,
          selectWorkspace: true,
          target: { ...target, partition: candidate.partition } });
        admin = candidate; break;
      } catch (error) {
        if (error?.mcpMutationStarted !== false || !/different Platform user|Platform authentication is different|read and use permissions/i.test(error.message)) throw error;
        preflightError = error;
      }
    }
    if (!admin) throw preflightError || new Error(ADMIN_REQUIRED);
    const checkAdmin = () => { assertCurrent?.(); admin.assertCurrent(); };
    checkAdmin();
    await inspectChatGptAccount({ ...options, partition: admin.partition,
      workspaceId: member.workspaceId, expectedContext: admin.context, assertCurrent: checkAdmin },
    async ({ context, fresh, contents, load }) => {
      if (!isWorkspaceOwner(context)) throw new Error(ADMIN_REQUIRED);
      const url = new URL(created.href, "https://chatgpt.com");
      await load(url.href);
      await contents.executeJavaScript(extensionHelpersSource(), true);
      const input = { path: url.pathname, name: created.name, workspaceName: context.workspaceName };
      await fresh();
      const prepared = await contents.executeJavaScript(workspaceUiScript("prepare-publish", input), true);
      if (prepared?.available !== true) return false;
      await fresh();
      if (!isWorkspaceOwner(await fresh())) throw new Error(ADMIN_REQUIRED);
      const confirmed = await contents.executeJavaScript(workspaceUiScript("confirm-publish", input), true);
      if (confirmed?.submitted !== true || confirmed?.published !== true) throw new Error(PUBLISH_REQUIRED);
      return true;
    });
    checkAdmin();
    let result;
    try {
      result = await connect(target.partition, member, { href: created.href, ...created.binding,
        publisherPartition: admin.partition, memberUserId: member.userId, creationResult: created });
    } catch (error) {
      if (error?.mcpMutationStarted !== true && /did not finish loading this plugin|exact workspace connector|not available to this member/i.test(error?.message || "")) {
        throw new Error(PUBLISH_REQUIRED);
      }
      throw error;
    }
    return { ...result, setupAccountId: admin.id, setupWorkspaceRole: admin.context.workspaceRole };
  }, { preserveSurface: options.preserveSurface === true });
}

module.exports = { ADMIN_REQUIRED, PUBLISH_REQUIRED, CONTEXT_CHANGED, isWorkspaceAdmin, workspaceUiScript, inspectChatGptAccount, createWorkspaceConnector };
