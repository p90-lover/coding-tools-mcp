import { describe, expect, test } from "bun:test";
import { resolveRuntimeBundleAppVersion } from "../src/runtime-bundle-version";

describe("desktop runtime bundle release identity", () => {
  test("uses the internal harness version when no outer app version is supplied", () => {
    expect(resolveRuntimeBundleAppVersion({})).toBe("5.0.6");
  });

  test("accepts an explicit desktop release version without changing the harness package version", () => {
    expect(resolveRuntimeBundleAppVersion({
      CODEX_CHATGPT_WEB_BUNDLE_APP_VERSION: "0.6.0-rc.1",
    })).toBe("0.6.0-rc.1");
  });

  test("rejects malformed outer release versions", () => {
    expect(() => resolveRuntimeBundleAppVersion({
      CODEX_CHATGPT_WEB_BUNDLE_APP_VERSION: "../../bad",
    })).toThrow("release version");
  });
});
