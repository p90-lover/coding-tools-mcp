import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { validateTemporaryRoot } from "../scripts/temp-root";

describe("verification temporary-root boundary", () => {
  const approvedRoot = resolve("aiTemp");
  const approvedStorage = resolve(approvedRoot, "tmp");
  const alias = resolve("short-alias");
  const unapprovedStorage = resolve("outside", "not-approved-storage");

  test("accepts a short alias only when its real storage is under aiTemp", () => {
    expect(validateTemporaryRoot(alias, approvedStorage, [approvedRoot])).toEqual({
      requested: alias,
      storage: approvedStorage,
    });
  });

  test("accepts a direct aiTemp path", () => {
    expect(
      validateTemporaryRoot(approvedStorage, approvedStorage, [approvedRoot]),
    ).toEqual({
      requested: approvedStorage,
      storage: approvedStorage,
    });
  });

  test("rejects aliases whose real storage is outside the approved aiTemp root", () => {
    expect(() =>
      validateTemporaryRoot(alias, unapprovedStorage, [approvedRoot]),
    ).toThrow("Verification temporary storage must stay under an approved aiTemp root");
  });

  test("rejects an aiTemp-looking alias whose real storage is outside the approved root", () => {
    expect(() =>
      validateTemporaryRoot(
        resolve(approvedRoot, "fake-alias"),
        unapprovedStorage,
        [approvedRoot],
      ),
    ).toThrow("Verification temporary storage must stay under an approved aiTemp root");
  });

  test("fails closed when no approved root is supplied", () => {
    expect(() => validateTemporaryRoot(alias, approvedStorage, [])).toThrow(
      "Verification temporary storage must stay under an approved aiTemp root",
    );
  });
});
