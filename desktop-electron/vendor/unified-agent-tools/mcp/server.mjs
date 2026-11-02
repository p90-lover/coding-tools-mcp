import childProcess from "node:child_process";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const SERVER_NAME = "unified-agent-tools";
const SERVER_VERSION = "0.5.0";
const MAX_TEXT_BYTES = 20_000_000;
const DEFAULT_MAX_BYTES = 1_000_000;
// Listing is cheap with ripgrep or git; the deadline, not a file count, bounds a slow walk.
const DEFAULT_MAX_FILES = 100_000;
const MAX_FILES_LIMIT = 1_000_000;
const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_MAX_RESULTS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;
// Under the 60 s Codex gives an MCP call: a slow search returns what it found instead of timing out.
const DEFAULT_SEARCH_TIMEOUT_MS = 25_000;
// One result stays well under what clients accept (Claude Code refuses MCP output over 25,000
// tokens); a cut result says how to get the rest.
const DEFAULT_OUTPUT_CHARS = Number.parseInt(process.env.UNIFIED_AGENT_TOOLS_MAX_OUTPUT ?? "", 10) || 40_000;
const MAX_OUTPUT_CHARS = 400_000;
const DEFAULT_READ_LINES = 2_000;
const READ_LINE_CHARS = 2_000;
const MATCH_LINE_CHARS = 300;
const STORED_LINE_CHARS = 1_000;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "Trash",
  "aiTemp",
  ".codex-log",
]);
// A plain directory walk has no .gitignore to go by; these heavy folders are almost never source.
const WALK_IGNORED_DIRECTORIES = new Set([
  ...IGNORED_DIRECTORIES,
  "target", ".venv", "venv", "__pycache__", ".tox", ".gradle", ".idea", ".vs", ".turbo", ".cache",
  ".parcel-cache", ".svelte-kit", ".nuxt", ".output", ".pytest_cache", ".mypy_cache", "bower_components",
]);
// A host that starts one server per project pins it there: workspaceRoot becomes optional and
// any other root is refused ("cwd" pins the directory the server was started in).
const ENV_ROOT = process.env.UNIFIED_AGENT_TOOLS_ROOT?.trim() ?? "";
// "files" offers only the file tools, without aliases, shell, web or desktop capture.
const FILE_PROFILE = new Set([
  "Read", "ReadMany", "ListDirectory", "Glob", "Grep", "SearchAndRead",
  "Edit", "ApplyMultipleEdits", "Write", "MoveToTrash", "ViewImage",
]);
const PROFILE = process.env.UNIFIED_AGENT_TOOLS_PROFILE?.trim().toLowerCase() === "files" ? FILE_PROFILE : null;

const ALIASES = new Map([
  ["ReadFile", "Read"],
  ["SearchFiles", "Glob"],
  ["Codebase", "Grep"],
  ["CodebaseSearch", "Grep"],
  ["ApplyEdit", "Edit"],
  ["Terminal", "Bash"],
]);

const MUTATIONS = new Set(["Edit", "Write", "ApplyMultipleEdits", "MoveToTrash", "DeleteFile"]);
const mutationQueues = new Map();
let activeSearchWorkers = 0;

function requireObject(value, name = "arguments") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function optionalInteger(value, name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

let pinnedRootPromise;
function pinnedRoot() {
  if (!ENV_ROOT) return null;
  pinnedRootPromise ??= (async () => {
    const raw = ENV_ROOT.toLowerCase() === "cwd" ? process.cwd() : ENV_ROOT;
    if (!path.isAbsolute(raw)) throw new Error("UNIFIED_AGENT_TOOLS_ROOT must be absolute or \"cwd\".");
    const resolved = await fs.realpath(path.resolve(raw));
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error("UNIFIED_AGENT_TOOLS_ROOT must be a directory.");
    return resolved;
  })();
  return pinnedRootPromise;
}

async function workspaceRoot(args) {
  const pinned = await pinnedRoot();
  if (pinned && args.workspaceRoot === undefined) return pinned;
  const raw = requireString(args.workspaceRoot, "workspaceRoot");
  if (!path.isAbsolute(raw)) throw new Error("workspaceRoot must be absolute.");
  const resolved = path.resolve(raw);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("workspaceRoot must be a directory.");
  const real = await fs.realpath(resolved);
  if (pinned && !isWithin(pinned, real)) {
    throw new Error(`This server is pinned to ${pinned}; omit workspaceRoot or pass that folder or one inside it.`);
  }
  return real;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveWithin(root, requested = ".") {
  const candidate = path.resolve(root, requested);
  if (!isWithin(root, candidate)) {
    throw new Error(`Path is outside workspaceRoot: ${requested}`);
  }
  if (process.platform === "win32") {
    const segments = path.relative(root, candidate).split(path.sep).filter(Boolean);
    if (segments.some((segment) => /[:\x00-\x1f]|[. ]$/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment))) {
      throw new Error("Invalid Windows path: alternate streams, device names and trailing dots/spaces are not allowed.");
    }
  }
  return candidate;
}

async function resolveRealWithin(root, requested = ".", allowMissing = false, rejectLinks = false) {
  const candidate = resolveWithin(root, requested);
  if (!allowMissing && !rejectLinks) {
    const resolved = await fs.realpath(candidate);
    if (!isWithin(root, resolved)) throw new Error(`Path resolves outside workspaceRoot: ${requested}`);
    return resolved;
  }
  const relative = path.relative(root, candidate);
  const segments = relative ? relative.split(path.sep) : [];
  let current = root;

  for (let index = 0; index < segments.length; index += 1) {
    const next = path.join(current, segments[index]);
    try {
      if (rejectLinks && (await fs.lstat(next)).isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed for this operation: ${requested}`);
      }
      current = await fs.realpath(next);
    } catch (error) {
      if (!allowMissing || error?.code !== "ENOENT") throw error;
      try {
        await fs.lstat(next);
        throw new Error(`Broken symbolic links are not allowed: ${requested}`);
      } catch (lstatError) {
        if (lstatError?.code !== "ENOENT") throw lstatError;
      }
      const unresolved = path.resolve(current, ...segments.slice(index));
      if (!isWithin(root, unresolved)) {
        throw new Error(`Path resolves outside workspaceRoot: ${requested}`);
      }
      return unresolved;
    }
    if (!isWithin(root, current)) {
      throw new Error(`Path resolves outside workspaceRoot: ${requested}`);
    }
  }
  return current;
}

function resolveExistingWithin(root, requested = ".") {
  return resolveRealWithin(root, requested, false);
}

function resolveWriteWithin(root, requested) {
  return resolveRealWithin(root, requested, true);
}

function portableRelative(root, candidate) {
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  return relative || ".";
}

async function readBytes(filePath, maxBytes) {
  if (!(await fs.stat(filePath)).isFile()) throw new Error(`Not a file: ${filePath}`);
  // Nonblocking open also handles a regular file replaced by a FIFO after the check.
  const file = await fs.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
    if (stat.size > maxBytes) throw new Error(`File exceeds maxBytes (${stat.size} > ${maxBytes}): ${filePath}`);
    // Read the opened file, including one extra byte to detect growth, without an unbounded readFile.
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > stat.size) throw new Error(`File grew during the operation; re-read it before retrying: ${filePath}`);
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function readUtf8(filePath, maxBytes = DEFAULT_MAX_BYTES) {
  const buffer = await readBytes(filePath, maxBytes);
  if (buffer.includes(0)) throw new Error(`Binary file is not supported: ${filePath}`);
  return buffer.toString("utf8");
}

/**
 * The lines a read returns: from startLine to endLine (default: DEFAULT_READ_LINES lines), each
 * at most READ_LINE_CHARS, stopping before maxChars. A read cut short names the line to go on from.
 */
function readWindow(lines, startLine, endLine, maxChars, totalLines = lines.length) {
  const total = lines.length;
  const start = optionalInteger(startLine, "startLine", 1, 1, Math.max(total, 1));
  const end = endLine === undefined
    ? Math.min(total, start + DEFAULT_READ_LINES - 1)
    : Math.min(optionalInteger(endLine, "endLine", total, start, Math.max(total, start)), total);
  const kept = [];
  let chars = 0;
  let clippedLines = 0;
  let last = start - 1;
  for (let line = start; line <= end; line++) {
    let text = lines[line - 1];
    if (text.length > READ_LINE_CHARS) {
      text = `${text.slice(0, READ_LINE_CHARS)}… [line clipped at ${READ_LINE_CHARS} of ${text.length} characters]`;
      clippedLines++;
    }
    if (kept.length && chars + text.length + 1 > maxChars) break;
    kept.push(text);
    chars += text.length + 1;
    last = line;
  }
  const more = last < end || (endLine === undefined && last < total) || (totalLines === null && endLine === undefined);
  return {
    startLine: start,
    endLine: Math.max(last, start),
    totalLines,
    text: kept.join("\n"),
    ...(more ? { truncated: true, nextStartLine: last + 1 } : {}),
    ...(clippedLines ? { clippedLines } : {}),
  };
}

/** A read window of a file too large to load whole: lines are streamed and the rest is never read. */
async function streamWindow(filePath, startLine, endLine, maxChars) {
  const start = optionalInteger(startLine, "startLine", 1, 1);
  const end = endLine === undefined ? start + DEFAULT_READ_LINES - 1 : optionalInteger(endLine, "endLine", start, start);
  const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 256 * 1024 });
  const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  let number = 0;
  let chars = 0;
  let ended = true;
  try {
    for await (const line of input) {
      number++;
      if (number === 1 && line.includes("\0")) throw new Error(`Binary file is not supported: ${filePath}`);
      if (number < start) continue;
      if (number > end || chars > maxChars) {
        ended = false;
        break;
      }
      lines.length = number - 1;
      lines[number - 1] = line;
      chars += Math.min(line.length, READ_LINE_CHARS) + 1;
    }
  } finally {
    input.close();
    stream.destroy();
  }
  if (start > number) throw new Error(`startLine must be at most ${number} (the file's line count).`);
  // Lines before startLine are holes; readWindow only visits start..end.
  const window = readWindow(lines, start, Math.min(end, lines.length), maxChars, ended ? number : null);
  if (!ended && endLine === undefined && !window.truncated) Object.assign(window, { truncated: true, nextStartLine: window.endLine + 1 });
  return window;
}

function globRegex(glob) {
  const normalized = requireString(glob, "pattern").split("\\").join("/");
  let source = "^";
  let braces = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    // *.{ts,tsx}: models write brace alternatives as often as single extensions.
    if (character === "{") {
      braces++;
      source += "(?:";
    } else if (character === "}" && braces) {
      braces--;
      source += ")";
    } else if (character === "," && braces) {
      source += "|";
    } else if (character === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  if (braces) throw new Error(`Unbalanced braces in pattern: ${glob}`);
  return new RegExp(`${source}$`, process.platform === "win32" ? "i" : "");
}

/**
 * A filePattern test: with no "/" it names files at any depth (as in ripgrep), else whole paths
 * from the root; a leading "/" anchors it there ("/*.ts": top-level files only), as in .gitignore.
 */
function fileFilter(pattern) {
  if (!pattern) return null;
  const normalized = pattern.split("\\").join("/");
  const regex = globRegex(normalized.startsWith("/") ? normalized.slice(1) : normalized);
  return normalized.includes("/")
    ? (relative) => regex.test(relative)
    : (relative) => regex.test(relative.slice(relative.lastIndexOf("/") + 1));
}

/**
 * Runs a helper (ripgrep, git) and hands each output record to onRecord until it returns false,
 * the helper exits or the deadline passes. The helper's own exit status is reported, not thrown.
 */
function streamRecords(command, args, { cwd, separator = "\n", deadline, onRecord }) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let stopped = false;
    let timedOut = false;
    let stderr = "";
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill();
    };
    const timer = deadline ? setTimeout(() => { timedOut = true; stop(); }, Math.max(0, deadline - Date.now())) : null;
    const take = (text) => {
      const records = (pending + text).split(separator);
      pending = records.pop();
      for (const record of records) {
        if (stopped) return;
        if (record && onRecord(record) === false) stop();
      }
    };
    child.stdout.on("data", (chunk) => { if (!stopped) take(decoder.write(chunk)); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 8_192) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!stopped) take(decoder.end() + separator);
      resolve({ code, stopped, timedOut, stderr });
    });
  });
}

let ripgrepLookup;
/** ripgrep from UNIFIED_AGENT_TOOLS_RG or an absolute PATH entry (Codex puts its own rg there), else null. */
function ripgrep() {
  ripgrepLookup ??= (async () => {
    const configured = process.env.UNIFIED_AGENT_TOOLS_RG?.trim();
    const name = process.platform === "win32" ? "rg.exe" : "rg";
    // Only absolute entries: a relative PATH entry would resolve inside the searched project.
    const candidates = configured
      ? [configured]
      : (process.env.PATH ?? "").split(path.delimiter).filter((entry) => entry && path.isAbsolute(entry)).map((entry) => path.join(entry, name));
    for (const candidate of candidates) {
      try {
        if ((await fs.stat(candidate)).isFile()) return candidate;
      } catch { /* not here */ }
    }
    return null;
  })();
  return ripgrepLookup;
}

/** How this call lists and searches files: "rg", "git" (the root is a repository) or "walk". */
async function searchEngine(root, allowRipgrep = true) {
  const forced = process.env.UNIFIED_AGENT_TOOLS_ENGINE?.trim().toLowerCase();
  if (forced === "walk") return { kind: "walk" };
  if (forced !== "git" && allowRipgrep) {
    const rg = await ripgrep();
    if (rg) return { kind: "rg", rg };
  }
  try {
    await fs.lstat(path.join(root, ".git"));
    return { kind: "git" };
  } catch {
    return { kind: "walk" };
  }
}

const excludedGlobs = () => [...IGNORED_DIRECTORIES].flatMap((name) => ["-g", `!${name}`]);
const helperPath = (record) => record.replace(/^\.[\\/]/, "").split("\\").join("/");

/**
 * Every file under `start` as ripgrep or git lists it, honoring .gitignore, or null when the
 * helper cannot run (the caller walks instead). Bounded by maxFiles and the deadline.
 */
async function helperFileList(root, start, engine, { maxFiles, includeGenerated, deadline }) {
  const relativeStart = portableRelative(root, start);
  const files = [];
  let truncated = false;
  const accept = (relative) => {
    if (!relative) return true;
    if (files.length >= maxFiles) {
      truncated = true;
      return false;
    }
    files.push(path.join(root, ...relative.split("/")));
    return true;
  };
  try {
    if (engine.kind === "rg") {
      const args = ["--files", "--hidden", "--no-messages", "-g", "!.git", ...(includeGenerated ? ["--no-ignore"] : excludedGlobs())];
      const outcome = await streamRecords(engine.rg, [...args, ...(relativeStart === "." ? [] : ["--", relativeStart])], {
        cwd: root, deadline, onRecord: (record) => accept(helperPath(record.trimEnd())),
      });
      if (outcome.timedOut) return { files, truncated: true, reason: "timeout" };
      files.sort();
      return { files, truncated };
    }
    const skip = (relative) => !includeGenerated && relative.split("/").slice(0, -1).some((part) => IGNORED_DIRECTORIES.has(part));
    // fsmonitor would run a command the repository's own config names.
    const git = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "ls-files", "-z"];
    const pathspec = relativeStart === "." ? [] : ["--", relativeStart];
    const seen = new Set();
    for (const mode of [["--cached", "--recurse-submodules"], ["--others", "--exclude-standard"]]) {
      const outcome = await streamRecords("git", [...git, ...mode, ...pathspec], {
        cwd: root, separator: "\0", deadline,
        onRecord: (record) => (seen.has(record) || skip(record) ? true : (seen.add(record), accept(record))),
      });
      if (outcome.code !== 0 && !outcome.stopped) return null;
      if (outcome.timedOut) return { files, truncated: true, reason: "timeout" };
      if (truncated) break;
    }
    files.sort();
    return { files, truncated };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function* listFileBatches(root, start, options = {}) {
  const maxFiles = optionalInteger(options.maxFiles, "maxFiles", DEFAULT_MAX_FILES, 1, MAX_FILES_LIMIT);
  const includeGenerated = options.includeGenerated === true;
  const deadline = options.deadline;
  const startStat = await fs.stat(start);
  if (startStat.isFile()) {
    yield { files: [start], truncated: false };
    return;
  }
  if (!startStat.isDirectory()) throw new Error(`Not a file or directory: ${start}`);
  const engine = options.engine ?? await searchEngine(root);
  // git cannot list what .gitignore ignores; includeGenerated walks instead.
  if (engine.kind === "rg" || (engine.kind === "git" && !includeGenerated)) {
    const listed = await helperFileList(root, start, engine, { maxFiles, includeGenerated, deadline });
    if (listed) {
      for (let index = 0; index < listed.files.length; index += 256) {
        const last = index + 256 >= listed.files.length;
        yield { files: listed.files.slice(index, index + 256), truncated: last && listed.truncated, ...(last && listed.reason ? { reason: listed.reason } : {}) };
      }
      if (!listed.files.length) yield { files: [], truncated: listed.truncated, ...(listed.reason ? { reason: listed.reason } : {}) };
      return;
    }
  }
  yield* walkFileBatches(root, start, maxFiles, includeGenerated, deadline);
}

async function* walkFileBatches(root, start, maxFiles, includeGenerated, deadline) {
  const ignored = WALK_IGNORED_DIRECTORIES;
  let count = 0;
  const queue = [start];
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    if (deadline && Date.now() > deadline) {
      yield { files: [], truncated: true, reason: "timeout" };
      return;
    }
    const directories = queue.slice(queueIndex, queueIndex + 16);
    queueIndex += directories.length;
    const listings = await Promise.allSettled(directories.map(async (directory) => {
      // Recheck containment in case a queued directory was replaced by a link.
      const resolved = await resolveExistingWithin(root, directory);
      if (resolved !== directory) throw new Error("Directory changed during traversal; retry the search.");
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      return entries;
    }));
    let files = [];
    for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex++) {
      const listing = listings[directoryIndex];
      if (listing.status === "rejected") {
        // A later speculative read must not invalidate an earlier requested prefix.
        if (files.length) yield { files, truncated: false };
        throw listing.reason;
      }
      const entries = listing.value;
      for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
        const entry = entries[entryIndex];
        if (!includeGenerated && entry.isDirectory() && ignored.has(entry.name)) continue;
        const absolute = path.join(directories[directoryIndex], entry.name);
        if (entry.isDirectory()) queue.push(absolute);
        else if (entry.isFile()) { files.push(absolute); count++; }
        if (count >= maxFiles) {
          const hasPendingEntry = entries.slice(entryIndex + 1).some((pending) => (
            pending.isFile()
            || (pending.isDirectory() && (includeGenerated || !ignored.has(pending.name)))
          ));
          yield { files, truncated: hasPendingEntry || directoryIndex + 1 < directories.length || queueIndex < queue.length };
          return;
        }
        if (files.length === 16) {
          yield { files, truncated: false };
          files = [];
        }
      }
    }
    if (files.length) yield { files, truncated: false };
  }
}

/** A Grep/SearchAndRead call's options, checked before any I/O. */
function searchOptions(args, includeContext) {
  const pattern = requireString(args.pattern, "pattern");
  const outputMode = args.outputMode ?? "content";
  if (!["content", "files"].includes(outputMode)) throw new Error('outputMode must be "content" or "files".');
  if (args.filePattern !== undefined) globRegex(args.filePattern);
  return {
    pattern,
    regex: args.regex !== false,
    // Smart case: a pattern with a capital letter matches exactly, an all-lowercase one any case.
    caseSensitive: typeof args.caseSensitive === "boolean" ? args.caseSensitive : /\p{Lu}/u.test(pattern),
    maxMatches: optionalInteger(args.maxMatches, "maxMatches", DEFAULT_MAX_MATCHES, 1, 5_000),
    contextLines: includeContext ? optionalInteger(args.contextLines, "contextLines", 2, 0, 20) : 0,
    filePattern: args.filePattern ?? null,
    maxBytesPerFile: optionalInteger(args.maxBytesPerFile, "maxBytesPerFile", 2_000_000, 1, 20_000_000),
    maxFiles: optionalInteger(args.maxFiles, "maxFiles", DEFAULT_MAX_FILES, 1, MAX_FILES_LIMIT),
    includeGenerated: args.includeGenerated === true,
    timeoutMs: optionalInteger(args.timeoutMs, "timeoutMs", DEFAULT_SEARCH_TIMEOUT_MS, 100, 120_000),
    filesOnly: outputMode === "files",
  };
}

const literalSource = (pattern) => pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The JavaScript matcher for a search; an invalid regex is searched literally, with a note saying so. */
function compileMatcher({ pattern, regex, caseSensitive }) {
  const flags = caseSensitive ? "" : "i";
  if (!regex) return { matcher: new RegExp(literalSource(pattern), flags) };
  try {
    return { matcher: new RegExp(pattern, flags) };
  } catch (error) {
    return { matcher: new RegExp(literalSource(pattern), flags), note: `Not a valid regular expression (${error.message}); searched for it literally.` };
  }
}

const clipStart = (length, index, limit) => (length <= limit ? 0 : Math.max(0, Math.min(index - Math.floor(limit / 3), length - limit)));

/** At most `limit` characters of a line, kept around `index` (the match), marked where cut. */
function clipAround(text, index, limit) {
  if (text.length <= limit) return text;
  const start = clipStart(text.length, index, limit);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + limit)}${start + limit < text.length ? "…" : ""}`;
}

/** A match line as a result keeps it: clipped around the match, with where the match now starts. */
function storedLine(text, index) {
  if (text.length <= STORED_LINE_CHARS) return { text };
  const start = clipStart(text.length, index, STORED_LINE_CHARS);
  return { text: clipAround(text, index, STORED_LINE_CHARS), matchOffset: index - start + (start > 0 ? 1 : 0) };
}

const byPathAndLine = (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : left.line - right.line);

/**
 * Search with ripgrep: .gitignore at every level, binary files skipped, out of process so no
 * pattern can block this server. Null when ripgrep cannot take the pattern (the caller scans).
 */
async function ripgrepSearch(rg, root, start, options, pcre2 = false) {
  const relativeStart = portableRelative(root, start);
  const filterFlag = process.platform === "win32" ? "--iglob" : "-g";
  const args = [
    "--hidden", "-g", "!.git", ...(options.includeGenerated ? ["--no-ignore"] : excludedGlobs()),
    "--max-filesize", String(options.maxBytesPerFile), options.caseSensitive ? "-s" : "-i",
    ...(options.regex ? (pcre2 ? ["--pcre2"] : []) : ["-F"]),
    ...(options.filePattern ? [filterFlag, options.filePattern] : []),
    ...(options.filesOnly ? ["--count-matches", "--null"] : ["--json", ...(options.contextLines ? ["-C", String(options.contextLines)] : [])]),
    "-e", options.pattern, ...(relativeStart === "." ? [] : ["--", relativeStart]),
  ];
  const deadline = Date.now() + options.timeoutMs;
  const matches = [];
  const files = [];
  const lines = new Map(); // path -> Map(line -> text), for context
  let skippedFiles = 0;
  let truncated = false;
  let reason = null;
  const decode = (value) => value?.text ?? (value?.bytes ? Buffer.from(value.bytes, "base64").toString("utf8") : "");
  const onRecord = options.filesOnly
    ? (record) => {
      const at = record.lastIndexOf("\0");
      if (at < 0) return true;
      if (files.length >= options.maxMatches) {
        truncated = true;
        reason = "maxMatches";
        return false;
      }
      files.push({ path: helperPath(record.slice(0, at)), count: Number.parseInt(record.slice(at + 1), 10) || 0 });
      return true;
    }
    : (record) => {
      let event;
      try { event = JSON.parse(record); } catch { return true; }
      if (event.type === "end" && event.data?.binary_offset != null) skippedFiles++;
      if (event.type !== "match" && event.type !== "context") return true;
      const relative = helperPath(decode(event.data.path));
      const raw = decode(event.data.lines).replace(/\r?\n$/, "");
      const lineNumber = event.data.line_number;
      if (options.contextLines) {
        if (!lines.has(relative)) lines.set(relative, new Map());
        lines.get(relative).set(lineNumber, clipAround(raw, 0, STORED_LINE_CHARS));
      }
      if (event.type === "context") return true;
      if (matches.length >= options.maxMatches) {
        truncated = true;
        reason = "maxMatches";
        return false;
      }
      const offset = event.data.submatches?.[0]?.start ?? 0;
      const column = Buffer.from(raw, "utf8").subarray(0, offset).toString("utf8").length;
      matches.push({ path: relative, line: lineNumber, column: column + 1, ...storedLine(raw, column) });
      return true;
    };
  const outcome = await streamRecords(rg, args, { cwd: root, deadline, onRecord });
  if (outcome.code === 2 && !matches.length && !files.length && /regex|look-?around|backreference/i.test(outcome.stderr)) {
    // Rust's regex has no look-around or backreferences; PCRE2 has both, else the JavaScript scan.
    if (!pcre2 && /look-?around|backreference/i.test(outcome.stderr)) return ripgrepSearch(rg, root, start, options, true);
    return null;
  }
  if (outcome.timedOut) {
    truncated = true;
    reason = "timeout";
  }
  // Files ripgrep could not read ("rg: <path>: <error>"), such as a reserved Windows name.
  skippedFiles += (outcome.stderr.match(/^rg: /gm) ?? []).length;
  if (options.filesOnly) {
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return { files, truncated, reason, skippedFiles, engine: "ripgrep" };
  }
  matches.sort(byPathAndLine);
  if (options.contextLines) {
    for (const match of matches) {
      const known = lines.get(match.path);
      match.context = [];
      for (let line = Math.max(1, match.line - options.contextLines); line <= match.line + options.contextLines; line++) {
        if (known?.has(line)) match.context.push({ line, text: known.get(line) });
      }
    }
  }
  return { matches, truncated, reason, skippedFiles, engine: "ripgrep" };
}

/** Search by reading the listed files here (git's list or a walk); used without ripgrep. */
async function scanSearch(root, start, options, engine) {
  const { matcher, note } = compileMatcher(options);
  const filter = fileFilter(options.filePattern);
  const deadline = Date.now() + options.timeoutMs;
  const matches = [];
  const files = [];
  let truncated = false;
  let reason = null;
  let skippedFiles = 0;
  const contained = new Map(); // directory -> inside root, for git-listed paths
  // Keep worst-case source bytes in flight within 20 MB even at the largest per-file limit.
  const batchSize = Math.max(1, Math.min(16, Math.floor(MAX_TEXT_BYTES / options.maxBytesPerFile)));
  const readListed = async (filePath) => {
    try {
      if (engine.kind === "git") {
        // A tracked link is not followed, and no tracked path may lead out through a linked folder.
        if ((await fs.lstat(filePath)).isSymbolicLink()) return null;
        const directory = path.dirname(filePath);
        if (!contained.has(directory)) contained.set(directory, fs.realpath(directory).then((real) => isWithin(root, real), () => false));
        if (!(await contained.get(directory))) return null;
      }
      return { filePath, text: await readUtf8(filePath, options.maxBytesPerFile) };
    } catch {
      skippedFiles++;
      return null;
    }
  };
  scan: for await (const listed of listFileBatches(root, start, { ...options, deadline, engine })) {
    if (listed.truncated) {
      truncated = true;
      reason ??= listed.reason ?? "maxFiles";
    }
    const listedFiles = filter ? listed.files.filter((filePath) => filter(portableRelative(root, filePath))) : listed.files;
    for (let batchStart = 0; batchStart < listedFiles.length; batchStart += batchSize) {
      if (Date.now() > deadline) {
        truncated = true;
        reason = "timeout";
        break scan;
      }
      const batch = await Promise.all(listedFiles.slice(batchStart, batchStart + batchSize).map(readListed));
      for (const file of batch) {
        if (!file) continue;
        const relative = portableRelative(root, file.filePath);
        const fileLines = file.text.split(/\r?\n/);
        let count = 0;
        for (let index = 0; index < fileLines.length; index += 1) {
          const match = matcher.exec(fileLines[index]);
          if (!match) continue;
          count++;
          if (options.filesOnly) continue;
          const item = { path: relative, line: index + 1, column: match.index + 1, ...storedLine(fileLines[index], match.index) };
          if (options.contextLines > 0) {
            const startLine = Math.max(0, index - options.contextLines);
            const endLine = Math.min(fileLines.length, index + options.contextLines + 1);
            item.context = fileLines.slice(startLine, endLine).map((line, offset) => ({ line: startLine + offset + 1, text: clipAround(line, 0, STORED_LINE_CHARS) }));
          }
          matches.push(item);
          // Stop at once, as before: an early match must not cost a walk of the rest of the tree.
          if (matches.length >= options.maxMatches) {
            truncated = true;
            reason = "maxMatches";
            break scan;
          }
        }
        if (options.filesOnly && count) {
          files.push({ path: relative, count });
          if (files.length >= options.maxMatches) {
            truncated = true;
            reason = "maxMatches";
            break scan;
          }
        }
      }
    }
  }
  const outcome = { truncated, reason, skippedFiles, engine: engine.kind === "git" ? "git" : "walk", ...(note ? { note } : {}) };
  return options.filesOnly ? { files, ...outcome } : { matches, ...outcome };
}

/** A regex scan in a worker with its own heap: a pathological pattern cannot block this server. */
async function scanInWorker(root, start, options, engine) {
  if (activeSearchWorkers >= 4) throw new Error("Four regex searches are already running; retry after one completes.");
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { scan: true, root, start, options, engine },
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  });
  activeSearchWorkers++;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      // The scan stops itself at its deadline; this catches one line a pattern never finishes.
      timer = setTimeout(() => reject(new Error(`Regex search exceeded timeoutMs (${options.timeoutMs}); simplify the pattern or use regex: false.`)), options.timeoutMs + 1_000);
      worker.once("message", (message) => message.error ? reject(new Error(message.error)) : resolve(message.result));
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Search worker exited before returning a result (${code}).`)));
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
    activeSearchWorkers--;
  }
}

async function grepInternal(args, includeContext) {
  const options = searchOptions(args, includeContext);
  const root = await workspaceRoot(args);
  const start = await resolveExistingWithin(root, args.path ?? ".");
  const started = Date.now();
  let engine = await searchEngine(root);
  let result = engine.kind === "rg" ? await ripgrepSearch(engine.rg, root, start, options) : null;
  if (!result) {
    if (engine.kind === "rg") engine = await searchEngine(root, false);
    result = options.regex && isMainThread
      ? await scanInWorker(root, start, options, engine)
      : await scanSearch(root, start, options, engine);
  }
  return { ...result, elapsedMs: Date.now() - started };
}

function backupTimestamp() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

async function backupFile(root, filePath, batchId = backupTimestamp()) {
  const relative = path.relative(root, filePath);
  const destination = await trashDestination(root, "unified-agent-tools-backups", batchId, relative);
  await fs.copyFile(filePath, destination, fs.constants.COPYFILE_EXCL);
  return destination;
}

async function trashDestination(root, bucket, batchId, relative) {
  const requested = path.join("Trash", bucket, batchId, relative);
  const destination = await resolveRealWithin(root, requested, true, true);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await resolveRealWithin(root, path.dirname(destination), false, true);
  return destination;
}

async function replaceFile(filePath, next, previous, backup) {
  const file = await fs.open(filePath, "r+");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink > 1) throw new Error("Refusing to overwrite a non-regular or hard-linked file.");
    if (stat.size > 20_000_000 || await file.readFile("utf8") !== previous) {
      throw new Error("File changed during the operation; re-read it before retrying.");
    }
    // r+ and positional writes preserve ACLs and named streams; truncate-open does not on Windows.
    const writeContent = async (content) => {
      const buffer = Buffer.from(content, "utf8");
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, offset);
        if (!bytesWritten) throw new Error("File write made no progress.");
        offset += bytesWritten;
      }
      await file.truncate(buffer.length);
    };
    try {
      await writeContent(next);
    } catch (error) {
      try {
        await writeContent(previous);
      } catch {
        throw new Error(`Write and rollback failed. Original backup: ${backup}`, { cause: error });
      }
      throw new Error(`Write failed; original content restored. Backup: ${backup}`, { cause: error });
    }
  } finally {
    await file.close();
  }
}

/** Where `needle` starts in `content`, at most `limit` times. */
function occurrences(content, needle, limit = 11) {
  const found = [];
  for (let at = content.indexOf(needle); at !== -1 && found.length < limit; at = content.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}

const lineAt = (content, index) => content.slice(0, index).split("\n").length;

/** Why oldText missed, as a pointer the model can act on: where the closest text is, and what differs. */
function notFoundHint(content, search) {
  const wanted = search.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!wanted.length) return "";
  const lines = content.split(/\r?\n/);
  const squash = (text) => text.replace(/\s+/g, " ").trim();
  const target = squash(search);
  const starts = [];
  for (let index = 0; index < lines.length && starts.length < 5; index++) if (lines[index].trim() === wanted[0]) starts.push(index);
  for (const index of starts) {
    if (squash(lines.slice(index, index + search.split(/\r?\n/).length).join("\n")) === target) {
      return ` The same text with different whitespace or indentation is at line ${index + 1}; Read it and copy it exactly.`;
    }
  }
  if (starts.length) return ` Its first line is at line ${starts.map((index) => index + 1).join(", ")}, but the lines after it differ; Read from there and copy the current text.`;
  return " Read the file again: it may have changed, or the text was retyped instead of copied.";
}

function replaceText(content, oldText, newText, replaceAll) {
  requireString(oldText, "oldText");
  if (typeof newText !== "string") throw new Error("newText must be a string.");
  let search = oldText;
  // Models send "\n" whatever the file uses: match, and write, the file's own line endings.
  const crlfFile = content.includes("\r\n") && !/(?<!\r)\n/.test(content);
  if (!content.includes(search) && search.includes("\n")) {
    const converted = crlfFile ? search.replace(/\r?\n/g, "\r\n") : search.replace(/\r\n/g, "\n");
    if (content.includes(converted)) search = converted;
  }
  const replacement = crlfFile ? newText.replace(/\r?\n/g, "\r\n") : newText;
  const found = occurrences(content, search);
  if (!found.length) throw new Error(`oldText was not found.${notFoundHint(content, search)}`);
  if (!replaceAll && found.length > 1) {
    const where = found.slice(0, 10).map((index) => lineAt(content, index)).join(", ");
    throw new Error(`oldText matched ${found.length > 10 ? "more than 10" : found.length} times (lines ${where}); include more surrounding lines to make it unique, or set replaceAll.`);
  }
  return replaceAll ? content.replaceAll(search, () => replacement) : content.replace(search, () => replacement);
}

function imageResult(buffer) {
  if (buffer.length > 10_000_000) throw new Error("Image exceeds maxBytes (10000000).");
  let mimeType;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = "image/png";
  else if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) mimeType = "image/jpeg";
  else if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) mimeType = "image/gif";
  else if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") mimeType = "image/webp";
  else throw new Error("Unsupported image: expected PNG, JPEG, GIF or WebP.");
  return { mimeType, bytes: buffer.length, image: { type: "image", mimeType, data: buffer.toString("base64") } };
}

async function viewImageTool(args) {
  const root = await workspaceRoot(args);
  const filePath = await resolveExistingWithin(root, requireString(args.path, "path"));
  const maxBytes = optionalInteger(args.maxBytes, "maxBytes", 10_000_000, 1, 10_000_000);
  const buffer = await readBytes(filePath, maxBytes);
  return { path: portableRelative(root, filePath), ...imageResult(buffer) };
}

async function windowsVisionTool(args, action) {
  const root = await workspaceRoot(args);
  if (process.platform !== "win32") throw new Error(action + " requires Windows and an interactive desktop.");
  const parameters = ["-Action", action];
  if (action === "Screenshot") {
    const maxWidth = optionalInteger(args.maxWidth, "maxWidth", 1600, 64, 4096);
    parameters.push("-MaxWidth", String(maxWidth));
    if (args.windowHandle !== undefined) {
      const handle = requireString(args.windowHandle, "windowHandle");
      if (!/^[1-9]\d{0,18}$/.test(handle) || BigInt(handle) > 9223372036854775807n) {
        throw new Error("windowHandle must be a positive decimal string returned by ListWindows.");
      }
      parameters.push("-WindowHandle", handle);
    }
  }
  // Windows PowerShell's C# compiler writes temporary files; keep them in this workspace.
  const temporaryParent = await resolveRealWithin(root, path.join("aiTemp", "windows-vision"), true, true);
  await fs.mkdir(temporaryParent, { recursive: true });
  await resolveRealWithin(root, temporaryParent, false, true);
  const temporary = await fs.mkdtemp(path.join(temporaryParent, "capture-"));
  try {
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const helper = fileURLToPath(new URL("./windows-vision.ps1", import.meta.url));
    const stdout = await new Promise((resolve, reject) => {
      childProcess.execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helper, ...parameters], {
        cwd: root, shell: false, windowsHide: true, encoding: "utf8", timeout: 30_000, maxBuffer: 14_000_000,
        env: { ...process.env, TEMP: temporary, TMP: temporary },
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      });
    });
    const { data, ...metadata } = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    return action === "Screenshot" ? { ...metadata, ...imageResult(Buffer.from(data, "base64")) } : metadata;
  } finally {
    // This exact randomly named directory was created above, never supplied by the caller.
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

const outputBudget = (args, fallback = DEFAULT_OUTPUT_CHARS) => optionalInteger(args.maxOutputChars, "maxOutputChars", fallback, 1_000, MAX_OUTPUT_CHARS);

async function readTool(args) {
  const root = await workspaceRoot(args);
  const filePath = await resolveExistingWithin(root, requireString(args.path, "path"));
  const maxChars = outputBudget(args);
  // maxBytes, when given, still refuses a larger file; otherwise a large file is read by window.
  const refuseOver = optionalInteger(args.maxBytes, "maxBytes", MAX_TEXT_BYTES, 1, MAX_TEXT_BYTES);
  const size = (await fs.stat(filePath)).size;
  const window = args.maxBytes === undefined && size > MAX_TEXT_BYTES
    ? await streamWindow(filePath, args.startLine, args.endLine, maxChars)
    : readWindow((await readUtf8(filePath, refuseOver)).split(/\r?\n/), args.startLine, args.endLine, maxChars);
  return { path: portableRelative(root, filePath), ...window };
}

async function readManyTool(args) {
  const root = await workspaceRoot(args);
  if (!Array.isArray(args.paths) || args.paths.length === 0 || args.paths.length > 50) {
    throw new Error("paths must contain 1 to 50 file paths.");
  }
  const maxBytes = optionalInteger(args.maxBytesPerFile, "maxBytesPerFile", DEFAULT_MAX_BYTES, 1, 20_000_000);
  const maxTotalBytes = optionalInteger(args.maxTotalBytes, "maxTotalBytes", MAX_TEXT_BYTES, 1, MAX_TEXT_BYTES);
  const planned = await Promise.all(args.paths.map(async (requested) => {
    try {
      const filePath = await resolveExistingWithin(root, requireString(requested, "paths[]"));
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error(`Not a file: ${requested}`);
      if (stat.size > maxBytes) throw new Error(`File exceeds maxBytesPerFile (${maxBytes}): ${requested}`);
      return { requested, filePath, size: stat.size };
    } catch (error) { return { requested, error }; }
  }));
  let total = 0;
  for (const item of planned) {
    if (!item.error && total + item.size > maxTotalBytes) item.error = new Error(`ReadMany exceeds maxTotalBytes (${maxTotalBytes}): ${item.requested}`);
    if (item.error && args.continueOnError !== true) throw item.error;
    if (!item.error) total += item.size;
  }
  const files = [];
  const errors = [];
  // One output budget across the batch, spent in input order; later files say they were left out.
  let remaining = outputBudget(args, DEFAULT_OUTPUT_CHARS * 2);
  for (let start = 0; start < planned.length; start += 16) {
    const batch = await Promise.all(planned.slice(start, start + 16).map(async (item) => {
      try {
        if (item.error) throw item.error;
        return { item, lines: (await readUtf8(item.filePath, item.size)).split(/\r?\n/) };
      } catch (error) { return { error, requested: item.requested }; }
    }));
    for (const read of batch) {
      if (read.error) {
        if (args.continueOnError !== true) throw read.error;
        errors.push({ path: read.requested, error: read.error.message });
        continue;
      }
      const relative = portableRelative(root, read.item.filePath);
      if (remaining < 200) {
        files.push({ path: relative, startLine: 1, endLine: 0, totalLines: read.lines.length, text: "", truncated: true, nextStartLine: 1, omitted: true });
        continue;
      }
      const window = readWindow(read.lines, 1, undefined, remaining);
      remaining -= window.text.length + 1;
      files.push({ path: relative, ...window });
    }
  }
  return args.continueOnError === true ? { files, errors } : { files };
}

async function listDirectoryTool(args) {
  const root = await workspaceRoot(args);
  const directory = await resolveExistingWithin(root, args.path ?? ".");
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return {
    path: portableRelative(root, directory),
    total: entries.length,
    entries: entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, optionalInteger(args.maxEntries, "maxEntries", DEFAULT_MAX_RESULTS, 1, 100_000))
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      })),
  };
}

async function globTool(args) {
  const root = await workspaceRoot(args);
  const start = await resolveExistingWithin(root, args.path ?? ".");
  const matcher = fileFilter(requireString(args.pattern, "pattern"));
  const maxResults = optionalInteger(args.maxResults, "maxResults", DEFAULT_MAX_RESULTS, 1, 100_000);
  const deadline = Date.now() + optionalInteger(args.timeoutMs, "timeoutMs", DEFAULT_SEARCH_TIMEOUT_MS, 100, 120_000);
  const paths = [];
  let total = 0;
  let truncated = false;
  let reason = null;
  for await (const listed of listFileBatches(root, start, { ...args, deadline })) {
    for (const filePath of listed.files) {
      const relative = portableRelative(root, filePath);
      if (!matcher(relative)) continue;
      // Past maxResults the matches are still counted, so the model knows how many it did not see.
      total++;
      if (paths.length < maxResults) paths.push(relative);
    }
    if (listed.truncated) {
      truncated = true;
      reason ??= listed.reason ?? "maxFiles";
    }
  }
  if (total > paths.length) {
    truncated = true;
    reason ??= "maxResults";
  }
  return { paths, total, truncated, ...(reason ? { reason } : {}) };
}

async function editTool(args, root) {
  const filePath = await resolveExistingWithin(root, requireString(args.path, "path"));
  const content = await readUtf8(filePath, 20_000_000);
  const next = replaceText(content, args.oldText, args.newText, args.replaceAll === true);
  if (Buffer.byteLength(next) > MAX_TEXT_BYTES) throw new Error("Replacement exceeds the 20 MB text limit.");
  if (next === content) return { path: portableRelative(root, filePath), backup: null, unchanged: true };
  const backup = await backupFile(root, filePath);
  await replaceFile(filePath, next, content, backup);
  return { path: portableRelative(root, filePath), backup: portableRelative(root, backup) };
}

async function writeTool(args, root) {
  const filePath = await resolveWriteWithin(root, requireString(args.path, "path"));
  if (typeof args.content !== "string") throw new Error("content must be a string.");
  if (Buffer.byteLength(args.content) > MAX_TEXT_BYTES) throw new Error("Content exceeds the 20 MB text limit.");
  let backup = null;
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (stat) {
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
    if (args.overwrite !== true) throw new Error("File exists; set overwrite to true to replace it with a recoverable backup.");
    const previous = await readUtf8(filePath, 20_000_000);
    if (args.content === previous) return { path: portableRelative(root, filePath), backup: null, unchanged: true };
    backup = await backupFile(root, filePath);
    await replaceFile(filePath, args.content, previous, backup);
  } else {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, args.content, { encoding: "utf8", flag: "wx" });
  }
  return {
    path: portableRelative(root, filePath),
    backup: backup ? portableRelative(root, backup) : null,
  };
}

async function applyMultipleEditsTool(args, root) {
  if (!Array.isArray(args.edits) || args.edits.length === 0 || args.edits.length > 50) {
    throw new Error("edits must contain 1 to 50 exact replacements.");
  }
  const pending = new Map();
  const originals = new Map();
  let totalBytes = 0;
  for (const edit of args.edits) {
    requireObject(edit, "edits[]");
    const filePath = await resolveExistingWithin(root, requireString(edit.path, "edits[].path"));
    const current = pending.has(filePath)
      ? pending.get(filePath)
      : await readUtf8(filePath, 20_000_000);
    if (!originals.has(filePath)) {
      originals.set(filePath, current);
      totalBytes += Buffer.byteLength(current);
    } else totalBytes -= Buffer.byteLength(current);
    const next = replaceText(current, edit.oldText, edit.newText, edit.replaceAll === true);
    totalBytes += Buffer.byteLength(next);
    if (totalBytes > MAX_TEXT_BYTES) throw new Error("Batch originals and replacements exceed the 20 MB text limit.");
    pending.set(filePath, next);
  }
  if (args.dryRun === true) return {
    dryRun: true,
    changed: [...pending].filter(([filePath, content]) => content !== originals.get(filePath))
      .map(([filePath]) => ({ path: portableRelative(root, filePath), backup: null })),
  };
  const batchId = backupTimestamp();
  const changed = [];
  const backups = new Map();
  for (const [filePath, content] of pending) {
    if (content !== originals.get(filePath)) backups.set(filePath, await backupFile(root, filePath, batchId));
  }
  const applied = [];
  try {
    for (const [filePath, content] of pending) {
      if (!backups.has(filePath)) continue;
      const backup = backups.get(filePath);
      await replaceFile(filePath, content, originals.get(filePath), backup);
      applied.push(filePath);
      changed.push({ path: portableRelative(root, filePath), backup: portableRelative(root, backup) });
    }
  } catch (cause) {
    const rollbackErrors = new Map();
    for (const filePath of applied.reverse()) {
      try { await replaceFile(filePath, originals.get(filePath), pending.get(filePath), backups.get(filePath)); }
      catch (error) { rollbackErrors.set(filePath, error.message); }
    }
    const recovery = [...backups].map(([filePath, backup]) => ({
      path: portableRelative(root, filePath), backup: portableRelative(root, backup),
      ...(rollbackErrors.has(filePath) ? { rollbackError: rollbackErrors.get(filePath) } : {}),
    }));
    const error = new Error(`Batch edit failed: ${cause.message}. ${rollbackErrors.size ? "Some earlier changes could not be restored; inspect recovery backups." : "Earlier completed changes were restored."} Backups: ${JSON.stringify(recovery)}`, { cause });
    error.recovery = recovery;
    throw error;
  }
  return { changed };
}

async function moveToTrashTool(args, root, fileOnly = false) {
  const target = await resolveRealWithin(root, requireString(args.path, "path"), false, true);
  if (target === root) throw new Error("workspaceRoot itself cannot be moved.");
  const relative = path.relative(root, target);
  if (relative.split(path.sep).some((part) => [".git", "trash"].includes(part.toLowerCase()))) {
    throw new Error("Protected path: Git metadata and Trash cannot be moved by cleanup tools.");
  }
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    if (fileOnly) throw new Error("DeleteFile accepts files only; use MoveToTrash for an intentional directory move.");
    if (args.recursive !== true) throw new Error("Directory moves require recursive: true and the exact directory path.");
    try {
      await fs.lstat(path.join(target, ".git"));
      throw new Error("Protected path: a repository directory cannot be moved by cleanup tools.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } else if (!stat.isFile()) {
    throw new Error("Only regular files and directories can be moved.");
  }
  const destination = await trashDestination(root, "unified-agent-tools-moved", backupTimestamp(), relative);
  await fs.rename(target, destination);
  return { from: portableRelative(root, target), to: portableRelative(root, destination) };
}

const BLOCKED_COMMANDS = [
  /\b(?:remove-item|del|erase|rmdir|rm)\b/i,
  /\bgit\s+(?:reset\s+--hard|clean\b)/i,
  /\b(?:format|diskpart|mkfs|clear-recyclebin|stop-computer|shutdown)\b/i,
  /\bdd\s+[^\r\n]*\bof=/i,
];

function assertCommandSafe(command) {
  if (BLOCKED_COMMANDS.some((pattern) => pattern.test(command))) {
    throw new Error("Unified Agent Tools blocked this command because it may perform permanent deletion or destructive system changes. Use MoveToTrash for cleanup.");
  }
}

async function bashTool(args) {
  const root = await workspaceRoot(args);
  const command = requireString(args.command, "command");
  if (process.platform !== "win32") assertCommandSafe(command);
  const cwd = await resolveExistingWithin(root, args.cwd ?? ".");
  const timeoutMs = optionalInteger(args.timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS, 1_000, 900_000);
  const maxOutputBytes = optionalInteger(args.maxOutputBytes, "maxOutputBytes", 30_000, 1_000, 2_000_000);
  const executable = process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "/bin/bash";
  const commandArgs = process.platform === "win32"
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./command-guard.ps1", import.meta.url))]
    : ["-lc", command];

  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(executable, commandArgs, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    if (process.platform === "win32") child.stdin.end(command, "utf8");
    else child.stdin.end();
    child.stdin.on("error", () => {});
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    const append = (chunks, chunk) => {
      const available = maxOutputBytes - capturedBytes;
      if (chunk.length > available) outputTruncated = true;
      const kept = chunk.subarray(0, available);
      capturedBytes += kept.length;
      if (kept.length) chunks.push(kept);
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.on("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      // Decode after joining chunks so split UTF-8 characters are not corrupted.
      const decode = (chunks) => {
        const decoder = new StringDecoder("utf8");
        const text = decoder.write(Buffer.concat(chunks));
        return outputTruncated ? text : text + decoder.end();
      };
      resolve({ exitCode, stdout: decode(stdout), stderr: decode(stderr), timedOut, outputTruncated });
    });
  });
}

async function webFetchTool(args) {
  const rawUrl = requireString(args.url, "url");
  const url = new URL(rawUrl);
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("WebFetch supports only http and https URLs.");
  }
  const timeoutMs = optionalInteger(args.timeoutMs, "timeoutMs", 30_000, 1_000, 120_000);
  const maxBytes = optionalInteger(args.maxBytes, "maxBytes", DEFAULT_MAX_BYTES, 1_000, 5_000_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": `unified-agent-tools/${SERVER_VERSION}` },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const chunks = [];
    let total = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error(`Response exceeds maxBytes (${maxBytes}).`);
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks, total).toString("utf8");
    return {
      url: response.url,
      status: response.status,
      contentType: response.headers.get("content-type"),
      body,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Validate the schema subset used by our tools, including aliases, before doing any I/O.
function validateArguments(value, schema, label = "arguments") {
  if (schema.type === "object") {
    requireObject(value, label);
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required.`);
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unknown argument: ${label}.${key}`);
      validateArguments(value[key], schema.properties[key], `${label}.${key}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) {
      throw new Error(`${label} must contain ${schema.minItems ?? 0} to ${schema.maxItems ?? "unlimited"} items.`);
    }
    value.forEach((item, index) => validateArguments(item, schema.items, `${label}[${index}]`));
  } else if (schema.type === "integer") {
    optionalInteger(value, label, undefined, schema.minimum ?? Number.MIN_SAFE_INTEGER, schema.maximum ?? Number.MAX_SAFE_INTEGER);
    if (value === undefined) throw new Error(`${label} must be an integer.`);
  } else if (typeof value !== schema.type) throw new Error(`${label} must be a ${schema.type}.`);
}

export async function callTool(requestedName, rawArgs = {}) {
  const definition = toolDefinitions().find((item) => item.name === requestedName);
  if (!definition) throw new Error(`Unknown tool: ${requestedName}`);
  validateArguments(rawArgs, definition.inputSchema);
  const args = requireObject(rawArgs);
  const name = ALIASES.get(requestedName) ?? requestedName;
  let release;
  let queueKey;
  let turn;
  let root;
  if (MUTATIONS.has(name)) {
    root = await workspaceRoot(args);
    queueKey = process.platform === "win32" ? root.toLowerCase() : root;
    const previous = mutationQueues.get(queueKey);
    turn = new Promise((resolve) => { release = resolve; });
    mutationQueues.set(queueKey, turn);
    // ponytail: serialize mutations per workspace in this process; reads stay parallel.
    await previous;
  }
  try {
  switch (name) {
    case "Read": return readTool(args);
    case "ViewImage": return viewImageTool(args);
    case "ListWindows": return windowsVisionTool(args, "ListWindows");
    case "Screenshot": return windowsVisionTool(args, "Screenshot");
    case "ReadMany": return readManyTool(args);
    case "ListDirectory": return listDirectoryTool(args);
    case "Glob": return globTool(args);
    case "Grep": return grepInternal(args, false);
    case "SearchAndRead": return grepInternal(args, true);
    case "Edit": return await editTool(args, root);
    case "Write": return await writeTool(args, root);
    case "ApplyMultipleEdits": return await applyMultipleEditsTool(args, root);
    case "MoveToTrash": return await moveToTrashTool(args, root);
    case "DeleteFile": return await moveToTrashTool(args, root, true);
    case "Bash": return bashTool(args);
    case "WebFetch": return webFetchTool(args);
    default: throw new Error(`Unknown tool: ${requestedName}`);
  }
  } finally {
    if (release) {
      release();
      if (mutationQueues.get(queueKey) === turn) mutationQueues.delete(queueKey);
    }
  }
}

const rootProperty = () => ({
  workspaceRoot: {
    type: "string",
    description: ENV_ROOT
      ? "Optional: this server is pinned to the active project, which is the default. A folder inside it narrows the root."
      : "Absolute root of the active project. Every filesystem path is constrained to this root.",
  },
});

function tool(name, description, properties, required = []) {
  const readOnly = !MUTATIONS.has(name) && name !== "Bash";
  return {
    name,
    description,
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: ["Bash", "ListWindows", "Screenshot"].includes(name) },
    inputSchema: {
      type: "object",
      properties: { ...rootProperty(), ...properties },
      required: [...(ENV_ROOT ? [] : ["workspaceRoot"]), ...required],
      additionalProperties: false,
    },
  };
}

const outputProperty = {
  maxOutputChars: { type: "integer", minimum: 1000, maximum: MAX_OUTPUT_CHARS, description: `Most characters this call returns, default ${DEFAULT_OUTPUT_CHARS}. A cut result says how to get the rest.` },
};
const searchProperties = {
  pattern: { type: "string", description: "Regular expression (JavaScript/Rust syntax), or literal text with regex: false. An invalid regex is searched literally." },
  path: { type: "string", description: "File or folder to search, relative to the workspace root (default: all of it)." },
  filePattern: { type: "string", description: "Only files matching this glob, e.g. \"*.ts\", \"*.{ts,tsx}\" (any depth) or \"src/**/*.rs\"." },
  regex: { type: "boolean", description: "false searches the pattern as literal text (fastest)." },
  caseSensitive: { type: "boolean", description: "Default: case-sensitive only when the pattern has a capital letter." },
  outputMode: { type: "string", enum: ["content", "files"], description: "\"content\" (default): matching lines. \"files\": each matching file with its match count, for broad terms." },
  maxMatches: { type: "integer", minimum: 1, maximum: 5000, description: `Matching lines (or files) to return, default ${DEFAULT_MAX_MATCHES}.` },
  maxFiles: { type: "integer", minimum: 1, maximum: MAX_FILES_LIMIT, description: "Most files to consider without ripgrep." },
  includeGenerated: { type: "boolean", description: "Also search .gitignore'd and generated folders (node_modules, build output, aiTemp, Trash)." },
  maxBytesPerFile: { type: "integer", minimum: 1, maximum: 20000000, description: "Skip larger files, default 2 MB." },
  timeoutMs: { type: "integer", minimum: 100, maximum: 120000, description: `Search deadline, default ${DEFAULT_SEARCH_TIMEOUT_MS} ms; a slower search returns its partial results.` },
  ...outputProperty,
};
const SEARCH_GUIDE = "Faster and more complete than shell grep/rg/findstr/Select-String: honors .gitignore at every level, "
  + "skips binary and generated files, and returns compact path:line results that fit the context. "
  + "Results say whether the search was complete; a partial one says how to narrow it.";

export function toolDefinitions() {
  const read = tool("Read", "Read a text file or a line range. Use it instead of cat, type, Get-Content or sed to read files: "
    + `returns up to ${DEFAULT_READ_LINES} lines per call (any file size), and a longer file says which startLine continues.`, {
    path: { type: "string" },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    maxBytes: { type: "integer", minimum: 1, maximum: 20000000, description: "Refuse files larger than this. Without it any size can be read by line range." },
    ...outputProperty,
  }, ["path"]);
  const glob = tool("Glob", "Find files by name pattern, e.g. \"*.rs\" (any depth), \"src/**/*.{ts,tsx}\" or \"**/package.json\". "
    + "Use it instead of dir, ls, find or Get-ChildItem -Recurse: honors .gitignore, skips generated folders, and reports the total.", {
    pattern: { type: "string" },
    path: { type: "string" },
    maxResults: { type: "integer", minimum: 1, maximum: 100000, description: `Paths to return, default ${DEFAULT_MAX_RESULTS}; all matches are still counted.` },
    maxFiles: { type: "integer", minimum: 1, maximum: MAX_FILES_LIMIT },
    includeGenerated: { type: "boolean" },
    timeoutMs: { type: "integer", minimum: 100, maximum: 120000 },
    ...outputProperty,
  }, ["pattern"]);
  const grep = tool("Grep", `Search file contents for a regex or literal text. ${SEARCH_GUIDE}`, searchProperties, ["pattern"]);
  const edit = tool("Edit", "Replace exact text in a file, copying the original to Trash first. Copy oldText from a Read; line endings "
    + "follow the file. A miss or an ambiguous match says which lines to re-read.", {
    path: { type: "string" },
    oldText: { type: "string" },
    newText: { type: "string" },
    replaceAll: { type: "boolean" },
  }, ["path", "oldText", "newText"]);
  const bash = tool("Bash", "Run a bounded shell command inside the workspace; permanent deletion and destructive system commands are blocked.", {
    command: { type: "string" },
    cwd: { type: "string" },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 900000 },
    maxOutputBytes: { type: "integer", minimum: 1000, maximum: 2000000, description: "Combined stdout and stderr kept, default 30000 bytes." },
  }, ["command"]);
  const moveToTrash = tool("MoveToTrash", "Move an exact path to recoverable Trash. Directories require recursive: true; Git metadata, Trash and symbolic links are protected.", {
    path: { type: "string" },
    recursive: { type: "boolean" },
  }, ["path"]);

  const definitions = [
    tool("ViewImage", "Return a local PNG, JPEG, GIF or WebP as image content for model vision. Paths stay inside workspaceRoot.", {
      path: { type: "string" },
      maxBytes: { type: "integer", minimum: 1, maximum: 10000000 },
    }, ["path"]),
    tool("ListWindows", "Windows: list visible titled desktop windows with decimal handles, process IDs, bounds and minimized state. Does not focus or control windows.", {}),
    tool("Screenshot", "Windows: return an image of the current desktop, or its visible window region. Occlusions remain visible; no focus or input is changed.", {
      windowHandle: { type: "string", pattern: "^[1-9][0-9]{0,18}$", description: "Optional decimal handle from ListWindows; omit for the full virtual desktop." },
      maxWidth: { type: "integer", minimum: 64, maximum: 4096, description: "Maximum image width, default 1600. Aspect ratio is preserved; output is also limited to 6 million pixels." },
    }),
    read,
    { ...read, name: "ReadFile", description: "Cursor-style alias of Read." },
    tool("ReadMany", "Read up to 50 text files in one call (in parallel, in order), sharing one output budget. "
      + "Use it instead of several Reads or cat a b c. Optionally report per-file errors while returning successful reads.", {
      paths: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
      maxBytesPerFile: { type: "integer", minimum: 1, maximum: 20000000 },
      maxTotalBytes: { type: "integer", minimum: 1, maximum: 20000000 },
      continueOnError: { type: "boolean" },
      ...outputProperty,
    }, ["paths"]),
    tool("ListDirectory", "List one directory inside the workspace (folders end with /).", {
      path: { type: "string" },
      maxEntries: { type: "integer", minimum: 1, maximum: 100000 },
    }),
    glob,
    { ...glob, name: "SearchFiles", description: "Cursor-style alias of Glob." },
    grep,
    { ...grep, name: "Codebase", description: "Cursor-style lexical Codebase alias of Grep; this is not a proprietary semantic index." },
    { ...grep, name: "CodebaseSearch", description: "Cursor-style lexical codebase-search alias of Grep; this is not a proprietary semantic index." },
    tool("SearchAndRead", `Search file contents and return each match with nearby lines in one call (grep -C). ${SEARCH_GUIDE}`, {
      ...searchProperties,
      contextLines: { type: "integer", minimum: 0, maximum: 20, description: "Lines before and after each match, default 2." },
    }, ["pattern"]),
    edit,
    { ...edit, name: "ApplyEdit", description: "Cursor-style alias of Edit." },
    tool("Write", "Create a UTF-8 file or overwrite one only after making a Trash backup.", {
      path: { type: "string" },
      content: { type: "string" },
      overwrite: { type: "boolean" },
    }, ["path", "content"]),
    tool("ApplyMultipleEdits", "Preview or apply up to 50 exact replacements across files in one call, within a 20 MB combined text budget. "
      + "Back up every changed file and attempt rollback on failure.", {
      dryRun: { type: "boolean" },
      edits: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            oldText: { type: "string" },
            newText: { type: "string" },
            replaceAll: { type: "boolean" },
          },
          required: ["path", "oldText", "newText"],
          additionalProperties: false,
        },
      },
    }, ["edits"]),
    moveToTrash,
    tool("DeleteFile", "Move one regular file to recoverable Trash. Refuses directories, links, Git metadata and Trash paths.", { path: { type: "string" } }, ["path"]),
    bash,
    { ...bash, name: "Terminal", description: "Cursor-style alias of Bash." },
    {
      name: "WebFetch",
      description: "Fetch an HTTP or HTTPS URL with byte and timeout limits.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
          maxBytes: { type: "integer", minimum: 1000, maximum: 5000000 },
          ...outputProperty,
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  ];
  return PROFILE ? definitions.filter((definition) => PROFILE.has(definition.name)) : definitions;
}

function rpcResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// What a model reads. Read and search results are plain text, as a shell would print them: a
// JSON copy of each line (and a second copy as structuredContent, which Codex shows instead) cost
// two to three times the tokens and was cut by clients' output limits mid-way.
const count = (value, one, many = `${one}s`) => `${value} ${value === 1 ? one : many}`;

/** `lines` joined while they fit `budget` characters; the rest is replaced by one line saying so. */
function withinBudget(lines, budget, what = "lines", limit = budget) {
  const kept = [];
  let used = 0;
  for (let index = 0; index < lines.length; index++) {
    if (kept.length && used + lines[index].length + 1 > budget) {
      kept.push(`… ${count(lines.length - index, "more line")} of ${what} not shown (maxOutputChars ${limit}). Narrow the request or raise maxOutputChars.`);
      break;
    }
    kept.push(lines[index]);
    used += lines[index].length + 1;
  }
  return kept.join("\n");
}

/** Why a search or listing stopped early, as the step that gets the rest. */
function partialNote(result, args) {
  switch (result.reason) {
    case "timeout": return `Stopped at the ${args.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS} ms deadline, so results are partial: narrow path or filePattern, or raise timeoutMs.`;
    case "maxMatches": return `Stopped at maxMatches (${args.maxMatches ?? DEFAULT_MAX_MATCHES}); more may exist: narrow pattern, path or filePattern, use outputMode "files", or raise maxMatches.`;
    case "maxFiles": return "Stopped at maxFiles, so not every file was searched: narrow path or raise maxFiles.";
    case "maxResults": return `Showing the first ${result.paths?.length ?? 0}: narrow pattern or path, or raise maxResults.`;
    default: return result.truncated ? "Results are partial." : "";
  }
}

function searchHeader(result, found) {
  const how = [result.engine, `${result.elapsedMs ?? 0} ms`].filter(Boolean).join(", ");
  return `${found} (${result.truncated ? "partial" : "search complete"}; ${how}).`;
}

function renderSearch(result, args) {
  const notes = [result.note, partialNote(result, args),
    result.skippedFiles ? `${count(result.skippedFiles, "file")} skipped (binary, too large or unreadable).` : ""].filter(Boolean);
  const budget = outputBudget(args);
  if (result.files) {
    const total = result.files.reduce((sum, file) => sum + file.count, 0);
    const header = result.files.length ? searchHeader(result, `${count(total, "match", "matches")} in ${count(result.files.length, "file")}`) : searchHeader(result, "No matches");
    return [header, ...notes, withinBudget(result.files.map((file) => `${file.path} (${file.count})`), budget, "files")].filter(Boolean).join("\n");
  }
  const byFile = new Map();
  for (const match of result.matches) {
    if (!byFile.has(match.path)) byFile.set(match.path, []);
    byFile.get(match.path).push(match);
  }
  const header = result.matches.length
    ? searchHeader(result, `${count(result.matches.length, "match", "matches")} in ${count(byFile.size, "file")}`)
    : searchHeader(result, "No matches");
  const lines = [];
  for (const [file, matches] of byFile) {
    lines.push(file);
    if (!matches.some((match) => match.context)) {
      for (const match of matches) lines.push(`${match.line}:${clipAround(match.text, match.matchOffset ?? match.column - 1, MATCH_LINE_CHARS)}`);
      continue;
    }
    // grep -C: a match line is "N:", a context line "N-", and "--" separates groups that do not touch.
    const shown = new Map();
    for (const match of matches) {
      for (const context of match.context) if (!shown.has(context.line)) shown.set(context.line, { text: context.text, at: 0 });
      shown.set(match.line, { text: match.text, hit: true, at: match.matchOffset ?? match.column - 1 });
    }
    let previous = null;
    for (const line of [...shown.keys()].sort((left, right) => left - right)) {
      if (previous !== null && line > previous + 1) lines.push("--");
      const entry = shown.get(line);
      lines.push(`${line}${entry.hit ? ":" : "-"}${clipAround(entry.text, entry.at, MATCH_LINE_CHARS)}`);
      previous = line;
    }
  }
  const used = [header, ...notes].join("\n").length;
  return [header, ...notes, withinBudget(lines, budget - used, "results", budget)].filter(Boolean).join("\n");
}

function renderGlob(result, args) {
  const header = `${count(result.total ?? result.paths.length, "file")} match "${args.pattern}" (${result.truncated ? "partial" : "complete"}).`;
  return [header, partialNote(result, args), withinBudget(result.paths, outputBudget(args), "paths")].filter(Boolean).join("\n");
}

/** Where a read window stopped, and the call that continues it. */
function readFooter(window) {
  const notes = [];
  const of = window.totalLines === null ? "" : ` of ${window.totalLines}`;
  if (window.truncated) notes.push(`Showing lines ${window.startLine}-${window.endLine}${of}; continue with startLine ${window.nextStartLine}.`);
  if (window.clippedLines) notes.push(`${count(window.clippedLines, "long line")} clipped to ${READ_LINE_CHARS} characters.`);
  return notes.length ? `\n\n[${notes.join(" ")}]` : "";
}

function renderRead(result) {
  return (result.text || (result.totalLines <= 1 ? "(empty file)" : "")) + readFooter(result);
}

function renderReadMany(result) {
  const parts = result.files.map((file) => {
    if (file.omitted) return `==> ${file.path} <==\n(not shown: the output budget was used by earlier files; Read it separately)`;
    const range = file.truncated ? ` (lines ${file.startLine}-${file.endLine} of ${file.totalLines}; continue with Read startLine ${file.nextStartLine})` : "";
    return `==> ${file.path}${range} <==\n${file.text}`;
  });
  for (const error of result.errors ?? []) parts.push(`==> ${error.path} <==\nERROR: ${error.error}`);
  return parts.join("\n\n");
}

function renderListDirectory(result, args) {
  const names = result.entries.map((entry) => (entry.type === "directory" ? `${entry.name}/` : entry.type === "file" ? entry.name : `${entry.name} (other)`));
  const header = `${result.path === "." ? "./" : `${result.path}/`} (${count(result.total, "entry", "entries")}${result.total > names.length ? `, first ${names.length} shown; raise maxEntries for more` : ""})`;
  return [header, withinBudget(names, outputBudget(args), "entries")].join("\n");
}

function renderBash(result, args) {
  const status = [`Exit code ${result.exitCode}`, result.timedOut ? "timed out" : "", result.outputTruncated ? "output truncated at maxOutputBytes" : ""].filter(Boolean).join("; ");
  const budget = outputBudget(args);
  return [status, result.stdout ? `--- stdout\n${withinBudget(result.stdout.split("\n"), budget, "stdout")}` : "",
    result.stderr ? `--- stderr\n${withinBudget(result.stderr.split("\n"), budget, "stderr")}` : ""].filter(Boolean).join("\n");
}

function renderWebFetch(result, args) {
  const budget = outputBudget(args);
  const body = result.body.length > budget ? `${result.body.slice(0, budget)}\n… ${result.body.length - budget} more characters not shown (maxOutputChars ${budget}).` : result.body;
  return `HTTP ${result.status} ${result.contentType ?? ""} ${result.url}\n\n${body}`;
}

const RENDERERS = new Map([
  ["Read", renderRead], ["ReadMany", renderReadMany], ["ListDirectory", renderListDirectory], ["Glob", renderGlob],
  ["Grep", renderSearch], ["SearchAndRead", renderSearch], ["Bash", renderBash], ["WebFetch", renderWebFetch],
]);

export function toolResult(requestedName, data, args = {}) {
  const render = RENDERERS.get(ALIASES.get(requestedName) ?? requestedName);
  if (render) return { content: [{ type: "text", text: render(data, args) }] };
  const { image, ...metadata } = data;
  return {
    content: [{ type: "text", text: JSON.stringify(metadata) }, ...(image ? [image] : [])],
    structuredContent: metadata,
  };
}

function toolFailure(error) {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
    ...(error.recovery ? { structuredContent: { recovery: error.recovery } } : {}),
  };
}

export async function handleRpc(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, -32600, "Invalid Request");
  }
  const { id, method } = message;
  const validId = typeof id === "string" || Number.isSafeInteger(id);
  if (message.jsonrpc !== "2.0" || typeof method !== "string" || (id !== undefined && !validId)) {
    return rpcError(validId ? id : null, -32600, "Invalid Request");
  }
  // Unknown notifications are ignored; tools/call always requires a request ID.
  if (id === undefined) return null;
  if (message.params !== undefined && (!message.params || typeof message.params !== "object" || Array.isArray(message.params))) {
    return rpcError(id, -32602, "params must be an object.");
  }
  if (method === "initialize") {
    return rpcResponse(id, {
      protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(message.params?.protocolVersion)
        ? message.params.protocolVersion : "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: SERVER_NAME,
        title: "Unified Agent Tools",
        version: SERVER_VERSION,
      },
      instructions: ENV_ROOT
        // A host that pins the server to its project wants these used for every file operation there.
        ? `Use these tools for every file read, search, listing and edit in this project (${ENV_ROOT.toLowerCase() === "cwd" ? process.cwd() : ENV_ROOT}): `
          + "Read/ReadMany instead of cat, type, Get-Content or sed; Grep/SearchAndRead instead of rg, grep, findstr or Select-String; "
          + "Glob/ListDirectory instead of dir, ls, find or Get-ChildItem; Edit/ApplyMultipleEdits/Write instead of shell edits. "
          + "They honor .gitignore, return compact results within the context budget, and say whether a search was complete. "
          + "workspaceRoot is optional. Keep using the shell for builds, tests, git and other commands."
        : "These optional local compatibility tools preserve host permissions and tool preferences. When using filesystem tools, pass the exact active project root as workspaceRoot.",
    });
  }
  if (method === "ping") return rpcResponse(id, {});
  if (method === "tools/list") return rpcResponse(id, { tools: toolDefinitions() });
  if (method === "tools/call") {
    try {
      const name = requireString(message.params?.name, "name");
      const args = message.params?.arguments ?? {};
      return rpcResponse(id, toolResult(name, await callTool(name, args), args));
    } catch (error) {
      return rpcResponse(id, toolFailure(error));
    }
  }
  if (method === "prompts/list") return rpcResponse(id, { prompts: [] });
  if (method === "resources/list") return rpcResponse(id, { resources: [] });
  if (method === "resources/templates/list") return rpcResponse(id, { resourceTemplates: [] });
  return rpcError(id ?? null, -32601, `Method not found: ${method}`);
}

export function runStdio() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", async (line) => {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      process.stdout.write(`${JSON.stringify(rpcError(null, -32700, `Parse error: ${error.message}`))}\n`);
      return;
    }
    const response = await handleRpc(request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

if (!isMainThread && workerData?.scan) {
  scanSearch(workerData.root, workerData.start, workerData.options, workerData.engine).then(
    (result) => parentPort.postMessage({ result }),
    (error) => parentPort.postMessage({ error: error.message }),
  );
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStdio();
}
