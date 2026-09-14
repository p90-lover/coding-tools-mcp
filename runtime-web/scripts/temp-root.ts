import { realpathSync } from "node:fs";
import { parse, resolve, sep } from "node:path";

export interface VerifiedTemporaryRoot {
  requested: string;
  storage: string;
}

function hasAiTempSegment(candidate: string): boolean {
  return candidate
    .slice(parse(candidate).root.length)
    .split(sep)
    .filter(Boolean)
    .includes("aiTemp");
}

export function validateTemporaryRoot(
  requestedPath: string,
  storagePath: string,
): VerifiedTemporaryRoot {
  const requested = resolve(requestedPath);
  const storage = resolve(storagePath);
  if (!hasAiTempSegment(storage)) {
    throw new Error(
      `Verification temporary storage must stay under aiTemp: ${storage}`,
    );
  }
  return { requested, storage };
}

export function resolveTemporaryRoot(candidate: string): VerifiedTemporaryRoot {
  const requested = resolve(candidate);
  const storage = realpathSync.native(requested);
  return validateTemporaryRoot(requested, storage);
}
