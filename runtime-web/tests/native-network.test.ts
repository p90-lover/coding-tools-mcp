import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchNativeCodex, nativeProxyFromPac } from "../src/native-network";
import { LAUNCHER_BROWSER_IDLE_URL, LAUNCHER_BROWSER_PARTITION_PRODUCTION } from "../src/launcher-browser-host";

const envKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
  "NO_PROXY", "no_proxy", "CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR"];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test("native proxy selection preserves Chromium's first route and rejects protocol guessing", () => {
  expect(nativeProxyFromPac("DIRECT")).toBeUndefined();
  expect(nativeProxyFromPac("PROXY 127.0.0.1:7897; DIRECT")).toBe("http://127.0.0.1:7897/");
  expect(nativeProxyFromPac("HTTPS [::1]:8443")).toBe("https://[::1]:8443/");
  for (const value of ["", undefined, "SOCKS5 localhost:1080; PROXY localhost:8080", "PROXY user:secret@host:8", "PROXY host:8#secret"]) {
    expect(() => nativeProxyFromPac(value)).toThrow();
  }
});

test("native relay forwards the request through the launcher without proxy credentials or cookies", async () => {
  for (const key of envKeys) delete process.env[key];
  const root = mkdtempSync(join(import.meta.dir, "../../aiTemp/native-relay-"));
  const token = "launcher-native-relay-test-token-0123456789";
  const seen: Array<{ path: string; authorization: string | null; upstreamUrl: string | null; upstreamAuth: string | null; body: string }> = [];
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    seen.push({
      path: new URL(request.url).pathname,
      authorization: request.headers.get("authorization"),
      upstreamUrl: request.headers.get("x-native-url"),
      upstreamAuth: request.headers.get("x-native-authorization"),
      body: await request.text(),
    });
    return new Response("data: NATIVE_RELAY_OK\n\ndata: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  } });
  const descriptor = join(root, "launcher.json");
  writeFileSync(descriptor, JSON.stringify({
    version: 3, kind: "codex-web-gpt-launcher", profile: "production", pid: process.pid,
    endpoint: "http://127.0.0.1:39110", control: { endpoint: control.url.origin, token },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: LAUNCHER_BROWSER_PARTITION_PRODUCTION, idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB", surfaceTargets: {}, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR = descriptor;
  // The launcher exports its global proxy, but the native request must still use
  // Electron's authenticated proxy session instead of Bun's credential-free route.
  process.env.HTTPS_PROXY = "http://127.0.0.1:1";
  try {
    const url = "https://chatgpt.com/backend-api/codex/responses";
    const response = await fetchNativeCodex(new Request(url, {
      method: "POST", headers: { authorization: "Bearer native-test-token", "content-type": "application/json" },
      body: '{"model":"gpt-5.6-sol"}',
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: NATIVE_RELAY_OK\n\ndata: [DONE]\n\n");
    expect(seen).toEqual([{ path: "/v1/network/native-fetch", authorization: `Bearer ${token}`,
      upstreamUrl: url, upstreamAuth: "Bearer native-test-token", body: '{"model":"gpt-5.6-sol"}' }]);
  } finally { control.stop(true); }
});

test("standalone native fetch retains Bun's explicitly configured proxy", async () => {
  const calls: string[] = [];
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    calls.push(req.url);
    return new Response("data: [DONE]\n\n");
  } });
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      const { fetchNativeCodex } = await import(${JSON.stringify(new URL("../src/native-network.ts", import.meta.url).href)});
      console.log(await (await fetchNativeCodex(new Request("http://native-proxy-regression.invalid/responses"))).text());
    `], { env: { ...process.env, CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: "", HTTP_PROXY: proxy.url.origin,
      HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "" }, stdout: "pipe", stderr: "pipe" });
    const childOutput = await new Response(child.stdout).text();
    const childError = await new Response(child.stderr).text();
    expect({ code: await child.exited, error: childError }).toEqual({ code: 0, error: "" });
    expect(childOutput).toContain("[DONE]");
    expect(calls).toHaveLength(1);
  } finally { proxy.stop(true); }
});

test("native relay waits for a crashed launcher's relaunch and re-reads its descriptor", async () => {
  for (const key of envKeys) delete process.env[key];
  const root = mkdtempSync(join(import.meta.dir, "../../aiTemp/native-relay-crash-"));
  const descriptor = join(root, "launcher-browser.json");
  const relaunchedToken = "launcher-native-relay-relaunched-token-0123456789";
  const seen: Array<string | null> = [];
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    seen.push(request.headers.get("authorization"));
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  // The pid of a process that has exited: what a crashed app leaves in its descriptor.
  const exited = Bun.spawn([process.execPath, "-e", "0"]);
  await exited.exited;
  const write = (pid: number, token: string) => writeFileSync(descriptor, JSON.stringify({
    version: 3, kind: "codex-web-gpt-launcher", profile: "production", pid,
    endpoint: "http://127.0.0.1:39110", control: { endpoint: control.url.origin, token },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: LAUNCHER_BROWSER_PARTITION_PRODUCTION, idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB", surfaceTargets: {}, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR = descriptor;
  const request = () => new Request("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST", headers: { authorization: "Bearer native-test-token", "content-type": "application/json" },
    body: '{"model":"gpt-5.6-sol"}',
  });
  try {
    // Crashed: the descriptor still names the dead pid. The request waits; the relaunched app
    // rewrites the descriptor (new pid and token) and the request goes through it.
    write(exited.pid, "launcher-native-relay-crashed-token-0123456789ab");
    let looks = 0;
    const response = await fetchNativeCodex(request(), {
      intervalMs: 1,
      sleep: async () => { looks += 1; if (looks === 3) write(process.pid, relaunchedToken); },
    });
    expect(response.status).toBe(200);
    expect(looks).toBe(3);
    expect(seen).toEqual([`Bearer ${relaunchedToken}`]);

    // Never relaunched: it fails after the wait, saying so.
    write(exited.pid, "launcher-native-relay-crashed-token-0123456789ab");
    let clock = 0;
    await expect(fetchNativeCodex(request(), { timeoutMs: 1_000, now: () => clock, sleep: async () => { clock += 500; } }))
      .rejects.toThrow(/host process is not running.*waited 1 s for Coding Tools to start again/);

    // A clean quit removes the descriptor and announces nothing: fail at once, no wait.
    rmSync(descriptor);
    let slept = 0;
    await expect(fetchNativeCodex(request(), { sleep: async () => { slept += 1; } }))
      .rejects.toThrow("descriptor is missing");
    expect(slept).toBe(0);
  } finally {
    control.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
