const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function safeSegment(value, fallback = "item") {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Preservation session requires a valid timestamp");
  return date.toISOString().replace(/[:.]/g, "-");
}

function assertInside(root, candidate, label, { allowRoot = false } = {}) {
  const relative = path.relative(root, candidate);
  if ((!allowRoot && relative === "")
      || relative === ".."
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside ${root}: ${candidate}`);
  }
}

function createPreservationSession({
  repositoryRoot,
  label,
  now = () => new Date(),
  nonce = () => crypto.randomBytes(6).toString("hex"),
  fsImpl = fs,
} = {}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.trim() === "") {
    throw new Error("Preservation session requires repositoryRoot");
  }
  const resolvedRepositoryRoot = path.resolve(repositoryRoot);
  const aiTempRoot = path.join(resolvedRepositoryRoot, "aiTemp");
  const safeLabel = safeSegment(label, "preservation");
  const sessionId = `${timestamp(now())}-${process.pid}-${safeSegment(nonce(), "nonce")}-${safeLabel}`;
  const workRoot = path.join(aiTempRoot, "work", safeLabel);
  const trashRoot = path.join(aiTempRoot, "Trash", sessionId);

  function createWorkDirectory(kind) {
    const safeKind = safeSegment(kind, "work");
    fsImpl.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
    const directory = fsImpl.mkdtempSync(path.join(workRoot, `${safeKind}-`));
    assertInside(aiTempRoot, directory, "working directory");
    return directory;
  }

  function uniqueDestination(category, baseName) {
    const categoryRoot = path.join(trashRoot, safeSegment(category, "preserved"));
    fsImpl.mkdirSync(categoryRoot, { recursive: true, mode: 0o700 });
    const parsed = path.parse(safeSegment(baseName, "item"));
    let destination = path.join(categoryRoot, `${parsed.name}${parsed.ext}`);
    let suffix = 2;
    while (fsImpl.existsSync(destination)) {
      destination = path.join(categoryRoot, `${parsed.name}-${suffix}${parsed.ext}`);
      suffix += 1;
    }
    return destination;
  }

  function preservePath(sourcePath, category = "preserved") {
    const source = path.resolve(sourcePath);
    assertInside(resolvedRepositoryRoot, source, "preserved path");
    if (!fsImpl.existsSync(source)) return null;
    const destination = uniqueDestination(category, path.basename(source));
    fsImpl.renameSync(source, destination);
    return destination;
  }

  function replaceDirectory(preparedPath, targetPath, { category = "prior-directory" } = {}) {
    const prepared = path.resolve(preparedPath);
    const target = path.resolve(targetPath);
    assertInside(aiTempRoot, prepared, "prepared directory");
    assertInside(resolvedRepositoryRoot, target, "target directory");
    if (!fsImpl.existsSync(prepared) || !fsImpl.statSync(prepared).isDirectory()) {
      throw new Error(`Prepared publication directory is missing: ${prepared}`);
    }

    let preservedPath = null;
    if (fsImpl.existsSync(target)) preservedPath = preservePath(target, category);
    try {
      fsImpl.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fsImpl.renameSync(prepared, target);
    } catch (publicationError) {
      let restorationError = null;
      if (preservedPath && !fsImpl.existsSync(target)) {
        try {
          fsImpl.renameSync(preservedPath, target);
          preservedPath = null;
        } catch (error) {
          restorationError = error;
        }
      }
      const failure = new Error(
        `PRESERVATION_REPLACE_FAILED: ${publicationError instanceof Error ? publicationError.message : String(publicationError)}`,
      );
      failure.cause = restorationError
        ? new AggregateError([publicationError, restorationError], "Publication and restoration both failed")
        : publicationError;
      throw failure;
    }

    return { targetPath: target, preservedPath };
  }

  return {
    repositoryRoot: resolvedRepositoryRoot,
    aiTempRoot,
    workRoot,
    trashRoot,
    createWorkDirectory,
    preservePath,
    replaceDirectory,
  };
}

module.exports = {
  createPreservationSession,
};
