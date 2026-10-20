import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { baseConfig, launcherCapabilityProbeRequired, setupProxyIsReady } from "../src/setup";

test("setup applies an explicit chat-mode flag and otherwise keeps the existing choice", () => {
  const options = { mode: "browser-only" as const, acknowledgedUnofficial: true };
  const existing = defaultConfig("browser-only");
  expect(baseConfig(undefined, options).useSavedChats).toBe(true);
  expect(baseConfig(existing, { ...options, useSavedChats: false }).useSavedChats).toBe(false);
  // Every later setup (an upgrade, a mode switch, Bigger Context) leaves the user's choice alone.
  expect(baseConfig({ ...existing, useSavedChats: false }, options).useSavedChats).toBe(false);
  expect(baseConfig({ ...existing, useSavedChats: false }, { ...options, useSavedChats: true }).useSavedChats).toBe(true);
});

const config = {
  mode: "browser-only" as const,
  releaseVersion: "0.2.0",
};

test("setup accepts only a matching daemon that is ready for new Codex turns", () => {
  const ready = {
    service: "codex-chatgpt-web",
    status: "ok",
    mode: "browser-only",
    version: "0.2.0",
    accepting_turns: true,
  };

  expect(setupProxyIsReady(ready, config)).toBe(true);
  expect(setupProxyIsReady({ ...ready, accepting_turns: false }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, status: "degraded" }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, version: "0.1.16" }, config)).toBe(false);
});

test("launcher setup refreshes account capabilities only when missing or explicitly requested", () => {
  const verifiedLauncher = {
    browserHost: "launcher",
    solAvailable: true,
    proAvailable: false,
  };

  expect(launcherCapabilityProbeRequired(undefined)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    browserHost: "launcher",
    proAvailable: false,
  } as never)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher as never, true)).toBe(true);
  expect(launcherCapabilityProbeRequired({
    ...verifiedLauncher,
    browserInteractionMode: "manual",
  } as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    ...verifiedLauncher,
    browserInteractionMode: "manual",
  } as never, false, "automatic")).toBe(true);
});
