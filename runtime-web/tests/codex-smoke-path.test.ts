import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveCodexSmokeExecutable } from "../scripts/codex-smoke-path";

describe("Codex subagent smoke executable resolution", () => {
  test("explicit argument overrides environment", () => {
    expect(
      resolveCodexSmokeExecutable(
        ["--v1", "aiTemp/explicit-codex"],
        { CODEX_SMOKE_BIN: "aiTemp/environment-codex" },
        "linux",
      ),
    ).toBe(resolve("aiTemp/explicit-codex"));
  });

  test("uses a configured portable binary on non-macOS hosts", () => {
    expect(
      resolveCodexSmokeExecutable(
        ["--v2"],
        { CODEX_SMOKE_BIN: "aiTemp/pinned-codex" },
        "linux",
      ),
    ).toBe(resolve("aiTemp/pinned-codex"));
  });

  test("keeps the ChatGPT application binary as the macOS local default", () => {
    expect(resolveCodexSmokeExecutable(["--v1"], {}, "darwin")).toBe(
      "/Applications/ChatGPT.app/Contents/Resources/codex",
    );
  });

  test("fails closed on non-macOS hosts without an explicit binary", () => {
    expect(() => resolveCodexSmokeExecutable(["--v2"], {}, "linux")).toThrow(
      "Pass its path or set CODEX_SMOKE_BIN",
    );
  });
});
