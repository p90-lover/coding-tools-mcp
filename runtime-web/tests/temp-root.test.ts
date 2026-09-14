import { describe, expect, test } from "bun:test";
import { validateTemporaryRoot } from "../scripts/temp-root";

describe("verification temporary-root boundary", () => {
  test("accepts a short external alias only when its real storage is under aiTemp", () => {
    expect(
      validateTemporaryRoot(
        "/tmp/ctm-short-alias",
        "/workspace/coding-tools-mcp/aiTemp/tmp",
      ),
    ).toEqual({
      requested: "/tmp/ctm-short-alias",
      storage: "/workspace/coding-tools-mcp/aiTemp/tmp",
    });
  });

  test("accepts a direct aiTemp path", () => {
    expect(
      validateTemporaryRoot(
        "/workspace/coding-tools-mcp/aiTemp/tmp",
        "/workspace/coding-tools-mcp/aiTemp/tmp",
      ),
    ).toEqual({
      requested: "/workspace/coding-tools-mcp/aiTemp/tmp",
      storage: "/workspace/coding-tools-mcp/aiTemp/tmp",
    });
  });

  test("rejects aliases whose real storage is outside aiTemp", () => {
    expect(() =>
      validateTemporaryRoot(
        "/tmp/ctm-short-alias",
        "/tmp/not-approved-storage",
      ),
    ).toThrow("Verification temporary storage must stay under aiTemp");
  });

  test("rejects an aiTemp-looking alias whose real storage is outside aiTemp", () => {
    expect(() =>
      validateTemporaryRoot(
        "/workspace/aiTemp/fake-alias",
        "/tmp/not-approved-storage",
      ),
    ).toThrow("Verification temporary storage must stay under aiTemp");
  });
});
