import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { basename, join, resolve } from "node:path";
import {
  activateDevProfileEnvironment,
  devLauncherEnvironment,
  installedLauncherCandidates,
  readDevChatExperimentalFeatures,
  resolveDevProfilePaths,
} from "../src/dev-chat/profile";

function retainFixture(root: string): void {
  const trash = join(process.cwd(), "aiTemp", "Trash", "dev-profile");
  mkdirSync(trash, { recursive: true });
  renameSync(root, join(trash, basename(root)));
}

test("DEV profile paths isolate browser, Codex, config, chat, and runtime state", () => {
  const homeDirectory = "/Users/tester";
  const devHome = resolve(homeDirectory, "development");
  const paths = resolveDevProfilePaths({
    homeDirectory,
    environment: {
      CODING_TOOLS_HOME: join(homeDirectory, "production"),
      CODING_TOOLS_DEV_HOME: join(homeDirectory, "development"),
    },
  });
  expect(paths).toEqual({
    home: devHome,
    codexHome: join(devHome, "codex-home"),
    launcherUserData: join(devHome, "launcher"),
    launcherStatePath: join(devHome, "launcher", "launcher-state.json"),
    descriptorPath: join(devHome, "runtime", "launcher-browser.json"),
    chatsPath: join(devHome, "chats"),
    runtimePath: join(devHome, "runtime", "dev-chat"),
    configPath: join(devHome, "config.json"),
  });
});

test("Bigger Context is disabled by default and read from the isolated DEV runtime config", () => {
  const parent = join(process.cwd(), "aiTemp", "dev-profile-fixtures");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "coding-tools-dev-features-"));
  try {
    const paths = resolveDevProfilePaths({
      homeDirectory: root,
      environment: { CODING_TOOLS_DEV_HOME: join(root, "dev") },
    });
    expect(readDevChatExperimentalFeatures(paths)).toEqual({ biggerContext: false });
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.configPath, JSON.stringify({
      version: 3,
      experimentalBiggerContext: true,
    }));
    expect(readDevChatExperimentalFeatures(paths)).toEqual({ biggerContext: true });
    writeFileSync(paths.configPath, JSON.stringify({
      version: 3,
      experimentalBiggerContext: "yes",
    }));
    expect(() => readDevChatExperimentalFeatures(paths)).toThrow("Invalid Bigger Context preference");
  } finally {
    retainFixture(root);
  }
});

test("DEV profile path refuses production home reuse", () => {
  const shared = "/Users/tester/shared";
  expect(() => resolveDevProfilePaths({
    homeDirectory: "/Users/tester",
    environment: {
      CODING_TOOLS_HOME: shared,
      CODING_TOOLS_DEV_HOME: shared,
    },
  })).toThrow("must differ from the production Coding Tools home");
});

for (const platform of ["win32", "linux", "darwin"]) {
  test(`DEV runtime home comparison preserves ${platform} case rules`, () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const homeDirectory = resolve("/fixture/home");
    const production = join(homeDirectory, "Production");
    const alias = join(homeDirectory, "production");
    const paths = (devHome: string) => resolveDevProfilePaths({ homeDirectory,
      environment: { CODING_TOOLS_HOME: production, CODING_TOOLS_DEV_HOME: devHome } });
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    try {
      expect(() => paths(production)).toThrow("must differ from the production Coding Tools home");
      expect(paths(join(homeDirectory, "Development")).home).toBe(join(homeDirectory, "Development"));
      if (platform === "win32") expect(() => paths(alias)).toThrow("must differ from the production Coding Tools home");
      else expect(paths(alias).home).toBe(alias);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });
}

test.skipIf(process.platform !== "win32")("Windows case alias cannot pass either DEV resolver or the launcher environment chain", () => {
  const parent = fileURLToPath(new URL("../../aiTemp/dev-profile-fixtures/", import.meta.url));
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "case-alias-"));
  const { resolveLauncherProfile } = createRequire(import.meta.url)("../../desktop-electron/electron/profile.cjs");
  try {
    const production = join(root, "Production");
    const alias = join(root, "production");
    mkdirSync(production);
    writeFileSync(join(production, "config.json"), '{"fixture":true}\n');
    const original = statSync(join(production, "config.json"), { bigint: true });
    const aliased = statSync(join(alias, "config.json"), { bigint: true });
    expect(original.ino).not.toBe(0n);
    expect([aliased.dev, aliased.ino]).toEqual([original.dev, original.ino]);
    const environment = { CODING_TOOLS_HOME: production, CODING_TOOLS_DEV_HOME: alias };
    expect(() => resolveDevProfilePaths({ environment, homeDirectory: root }))
      .toThrow("must differ from the production Coding Tools home");
    expect(() => resolveLauncherProfile({ env: environment, argv: ["electron", "--dev-profile"],
      homeDir: root, appData: join(root, "app-data") })).toThrow("must differ from the production Coding Tools home");

    const paths = resolveDevProfilePaths({ homeDirectory: root,
      environment: { ...environment, CODING_TOOLS_DEV_HOME: join(root, "Development") } });
    const childEnvironment = devLauncherEnvironment(paths, environment);
    expect(childEnvironment.CODING_TOOLS_HOME).toBeUndefined();
    const child = resolveLauncherProfile({ env: childEnvironment, argv: ["electron", "--dev-profile"],
      homeDir: root, appData: join(root, "app-data") });
    expect(child.coreHome).toBe(paths.home);
    expect(child.userData).toBe(paths.launcherUserData);
    expect(readFileSync(join(production, "config.json"), "utf8")).toBe('{"fixture":true}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed launcher discovery has explicit rebranded platform candidates", () => {
  expect(installedLauncherCandidates({
    platform: "darwin",
    homeDirectory: "/Users/tester",
    environment: {},
  })).toEqual([
    "/Applications/Coding Tools.app/Contents/MacOS/Coding Tools",
    "/Users/tester/Applications/Coding Tools.app/Contents/MacOS/Coding Tools",
  ]);
  expect(installedLauncherCandidates({
    platform: "linux",
    homeDirectory: "/home/tester",
    environment: { PATH: "/usr/local/bin:/usr/bin" },
  })).toEqual([
    "/home/tester/.local/bin/coding-tools",
    "/usr/local/bin/coding-tools",
    "/usr/bin/coding-tools",
  ]);
  expect(installedLauncherCandidates({
    platform: "win32",
    homeDirectory: "C:\\Users\\tester",
    environment: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
  })).toEqual([
    "C:\\Users\\tester\\AppData\\Local\\Programs\\Coding Tools\\Coding Tools.exe",
  ]);
  expect(installedLauncherCandidates({
    platform: "win32",
    homeDirectory: "C:\\Users\\tester",
    environment: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    windowsInstallLocation: "D:\\Apps\\Coding Tools",
  })).toEqual([
    "D:\\Apps\\Coding Tools\\Coding Tools.exe",
  ]);
});

test("injected Windows discovery avoids the live registry while ordinary discovery still uses it", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const registry = spyOn(childProcess, "execFileSync").mockImplementation((() =>
    "    InstallLocation    REG_SZ    D:\\Installed\\Coding Tools\n"
  ) as unknown as typeof childProcess.execFileSync);
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    expect(installedLauncherCandidates({
      platform: "win32",
      environment: { LOCALAPPDATA: "C:\\Fixture\\AppData\\Local" },
    })).toEqual(["C:\\Fixture\\AppData\\Local\\Programs\\Coding Tools\\Coding Tools.exe"]);
    expect(registry).not.toHaveBeenCalled();
    expect(installedLauncherCandidates({ platform: "win32", environment: process.env }))
      .toEqual(["D:\\Installed\\Coding Tools\\Coding Tools.exe"]);
    expect(registry).toHaveBeenCalledTimes(1);
    expect(installedLauncherCandidates({
      platform: "win32", environment: {}, windowsInstallLocation: "E:\\Explicit",
    })).toEqual(["E:\\Explicit\\Coding Tools.exe"]);
    expect(registry).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(process, "platform", platform);
    registry.mockRestore();
  }
});

test("DEV launcher child cannot inherit production home or browser-profile overrides", () => {
  const paths = resolveDevProfilePaths({
    homeDirectory: "/Users/tester",
    environment: {
      CODING_TOOLS_HOME: "/Users/tester/production",
      CODING_TOOLS_DEV_HOME: "/Users/tester/development",
    },
  });
  expect(devLauncherEnvironment(paths, {
    KEEP_ME: "yes",
    CODING_TOOLS_HOME: "/Users/tester/production",
    CODING_TOOLS_LAUNCHER_DATA_DIR: "/Users/tester/production-launcher",
    CODEX_CHATGPT_WEB_HOME: paths.home,
    CODEX_HOME: "/Users/tester/production-codex",
    CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES: '["/Users/tester/second-account"]',
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: "/Users/tester/legacy-production-launcher",
  })).toEqual({
    KEEP_ME: "yes",
    CODING_TOOLS_DEV_HOME: paths.home,
    CODEX_WEB_GPT_DEV_HOME: paths.home,
  });
});

test("DEV chat activation removes shared production Codex homes", () => {
  const keys = ["CODEX_WEB_GPT_DEV_HOME", "CODEX_CHATGPT_WEB_HOME", "CODEX_HOME", "CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES"];
  const saved = keys.map(key => process.env[key]);
  try {
    process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = '["/Users/tester/production-account"]';
    const paths = resolveDevProfilePaths({ environment: {}, homeDirectory: "/Users/tester" });
    activateDevProfileEnvironment(paths);
    expect(process.env.CODEX_HOME).toBe(paths.codexHome);
    expect(process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES).toBeUndefined();
  } finally {
    for (const [index, key] of keys.entries()) {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    }
  }
});
