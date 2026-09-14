import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { validateTemporaryRoot } from "../scripts/temp-root";

describe("verification temporary-root boundary", () => {
  const alias = resolve("aiTemp", "fixtures", "short-alias");
  const approvedStorage = resolve("workspace", "coding-tools-mcp", "aiTemp", "tmp");
  const unapprovedStorage = resolve("outside", "not-approved-storage");

  test("accepts a short alias only when its real storage is under aiTemp", () => {
    expect(validateTemporaryRoot(alias, approvedStorage)).toEqual({
      requested: alias,
      storage: approvedStorage,
    });
  });

  test("accepts a direct aiTemp path", () => {
    expect(validateTemporaryRoot(approvedStorage, approvedStorage)).toEqual({
      requested: approvedStorage,
      storage: approvedStorage,
    });
  });

  test("rejects aliases whose real storage is outside aiTemp", () => {
    expect(() => validateTemporaryRoot(alias, unapprovedStorage)).toThrow(
      "Verification temporary storage must stay under aiTemp",
    );
  });

  test("rejects an aiTemp-looking alias whose real storage is outside aiTemp", () => {
    expect(() =>
      validateTemporaryRoot(
        resolve("workspace", "aiTemp", "fake-alias"),
        unapprovedStorage,
      ),
    ).toThrow("Verification temporary storage must stay under aiTemp");
  });
});
