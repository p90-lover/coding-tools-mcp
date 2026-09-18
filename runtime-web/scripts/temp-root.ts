import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface VerifiedTemporaryRoot {
  requested: string;
  storage: string;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

export function validateTemporaryRoot(
  requestedPath: string,
  storagePath: string,
  allowedRoots: readonly string[],
): VerifiedTemporaryRoot {
  const requested = resolve(requestedPath);
  const storage = resolve(storagePath);
  const approved = allowedRoots.map((root) => resolve(root));
  if (approved.length === 0 || !approved.some((root) => isWithin(root, storage))) {
    throw new Error(
      `Verification temporary storage must stay under an approved aiTemp root: ${storage}`,
    );
  }
  return { requested, storage };
}

export function resolveTemporaryRoot(
  candidate: string,
  allowedRoots: readonly string[],
): VerifiedTemporaryRoot {
  const requested = resolve(candidate);
  const storage = realpathSync.native(requested);
  return validateTemporaryRoot(requested, storage, allowedRoots);
}
