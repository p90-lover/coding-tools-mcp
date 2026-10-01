import { closeSync, existsSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, toNamespacedPath } from "node:path";
import { getCodexHome } from "./codex-integration-shared";

type Json = Record<string, unknown>;
type Source = "active" | "archived";
type Entry = { path: string; source: Source; key: string; id: string; root: string };
type Row = { value?: Json; start: number; end: number; incomplete?: boolean };
export type CodexSessionInput = { operation: "discover" | "list" | "read"; source?: Source | "all"; session_id?: string; cursor?: string; limit?: number; max_bytes?: number };
type Context = { roots: string[]; scope: "workspace" | "all" };
const uuidSource = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const uuid = new RegExp(`^${uuidSource}$`, "i");
// Same canonical rollout shape as the active-turn authority reader; browsing never relaxes that reader.
const rollout = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${uuidSource})(?:_${uuidSource})?\\.jsonl$`, "i");
const maxRecordBytes = 16 * 1024 * 1024;
const record = (value: unknown): Json | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const identity = (path: string) => process.platform === "win32" ? toNamespacedPath(resolve(path)).toLowerCase() : resolve(path);
function within(root: string, path: string): boolean {
  const rel = relative(identity(root), identity(path));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function number(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error("Invalid session page bounds");
  return result;
}
function redact(text: string): string {
  // Adapt the existing history/markdown and browser diagnostic patterns without importing a browser runtime.
  return text
    .replace(/<codex_context_json>[\s\S]*?(?:<\/codex_context_json>|$)/gi, "[REDACTED CONTEXT]")
    .replace(/-----BEGIN[^\r\n]{0,80}PRIVATE KEY-----[\s\S]*?(?:-----END[^\r\n]{0,80}PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [REDACTED]")
    .replace(/\b((?:proxy-)?authorization|(?:set-)?cookie)["']?\s*:\s*[^\r\n]*/gi, "$1: [REDACTED]")
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|(?:turn|binding|request|activity|call)_[\w-]{12,})\b/g, "[REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS)(?:_ID)?)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/g, "$1=[REDACTED]")
    .replace(/(\b(?:api[_ -]?key|(?:access|refresh|turn|control|session)[_ -]?token|token|cookie|password|passwd|pwd)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/((?:https?|socks5):\/\/)[^\s/"'`<>]+@/gi, "$1[REDACTED]@");
}
function openFile(path: string, root: string): { fd: number; stat: Stats } {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || !within(realpathSync(root), realpathSync(path))) throw new Error("Session path is not an allowed regular file");
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error("Session file changed while opening");
    return { fd, stat };
  } catch (error) { closeSync(fd); throw error; }
}
function* rows(fd: number, start: number, size: number): Generator<Row> {
  if (start > 0) {
    const previous = Buffer.alloc(1);
    if (readSync(fd, previous, 0, 1, start - 1) !== 1 || previous[0] !== 10) throw new Error("Session cursor is not at a record boundary");
  }
  let position = start, lineStart = start, pending = Buffer.alloc(0);
  while (position < size) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, size - position));
    const count = readSync(fd, chunk, 0, chunk.length, position);
    if (!count) throw new Error("Session was truncated during reading");
    position += count;
    pending = Buffer.concat([pending, chunk.subarray(0, count)]);
    let newline: number;
    while ((newline = pending.indexOf(10)) >= 0) {
      if (newline > maxRecordBytes) throw new Error("Session JSONL record exceeds the 16 MiB read limit");
      const end = lineStart + newline + 1;
      let value: Json | undefined;
      try { value = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, newline)).replace(/^\uFEFF/, ""))); } catch {}
      yield { value, start: lineStart, end };
      pending = pending.subarray(newline + 1); lineStart = end;
    }
    if (pending.length > maxRecordBytes) throw new Error("Session JSONL record exceeds the 16 MiB read limit");
  }
  if (pending.length) yield { start: lineStart, end: size, incomplete: true };
}
function sourceDirectory(home: string, source: Source): string | null {
  const path = join(home, source === "active" ? "sessions" : "archived_sessions");
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !within(realpathSync(home), realpathSync(path))) return null;
  return path;
}
function entries(home: string, source: CodexSessionInput["source"]): Entry[] {
  const result: Entry[] = [];
  let visited = 0;
  for (const kind of ["active", "archived"] as const) {
    if (source && source !== "all" && source !== kind) continue;
    const root = sourceDirectory(home, kind);
    if (!root) continue;
    const visit = (path: string, depth: number) => {
      const directory = opendirSync(path);
      try {
        for (let entry; (entry = directory.readSync());) {
          if (++visited > 100_000) throw new Error("Codex history exceeds the bounded directory scan; select one source");
          if (entry.isSymbolicLink()) continue;
          const child = join(path, entry.name);
          if (entry.isDirectory() && depth < 3 && /^\d+$/.test(entry.name)) visit(child, depth + 1);
          const match = entry.isFile() && rollout.exec(entry.name);
          if (match) result.push({ path: child, source: kind, root, id: match[1]!.toLowerCase(), key: `${entry.name}|${kind}/${relative(root, child).replaceAll("\\", "/")}` });
        }
      } finally { directory.closeSync(); }
    };
    visit(root, 0);
  }
  // ponytail: bounded filename scan, no new index/database; use Codex's index if catalog size makes this measurable.
  return result.sort((a, b) => a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
}
function session(entry: Entry, context: Context) {
  const opened = openFile(entry.path, entry.root);
  try {
    const first = rows(opened.fd, 0, opened.stat.size).next().value as Row | undefined;
    const meta = record(first?.value?.payload);
    if (first?.value?.type !== "session_meta" || typeof meta?.id !== "string" || meta.id.toLowerCase() !== entry.id
      || typeof meta.cwd !== "string" || !isAbsolute(meta.cwd) || meta.cwd.length > 4096) throw new Error("Invalid Codex session metadata");
    if (context.scope !== "all" && !context.roots.some(root => within(root, meta.cwd as string))) throw new Error("Session is outside the allowed workspace scope");
    const timestamp = meta.timestamp ?? first.value?.timestamp;
    const date = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
    return { ...opened, afterMeta: first.end, metadata: { id: entry.id, source: entry.source, path: entry.path, cwd: meta.cwd,
      timestamp: Number.isFinite(date) ? new Date(date).toISOString() : null } };
  } catch (error) { closeSync(opened.fd); throw error; }
}
function titles(home: string): Map<string, string> {
  const result = new Map<string, string>(), path = join(home, "session_index.jsonl");
  if (!existsSync(path)) return result;
  let fd: number | undefined;
  try {
    const opened = openFile(path, home); fd = opened.fd;
    if (opened.stat.size > 4 * 1024 * 1024) return result;
    for (const { value } of rows(fd, 0, opened.stat.size)) {
      const title = value?.thread_name ?? value?.title;
      if (typeof value?.id === "string" && uuid.test(value.id) && typeof title === "string") result.set(value.id.toLowerCase(), redact(title).slice(0, 200).replace(/[\ud800-\udbff]$/, ""));
    }
  } catch {} finally { if (fd !== undefined) closeSync(fd); }
  return result;
}
function visible(value: Json | undefined): { role: string; channel?: string; text: string } | undefined {
  const payload = record(value?.payload);
  if (value?.type !== "response_item" || payload?.type !== "message" || !["user", "assistant"].includes(String(payload.role))) return;
  if (payload.channel != null && !["final", "commentary"].includes(String(payload.channel))) return;
  const content = payload.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(part => {
    const item = record(part);
    if (["input_text", "output_text", "text"].includes(String(item?.type)) && typeof item?.text === "string") return item.text;
    if (["input_image", "image", "local_image", "input_audio", "input_file"].includes(String(item?.type))) return "[Attachment omitted]";
    return "";
  }).filter(Boolean).join("\n") : "";
  if (text) return { role: String(payload.role), ...(typeof payload.channel === "string" ? { channel: payload.channel } : {}), text: redact(text) };
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function decode(cursor: string): Json {
  if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Invalid session cursor");
  try { const value = record(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); if (value) return value; } catch {}
  throw new Error("Invalid session cursor");
}

export function readCodexChatSessions(input: CodexSessionInput, context: Context): Record<string, unknown> {
  const home = getCodexHome();
  const scope = context.scope === "all" ? "all" : "workspace";
  const base = { read_only: true, scope, untrusted_history: true };
  if (input.operation === "discover") return { ...base, codex_home: home, active_path: join(home, "sessions"), archived_path: join(home, "archived_sessions"),
    active_available: Boolean(sourceDirectory(home, "active")), archived_available: Boolean(sourceDirectory(home, "archived")) };
  if (input.source && !["all", "active", "archived"].includes(input.source)) throw new Error("Invalid Codex history source");
  if (input.operation !== "list" && (input.operation !== "read" || !input.session_id || !uuid.test(input.session_id))) throw new Error("Read requires a valid Codex session UUID");
  const limit = number(input.limit, 20, 1, 100);
  const files = entries(home, input.source);
  if (input.operation === "list") {
    const cursor = input.cursor ? decode(input.cursor) : null;
    if (cursor && (cursor.kind !== "list" || typeof cursor.after !== "string" || cursor.source !== (input.source ?? "all"))) throw new Error("Invalid session list cursor");
    const named = titles(home), sessions = [];
    let nextCursor: string | null = null, skipped = 0;
    for (let index = 0; index < files.length; index++) {
      const entry = files[index]!;
      if (cursor && entry.key >= String(cursor.after)) continue;
      try {
        const opened = session(entry, context);
        closeSync(opened.fd);
        sessions.push({ ...opened.metadata, title: named.get(entry.id) ?? null });
      } catch { skipped++; }
      if (sessions.length >= limit) {
        if (index < files.length - 1) nextCursor = encode({ kind: "list", source: input.source ?? "all", after: entry.key });
        break;
      }
    }
    return { ...base, sessions, next_cursor: nextCursor, skipped };
  }
  if (input.operation !== "read" || !input.session_id || !uuid.test(input.session_id)) throw new Error("Read requires a valid Codex session UUID");
  const matches = files.filter(entry => entry.id === input.session_id!.toLowerCase());
  if (matches.length !== 1) throw new Error(matches.length ? "Session ID is ambiguous; select its active or archived source" : "Codex session is unavailable");
  const opened = session(matches[0]!, context);
  try {
    const { fd, stat, metadata } = opened;
    const stamp = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const cursor = input.cursor ? decode(input.cursor) : null;
    if (cursor && (cursor.kind !== "read" || cursor.id !== metadata.id || cursor.source !== metadata.source || cursor.stamp !== stamp
      || !Number.isSafeInteger(cursor.size) || Number(cursor.size) > stat.size || Number(cursor.size) < 0
      || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0 || Number(cursor.offset) > Number(cursor.size)
      || !Number.isSafeInteger(cursor.part) || Number(cursor.part) < 0
      || (cursor.tail !== undefined && typeof cursor.tail !== "boolean"))) throw new Error("Session cursor is invalid or the file changed");
    const size = cursor && !cursor.tail ? Number(cursor.size) : stat.size;
    let offset = cursor ? Number(cursor.offset) : opened.afterMeta;
    let part = cursor ? Number(cursor.part) : 0;
    let remaining = number(input.max_bytes, 16 * 1024, 512, 64 * 1024);
    let skipped = 0, tail = false;
    const messages: Array<Record<string, unknown>> = [];
    const start = offset;
    for (const row of rows(fd, offset, size)) {
      if (row.incomplete) { offset = row.start; tail = true; break; }
      const message = visible(row.value);
      if (!message) {
        if (part) throw new Error("Session fragment cursor does not refer to a visible message");
        skipped++; offset = row.end;
      } else {
        const text = Buffer.from(message.text);
        if (part > text.length || (part < text.length && (text[part]! & 0xc0) === 0x80)) throw new Error("Invalid UTF-8 message cursor");
        let end = Math.min(text.length, part + remaining);
        while (end < text.length && (text[end]! & 0xc0) === 0x80) end--;
        if (end === part && end < text.length) { offset = row.start; break; }
        messages.push({ role: message.role, channel: message.channel ?? null, text: text.subarray(part, end).toString("utf8"), continued: part > 0, text_complete: end === text.length });
        remaining -= end - part;
        if (end < text.length) { offset = row.start; part = end; break; }
        offset = row.end; part = 0;
      }
      if (!remaining || messages.length >= limit || offset - start >= 8 * 1024 * 1024) break;
    }
    const next = offset < size ? encode({ kind: "read", id: metadata.id, source: metadata.source, stamp, size, offset, part, tail }) : null;
    return { ...base, session: metadata, messages, skipped, next_cursor: next, complete: !next, live_tail: tail,
      redaction: "Common credentials and bridge capabilities redacted; not a guarantee that arbitrary personal information is absent." };
  } finally { closeSync(opened.fd); }
}
