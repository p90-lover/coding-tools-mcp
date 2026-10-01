import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { connectLauncherBrowserHost, LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL, LAUNCHER_BROWSER_PARTITION_PRODUCTION } from "../src/launcher-browser-host";

const chrome = process.env.CHROME_PATH || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : chromium.executablePath());

test.skipIf(!existsSync(chrome))("five launcher connections preserve every existing page viewport and continue streaming", async () => {
  const scratch = resolve(import.meta.dir, "../../aiTemp/browser-stability");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "five-tabs-"));
  const profile = join(root, "profile");
  const owner = await chromium.launchPersistentContext(profile, {
    executablePath: chrome,
    headless: true,
    viewport: null,
    args: ["--remote-debugging-port=0", "--no-proxy-server"],
  });
  const connections: Awaited<ReturnType<typeof connectLauncherBrowserHost>>[] = [];
  try {
    const pages = [owner.pages()[0]!];
    for (let index = 1; index < 5; index++) pages.push(await owner.newPage());
    const surfaceTargets: Record<string, string> = {};
    for (const [index, page] of pages.entries()) {
      await page.setViewportSize({ width: 1280 + index * 20, height: 720 + index * 10 });
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await page.setContent("<!doctype html><p id='answer'>waiting</p>");
      await page.evaluate(() => {
        const state = window as typeof window & { stability: { resizes: number; chunks: number } };
        state.stability = { resizes: 0, chunks: 0 };
        window.addEventListener("resize", () => state.stability.resizes++);
        window.setInterval(() => { document.getElementById("answer")!.textContent = `chunk ${++state.stability.chunks}`; }, 25);
      });
      const session = await owner.newCDPSession(page);
      const { targetInfo } = await session.send("Target.getTargetInfo");
      await session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      // Keep the host's focus setting attached for this fixture's lifetime.
      surfaceTargets[`launcher_surface_id_0123456789A${index}`] = targetInfo.targetId;
    }
    const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0];
    const descriptor = join(root, "launcher-browser.json");
    writeFileSync(descriptor, JSON.stringify({
      version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
      endpoint: `http://127.0.0.1:${port}`,
      control: { endpoint: "http://127.0.0.1:39111", token: "launcher-control-stability-0123456789abcdef" },
      helper: { executable: process.execPath, script: import.meta.path },
      partition: LAUNCHER_BROWSER_PARTITION_PRODUCTION, idleUrl: LAUNCHER_BROWSER_IDLE_URL,
      surfaceId: "launcher_surface_id_0123456789A0", surfaceTargets, createdAt: new Date().toISOString(),
    }), { mode: 0o600 });
    const measure = () => Promise.all(pages.map(page => page.evaluate(() => ({
      width: innerWidth, height: innerHeight, focused: document.hasFocus(),
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      ...(window as typeof window & { stability: { resizes: number; chunks: number } }).stability,
    }))));
    const before = await measure();
    const started = performance.now();
    for (let index = 0; index < 5; index++) {
      connections.push(await connectLauncherBrowserHost(descriptor, 5000, `launcher_surface_id_0123456789A${index}`));
      expect(await connections[index]!.page.evaluate(() => document.hasFocus())).toBe(true);
    }
    await connections[2]!.browser.close();
    connections[2] = await connectLauncherBrowserHost(descriptor, 5000, "launcher_surface_id_0123456789A2");
    const after = await measure();
    console.info(JSON.stringify({ scenario: "five-tabs-and-one-reconnect", elapsedMs: Math.round(performance.now() - started), before, after }));
    expect(after.map(({ width, height }) => ({ width, height }))).toEqual(before.map(({ width, height }) => ({ width, height })));
    expect(after.map(({ dark, reducedMotion }) => ({ dark, reducedMotion }))).toEqual(before.map(({ dark, reducedMotion }) => ({ dark, reducedMotion })));
    expect(after.every((state, index) => state.chunks > before[index]!.chunks)).toBe(true);
    expect(new Set(connections.map(connection => connection.page)).size).toBe(5);
  } finally {
    await Promise.all(connections.map(connection => connection.browser.close().catch(() => {})));
    await owner.close();
  }
}, 25000);
