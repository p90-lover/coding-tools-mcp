import { describe, expect, test } from "bun:test";
import { join, resolve, win32 } from "node:path";
import {
  resolveDevProfilePaths,
  installedLauncherCandidates,
  devLauncherEnvironment,
} from "../src/dev-chat/profile";

describe("Coding Tools upstream profile adaptation", () => {
  test("uses a disjoint Coding Tools DEV home", () => {
    const home = resolve("/fixture/home");
    const paths = resolveDevProfilePaths({ environment: {}, homeDirectory: home });
    expect(paths.home).toBe(join(home, ".coding-tools-dev"));
    expect(paths.codexHome).toBe(join(home, ".coding-tools-dev", "codex-home"));
    expect(paths.launcherUserData).toBe(join(home, ".coding-tools-dev", "launcher"));
  });

  test("honors new overrides and ignores colliding legacy homes", () => {
    const home = resolve("/fixture/home");
    const paths = resolveDevProfilePaths({
      homeDirectory: home,
      environment: {
        CODEX_CHATGPT_WEB_HOME: join(home, "legacy"),
        CODEX_WEB_GPT_DEV_HOME: join(home, "legacy"),
        CODING_TOOLS_HOME: join(home, "production"),
        CODING_TOOLS_DEV_HOME: join(home, "development"),
      },
    });
    expect(paths.home).toBe(join(home, "development"));
  });

  test("finds the rebranded Windows launcher and exports only isolated child paths", () => {
    const home = win32.resolve("C:\\Users\\fixture");
    const paths = resolveDevProfilePaths({
      homeDirectory: home,
      environment: { CODING_TOOLS_DEV_HOME: win32.join(home, ".coding-tools-dev") },
    });
    const candidates = installedLauncherCandidates({
      platform: "win32",
      homeDirectory: home,
      environment: { LOCALAPPDATA: win32.join(home, "AppData", "Local") },
      windowsInstallLocation: win32.join(home, "Apps", "Coding Tools"),
    });
    expect(candidates).toContain(win32.join(home, "Apps", "Coding Tools", "Coding Tools.exe"));
    const child = devLauncherEnvironment(paths, {
      CODEX_CHATGPT_WEB_HOME: "legacy-production",
      CODEX_HOME: "legacy-codex",
      CODEX_WEB_GPT_LAUNCHER_DATA_DIR: "legacy-launcher",
    });
    expect(child.CODING_TOOLS_DEV_HOME).toBe(paths.home);
    expect(child.CODEX_WEB_GPT_DEV_HOME).toBe(paths.home);
    expect(child.CODEX_CHATGPT_WEB_HOME).toBeUndefined();
    expect(child.CODEX_HOME).toBeUndefined();
  });
});
