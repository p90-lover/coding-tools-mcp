"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, WebContentsView, dialog, shell } = require("electron");
const { createAgentOrchestratorUpstream } = require("../electron/agent-orchestrator-upstream.cjs");

const evidenceRoot = path.resolve(__dirname, "../../aiTemp/ao-integration-smoke");
fs.mkdirSync(evidenceRoot, { recursive: true });
app.setPath("userData", path.join(evidenceRoot, "electron"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
let controller;
let hostWindow;
app.whenReady().then(async () => {
  hostWindow = new BrowserWindow({ title: "Coding Tools AO integration check", width: 1400, height: 940, show: true });
  await hostWindow.loadURL("data:text/html,<title>Coding Tools AO integration check</title><body style='background:%23181818'>Source integration verification</body>");
  hostWindow.show();
  hostWindow.focus();
  controller = createAgentOrchestratorUpstream({
    resourceRoot: path.resolve(__dirname, "../build/agent-orchestrator"),
    dataRoot: path.join(evidenceRoot, "data"), getWindow: () => hostWindow,
    WebContentsView, dialog, shell, confirm: async () => false,
    logger: { warn: (...messages) => console.log(JSON.stringify(messages)) },
  });
  await controller.show({ x: 0, y: 0, width: 1380, height: 870 });
  const status = controller.snapshot();
  console.log("AO_READY", JSON.stringify(status));
  assert.equal(status.state, "ready");
  const denied = await fetch(`http://127.0.0.1:${status.port}/api/v1/mobile/enable`, { method: "POST" });
  assert.equal(denied.status, 403);
  const projects = await controller.call("upstream_projects");
  assert.equal(projects.ok, true);
  const embedded = hostWindow.contentView.children.find((child) => child.webContents && child.webContents !== hostWindow.webContents);
  embedded.webContents.setBackgroundThrottling(false);
  embedded.webContents.debugger.attach("1.3");
  embedded.webContents.debugger.on("message", (_event, method, details) => {
    if (method === "Network.responseReceived" && details.response.url.includes("/api/")) console.log("AO_RESPONSE", details.response.status, new URL(details.response.url).pathname);
    if (method === "Network.loadingFailed") console.log("AO_REQUEST_FAILED", details.errorText);
  });
  await embedded.webContents.debugger.sendCommand("Network.enable");
  embedded.webContents.reload();
  let text = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    text = await embedded.webContents.executeJavaScript("document.body.innerText");
    if (/Add project|Open project|New task|No projects|System requirements|Install dependencies/.test(text)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  text = await embedded.webContents.executeJavaScript("document.body.innerText");
  fs.writeFileSync(path.join(evidenceRoot, "renderer-text.txt"), text);
  console.log("AO_RENDERER", text.slice(0, 1500));
  console.log("AO_BOUNDS", JSON.stringify(embedded.getBounds()));
  console.log("AO_API", JSON.stringify(await embedded.webContents.executeJavaScript(`Promise.all(['/api/v1/projects', '/api/v1/sessions', '/api/v1/system/requirements'].map(async endpoint => {
    try { const response = await fetch(endpoint, { signal: AbortSignal.timeout(3000) }); return { endpoint, status: response.status, text: (await response.text()).slice(0, 1500) }; }
    catch (error) { return { endpoint, error: String(error) }; }
  }))`)));
  console.log("AO_VISIBILITY", hostWindow.isVisible(), await embedded.webContents.executeJavaScript("document.visibilityState"));
  fs.writeFileSync(path.join(evidenceRoot, "visibility.json"), JSON.stringify({ visible: hostWindow.isVisible(), bounds: hostWindow.getBounds(), renderer: await embedded.webContents.executeJavaScript("({visibility:document.visibilityState,online:navigator.onLine,width:innerWidth,height:innerHeight})") }));
  const screenshot = await embedded.webContents.capturePage();
  fs.writeFileSync(path.join(evidenceRoot, "upstream-panel.png"), screenshot.toPNG());
  fs.writeFileSync(path.join(evidenceRoot, "renderer-text.txt"), text);
  assert.ok(text.length > 80, "Original AO renderer did not paint");
  assert.doesNotMatch(text, /Unexpected Application Error|Electron preload is not available/);
  console.log(JSON.stringify({ ok: true, state: status.state, daemonPid: status.pid, mobileBlocked: denied.status, rendererText: text.slice(0, 1500), screenshot: path.join(evidenceRoot, "upstream-panel.png") }));
  await controller.stop(); hostWindow.destroy(); app.exit(0);
}).catch(async (error) => {
  console.error(error);
  await controller?.stop(); hostWindow?.destroy(); app.exit(1);
});
