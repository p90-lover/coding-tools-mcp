"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { app, BrowserWindow, protocol } = require("electron");
const { createRegMachineService, UI_ORIGIN } = require("../electron/reg-machine-managed.cjs");

const repo = path.resolve(__dirname, "../..");
const moduleRoot = path.join(repo, "app-handler/reg-machine");
const runtimeRoot = path.resolve(process.env.REG_MACHINE_SMOKE_RUNTIME_ROOT || path.join(repo, "aiTemp/reg-machine-build/resources"));
const evidenceRoot = path.join(repo, "aiTemp/reg-machine-smoke", crypto.randomUUID());
const scratchRoot = path.join(path.dirname(runtimeRoot), "smoke-temp", crypto.randomUUID());
const dataRoot = path.join(scratchRoot, "data");
process.env.TEMP = path.join(scratchRoot, "temp");
process.env.TMP = process.env.TEMP;
fs.mkdirSync(process.env.TEMP, { recursive: true });
fs.mkdirSync(evidenceRoot, { recursive: true });
app.setPath("userData", path.join(scratchRoot, "electron"));
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: "coding-tools-register", privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);
let service;
let window;
const deadline = setTimeout(() => { console.error("Register smoke timed out"); app.exit(1); }, 120_000);

app.whenReady().then(async () => {
  try {
    const checked = spawnSync(path.join(runtimeRoot, "backend", process.platform === "win32" ? "register-backend.exe" : "register-backend"),
      ["--verify-browsers"], { windowsHide: true, timeout: 90_000, encoding: "utf8", env: {
        ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(runtimeRoot, "browsers"),
        CAMOUFOX_CACHE_DIR: path.join(runtimeRoot, "camoufox"),
        LOCALAPPDATA: path.join(scratchRoot, "local-app-data"), APPDATA: path.join(scratchRoot, "app-data"),
        HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1",
        NO_PROXY: "localhost,127.0.0.1,::1",
      } });
    assert.equal(checked.status, 0, (checked.stderr || checked.error?.message || "Bundled browser check failed").slice(-2000));
    assert.ok(checked.stdout.includes("Register browser runtimes verified"));
    service = createRegMachineService({ moduleRoot, runtimeRoot, dataRoot });
    protocol.handle("coding-tools-register", (request) => service.handleRequest(request));
    await service.start();
    const call = (pathname, options) => service.handleRequest(new Request(UI_ORIGIN + pathname, options));
    const platforms = await call("/api/platforms");
    assert.equal(platforms.status, 200);
    const available = await platforms.json();
    assert.ok(Array.isArray(available) && available.some((entry) => entry.name === "chatgpt"));
    const before = await call("/api/accounts");
    assert.equal(before.status, 200);
    const initial = await before.json();
    assert.equal(initial.total, 0);
    const created = await call("/api/accounts", { method: "POST",
      headers: { "content-type": "application/json", origin: UI_ORIGIN },
      body: JSON.stringify({ platform: "desktop-fixture", status: "failed", email: "register-smoke@example.invalid", password: "fixture-password" }) });
    assert.equal(created.status, 200);
    const fixture = await created.json();
    assert.ok(fixture.id);
    const exported = await call("/api/accounts/export");
    assert.equal(exported.status, 200);
    assert.ok((await exported.arrayBuffer()).byteLength > 0);
    const removed = await call("/api/accounts/" + fixture.id, { method: "DELETE", headers: { origin: UI_ORIGIN } });
    assert.equal(removed.status, 200);
    const owner = await service.call("portal-owner-session");
    const portal = await call("/portal/api/auth/me", { headers: { "x-register-portal-session": owner.sessionId } });
    assert.equal(portal.status, 200);
    const portalUser = await portal.json();
    assert.equal(portalUser.username, "coding-tools");

    window = new BrowserWindow({ show: false, width: 1400, height: 1000,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const consoleErrors = [];
    window.webContents.on("console-message", (_event, level, message) => {
      if (level >= 3) consoleErrors.push(message.slice(0, 160));
    });
    await window.loadURL(UI_ORIGIN + "/");
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await window.webContents.executeJavaScript("document.body.innerText")).includes("Auto Register")) break;
      await delay(150);
    }
    const sections = ["/", "/accounts", "/accounts/chatgpt", "/register", "/history", "/authenticator", "/proxies", "/settings"];
    assert.equal((await call("/tasks")).status, 200);
    const rendered = [];
    for (const section of sections) {
      await window.loadURL(UI_ORIGIN + section);
      let content = "";
      for (let attempt = 0; attempt < 40; attempt++) {
        content = await window.webContents.executeJavaScript("document.querySelector('main')?.innerText || ''");
        if (content.length > 40) break;
        await delay(100);
      }
      assert.equal(await window.webContents.executeJavaScript("location.pathname"), section);
      assert.ok(content.length > 40, section + " must render its own page");
      rendered.push(content);
    }
    assert.equal(new Set(rendered).size, sections.length, "each original section must render distinct content");

    assert.deepEqual(consoleErrors, []);
    fs.writeFileSync(path.join(evidenceRoot, "register.png"), (await window.webContents.capturePage()).toPNG());
    const report = { ok: true, platformCount: available.length, apiCatalogCount: require(path.join(moduleRoot, "routes.json")).length,
      sections, isolatedAccounts: true, binaryExport: true, portalAuthentication: true, bundledBackend: true, bundledBrowserRuntimes: true };
    fs.writeFileSync(path.join(evidenceRoot, "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, evidenceRoot }));
    window.destroy();
    window = null;
    await service.stop();
    fs.rmSync(dataRoot, { recursive: true, force: true });
    clearTimeout(deadline);
    app.quit();
  } catch (error) {
    console.error(error.stack || error.message);
    window?.destroy();
    try { await service?.stop(); } catch {}
    clearTimeout(deadline);
    app.exit(1);
  }
});
