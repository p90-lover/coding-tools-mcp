const fs = require("node:fs");
const path = require("node:path");
const { renameAtomicFile } = require("./atomic-file.cjs");

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_MEMORY_RECORDS = 300;
// Enough for MAX_MEMORY_RECORDS ordinary lines. Reading the whole 1.3 MB file synchronously held
// 0.8.35's first start for 1.3 s on the busy drive.
const RESTORE_TAIL_BYTES = 512 * 1024;
const MAX_LOG_STRING_CHARS = 16 * 1024;

function redactText(value) {
  const redacted = value
    .replace(/((?:https?|socks5):\/\/)[^\s/"'`<>]+@/gi, "$1[redacted]@")
    .replace(/tunnel_[a-f0-9]{32}/g, "[tunnel-id]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[runtime-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{20,}\b/gi, "Bearer [redacted]");
  return redacted.length > MAX_LOG_STRING_CHARS
    ? `${redacted.slice(0, MAX_LOG_STRING_CHARS)}…[truncated]`
    : redacted;
}

function redactHttpUrls(value) {
  return value.replace(/https?:\/\/[^\s"'`<>]+/gi, (candidate) => {
    const trailing = candidate.match(/[),.;:!?]+$/)?.[0] || "";
    const url = trailing ? candidate.slice(0, -trailing.length) : candidate;
    try {
      return `${new URL(url).origin}${trailing}`;
    } catch {
      return "[redacted-url]";
    }
  });
}

function redactExportText(value) {
  return redactHttpUrls(redactText(value))
    .replace(/\b[A-Za-z]:\\+Users\\+[^\\/\r\n"'`<>|]+/gi, "[user-home]")
    .replace(/\/(?:Users|home)\/[^/\r\n"'`<>]+/g, "[user-home]")
    .replace(/((?:visible rows|sidebar (?:rows|titles)|conversation titles):)\s*[^\r\n]*/gi, "$1 [redacted]");
}

function sanitizeForExport(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactExportText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeForExport(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /^(?:prompt|response|html|dom|content|visibleRows|sidebarRows|sidebarTitles|conversationTitle|conversationTitles|chatTitle|chatTitles)$/i.test(key)
        ? "[redacted]"
        : sanitizeForExport(item, seen),
    ]),
  );
}

function exportSanitizedLogs({ filePath = null, destinationPath, records: memoryRecords = [] }) {
  const sourcePaths = filePath ? [`${filePath}.1`, filePath] : [];
  const destination = path.resolve(destinationPath);
  if (sourcePaths.some(sourcePath => path.resolve(sourcePath) === destination)) {
    throw new Error("Refusing to overwrite a launcher source log with an exported diagnostic");
  }
  const records = [];
  const append = (record) => {
    if (!record || typeof record.at !== "string" || !["debug", "info", "warning", "error"].includes(record.level)
      || typeof record.event !== "string") return;
    records.push({ at: record.at, level: record.level, event: record.event,
      detail: record.detail && typeof record.detail === "object" ? sanitizeForExport(record.detail) : {} });
  };
  for (const sourcePath of sourcePaths) {
    let lines;
    try {
      lines = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const line of lines) { try { append(JSON.parse(line)); } catch {} }
  }
  for (const record of memoryRecords) append(record);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    destination,
    records.length > 0 ? `${records.map(record => JSON.stringify(record)).join("\n")}\n` : "",
    { mode: 0o600 },
  );
  if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
  return records.length;
}

function sanitize(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /(?:authorization|cookie|runtimeKey|controlToken)/i.test(key)
        ? "[redacted]"
        : sanitize(item, seen),
    ]),
  );
}

/** The previous process's last records; only the file's tail is read, never on the main thread's clock. */
async function readRecent(filePath) {
  try {
    const handle = await fs.promises.open(filePath, "r");
    let text;
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - RESTORE_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
      // A tail read starts mid-line; that partial line is dropped.
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } finally {
      await handle.close();
    }
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-MAX_MEMORY_RECORDS)
      .flatMap((line) => {
        try {
          const record = JSON.parse(line);
          if (!record
            || typeof record.at !== "string"
            || !["debug", "info", "warning", "error"].includes(record.level)
            || typeof record.event !== "string") return [];
          return [{
            at: record.at,
            level: record.level,
            event: record.event,
            detail: record.detail && typeof record.detail === "object"
              ? sanitize(record.detail)
              : {},
          }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// Log lines are written in batches this often, off the main thread.
const LOG_FLUSH_MS = 250;

function createLogger({ filePath, publish, persist = true }) {
  const records = [];
  // Warnings and errors (freezes, memory, failures) also go here. With several chats working,
  // routine lines filled the 300-record ring in 16 minutes, so a freeze rolled off before anyone
  // outside the app could read it.
  const notable = [];
  // Routine app activity stays in memory. Persistent diagnostics are an explicit opt-in; the
  // default app launch must neither replay old logs nor append a file every few hundred ms.
  const restored = (persist ? readRecent(filePath) : Promise.resolve([])).then((previous) => {
    records.unshift(...previous);
    if (records.length > MAX_MEMORY_RECORDS) records.splice(0, records.length - MAX_MEMORY_RECORDS);
  });
  // Every line used to make, check the size of and append to the file synchronously on the main
  // process's thread. On a saturated hard disk (seen live: a queue of 30-40 requests on the drive
  // holding the app's data) each line held the main process for up to seconds, and every IPC call
  // waited behind it (a 13.9 s round trip). Lines now go out in batches, asynchronously; whatever
  // is still queued when the process exits is written synchronously then.
  let pending = [];
  let flushing = null;
  let timer = null;
  let ready = false;
  let size = null;

  async function flush() {
    timer = null;
    if (flushing || !pending.length) return;
    const lines = pending.join("");
    pending = [];
    flushing = (async () => {
      try {
        if (!ready) { await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 }); ready = true; }
        if (size === null) size = (await fs.promises.stat(filePath).catch(() => null))?.size ?? 0;
        if (size >= MAX_LOG_BYTES) {
          await fs.promises.rm(`${filePath}.1`, { force: true });
          renameAtomicFile(filePath, `${filePath}.1`);
          size = 0;
        }
        await fs.promises.appendFile(filePath, lines, { mode: 0o600 });
        size += Buffer.byteLength(lines);
      } catch {}
    })();
    try { await flushing; } finally {
      flushing = null;
      if (pending.length && !timer) schedule();
    }
  }
  function schedule() {
    timer = setTimeout(() => { void flush(); }, LOG_FLUSH_MS);
    timer.unref?.();
  }
  if (persist) process.once("exit", () => {
    if (!pending.length) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(filePath, pending.join(""), { mode: 0o600 });
    } catch {}
    pending = [];
  });

  const append = (level, event, detail = {}) => {
    const record = {
      at: new Date().toISOString(),
      level,
      event,
      detail: detail && typeof detail === "object" && !Array.isArray(detail) ? sanitize(detail) : {},
    };
    records.push(record);
    if (records.length > MAX_MEMORY_RECORDS) records.splice(0, records.length - MAX_MEMORY_RECORDS);
    if (level === "warning" || level === "error") {
      notable.push(record);
      if (notable.length > MAX_MEMORY_RECORDS) notable.splice(0, notable.length - MAX_MEMORY_RECORDS);
    }
    if (persist) {
      pending.push(`${JSON.stringify(record)}\n`);
      if (!timer && !flushing) schedule();
    }
    publish?.(record);
    return record;
  };

  return {
    debug: (event, detail) => append("debug", event, detail),
    info: (event, detail) => append("info", event, detail),
    warn: (event, detail) => append("warning", event, detail),
    error: (event, detail) => append("error", event, detail),
    recent: (limit = 150) => records.slice(-Math.max(1, Math.min(300, limit))),
    /** This process's last warnings and errors, kept apart from routine lines. */
    notable: () => notable.slice(),
    /** Settles once the previous process's records are in `recent()`. */
    restored,
    /** Writes every queued line now (tests, and before a deliberate quit). */
    flush: async () => { if (timer) { clearTimeout(timer); timer = null; } while (flushing || pending.length) { if (flushing) await flushing; else await flush(); } },
    filePath: persist ? filePath : null,
  };
}

function installProcessDiagnosticGuards({ filePath, streams = [process.stdout, process.stderr], persist = true }) {
  const guarded = new Set();
  for (const stream of streams) {
    if (!stream || typeof stream.on !== "function" || guarded.has(stream)) continue;
    guarded.add(stream);
    stream.on("error", (error) => {
      if (!persist) return;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        fs.appendFileSync(
          filePath,
          `${new Date().toISOString()} ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
          { mode: 0o600 },
        );
      } catch {
        // A lost diagnostic sink must not become a second process error.
      }
    });
  }
}

function registerLoggedIpc(ipcMain, logger, channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      // An app-module call names its module and operation (identifiers only, never its arguments):
      // without them Activity's "AO run not found" or focus refusals could not be traced to a caller.
      const call = args[0] && typeof args[0] === "object" ? args[0] : null;
      const name = (value) => (typeof value === "string" && /^[\w.:-]{1,64}$/.test(value) ? value : undefined);
      logger.error("launcher.ipc_failed", {
        channel,
        ...(name(call?.moduleId) ? { module: call.moduleId } : {}),
        ...(name(call?.operation) ? { operation: call.operation } : {}),
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}

module.exports = {
  createLogger,
  exportSanitizedLogs,
  installProcessDiagnosticGuards,
  readRecent,
  redactExportText,
  redactText,
  registerLoggedIpc,
  sanitize,
  sanitizeForExport,
};
