"use strict";

// The app's own tools for chat agents. Every AO chat session (Claude Code, Codex, opencode) gets
// one MCP server, "coding-tools", reached through the local headless service the app always runs,
// under the workspace's own tool profile and approval policy.
//
// Each session has its own server path and credential (/mcp/<workspaceId>/<key>, a bearer token
// minted at spawn and sent to AO only in the spawn request's headers; never logged), and its tools
// are rooted at that session's own git worktree, the isolation that keeps its changes reviewable
// and discardable in the chat's diff and approval card:
// - The root is learned from AO once the session exists: the spawn binds the credential to its
//   AO session, and the first call asks AO for the session's worktree (re-checked every
//   ROOT_RECHECK_MS). Until AO has made it, calls are refused ("not ready yet"); once the
//   session has ended, its credential is forgotten (also on kill, after a sweep, or unused). When
//   the app names AO's worktrees folder, a root outside it is refused.
// - Headless runs each call in a context rooted at that worktree (the `root` of
//   /api/v1/tools/call), so paths, the command directory, terminal sessions, approvals and plans
//   all belong to it. This endpoint is the outer guard: every path argument and patch target must
//   resolve inside the worktree (after `..`, drive letters, UNC and device paths, Windows spellings
//   that open another file (trailing dots or spaces, `:` streams, and for patch targets also
//   device names and 8.3 short names),
//   and symlinks or junctions via realpath), a patch never writes git's own data, and
//   exec_command always starts in the worktree.
// - Consent is the user's alone: `confirm` and `approval_token` are stripped from every call the
//   agent makes, and request_permissions is never offered. When the workspace policy needs an
//   approval (APPROVAL_REQUIRED) or a confirmation (DANGEROUS_OPERATION_REQUIRES_CONFIRMATION),
//   the user is asked here; on yes this endpoint obtains a one-use grant for that one operation in
//   the session's own context and retries it once. The grant never reaches the agent.
// - The user approves only what they were shown: a confirmation shows what will run in full,
//   every character visible (displaySafe), right-to-left letters escaped so every line reads left
//   to right, and notes naming any character beyond ASCII that could pass for another (with its
//   script) and any word mixing scripts; a call too long to show in full is refused, never
//   cut. One prompt is open at a time across every session, and an approval given too quickly to
//   have been read is asked again.
// - Not a sandbox: a terminal command can still `cd` anywhere and read or change anything the
//   user's account can, exactly as the agent's own built-in shell can. That is why the terminal is
//   its own group, off by default, and why the user confirms every command and every input sent
//   to one (unless the session was launched to bypass permissions).
//
// Tool groups, all under Settings: "agent" (files, search, patches, git, images, plan; on by
// default), "terminal" (exec_command, write_stdin, read_output, kill_command; off unless the user
// opts in) and "desktop" (screen capture and computer control; off unless the user opts in).
// Anything else (the default cwd, the native Codex bridge, ChatGPT history, the operation store,
// the task board, request_permissions, sandbox and harness tools) is never offered. A tool outside
// the enabled groups is absent from tools/list and refused on tools/call; turning a group off also
// refuses it in sessions already running. Desktop tools run in the workspace's own context:
// computer_* control needs the user to enable it in the app (its existing local lease, bound to the
// workspace, not to one chat: every chat the user allows to control the screen can use it while it
// is enabled), each chat asks the user once before its first control call, and a screen or window
// observation is confirmed by the user in the app every time.
//
// Transport: MCP Streamable HTTP (JSON responses, no SSE stream) on 127.0.0.1 at an ephemeral port.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { PREVIEW_TOOL_DEFS, PREVIEW_TOOLS } = require("./chat-preview.cjs");

const SERVER_NAME = "coding-tools";
const PROTOCOL_VERSIONS = Object.freeze(["2025-06-18", "2025-03-26", "2024-11-05"]);
const MAX_BODY_BYTES = 1024 * 1024;
const TOOL_CALL_TIMEOUT_MS = 120_000;
// Agents whose AO chat driver takes an HTTP MCP server: Claude Code and opencode over ACP,
// Codex through app-server's mcp_servers config. Other ACP agents may lack the HTTP
// capability, which would fail the whole session, so they launch without these tools.
const MCP_HTTP_AGENTS = new Set(["claude-code", "codex", "opencode"]);
const WORKSPACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SESSION_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_TOOLS = new Set(["view_image", "capture_screenshot", "capture_window"]);
const WINDOWS = process.platform === "win32";

// Default on: everything stays inside the session's worktree.
const AGENT_TOOLS = new Set([
  "read_file", "list_dir", "list_files", "search_text", "grep_text",
  "apply_patch", "patch_check",
  "git_status", "git_diff", "git_log", "git_show", "git_blame",
  "view_image", "image_info", "compare_images",
  "update_plan", "get_plan", "get_current_time", "tool_search", "server_info",
]);
// Opt-in: commands start in the worktree but are not confined to it.
const TERMINAL_TOOLS = new Set([
  "exec_command", "write_stdin", "read_output", "kill_command", "kill_session", "check_exec_environment",
]);
// Opt-in: these see the screen and drive the mouse and keyboard, outside any worktree.
const DESKTOP_TOOLS = new Set([
  "computer_status", "computer_route", "computer_snapshot", "computer_list_windows", "computer_select_window",
  "computer_find_control", "computer_wait", "computer_action", "computer_sequence", "computer_stop",
  "capture_screenshot", "capture_window", "list_windows", "list_displays", "vision_status",
]);
// Desktop tools that observe the screen: the user confirms each call in the app.
const CONFIRMED_TOOLS = new Map([
  ["capture_screenshot", "take a screenshot of your screen"],
  ["capture_window", "capture a window on your screen"],
  ["list_windows", "list the windows open on your desktop"],
  ["list_displays", "list your displays"],
  ["computer_list_windows", "list the windows open on your desktop"],
  ["computer_snapshot", "capture the window it controls"],
]);
// Computer control the user allows once per chat (on top of enabling control in the app); status
// and stop are harmless, and the observations above are confirmed every time.
const CONTROL_TOOLS = new Set([
  "computer_route", "computer_select_window", "computer_find_control", "computer_wait", "computer_action", "computer_sequence",
]);
// Consent the agent may never give itself: stripped from every call it makes.
const CONSENT_ARGUMENTS = Object.freeze(["confirm", "confirmed", "approval_token"]);
const GROUPS = Object.freeze(["agent", "terminal", "desktop", "preview"]);
const groupOf = (name) => (AGENT_TOOLS.has(name) ? "agent" : TERMINAL_TOOLS.has(name) ? "terminal" : DESKTOP_TOOLS.has(name) ? "desktop"
  : PREVIEW_TOOLS.has(name) ? "preview" : null);
// Commands remembered per session for the chat's Terminal pane, newest kept.
const MAX_TRACKED_COMMANDS = 40;
const MAX_PANE_READ_BYTES = 64 * 1024;
const COMMAND_ID = /^[A-Za-z0-9_.-]{1,128}$/;

// Path arguments per tool, taken from the tool schemas (registry_definitions.rs) and the headless
// dispatch's own default-cwd rewriting (dispatch.rs apply_default_cwd).
const PATH_ARGUMENTS = Object.freeze({
  read_file: ["path"], list_dir: ["path"], list_files: ["path"], search_text: ["path"], grep_text: ["path"],
  git_status: ["path"], git_diff: ["path"], git_log: ["path"], git_show: ["path"], git_blame: ["path"],
  view_image: ["path"], image_info: ["path"], compare_images: ["before_path", "after_path"],
  exec_command: ["workdir", "cwd"],
});
const PATH_LIST_ARGUMENTS = Object.freeze({ git_diff: ["paths"], git_show: ["paths"] });
const PATCH_TOOLS = new Set(["apply_patch", "patch_check"]);
// Names no patch writes into, compared by the name the file system opens (see effectiveName).
const PROTECTED_NAMES = new Set([".git", ".github", ".mcp-paths"]);

// What a confirmation dialog can show in full. It is the app's native message box, which never
// scrolls: everything must fit on screen at once (a 720-pixel-high work area, as on a 1080p
// display at 150%). Shown text is hard-wrapped at DISPLAY_COLUMNS (a wide character counts twice),
// and a dialog whose text would take more than DIALOG_MAX_LINES lines is refused, never cut.
// The width is an assumption about the native box, which Electron does not let the app set on
// Windows (`textWidth` is macOS only; main.cjs sets it there): Electron shows a task dialog sized to
// its content (TDF_SIZE_TO_CONTENT, cxWidth 0) in Segoe UI 9 pt, 12 px to the em at 100%. A line of
// 72 columns takes about 470 px of ordinary text and under 800 px at worst (72 capital Ws; 36 wide
// characters take about 430 px), which with the icon and margins is still less than the 1280 px of
// a 1080p display at 150%, so the box widens to fit the line instead of wrapping it again. (Not
// measured in the running app.)
const DISPLAY_COLUMNS = 72;
const DIALOG_MAX_LINES = 30;
// A patch is approved by its list of files, one line each; more than this are refused.
const MAX_CONFIRM_PATHS = 20;
// An approval given sooner than this after the prompt opened was not read (a double click, a key
// held down): the prompt is shown again, at most MAX_QUICK_ANSWERS times.
const MIN_ANSWER_MS = 500;
const MAX_QUICK_ANSWERS = 3;

const ROOT_RECHECK_MS = 30_000;
const UNBOUND_TTL_MS = 10 * 60_000;
const SWEEP_MS = 10 * 60_000;
const MAX_SESSIONS = 512;
/** A credential as it is compared and kept: its SHA-256, so neither memory nor disk holds it. */
const hashBearer = (value) => crypto.createHash("sha256").update(String(value), "utf8").digest();

class ScopeError extends Error {}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function errorMessage(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 500);
}

/** The MCP CallToolResult for a workspace tool's structured result, as the workspace listener shapes it. */
function toolResult(name, args, structured) {
  const value = structured && typeof structured === "object" && !Array.isArray(structured)
    ? { ...structured } : { value: structured ?? null };
  const isError = value.ok === false;
  const wantsImage = name.startsWith("computer_")
    ? typeof value.base64 === "string"
    : IMAGE_TOOLS.has(name) && !isError && (args?.output ?? "mcp_image") === "mcp_image";
  if (wantsImage && typeof value.base64 === "string" && value.base64 && IMAGE_TYPES.has(value.mime_type)) {
    const data = value.base64;
    delete value.base64;
    delete value.data_url;
    return {
      content: [{ type: "image", data, mimeType: value.mime_type }, { type: "text", text: JSON.stringify(value) }],
      structuredContent: value, isError,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError };
}

function failedCall(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function inside(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** The real location of a path that may not exist yet: its deepest existing ancestor, resolved. */
function realLocation(target) {
  const rest = [];
  let cursor = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cursor), ...[...rest].reverse());
    } catch (error) {
      let dangling = false;
      try { fs.lstatSync(cursor); dangling = true; } catch { /* the entry does not exist */ }
      // A link whose target is missing could point anywhere once it appears.
      if (dangling) throw new ScopeError("a link inside it points to a missing target");
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw new ScopeError("it cannot be resolved");
      const parent = path.dirname(cursor);
      if (parent === cursor) return target;
      rest.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

// \\?\C:\..., \\.\pipe\...: verbatim and device paths skip normalization; never accepted.
const DEVICE_PATH = /^[\\/]{2}[?.](?:[\\/]|$)/;
// C:foo is relative to that drive's current directory, not to the worktree.
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9\u00b9\u00b2\u00b3])$/i;

/**
 * Why Windows would open something other than what a path part names, if it would: trailing dots
 * or spaces are dropped and `:` names an alternate data stream (`.git::$INDEX_ALLOCATION` is the
 * `.git` directory), for every path. With `write` (a write into this chat's own worktree) also a
 * device name (CON, NUL, COM1, with or without an extension), which is a device, and an 8.3 short
 * name (`GIT~1`), which the file system expands. Reads keep those two: `file~2.txt` and `aux.ts`
 * are ordinary names, and a read lands wherever the name really resolves (checked by realpath).
 */
function windowsQuirk(part, { write = false } = {}) {
  if (!part || part === "." || part === "..") return null;
  if (/[. ]$/.test(part)) return "a path part ends with a dot or a space";
  if (part.includes(":")) return "a path part names an alternate data stream";
  if (!write) return null;
  if (RESERVED_DEVICE.test(part.split(".")[0].replace(/ +$/, ""))) return "a path part is a reserved device name";
  if (/~\d/.test(part)) return "a path part is an 8.3 short name";
  return null;
}

/** The name Windows opens for a path part, lower-cased: `.git.`, `.GIT ` and `.git::$DATA` all open `.git`. */
const effectiveName = (part) => part.split(":")[0].replace(/[. ]+$/, "").toLowerCase();
const protectedName = (part) => part !== "." && part !== ".." && PROTECTED_NAMES.has(effectiveName(part));

/**
 * A path argument, scoped to the session's worktree: relative to its root, refused if it resolves
 * anywhere else or is spelled to open another file than it names, and forwarded relative (headless
 * resolves it against the same root). A `write` target may not be git's own data or another
 * protected folder, compared by its canonical name.
 */
function scopePath(root, raw, label, { write = false } = {}) {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) throw new ScopeError(`${label} must be a non-empty path`);
  const outside = (why = "it is outside this chat's worktree") => new ScopeError(`${label} "${raw.slice(0, 200)}" is refused: ${why}`);
  if (raw.startsWith("@")) throw outside("linked projects (@alias) are outside this chat's worktree");
  if (DEVICE_PATH.test(raw) || DRIVE_RELATIVE.test(raw)) throw outside();
  const candidate = path.resolve(root.path, raw);
  if (!inside(root.path, candidate)) throw outside();
  const relative = path.relative(root.path, candidate);
  const parts = relative ? relative.split(path.sep) : [];
  if (WINDOWS) {
    for (const part of parts) {
      const why = windowsQuirk(part, { write });
      if (why) throw outside(why);
    }
  }
  let real;
  try { real = realLocation(candidate); } catch (error) { throw outside(error instanceof ScopeError ? error.message : undefined); }
  if (!inside(root.real, real)) throw outside("it leads outside this chat's worktree through a link");
  if (write) {
    const realRelative = path.relative(root.real, real);
    const canonical = realRelative ? realRelative.split(path.sep) : [];
    if ([...parts, ...canonical].some(protectedName)) throw outside("git's own data and protected folders are never patched");
  }
  return relative.split(path.sep).join("/") || ".";
}

// Rust's `trim` and `split_whitespace` use the Unicode White_Space property.
const trimWhite = (text) => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
const withoutCr = (line) => line.replace(/\r+$/, "");

/** patch.rs parse_diff_path: trimmed, without an `a/` or `b/` prefix, `/dev/null` as none. */
function diffPath(raw) {
  const trimmed = trimWhite(raw);
  const target = trimmed.startsWith("a/") || trimmed.startsWith("b/") ? trimmed.slice(2) : trimmed;
  return target === "/dev/null" ? "" : target.replace(/\\/g, "/");
}

/** patch.rs unified_header: a hunk's old and new line counts, or null when it has none. */
function hunkCounts(line) {
  const parts = trimWhite(line.slice(2)).split(/\p{White_Space}+/u);
  const count = (part, sign) => {
    if (!part?.startsWith(sign)) return null;
    const body = part.slice(1);
    const comma = body.indexOf(",");
    const [start, lines] = comma < 0 ? [body, "1"] : [body.slice(0, comma), body.slice(comma + 1)];
    const usize = (value) => (/^\+?[0-9]+$/.test(value) && BigInt(value) <= 0xFFFF_FFFF_FFFF_FFFFn ? Number(value) : null);
    return usize(start) === null || usize(lines) === null ? null : usize(lines);
  };
  const old = count(parts[0], "-");
  const added = old === null ? null : count(parts[1], "+");
  return added === null ? null : { old, added };
}

/**
 * Every file a patch touches, parsed as headless parses it (patch.rs parse_unified_diff and
 * parse_codex_patch): `{ path, operation: "add" | "update" | "delete" }`, plus the names headless
 * ignores but a scope check still covers: a unified diff's old name (`from`) and a Codex
 * `*** Move to:` (`moveTo`; headless does not move files, it updates the original in place).
 */
function parsePatch(text) {
  const lines = String(text).split(/\r?\n/);
  const files = [];
  if (lines.some((line) => withoutCr(line) === "*** Begin Patch")) {
    let current = null;
    for (const raw of lines) {
      const line = withoutCr(raw);
      const header = /^\*\*\* (Add|Update|Delete) File: /.exec(line);
      if (header) {
        current = { path: diffPath(line.slice(header[0].length)), operation: header[1].toLowerCase() };
        files.push(current);
      } else if (line === "*** End Patch") {
        current = null;
      } else if (line.startsWith("*** Move to: ") && current) {
        current.moveTo = diffPath(line.slice("*** Move to: ".length));
      }
    }
    return files;
  }
  let current = null;
  let hunk = null;
  lines.forEach((line, index) => {
    // A real file header is `--- ` directly followed by `+++ `; anything else inside a counted
    // hunk is its content (a removed SQL comment `-- x`), as in patch.rs.
    const header = line.startsWith("--- ") && (lines[index + 1] ?? "").startsWith("+++ ");
    if (hunk && !header && hunk.old + hunk.added > 0) {
      const body = withoutCr(line);
      if (body.startsWith("+")) { hunk.added = Math.max(0, hunk.added - 1); return; }
      if (body.startsWith("-")) { hunk.old = Math.max(0, hunk.old - 1); return; }
      if (body === "" || body.startsWith(" ")) {
        hunk.old = Math.max(0, hunk.old - 1);
        hunk.added = Math.max(0, hunk.added - 1);
        return;
      }
    }
    if (line.startsWith("--- ")) {
      hunk = null;
      const from = diffPath(line.slice(4));
      current = { path: from, from, added: line.includes("/dev/null"), deleted: false };
      files.push(current);
    } else if (line.startsWith("+++ ")) {
      if (current) {
        const next = diffPath(line.slice(4));
        if (next) current.path = next;
        if (line.includes("/dev/null")) current.deleted = true;
      }
    } else if (line.startsWith("@@")) {
      hunk = hunkCounts(line) ?? { old: 0, added: 0 };
    }
  });
  return files.map(({ path: target, from, added, deleted }) => ({
    path: target, operation: deleted ? "delete" : added ? "add" : "update", ...(from && from !== target ? { from } : {}),
  }));
}

/** Every file a patch names, in the formats headless applies (patch.rs): Codex envelopes or unified diffs. */
function patchTargets(text) {
  return parsePatch(text).flatMap((file) => [file.from, file.path, file.moveTo]).filter(Boolean);
}

/** patch.rs is_critical_file: deleting one needs the user's confirmation. */
function criticalFile(target) {
  const parts = target.replace(/\\/g, "/").split("/");
  if (parts[0] && [".git", ".github"].includes(effectiveName(parts[0]))) return true;
  const name = parts.at(-1);
  return [".gitignore", "Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "pnpm-lock.yaml", "tauri.conf.json", "pyproject.toml"].includes(name)
    || name.startsWith("README") || name.startsWith("LICENSE") || name.startsWith("vite.config.");
}

// Characters that would hide or disguise text in a dialog: controls (Cc), format characters such
// as bidi overrides and zero-width spaces (Cf), line and paragraph separators (Zl, Zp), spaces
// other than U+0020 (Zs), surrogates, private-use and unassigned code points.
const INVISIBLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;
// Right-to-left text: every code point whose Bidi_Class is R or AL, as the ranges where those are
// the default (DerivedBidiClass.txt): Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, their
// presentation forms, and the RTL scripts beyond the BMP (Kharoshthi, Old Turkic, Adlam and more).
// Drawn as itself, an RTL letter makes the dialog reorder the spaces, quotes and digits around it,
// so a line no longer reads the way it runs; escaped, every line stays left to right. (JS regular
// expressions have no \p{Bidi_Class=...}.)
const RTL_RANGES = "\\u{0590}-\\u{08FF}\\u{FB1D}-\\u{FDCF}\\u{FDF0}-\\u{FDFF}\\u{FE70}-\\u{FEFF}"
  + "\\u{10800}-\\u{10FFF}\\u{1E800}-\\u{1EFFF}";
const RTL = new RegExp(`^[${RTL_RANGES}]$`, "u");
const HAS_RTL = new RegExp(`[${RTL_RANGES}]`, "u");
const COMBINING = /^\p{M}$/u;
// The marks displaySafe draws with; a literal one in the text is escaped so a mark always means it.
const MARKS = new Set(["⏎", "⇥", "␠", "↪"]);
// Characters that take two columns: East Asian Width W and F (EastAsianWidth.txt, Unicode 16),
// rounded up to whole blocks where a block is mostly wide (Hangul Jamo and its extensions, CJK,
// kana, Tangut, Nushu, small and fullwidth forms), plus the symbols the dialog draws from an emoji
// or symbol font about an em wide: Misc Symbols and Dingbats (U+2600-27BF) and U+1F000-1FAFF.
// Counting a narrow character as wide only wraps a line earlier; counting a wide one as narrow
// would let the native dialog wrap the line again, past the line budget.
const WIDE = new RegExp("^[\\u{1100}-\\u{115F}\\u{231A}\\u{231B}\\u{2329}\\u{232A}\\u{23E9}-\\u{23EC}\\u{23F0}\\u{23F3}"
  + "\\u{25FD}\\u{25FE}\\u{2600}-\\u{27BF}\\u{2B1B}\\u{2B1C}\\u{2B50}\\u{2B55}\\u{2E80}-\\u{A4CF}\\u{A960}-\\u{A97F}"
  + "\\u{AC00}-\\u{D7FF}\\u{F900}-\\u{FAFF}\\u{FE10}-\\u{FE19}\\u{FE30}-\\u{FE6F}\\u{FF00}-\\u{FF60}\\u{FFE0}-\\u{FFE6}"
  + "\\u{16FE0}-\\u{16FFF}\\u{17000}-\\u{18D7F}\\u{1AFF0}-\\u{1B2FF}\\u{1F000}-\\u{1FAFF}\\u{20000}-\\u{3FFFD}]$", "u");
const escapeCodePoint = (char) => `\\u{${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}}`;

/**
 * How displaySafe reads text: its [shown, width] tokens ("\n" for a line break) and the characters
 * it draws as themselves (all but those it escapes and the space, tab and newline it draws as marks).
 */
function readForDisplay(text) {
  const tokens = [];
  const drawn = [];
  const chars = [...String(text)];
  // Whether the last character was drawn as itself: a combining mark is drawn only on one.
  let base = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === "\n") { tokens.push(["⏎", 1], "\n"); base = false; continue; }
    if (char === "\t") { tokens.push(["⇥", 1]); base = false; continue; }
    if (char === " ") {
      let run = 1;
      while (chars[index + run] === " ") run += 1;
      if (run > 3) {
        tokens.push([`␠×${run}`, 2 + String(run).length]);
        index += run - 1;
      } else {
        tokens.push([" ", 1]);
      }
      base = false;
      continue;
    }
    const combining = COMBINING.test(char);
    const escaped = INVISIBLE.test(char) || RTL.test(char) || MARKS.has(char) || (combining && !base)
      || (char === "\\" && chars[index + 1] === "u" && chars[index + 2] === "{");
    if (escaped) {
      const shown = escapeCodePoint(char);
      tokens.push([shown, shown.length]);
      base = false;
    } else {
      tokens.push([char, combining ? 0 : WIDE.test(char) ? 2 : 1]);
      drawn.push(char);
      base = !combining;
    }
  }
  return { tokens, drawn };
}

/**
 * Text for a confirmation dialog with every character visible: a newline is drawn as `⏎` and
 * breaks the line, a tab as `⇥`, a run of more than 3 spaces as `␠×N`, and any character that is
 * invisible or reorders text (bidi controls, right-to-left letters, zero-width characters, other
 * controls, separators, unusual spaces, a combining mark with no letter drawn just before it, such
 * as a second one) as `\u{XXXX}`; a backslash that would read as such an escape is escaped itself.
 * Lines are hard-wrapped at DISPLAY_COLUMNS, each continuation starting with `↪`, so nothing runs
 * off the dialog; `column` is where the text starts on its first line.
 */
function displaySafe(text, { column = 0 } = {}) {
  const { tokens } = readForDisplay(text);
  const lines = [];
  let line = "";
  let width = column;
  for (const token of tokens) {
    if (token === "\n") { lines.push(line); line = ""; width = 0; continue; }
    const [shown, size] = token;
    if (width && width + size > DISPLAY_COLUMNS) {
      lines.push(line);
      line = "↪ ";
      width = 2;
    }
    line += shown;
    width += size;
  }
  lines.push(line);
  return lines.join("\n");
}

/** How many columns text displaySafe has drawn takes. */
const shownWidth = (shown) => [...shown].reduce((sum, char) => sum + (COMBINING.test(char) ? 0 : WIDE.test(char) ? 2 : 1), 0);

// What the notes on top of a dialog list at most: look-alike characters and words that mix scripts.
const MAX_LISTED_CHARACTERS = 12;
const MAX_LISTED_WORDS = 3;
const MAX_WORD_CHARS = 40;
// Where a word ends in a command line or in JSON arguments; a dot, a slash or a hyphen does not
// end one, so a mixed-script domain or package name is named whole.
const WORD_BREAK = /[\s"'`,;=(){}[\]<>|&]+/u;
const LATIN = /\p{Script=Latin}/u;
const NON_LATIN_LETTER = /(?=\p{L})\P{Script=Latin}/u;
// Scripts named in a note, by Unicode's own names; anything else is named by its kind.
const SCRIPTS = ["Latin", "Greek", "Cyrillic", "Armenian", "Georgian", "Hebrew", "Arabic", "Syriac", "Thaana", "Nko", "Samaritan",
  "Mandaic", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala",
  "Thai", "Lao", "Tibetan", "Myanmar", "Khmer", "Mongolian", "Ethiopic", "Cherokee", "Canadian_Aboriginal", "Runic", "Ogham",
  "Coptic", "Glagolitic", "Tifinagh", "Hangul", "Hiragana", "Katakana", "Bopomofo", "Han", "Yi", "Vai", "Lisu", "Bamum", "Adlam",
  "Osage", "Deseret", "Gothic", "Old_Italic", "Cypriot", "Linear_B", "Tai_Le", "Buginese", "Javanese", "Balinese", "Sundanese"]
  .map((name) => [name.replace(/_/g, " "), new RegExp(`^\\p{Script=${name}}$`, "u")]);
const KINDS = [["letter", /^\p{L}$/u], ["mark", /^\p{M}$/u], ["number", /^\p{N}$/u], ["punctuation", /^\p{P}$/u], ["symbol", /^\p{S}$/u]];
const nameOf = (char) => (SCRIPTS.find(([, script]) => script.test(char))
  ?? KINDS.find(([, kind]) => kind.test(char)) ?? ["character"])[0];
const codePoint = (char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * One note listing `items` (at most `max`, then how many more), as dialogText parts: an item is
 * never split across lines if it fits on one, so a code point stays next to its character.
 */
function listNote(label, items, max) {
  const shown = items.slice(0, max);
  if (items.length > max) shown.push(`and ${items.length - max} more`);
  const parts = [label];
  let column = shownWidth(label);
  shown.forEach((item, index) => {
    const value = index < shown.length - 1 ? `${item},` : item;
    const width = shownWidth(displaySafe(value));
    if (index && column + 1 + width > DISPLAY_COLUMNS) {
      parts.push("\n↪ ");
      column = 2;
    } else {
      parts.push(" ");
      column += 1;
    }
    parts.push({ value });
    column += width;
  });
  return parts;
}

/**
 * The notes on top of a dialog, as dialogText parts: right-to-left text anywhere (it is shown
 * escaped), and, in what the agent asks for (not the app's `own` data), every character beyond
 * ASCII drawn as itself, which can pass for another (Cyrillic с for Latin c, a one-dot leader for a
 * full stop), with its code point and script, and every word mixing Latin with another script.
 */
function dialogNotes(values) {
  const notes = [];
  if (values.some((part) => HAS_RTL.test(String(part.value)))) notes.push(["Contains right-to-left text (shown escaped)."]);
  const asked = values.filter((part) => part.own !== true).map((part) => String(part.value));
  const foreign = [...new Set(asked.flatMap((value) => readForDisplay(value).drawn))].filter((char) => char.codePointAt(0) > 0x7f);
  if (foreign.length) {
    // A combining mark is named, not drawn: on its own it would sit on the space before it.
    notes.push(listNote("Contains non-ASCII characters:",
      foreign.map((char) => `${COMBINING.test(char) ? "" : `${char} `}${codePoint(char)} ${nameOf(char)}`), MAX_LISTED_CHARACTERS));
  }
  const mixed = [...new Set(asked.flatMap((value) => value.split(WORD_BREAK)))]
    .filter((word) => LATIN.test(word) && NON_LATIN_LETTER.test(word));
  if (mixed.length) {
    notes.push(listNote("Mixed scripts in:",
      mixed.map((word) => ([...word].length > MAX_WORD_CHARS ? `${[...word].slice(0, MAX_WORD_CHARS).join("")}…` : word)), MAX_LISTED_WORDS));
  }
  return notes.flatMap((note, index) => (index ? ["\n", ...note] : note));
}

/** Parts drawn one after another, each value with displaySafe from the column the text has reached. */
function renderParts(parts) {
  let text = "";
  for (const part of parts) {
    text += typeof part === "string" ? part : displaySafe(part.value, { column: shownWidth(text.slice(text.lastIndexOf("\n") + 1)) });
  }
  return text;
}

/**
 * The full dialog text, or null when it would not fit the dialog in full. `parts` are fixed
 * strings (the app's own wording, already wrapped) or `{ value }` for anything else, shown with
 * displaySafe; `{ value, own: true }` marks the app's own data (the AO session, the worktree, what
 * the policy says about a risk) as opposed to what the agent asks for. Notes on top say when the
 * text holds right-to-left letters, characters beyond ASCII or mixed-script words (see
 * dialogNotes); they count toward DIALOG_MAX_LINES like the rest.
 */
function dialogText(parts) {
  const values = parts.filter((part) => typeof part !== "string");
  // Far too long to fit (every shown character takes a column, a lone combining mark aside):
  // refused before it is drawn at all.
  if (values.some((part) => String(part.value).length > 4 * DISPLAY_COLUMNS * DIALOG_MAX_LINES)) return null;
  const notes = dialogNotes(values);
  const text = `${notes.length ? `${renderParts(notes)}\n\n` : ""}${renderParts(parts)}`;
  return text.split("\n").length <= DIALOG_MAX_LINES ? text : null;
}

/** The text of what a call would do, for its approval: [label, value] lines, or null if it cannot be shown in full. */
function describeCall(name, args, root) {
  if (name === "exec_command") {
    const workdir = String(args.workdir ?? args.cwd ?? ".");
    const full = root ? path.join(root.path, workdir) : workdir;
    // The worktree is the app's own; what the agent named inside it is the agent's.
    const directory = root && full.startsWith(root.path)
      ? [{ value: root.path, own: true }, ...(full.length > root.path.length ? [{ value: full.slice(root.path.length) }] : [])]
      : [{ value: full }];
    const input = typeof args.stdin === "string" && args.stdin ? ["\nInput:\n", { value: args.stdin }] : [];
    return ["Directory: ", ...directory, "\n\nCommand:\n", { value: String(args.cmd ?? "") }, ...input];
  }
  if (name === "write_stdin") {
    return ["Command: ", { value: String(args.command_id ?? args.session_id ?? "") }, "\n\nInput:\n", { value: String(args.chars ?? "") }];
  }
  if (PATCH_TOOLS.has(name) && typeof args.patch === "string") {
    const files = parsePatch(args.patch);
    if (!files.length || files.length > MAX_CONFIRM_PATHS) return null;
    // Deletes first, each critical file marked: confirming a patch approves all of them.
    const ordered = [...files.filter((file) => file.operation === "delete"), ...files.filter((file) => file.operation !== "delete")];
    const deletes = ordered.filter((file) => file.operation === "delete");
    const critical = ordered.filter((file) => criticalFile(file.path));
    const lines = ordered.flatMap((file) => [
      `\n${file.operation === "delete" ? "DELETE" : file.operation}${criticalFile(file.path) ? " (critical file)" : ""}: `,
      { value: file.path || "(no path)" },
      ...(file.moveTo ? [" (its Move to: ", { value: file.moveTo }, " is not applied; the file is changed in place)"] : []),
    ]);
    const rest = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "patch"));
    return [
      `Files (${files.length}; ${deletes.length} deleted, ${critical.length} critical):`, ...lines,
      ...(Object.keys(rest).length ? ["\n\nOther arguments:\n", { value: JSON.stringify(rest, null, 1) }] : []),
    ];
  }
  return ["Arguments:\n", { value: JSON.stringify(args, null, 1) ?? "{}" }];
}

/** The call's arguments without any consent the agent tried to give itself. */
function withoutConsent(args) {
  const clean = { ...args };
  for (const key of CONSENT_ARGUMENTS) delete clean[key];
  return clean;
}

/** The call's arguments with every path scoped to the worktree; throws ScopeError on any escape. */
function scopeArguments(name, args, root) {
  const scoped = { ...args };
  if (Object.hasOwn(scoped, "project_root")) scoped.project_root = scopePath(root, scoped.project_root, "project_root");
  for (const key of PATH_ARGUMENTS[name] ?? []) {
    if (scoped[key] !== undefined && scoped[key] !== null) scoped[key] = scopePath(root, scoped[key], key);
  }
  for (const key of PATH_LIST_ARGUMENTS[name] ?? []) {
    if (scoped[key] === undefined || scoped[key] === null) continue;
    if (!Array.isArray(scoped[key])) throw new ScopeError(`${key} must be a list of paths`);
    scoped[key] = scoped[key].map((value) => scopePath(root, value, key));
  }
  if (PATCH_TOOLS.has(name) && typeof scoped.patch === "string") {
    for (const target of patchTargets(scoped.patch)) scopePath(root, target, "patch target", { write: true });
  }
  // Commands start in the worktree unless they name a directory inside it.
  if (name === "exec_command" && scoped.workdir === undefined && scoped.cwd === undefined) scoped.workdir = ".";
  return scoped;
}

function instructionsFor(groups, { bypass = false } = {}) {
  return "Coding Tools tools for this chat's own git worktree: read_file, list_dir, search_text and apply_patch "
    + "for files; git_* for this worktree's history. Paths are relative to the worktree root and paths outside it are refused. "
    + (groups.includes("terminal")
      ? "exec_command, write_stdin, read_output and kill_command run commands through the app's terminal. A command "
        + "starts in the worktree but is NOT confined to it: it can read and write anything the user's account can. "
        + (bypass ? "" : "The user confirms each command and each input sent to one, shown in full: a command with its "
          + "input must fit about 20 short lines, so write anything longer to a script file with apply_patch and run that. ")
      : "")
    + "When the workspace policy needs approval for an operation, the user is asked in the app; never pass confirm "
    + "or approval_token yourself (they are ignored). "
    + (groups.includes("terminal")
      ? "Start a dev server or any long-running process with exec_command and a short yield_time_ms, and leave it running: "
        + "it keeps running in the background, the user watches its output in the chat's Terminal pane, and you read "
        + "more of it with read_output. "
      : "")
    + (groups.includes("preview")
      ? "preview_open opens a page your dev server serves on this machine (localhost only) in this chat's own browser, "
        + "which the user sees in the chat's Preview pane; preview_read, preview_screenshot, preview_click, preview_type, "
        + "preview_press, preview_scroll, preview_wait and preview_console let you check the page works as intended. "
      : "")
    + (groups.includes("desktop")
      ? "capture_screenshot, list_windows and computer_* see and drive the desktop: the user confirms each screen "
        + "capture, and computer control works only while the user has enabled it in the app and allowed this chat. "
      : "")
    + "Large results are paged; ask for less per call.";
}

/**
 * Whether a chat's preview may open a loopback origin it has not opened before without asking the
 * user: "allow", or "ask" to show the user a prompt first. By the time this runs, previewTarget
 * has already refused anything that is not http(s) on localhost/127.x/[::1] and every port of the
 * app's own services. `origin` is like "http://localhost:5173"; `bypass` is true when the session
 * was launched to bypass permissions; `servedHere` is true when one of this chat's own running
 * commands printed that host and port (usually its dev server). It is a hint, not proof: the agent
 * writes those commands, so `echo localhost:8888` would set it for a port it never served.
 */
function previewOriginDecision({ origin, bypass, servedHere }) {
  // TODO(human): decide when a new origin opens without a prompt.
  return "ask";
}

/** What the agent is told when a call cannot be shown to the user in full: nothing ran. */
function tooLongToShow(name) {
  const limit = `A confirmation shows what will run in full, every character visible, in at most ${DIALOG_MAX_LINES} lines `
    + `of ${DISPLAY_COLUMNS} characters`;
  if (name === "exec_command") {
    return `${limit}; this command and its input do not fit, so it was not run. Use a shorter command, or write a `
      + "script file with apply_patch first and run that.";
  }
  if (name === "write_stdin") {
    return `${limit}; this input does not fit, so it was not sent. Send it in smaller pieces, or write it to a file `
      + "with apply_patch and have the command read that.";
  }
  if (PATCH_TOOLS.has(name)) {
    return `${limit}, one line per file and at most ${MAX_CONFIRM_PATHS} files; this patch does not fit, so it was not `
      + "applied. Split it into smaller patches.";
  }
  return `${limit}; this ${name} call does not fit, so it was not run. Use shorter arguments.`;
}

function createChatAgentTools({
  requestHeadless, sessionWorkspace = null, confirm = null,
  enabled = () => true, terminalEnabled = () => false, desktopEnabled = () => false,
  // The chat's own browser (chat-preview.cjs), on unless the user turns it off.
  previews = null, previewEnabled = () => true,
  // Why a command line is a routine project command "Approve for me" may run unasked, or null.
  routineCommand = () => null,
  // Where the leases (credential hashes, never credentials) and the port are kept across restarts.
  statePath = null,
  worktreesRoot = null,
  logger = console, version = "1", now = Date.now,
  // How long the user must have had a prompt open for an approval to count (see MIN_ANSWER_MS),
  // on a monotonic clock.
  minAnswerMs = MIN_ANSWER_MS, answerClock = () => performance.now(),
} = {}) {
  if (typeof requestHeadless !== "function") throw new Error("The headless tool service is required");
  // Identifies this server's lifetime in warm-session keys without exposing any credential.
  const instance = crypto.randomUUID();
  const sessions = new Map(); // key -> session entry (see mint)
  let server = null;
  let listening = null;
  let port = 0;
  let sweeper = null;

  const setting = (read) => {
    try { return read() === true; } catch { return false; }
  };
  const isEnabled = () => {
    try { return enabled() !== false; } catch { return false; }
  };
  const optIns = { terminal: terminalEnabled, desktop: desktopEnabled, preview: () => Boolean(previews) && previewEnabled() };
  /** The groups a new session gets now: agent tools when the setting is on, plus each opted-in group. */
  const currentGroups = () => (isEnabled() ? GROUPS.filter((group) => group === "agent" || setting(optIns[group])) : []);
  // A group is usable only if the session got it and the setting still allows it.
  const allowed = (entry, group) => entry.groups.includes(group) && currentGroups().includes(group);

  /**
   * Forgets a credential. `ended` means its AO session is over (it ended, moved, or was killed),
   * which also closes that session's preview; a credential retired for a newer one of the same
   * session, or evicted, leaves the preview to the session.
   */
  function forget(key, { ended = false } = {}) {
    const entry = sessions.get(key);
    if (!entry) return;
    sessions.delete(key);
    entry.expected = null;
    save();
    if (ended && entry.aoSession && ![...sessions.values()].some((other) => other.aoSession === entry.aoSession)) {
      try { previews?.close(entry.aoSession); } catch { /* the window is gone */ }
    }
  }

  function mint({ agent, workspaceId, approvalMode, autoReview = false }) {
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((left, right) => left.usedAt - right.usedAt)[0];
      forget(oldest.key);
    }
    const key = crypto.randomBytes(18).toString("base64url");
    const token = crypto.randomBytes(32).toString("base64url");
    const entry = {
      // Only the credential's hash is held (and kept on disk), never the credential itself.
      key, agent, workspaceId, groups: currentGroups(), expected: hashBearer(`Bearer ${token}`),
      // Only a session launched to bypass permissions runs commands without a confirmation each.
      // Captured once, at spawn time, from the mode the session was launched with: changing the
      // session's mode in AO later does not change it here, either way (a relaunch gets a new lease).
      bypass: approvalMode === "bypass-permissions", controlAllowed: false,
      // Launched with "Approve for me": its routine project commands run without a dialog each.
      autoReview: autoReview === true,
      aoSession: null, root: null, checkedAt: 0, createdAt: now(), usedAt: now(),
      // The commands it started (for the Terminal pane) and the preview origins it may open.
      commands: new Map(), origins: new Set(),
    };
    sessions.set(key, entry);
    save();
    return { entry, token };
  }

  function authorized(request, entry) {
    const given = hashBearer(String(request.headers.authorization || ""));
    const expected = entry?.expected ?? crypto.randomBytes(32);
    return crypto.timingSafeEqual(given, expected) && Boolean(entry?.expected);
  }

  // ---- Leases kept across app restarts ---------------------------------------------------------
  // A chat session outlives the app (AO keeps it running through an update), but its MCP server
  // address and credential were this process's: after a restart the agent lost the app's tools.
  // The leases (each credential's hash, never the credential) and the port are kept in `statePath`;
  // the next app listens on the same port and honours them, so a running agent keeps its tools.
  // They are restored only when that port is ours again: had something else taken it, it may have
  // collected the agents' credentials, and those are dropped instead.
  // Residual risk, accepted: a process running as the user could take the port while the app is
  // away (an update leaves it free for minutes), collect the credentials agents keep sending, and
  // free it again before the app returns; the leases would then be honoured. Dropping leases no
  // agent reuses soon would not stop it (the collector can use one first), and such a process can
  // already read the agents' own MCP configuration, so nothing more is done here.
  const LEASE_FILE_VERSION = 1;
  const LEASE_MAX_IDLE_MS = 7 * 24 * 60 * 60_000;
  let saveTimer = null;
  let restored = { port: 0, entries: [] };

  function writeLeases() {
    if (typeof statePath !== "string" || !statePath || !port) return;
    const data = {
      version: LEASE_FILE_VERSION, port,
      sessions: [...sessions.values()].filter((entry) => entry.expected).map((entry) => ({
        key: entry.key, hash: entry.expected.toString("hex"), agent: entry.agent, workspaceId: entry.workspaceId, aoSession: entry.aoSession,
        groups: entry.groups, bypass: entry.bypass, autoReview: entry.autoReview, createdAt: entry.createdAt, usedAt: entry.usedAt,
        origins: [...entry.origins].slice(0, 50),
      })),
    };
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      const temporary = `${statePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, statePath);
    } catch (error) {
      logger.warn?.("chat_agent_tools.leases_not_saved", { message: errorMessage(error) });
    }
  }
  let closing = false;
  function save() {
    if (closing || typeof statePath !== "string" || !statePath || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; writeLeases(); }, 200);
    saveTimer.unref?.();
  }
  function readLeases() {
    if (typeof statePath !== "string" || !statePath) return { port: 0, entries: [] };
    let data;
    try { data = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { port: 0, entries: [] }; }
    if (data?.version !== LEASE_FILE_VERSION || !Number.isInteger(data.port) || data.port <= 0 || data.port > 65535) return { port: 0, entries: [] };
    const entries = (Array.isArray(data.sessions) ? data.sessions : []).slice(0, MAX_SESSIONS)
      .filter((saved) => SESSION_KEY.test(String(saved?.key)) && /^[0-9a-f]{64}$/.test(String(saved?.hash))
        && MCP_HTTP_AGENTS.has(saved.agent) && WORKSPACE_ID.test(String(saved.workspaceId))
        && (saved.aoSession === null || /^[a-zA-Z0-9_-]{1,128}$/.test(String(saved.aoSession)))
        && Number.isFinite(saved.usedAt) && now() - saved.usedAt < LEASE_MAX_IDLE_MS)
      .map((saved) => ({
        key: saved.key, agent: saved.agent, workspaceId: saved.workspaceId, expected: Buffer.from(saved.hash, "hex"),
        groups: (Array.isArray(saved.groups) ? saved.groups : []).filter((group) => GROUPS.includes(group)),
        bypass: saved.bypass === true, controlAllowed: false, autoReview: saved.autoReview === true,
        aoSession: saved.aoSession ?? null, root: null, checkedAt: 0, createdAt: Number(saved.createdAt) || now(), usedAt: saved.usedAt,
        commands: new Map(), origins: new Set((Array.isArray(saved.origins) ? saved.origins : []).filter((origin) => typeof origin === "string").slice(0, 50)),
      }));
    return { port: data.port, entries };
  }
  restored = readLeases();

  /** AO's worktrees folder, resolved, when the app named it. */
  function worktreesBase() {
    if (typeof worktreesRoot !== "string" || !path.isAbsolute(worktreesRoot)) return null;
    try { return fs.realpathSync.native(worktreesRoot); } catch { return path.resolve(worktreesRoot); }
  }

  /** The session's worktree, as AO reports it; throws a message for the agent when it is not usable. */
  async function rootOf(entry) {
    if (!entry.aoSession) throw new ScopeError("This chat's session workspace is not ready yet; try again in a moment.");
    if (entry.root && now() - entry.checkedAt < ROOT_RECHECK_MS) return entry.root;
    if (typeof sessionWorkspace !== "function") throw new ScopeError("This chat's session workspace is unavailable.");
    let found;
    try {
      found = await sessionWorkspace(entry.aoSession);
    } catch (error) {
      // AO did not answer; a worktree it reported before is still this session's.
      if (entry.root) return entry.root;
      logger.warn?.("chat_agent_tools.workspace_unavailable", { message: errorMessage(error) });
      throw new ScopeError("This chat's session workspace is not ready yet; try again in a moment.");
    }
    if (found?.ended) {
      forget(entry.key, { ended: true });
      throw new ScopeError("This chat's session has ended; its tools are no longer available.");
    }
    const reported = typeof found?.root === "string" && path.isAbsolute(found.root) ? path.resolve(found.root) : null;
    if (!reported) throw new ScopeError("This chat's session workspace is not ready yet; try again in a moment.");
    let real;
    try {
      if (!fs.statSync(reported).isDirectory()) throw new Error("not a directory");
      real = fs.realpathSync.native(reported);
    } catch {
      throw new ScopeError("This chat's session workspace is not ready yet; try again in a moment.");
    }
    const base = worktreesBase();
    if (base && (!inside(base, real) || path.relative(base, real) === "")) {
      // Only AO's own session worktrees are roots, never the user's checkout or anything else.
      throw new ScopeError("This chat's session workspace is not one of AO's worktrees; its tools are unavailable.");
    }
    if (entry.root && path.relative(entry.root.path, reported) !== "") {
      // A session never moves to another tree; refuse rather than follow it.
      forget(entry.key, { ended: true });
      throw new ScopeError("This chat's session workspace changed; its tools are no longer available.");
    }
    entry.root = { path: reported, real };
    entry.checkedAt = now();
    return entry.root;
  }

  async function listTools(entry) {
    const catalog = await requestHeadless(`/api/v1/tools/catalog?workspace_id=${encodeURIComponent(entry.workspaceId)}`, null, { method: "GET" });
    // The preview's tools are the app's own, not headless's.
    const own = allowed(entry, "preview") ? PREVIEW_TOOL_DEFS : [];
    return [...(Array.isArray(catalog?.tools) ? catalog.tools : []).filter((tool) => !PREVIEW_TOOLS.has(tool?.name)), ...own]
      .filter((tool) => typeof tool?.name === "string" && groupOf(tool.name) && allowed(entry, groupOf(tool.name)))
      // outputSchema is left out: clients would validate structuredContent against it, and the
      // agent gains nothing from it.
      .map(({ name, title, description, inputSchema, annotations }) => ({
        name, ...(title ? { title } : {}), ...(description ? { description } : {}),
        inputSchema: inputSchema && typeof inputSchema === "object" ? inputSchema : { type: "object" },
        ...(annotations ? { annotations } : {}),
      }));
  }

  // Every prompt, from every session and every call in a batch, waits for the one before it: two
  // dialogs never stack, so a second click can never land on a prompt the user has not seen.
  let prompting = Promise.resolve();

  /**
   * Asks the user in the app; true when they agree, otherwise the refusal to return to the agent.
   * `detail` is the full dialog text (see dialogText): null means it cannot be shown in full, and
   * the call is refused without asking.
   */
  function ask(message, detail, declined, tooLong = "This call cannot be shown to the user in full, so it was not run.") {
    if (detail === null) return Promise.resolve(failedCall(tooLong));
    const turn = prompting.then(() => askNow(message, detail, declined));
    prompting = turn.catch(() => undefined);
    return turn;
  }

  async function askNow(message, detail, declined) {
    for (let attempt = 0; attempt < MAX_QUICK_ANSWERS; attempt += 1) {
      const opened = answerClock();
      let approved = false;
      try {
        approved = typeof confirm === "function" && await confirm({
          message: attempt ? `That answer came too quickly to have been read. ${message}` : message, detail,
        }) === true;
      } catch (error) {
        return failedCall(`The user could not be asked, so nothing was run: ${errorMessage(error)}`);
      }
      if (!approved) return failedCall(declined);
      // An approval sooner than the user could have read the prompt is not one: ask again.
      if (answerClock() - opened >= minAnswerMs) return true;
    }
    return failedCall(`The user's approval came too quickly to have been read, ${MAX_QUICK_ANSWERS} times; nothing was run or sent.`);
  }

  /** One call to headless: `{ result }` once it completed, or `{ failed }` with the agent's error. */
  async function invoke(entry, name, args, root) {
    let response;
    try {
      response = await requestHeadless("/api/v1/tools/call", {
        request_id: crypto.randomUUID(), workspace_id: entry.workspaceId, tool: name, arguments: args,
        // Desktop tools act on the screen, not on files, and computer control is leased to the
        // workspace itself; everything else runs in the session's worktree.
        ...(root ? { root: root.path } : {}),
      }, { timeout: TOOL_CALL_TIMEOUT_MS });
    } catch (error) {
      return { failed: failedCall(errorMessage(error)) };
    }
    const operation = response?.operation;
    if (operation?.state !== "completed") {
      return { failed: failedCall(typeof operation?.error === "string" && operation.error
        ? operation.error.slice(0, 2000) : "The tool call did not complete; its outcome is unknown.") };
    }
    return { result: operation.result };
  }

  const who = (entry) => [`Agent: ${entry.agent}\nAO session: `, { value: String(entry.aoSession), own: true }, "\n"];

  /** The user's confirmation of one command or one input to a command, unless the session bypasses permissions. */
  async function confirmTerminal(entry, name, args, root) {
    if (entry.bypass) return false;
    if (name === "exec_command") {
      // "Approve for me": a routine project command (an install from the lockfile, the project's
      // own scripts and checks, a version check) runs as it would from the agent's own shell. It
      // counts as confirmed, so a routine approval the workspace asks for is not asked again.
      let routine = null;
      try { routine = entry.autoReview && !(typeof args.stdin === "string" && args.stdin) ? routineCommand(String(args.cmd ?? "")) : null; } catch { routine = null; }
      if (routine) return true;
      return ask("A chat agent wants to run a command",
        dialogText([...who(entry), ...describeCall(name, args, root),
          "\n\nThe command starts in the chat's worktree but is not confined to it:\n"
            + "it can read and change anything your user account can. Run it once?"]),
        "The user declined this command; it was not run.", tooLongToShow(name));
    }
    // An empty write only polls the command's output; it sends nothing.
    if (name === "write_stdin" && typeof args.chars === "string" && args.chars) {
      return ask("A chat agent wants to type into a running command",
        dialogText([...who(entry), "Worktree: ", { value: root.path, own: true }, "\n", ...describeCall(name, args, root), "\n\nSend it once?"]),
        "The user declined this input; it was not sent.", tooLongToShow(name));
    }
    return false;
  }

  // An approval the user already gave for the command itself covers only a routine one; any
  // other risk is shown and asked about (see approveAndRetry).
  const ROUTINE_RISK = "routine_mutation";
  const gateKey = (failure) => `${failure.code}:${typeof failure.details?.risk === "string" ? failure.details.risk : ""}`;

  /**
   * The workspace policy wants the user's approval (APPROVAL_REQUIRED) or confirmation
   * (DANGEROUS_OPERATION_REQUIRES_CONFIRMATION) for this exact call: ask the user, showing the
   * risk and the reason, then obtain a one-use grant in the session's own context and retry the
   * call once with it. The grant never reaches the agent. A command the user just confirmed is
   * not asked about again only for a routine approval; a confirmation never stands in for a risk
   * the user was not shown, so each new gate (a dangerous command, a destructive, network,
   * interpreter or elevation risk) is asked about with its own risk.
   */
  async function approveAndRetry(entry, name, args, root, failure, alreadyConfirmed) {
    const shown = new Set();
    const gate = async (current) => {
      if (shown.has(gateKey(current))) return true;
      if (alreadyConfirmed && current.code === "APPROVAL_REQUIRED" && current.details?.risk === ROUTINE_RISK) return true;
      const risk = typeof current.details?.risk === "string" && current.details.risk
        ? current.details.risk : current.code === "DANGEROUS_OPERATION_REQUIRES_CONFIRMATION" ? "dangerous operation" : "";
      const reason = [current.details?.summary, current.message].filter((value) => typeof value === "string" && value).join("\n");
      const call = describeCall(name, args, root);
      const answer = await ask(`A chat agent's ${name} call needs your approval${risk ? ` (risk: ${risk})` : ""}`,
        call && dialogText([
          ...who(entry), "Worktree: ", { value: root ? root.path : "(the workspace)", own: true }, `\nTool: ${name}\n`,
          ...(risk ? ["Risk: ", { value: risk, own: true }, "\n"] : []),
          ...(reason ? ["\nWhy:\n", { value: reason, own: true }, "\n"] : []),
          "\n", ...call, "\n\nAllow it once?",
        ]),
        `The user declined ${name}; it was not run.`, tooLongToShow(name));
      if (answer === true) shown.add(gateKey(current));
      return answer;
    };
    // A confirmation can be followed by an approval for the same call (or the other way round):
    // each is supplied at most once, then whatever headless answers goes back to the agent.
    let callArgs = args;
    let current = failure;
    let result = null;
    const tokens = [];
    for (let round = 0; round < 2; round += 1) {
      const needed = (current.code === "DANGEROUS_OPERATION_REQUIRES_CONFIRMATION" && callArgs.confirm !== true)
        || (current.code === "APPROVAL_REQUIRED" && typeof current.details?.request_id === "string" && !callArgs.approval_token);
      if (!needed) break;
      const answer = await gate(current);
      if (answer !== true) return answer;
      if (current.code === "DANGEROUS_OPERATION_REQUIRES_CONFIRMATION") {
        callArgs = { ...callArgs, confirm: true };
      } else {
        const granted = await invoke(entry, "request_permissions",
          { request_id: current.details.request_id, scope: "once", confirm: true, reason: "Approved by the user in Coding Tools" }, root);
        const token = granted.result?.ok === true && typeof granted.result.approval_token === "string" ? granted.result.approval_token : null;
        if (!token) {
          const why = granted.failed?.content?.[0]?.text || granted.result?.error?.message || "no grant was issued";
          return failedCall(`The user approved ${name}, but the approval could not be recorded: ${String(why).slice(0, 500)}`);
        }
        tokens.push(token);
        callArgs = { ...callArgs, approval_token: token };
      }
      const retried = await invoke(entry, name, callArgs, root);
      if (retried.failed) return retried.failed;
      // Nothing of a grant goes back to the agent.
      result = JSON.parse(tokens.reduce((text, token) => text.split(token).join("[redacted]"), JSON.stringify(retried.result ?? null)));
      current = result && typeof result === "object" && result.ok === false ? result.error : null;
      if (!current) break;
    }
    return toolResult(name, args, result);
  }

  async function callTool(entry, params) {
    const name = params?.name;
    if (typeof name !== "string" || !name || name.length > 128) return failedCall("A tool name is required");
    if (!isEnabled()) return failedCall("The app's tools for chat agents are turned off in Settings.");
    const group = groupOf(name);
    if (!group || !allowed(entry, group)) return failedCall(`Unknown tool: ${name}`);
    const given = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
    let args = withoutConsent(given);
    let root;
    try {
      root = await rootOf(entry);
      if (group !== "desktop") args = scopeArguments(name, args, root);
    } catch (error) {
      if (error instanceof ScopeError) return failedCall(error.message);
      throw error;
    }
    if (CONFIRMED_TOOLS.has(name)) {
      // What it observes (which window, which display) is part of what the user allows.
      const details = Object.keys(args).length ? ["\n", ...describeCall(name, args, null)] : [];
      const answer = await ask(`A chat agent wants to ${CONFIRMED_TOOLS.get(name)}`,
        dialogText([...who(entry), `Tool: ${name}\n`, ...details, "\nAllow this once?"]), `The user declined ${name}.`, tooLongToShow(name));
      if (answer !== true) return answer;
    }
    if (CONTROL_TOOLS.has(name) && !entry.controlAllowed) {
      // This allows the chat, not one action, so the action's arguments are not what is approved.
      const answer = await ask("A chat agent wants to control your screen",
        dialogText([...who(entry), `Tool: ${name}\n\nWhile you have computer control enabled in Coding Tools, this chat could\n`
          + "click and type in the window you enabled it for. Control is enabled for the\n"
          + "workspace, not for one chat: every chat you allow here can use it while it\n"
          + "is on. Allow this chat?"]),
        `The user did not allow this chat to control the screen (${name}).`);
      if (answer !== true) return answer;
      entry.controlAllowed = true;
    }
    let confirmed = false;
    if (group === "terminal") {
      const answer = await confirmTerminal(entry, name, args, root);
      if (answer !== true && answer !== false) return answer;
      confirmed = answer === true;
    }
    if (group === "preview") {
      // The session's own browser; which addresses it may open is the user's call (permitOrigin).
      return previews.call(entry.aoSession, name, args, { permit: (origin) => permitOrigin(entry, origin) });
    }
    const rooted = group === "desktop" ? null : root;
    const outcome = await invoke(entry, name, args, rooted);
    if (outcome.failed) return outcome.failed;
    const failure = outcome.result && typeof outcome.result === "object" && outcome.result.ok === false ? outcome.result.error : null;
    const result = (failure?.code === "APPROVAL_REQUIRED" && typeof failure.details?.request_id === "string")
      || failure?.code === "DANGEROUS_OPERATION_REQUIRES_CONFIRMATION"
      ? await approveAndRetry(entry, name, args, rooted, failure, confirmed)
      : toolResult(name, args, outcome.result);
    track(entry, name, args, result);
    return result;
  }

  /** Remembers a command the session started, and what became of it, for the chat's Terminal pane. */
  function track(entry, name, args, result) {
    const value = result?.structuredContent;
    const id = typeof value?.command_id === "string" && COMMAND_ID.test(value.command_id) ? value.command_id : null;
    if (!id || result.isError) return;
    const status = { status: value.status === "running" ? "running" : String(value.status ?? "exited"),
      exitCode: Number.isInteger(value.exit_code) ? value.exit_code : null };
    if (name === "exec_command") {
      entry.commands.set(id, { id, cmd: String(args.cmd ?? "").slice(0, 2000), workdir: String(args.workdir ?? "."), startedAt: now(), ...status });
      while (entry.commands.size > MAX_TRACKED_COMMANDS) {
        const oldest = [...entry.commands.values()].sort((left, right) => (left.status === "running") - (right.status === "running") || left.startedAt - right.startedAt)[0];
        entry.commands.delete(oldest.id);
      }
    } else if (entry.commands.has(id) && ["write_stdin", "kill_command", "kill_session"].includes(name)) {
      Object.assign(entry.commands.get(id), status);
    }
  }

  /** Whether one of the session's running commands printed this origin's port: its own dev server. */
  async function servedHere(entry, origin) {
    const { hostname, port } = new URL(origin);
    const number = port || (origin.startsWith("https:") ? "443" : "80");
    // The same host (localhost, 127.0.0.1 and [::1] count as one), then the port.
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hosts = ["localhost", "127.0.0.1", "[::1]"].includes(hostname) ? ["localhost", "127.0.0.1", "[::1]"] : [hostname];
    const mention = new RegExp(`(?<![\\w.-])(?:${hosts.map(escape).join("|")}):${number}(?![0-9])`, "i");
    for (const command of entry.commands.values()) {
      if (command.status !== "running") continue;
      for (const stream of ["stdout", "stderr"]) {
        const read = await invoke(entry, "read_output", { output_ref: `command:${command.id}:${stream}`, offset: 0, limit: MAX_PANE_READ_BYTES }, entry.root);
        if (mention.test(String(read.result?.content ?? ""))) return true;
      }
    }
    return false;
  }

  /**
   * Whether this chat may open `origin` in its preview for the first time: true, or the refusal to
   * return to the agent. Once allowed, an origin stays allowed for the session.
   */
  async function permitOrigin(entry, origin) {
    if (entry.origins.has(origin)) return true;
    const decision = previewOriginDecision({ origin, bypass: entry.bypass, servedHere: await servedHere(entry, origin).catch(() => false) });
    if (decision !== "allow") {
      const answer = await ask("A chat agent wants to open a page in its preview",
        dialogText([...who(entry), "Address: ", { value: origin }, "\n\nThe chat's own browser would load this page served on this computer; the\n"
          + "agent could read it, click and type in it. Allow this address for this chat?"]),
        `The user did not allow this chat to open ${origin}.`);
      if (answer !== true) return answer;
    }
    entry.origins.add(origin);
    save();
    return true;
  }

  async function dispatch(entry, message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(message?.id ?? null, -32600, "Invalid request");
    }
    const notification = !Object.hasOwn(message, "id");
    if (notification) return null;
    const { id, method, params } = message;
    try {
      switch (method) {
        case "initialize": {
          const requested = params?.protocolVersion;
          return { jsonrpc: "2.0", id, result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, title: "Coding Tools", version: String(version) },
            instructions: instructionsFor(entry.groups.filter((group) => allowed(entry, group)), { bypass: entry.bypass }),
          } };
        }
        case "ping": return { jsonrpc: "2.0", id, result: {} };
        case "tools/list": return { jsonrpc: "2.0", id, result: { tools: await listTools(entry) } };
        case "tools/call": return { jsonrpc: "2.0", id, result: await callTool(entry, params) };
        default: return rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      return rpcError(id, -32603, errorMessage(error));
    }
  }

  function send(response, status, body, headers = {}) {
    const payload = body === undefined ? "" : JSON.stringify(body);
    response.writeHead(status, {
      ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      "cache-control": "no-store", ...headers,
    });
    response.end(payload);
  }

  function handle(request, response) {
    const host = String(request.headers.host || "");
    const match = /^\/mcp\/([^/?#]+)\/([^/?#]+)$/.exec(String(request.url || "").split("?")[0]);
    let workspaceId = null;
    try { workspaceId = match ? decodeURIComponent(match[1]) : null; } catch { workspaceId = null; }
    const key = match?.[2] ?? "";
    // Loopback clients only: a browser page (Origin) or a rebinding host name is refused.
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) || request.headers.origin) {
      send(response, 403, rpcError(null, -32000, "Forbidden"));
      return;
    }
    if (!workspaceId || !WORKSPACE_ID.test(workspaceId) || !SESSION_KEY.test(key)) {
      send(response, 404, rpcError(null, -32000, "Unknown session path"));
      return;
    }
    // A credential opens only its own session's path, and only in the workspace it was minted for.
    const entry = sessions.get(key);
    if (!authorized(request, entry) || entry.workspaceId !== workspaceId) {
      send(response, 401, rpcError(null, -32001, "Unauthorized"), { "www-authenticate": "Bearer" });
      return;
    }
    entry.usedAt = now();
    if (request.method !== "POST") {
      // No server-initiated stream and no session to delete.
      send(response, 405, undefined, { allow: "POST" });
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      if (size > MAX_BODY_BYTES) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        response.once("finish", () => request.destroy());
        send(response, 413, rpcError(null, -32600, "Request too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", async () => {
      if (size > MAX_BODY_BYTES) return;
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { send(response, 400, rpcError(null, -32700, "Parse error")); return; }
      const batch = Array.isArray(parsed);
      const messages = batch ? parsed : [parsed];
      if (!messages.length || messages.length > 32) { send(response, 400, rpcError(null, -32600, "Invalid request")); return; }
      // One message at a time: a batch of calls that each need the user's confirmation asks
      // about them one after another, never all at once.
      const answers = [];
      for (const message of messages) {
        const answer = await dispatch(entry, message);
        if (answer) answers.push(answer);
      }
      if (!answers.length) send(response, 202, undefined);
      else send(response, 200, batch ? answers : answers[0]);
    });
  }

  /** Forgets credentials never bound to a session, and those whose session AO reports ended. */
  async function sweep() {
    for (const entry of [...sessions.values()]) {
      if (!entry.aoSession) {
        if (now() - entry.createdAt >= UNBOUND_TTL_MS) forget(entry.key);
        continue;
      }
      if (typeof sessionWorkspace !== "function") continue;
      const found = await Promise.resolve().then(() => sessionWorkspace(entry.aoSession)).catch(() => null);
      if (found?.ended) forget(entry.key, { ended: true });
    }
  }

  // The chat's Terminal and Preview panes act for the user, never for the agent.

  const SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;
  /** The live credential of an AO session (the newest one), or null. */
  function entryFor(sessionId) {
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
    return [...sessions.values()].filter((entry) => entry.aoSession === sessionId).sort((left, right) => right.usedAt - left.usedAt)[0] ?? null;
  }

  // The panes reach a session the app holds no lease for (one started before the app restarted
  // and lost it, or with the tools off) through its AO worktree all the same: the user's own view
  // of it, with no credential and none of the agent's tools.
  const paneEntries = new Map(); // AO session -> its pane-only entry
  function paneEntry(sessionId, workspaceId) {
    const leased = entryFor(sessionId);
    if (leased) return leased;
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId) || typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) return null;
    let entry = paneEntries.get(sessionId);
    if (!entry || entry.workspaceId !== workspaceId) {
      entry = { key: `pane-${sessionId}`, agent: "user", workspaceId, groups: [], expected: null, bypass: false, autoReview: false, controlAllowed: false,
        aoSession: sessionId, root: null, checkedAt: 0, createdAt: now(), usedAt: now(), commands: entry?.commands ?? new Map(), origins: new Set(), pane: true };
      paneEntries.set(sessionId, entry);
      while (paneEntries.size > 64) paneEntries.delete(paneEntries.keys().next().value);
    }
    return entry;
  }

  /**
   * A call the user made from a pane (stop a command, type into it): their click is the consent,
   * so a routine approval or a confirmation the workspace policy asks for is granted for that one
   * call. Returns the tool's structured result, or throws with the reason.
   */
  async function invokeAsUser(entry, name, args) {
    const root = await rootOf(entry);
    let callArgs = args;
    for (let round = 0; round < 3; round += 1) {
      const outcome = await invoke(entry, name, callArgs, root);
      if (outcome.failed) throw new Error(outcome.failed.content?.[0]?.text ?? `${name} failed`);
      const failure = outcome.result?.ok === false ? outcome.result.error : null;
      if (failure?.code === "DANGEROUS_OPERATION_REQUIRES_CONFIRMATION" && callArgs.confirm !== true) {
        callArgs = { ...callArgs, confirm: true };
      } else if (failure?.code === "APPROVAL_REQUIRED" && typeof failure.details?.request_id === "string" && !callArgs.approval_token) {
        const granted = await invoke(entry, "request_permissions",
          { request_id: failure.details.request_id, scope: "once", confirm: true, reason: "The user did this from the chat's Terminal pane" }, root);
        const token = granted.result?.ok === true && typeof granted.result.approval_token === "string" ? granted.result.approval_token : null;
        if (!token) throw new Error("The workspace policy did not allow it");
        callArgs = { ...callArgs, approval_token: token };
      } else {
        if (failure) throw new Error(String(failure.message ?? failure.code ?? `${name} failed`).slice(0, 300));
        return outcome.result;
      }
    }
    throw new Error(`${name} needed more approvals than expected`);
  }

  const commandOf = (entry, commandId) => {
    const command = typeof commandId === "string" && COMMAND_ID.test(commandId) ? entry.commands.get(commandId) : null;
    if (!command) throw new Error("That command is not one of this chat's");
    return command;
  };

  /** One read of a command's output from `offset`, with whether it still runs. */
  async function readCommand(entry, command, stream, offset) {
    const root = await rootOf(entry);
    const read = await invoke(entry, "read_output", {
      output_ref: `command:${command.id}:${stream}`, offset: Math.max(0, Number(offset) || 0), limit: MAX_PANE_READ_BYTES,
    }, root);
    const value = read.result?.ok === false ? null : read.result;
    if (!value) {
      // Headless forgot it (its output expired, or headless restarted): it no longer runs.
      if (command.status === "running") command.status = "gone";
      return { content: "", nextOffset: Math.max(0, Number(offset) || 0), gap: false, status: command.status, exitCode: command.exitCode };
    }
    if (typeof value.status === "string") command.status = value.status;
    if (Number.isInteger(value.exit_code)) command.exitCode = value.exit_code;
    return {
      content: String(value.content ?? ""), nextOffset: Number(value.next_read_offset ?? offset) || 0, gap: value.output_gap === true,
      status: command.status, exitCode: command.exitCode,
    };
  }

  function listen() {
    listening ??= new Promise((resolve, reject) => {
      const created = http.createServer(handle);
      // The previous app's port first, so agents it leased keep reaching their tools.
      let wanted = restored.port || 0;
      created.on("error", (error) => {
        if (!port && wanted && error?.code === "EADDRINUSE") {
          logger.warn?.("chat_agent_tools.port_taken", { port: wanted });
          wanted = 0;
          created.listen(0, "127.0.0.1");
          return;
        }
        if (listening && !port) { listening = null; reject(error); }
        else logger.warn?.("chat_agent_tools.server_error", { message: errorMessage(error) });
      });
      created.once("listening", () => {
        server = created;
        port = created.address().port;
        created.unref();
        if (restored.entries.length) {
          if (restored.port === port) {
            for (const entry of restored.entries) if (!sessions.has(entry.key)) sessions.set(entry.key, entry);
            logger.info?.("chat_agent_tools.leases_restored", { count: restored.entries.length });
          } else {
            logger.warn?.("chat_agent_tools.leases_dropped", { count: restored.entries.length, reason: "port_changed" });
          }
        }
        restored = { port: 0, entries: [] };
        writeLeases();
        sweeper ??= setInterval(() => { void sweep().catch(() => undefined); }, SWEEP_MS);
        sweeper.unref?.();
        logger.info?.("chat_agent_tools.listening", { port });
        resolve(port);
      });
      created.listen(wanted, "127.0.0.1");
    });
    return listening;
  }

  return Object.freeze({
    /**
     * Tools for one AO chat session about to be spawned, or null when the setting is off, the
     * agent's driver cannot take an HTTP server, or the workspace id is unusable. `servers` go into
     * the spawn's mcpServers; `bind(sessionId)` ties the credential to the session AO created (its
     * worktree becomes the root), and `release()` forgets it when the spawn failed. `approvalMode`
     * is the session's AO permission mode: only "bypass-permissions" runs every command unconfirmed;
     * `autoReview` (the card is set to "Approve for me") runs its routine project commands unconfirmed.
     */
    async lease({ agent, workspaceId, approvalMode = null, autoReview = false } = {}) {
      if (!isEnabled() || !MCP_HTTP_AGENTS.has(agent) || typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) return null;
      await listen();
      const { entry, token } = mint({ agent, workspaceId, approvalMode, autoReview });
      const url = `http://127.0.0.1:${port}/mcp/${encodeURIComponent(workspaceId)}/${entry.key}`;
      return Object.freeze({
        servers: [{ name: SERVER_NAME, type: "http", url, headers: { Authorization: `Bearer ${token}` } }],
        bind(sessionId) {
          if (sessions.get(entry.key) !== entry) return false;
          if (typeof sessionId !== "string" || !sessionId || (entry.aoSession && entry.aoSession !== sessionId)) {
            forget(entry.key);
            return false;
          }
          // One credential per session: an older one for the same session is retired.
          for (const other of [...sessions.values()]) {
            if (other === entry || other.aoSession !== sessionId) continue;
            // The session's commands and the origins it was allowed to open stay its own.
            for (const [id, command] of other.commands) if (!entry.commands.has(id)) entry.commands.set(id, command);
            for (const origin of other.origins) entry.origins.add(origin);
            forget(other.key);
          }
          entry.aoSession = sessionId;
          save();
          return true;
        },
        release() { forget(entry.key); },
      });
    },
    /** Forgets the credential of an AO session that has ended (it was killed or deleted). */
    forgetSession(sessionId) {
      for (const entry of [...sessions.values()]) if (entry.aoSession === sessionId) forget(entry.key, { ended: true });
    },
    /**
     * What a launch would attach now: the tool groups (agent[+terminal][+desktop]) and this
     * server's lifetime, never a credential or anything per session. "pending" until the server
     * listens.
     */
    identity() {
      const groups = currentGroups();
      if (!groups.length) return "off";
      return port ? `on|${groups.join("+")}|${instance}` : "pending";
    },
    /** The commands each of these AO sessions started, newest first, with whether they still run. */
    async processes(sessionIds = [], workspaceId = null) {
      const out = [];
      for (const sessionId of [...new Set(Array.isArray(sessionIds) ? sessionIds : [])].slice(0, 32)) {
        const entry = paneEntry(sessionId, workspaceId);
        if (!entry) continue;
        const commands = [...entry.commands.values()].sort((left, right) => right.startedAt - left.startedAt);
        // A running command is asked about once per listing; finished ones stay as they ended.
        for (const command of commands) if (command.status === "running") await readCommand(entry, command, "stdout", Number.MAX_SAFE_INTEGER).catch(() => undefined);
        out.push({ sessionId, agent: entry.agent, commands: commands.map(({ id, cmd, workdir, startedAt, status, exitCode, user }) => ({ id, cmd, workdir, startedAt, status, exitCode, user: user === true })) });
      }
      return out;
    },
    /** A command's output (stdout or stderr) from `offset`; `nextOffset` continues it. */
    async processOutput({ sessionId, workspaceId, commandId, stream = "stdout", offset = 0 } = {}) {
      const entry = paneEntry(sessionId, workspaceId);
      if (!entry) throw new Error("That chat agent's session has ended");
      if (stream !== "stdout" && stream !== "stderr") throw new Error("stream must be stdout or stderr");
      return readCommand(entry, commandOf(entry, commandId), stream, offset);
    },
    /** The user stops one of the chat's commands. */
    async processStop({ sessionId, workspaceId, commandId } = {}) {
      const entry = paneEntry(sessionId, workspaceId);
      if (!entry) throw new Error("That chat agent's session has ended");
      const command = commandOf(entry, commandId);
      const value = await invokeAsUser(entry, "kill_command", { command_id: command.id, wait_ms: 3000 });
      command.status = value?.status === "terminating" ? "running" : "killed";
      return { ok: true, status: command.status };
    },
    /** The user types into one of the chat's running commands (a newline is sent as typed). */
    async processInput({ sessionId, workspaceId, commandId, text } = {}) {
      const entry = paneEntry(sessionId, workspaceId);
      if (!entry) throw new Error("That chat agent's session has ended");
      if (typeof text !== "string" || !text || text.length > 4000) throw new Error("Type 1 to 4000 characters");
      const command = commandOf(entry, commandId);
      await invokeAsUser(entry, "write_stdin", { command_id: command.id, chars: text, yield_time_ms: 200, max_output_bytes: 0 });
      return { ok: true };
    },
    /**
     * The user's own shell in the session's worktree (the side panel's Terminal tab): PowerShell on
     * a terminal, listed with the session's commands so its output and input use the same panes.
     * The user started it, so no dialog asks.
     */
    async terminalStart({ sessionId, workspaceId } = {}) {
      const entry = paneEntry(sessionId, workspaceId);
      if (!entry) throw new Error("That chat agent's session has ended");
      const cmd = WINDOWS ? 'powershell.exe -NoLogo -NoProfile -NoExit -Command "Remove-Module PSReadLine -ErrorAction SilentlyContinue"' : "bash -i";
      const value = await invokeAsUser(entry, "exec_command", { cmd, workdir: ".", tty: true, yield_time_ms: 500, max_output_bytes: 4096 });
      const id = typeof value?.command_id === "string" && COMMAND_ID.test(value.command_id) ? value.command_id : null;
      if (!id) throw new Error("The terminal did not start");
      entry.commands.set(id, { id, cmd: "Terminal", workdir: ".", startedAt: now(), status: "running", exitCode: null, user: true });
      return { ok: true, commandId: id };
    },
    /**
     * The session worktree's changes for the side panel's Changes tab: git's status (with new files)
     * and the diff of tracked files, as headless reads them in that worktree.
     */
    async changes({ sessionId, workspaceId } = {}) {
      const entry = paneEntry(sessionId, workspaceId);
      if (!entry) throw new Error("That chat agent's session has ended");
      const status = await invokeAsUser(entry, "git_status", { include_untracked: true, max_entries: 500 });
      const diff = await invokeAsUser(entry, "git_diff", { context_lines: 3, max_bytes: 512 * 1024 });
      return {
        ok: true, root: entry.root?.path ?? null, branch: typeof status?.branch === "string" ? status.branch : "",
        entries: Array.isArray(status?.entries) ? status.entries.slice(0, 500) : [],
        diff: typeof diff?.diff === "string" ? diff.diff : "", truncated: diff?.truncated === true,
      };
    },
    /** One folder of the session's worktree for the Files tab (`path` relative to its root). */
    async files({ sessionId, workspaceId, path: folder = "." } = {}) {
      const entry = paneEntry(sessionId, workspaceId);
      if (!entry) throw new Error("That chat agent's session has ended");
      const root = await rootOf(entry);
      const listed = await invokeAsUser(entry, "list_dir", { path: scopePath(root, folder || ".", "path") });
      return { ok: true, path: folder || ".", entries: Array.isArray(listed?.entries) ? listed.entries.slice(0, 1000) : [], truncated: listed?.truncated === true };
    },
    /** One file of the session's worktree for the Files tab, as text. */
    async file({ sessionId, workspaceId, path: target } = {}) {
      const entry = paneEntry(sessionId, workspaceId);
      if (!entry) throw new Error("That chat agent's session has ended");
      const root = await rootOf(entry);
      const read = await invokeAsUser(entry, "read_file", { path: scopePath(root, target, "path"), max_bytes: 512 * 1024 });
      return { ok: true, path: target, content: typeof read?.content === "string" ? read.content : "", encoding: read?.encoding ?? null,
        truncated: read?.truncated === true };
    },
    /** What each session's preview shows, for the Preview pane (sessions without one are left out). */
    previewState(sessionIds = []) {
      if (!previews) return {};
      const out = {};
      for (const sessionId of [...new Set(Array.isArray(sessionIds) ? sessionIds : [])].slice(0, 32)) {
        if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) continue;
        const state = previews.state(sessionId);
        if (state) out[sessionId] = state;
      }
      return out;
    },
    previewShow(sessionId, bounds, zoom) {
      if (!previews || typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return false;
      return previews.show(sessionId, bounds, zoom);
    },
    previewHide() { previews?.hide(); },
    /** The user's own navigation in a session's preview: back, forward, reload or a loopback URL. */
    async previewNavigate(sessionId, request) {
      if (!previews || typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return { ok: false, error: "No preview" };
      if (request?.url !== undefined && !entryFor(sessionId)) return { ok: false, error: "That chat agent's session has ended" };
      return previews.navigate(sessionId, request ?? {});
    },
    /** The port this server listens on (0 before it does), so a preview never opens it. */
    servicePort() { return port; },
    listen,
    sweep,
    async close() {
      // The leases stay on disk for the next app; closing forgets them only in this process.
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      writeLeases();
      closing = true;
      const current = server;
      server = null; listening = null; port = 0;
      if (sweeper) clearInterval(sweeper);
      sweeper = null;
      for (const key of [...sessions.keys()]) forget(key);
      if (current) await new Promise((resolve) => current.close(() => resolve()));
    },
  });
}

module.exports = Object.freeze({
  AGENT_TOOLS,
  DESKTOP_TOOLS,
  MCP_HTTP_AGENTS,
  SERVER_NAME,
  TERMINAL_TOOLS,
  createChatAgentTools,
  dialogText,
  displaySafe,
  parsePatch,
  patchTargets,
  previewOriginDecision,
  scopePath,
  toolResult,
  windowsQuirk,
});
