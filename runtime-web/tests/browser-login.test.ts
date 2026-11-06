import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { chromium } from "playwright-core";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserLoginStateExists,
  captureSystemBrowserLogin,
  loginToChatGpt,
  loginVerificationMarkerPath,
  sanitizeBrowserLoginStorageState,
} from "../src/browser-login";
import { CHATGPT_NEW_CHAT_URL } from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";

for (const closeFirst of [true, false]) test(`Windows Chrome capture waits for normal close and Continue (close first=${closeFirst})`, async () => {
  if (process.platform !== "win32") return;
  const scratch = join(import.meta.dir, "../../aiTemp/windows-chrome-login-tests");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "profile-"));
  const executable = join(root, "chrome.exe");
  writeFileSync(executable, "fixture, never executed");
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null, pid: 12345,
    kill: () => { throw new Error("Windows login must close normally before capture"); } });
  const launches: string[][] = [];
  const spawn = spyOn(childProcess, "spawn").mockImplementation((_exe: unknown, args: unknown) => {
    expect(_exe).toBe(executable);
    launches.push(args as string[]);
    queueMicrotask(() => child.emit("spawn"));
    return child as any;
  });
  let offline = false, captured = false;
  const context = { isClosed: () => false, close: async () => {},
    setOffline: async (value: boolean) => { offline = value; }, route: async () => {},
    pages: () => [{ goto: async () => {}, url: () => CHATGPT_NEW_CHAT_URL }],
    storageState: async () => { expect(offline).toBe(true); captured = true; return { cookies: [
      { name: "session", value: "fixture", domain: ".chatgpt.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
      { name: "google", value: "excluded", domain: ".google.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    ], origins: [] }; },
  };
  const launch = spyOn(chromium, "launchPersistentContext").mockImplementation(async (profile, options) => {
    expect(profile.startsWith(root)).toBe(true);
    expect(options?.offline).toBe(true);
    expect(options?.headless).toBe(true);
    expect(options?.chromiumSandbox).toBe(true);
    return context as any;
  });
  let continueLogin!: () => void;
  const continuation = new Promise<void>(resolve => { continueLogin = resolve; });
  const closeChrome = () => { child.exitCode = 0; child.emit("exit", 0, null); };
  try {
    const pending = captureSystemBrowserLogin({ chromeExecutablePath: executable, storageStatePath: join(root, "state.json") }, {
      continuation, timeoutMs: 1000, ...(closeFirst ? { proxyServer: "http://127.0.0.1:32123" } : {}),
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    if (closeFirst) closeChrome(); else continueLogin();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(captured).toBe(false);
    if (closeFirst) continueLogin(); else closeChrome();
    const result = await pending;
    expect(captured).toBe(true);
    expect(result.storageState.cookies.map(cookie => cookie.name)).toEqual(["session"]);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain(closeFirst ? "--proxy-server=http://127.0.0.1:32123" : "--no-proxy-server");
    expect(launches[0].some(arg => /remote-debugging|enable-automation/.test(arg))).toBe(false);
    expect(readdirSync(root).filter(name => name.startsWith("login-profile-"))).toEqual([]);
  } finally { spawn.mockRestore(); launch.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("login starts with normal Chrome and captures state in a headed Keychain-aware context", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousLog = process.env.CODEX_LOGIN_ARG_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    await loginToChatGpt(config, { timeoutMs: 100 }).catch(() => {});

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    const firstLaunch = launches[0] ?? "";
    expect(firstLaunch).toContain("--new-window");
    expect(firstLaunch).toContain("--user-data-dir=");
    expect(firstLaunch).toContain(CHATGPT_NEW_CHAT_URL);
    expect(firstLaunch).not.toContain("--remote-debugging-pipe");
    expect(launches[1]).not.toContain("--headless");
  } finally {
    if (previousLog === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test("passkey login authenticates in normal Chrome before isolated offline pipe capture", async () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-passkey-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  const pidLog = join(root, "pid.log");
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"",
    "case \"$*\" in",
    "  *--remote-debugging-pipe*) exit 0 ;;",
    "esac",
    "printf '%s\\n' \"$$\" > \"$CODEX_LOGIN_PID_LOG\"",
    "trap 'exit 0' TERM INT HUP",
    "while :; do sleep 1; done",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousArgs = process.env.CODEX_LOGIN_ARG_LOG;
  const previousPid = process.env.CODEX_LOGIN_PID_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  process.env.CODEX_LOGIN_PID_LOG = pidLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "transfer", "storage-state.json");
    let continueLogin!: () => void;
    const continuation = new Promise<void>(resolve => { continueLogin = resolve; });
    let browserReady = false;
    const capture = captureSystemBrowserLogin(config, { continuation, timeoutMs: 5_000,
      onBrowserReady: () => { browserReady = true; } });
    for (let attempt = 0; attempt < 100 && !existsSync(pidLog); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(existsSync(pidLog)).toBe(true);
    expect(browserReady).toBe(true);
    continueLogin();
    const error = await capture.then(() => undefined, caught => caught as Error);
    expect(error).toBeInstanceOf(Error);

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    expect(launches).toHaveLength(2);
    expect(launches[0]).toContain("--new-window");
    expect(launches[0]).toContain("--user-data-dir=");
    expect(launches[0]).not.toContain("--remote-debugging-pipe");
    expect(launches[0]).not.toContain("--enable-automation");
    expect(launches[1]).toContain("--remote-debugging-pipe");
    expect(launches[1]).toContain("--headless");
    expect(launches[1]).toContain("--restore-last-session");
    expect(launches[1]).toContain("--disable-background-networking");
    expect(readdirSync(join(root, "transfer")).filter(name => name.startsWith("login-profile-"))).toEqual([]);
  } finally {
    if (previousArgs === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousArgs;
    if (previousPid === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previousPid;
    rmSync(root, { recursive: true, force: true });
  }
});

test("passkey storage capture excludes identity-provider and partitioned state", () => {
  const cookie = (name: string, domain: string, extra = {}) => ({
    name,
    value: name,
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
    ...extra,
  });
  const state = sanitizeBrowserLoginStorageState({
    cookies: [
      cookie("chatgpt", ".chatgpt.com"),
      cookie("openai", "auth.openai.com"),
      cookie("partitioned", ".chatgpt.com", { partitionKey: "https://accounts.google.com" }),
      cookie("google", ".accounts.google.com"),
      cookie("lookalike", ".chatgpt.com.attacker.example"),
    ],
    origins: [
      { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
      { origin: "https://accounts.google.com", localStorage: [{ name: "idp", value: "removed" }] },
    ],
  });
  expect(state.cookies.map(value => value.name)).toEqual(["chatgpt", "openai"]);
  expect(state.origins).toEqual([
    { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
  ]);
});

test("a storage-state file is not trusted without a verification marker", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-state-"));
  try {
    const config = defaultConfig("browser-only");
    config.storageStatePath = join(root, "storage-state.json");
    writeFileSync(config.storageStatePath, "{}\n", { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({ version: 1, authenticated: true, verifiedAt: "2026-07-26T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
