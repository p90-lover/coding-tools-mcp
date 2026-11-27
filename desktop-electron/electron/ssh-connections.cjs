"use strict";

// SSH hosts the person approved, and the host key they confirmed for each (Connections > SSH hosts).
//
// The user asked for "a list of SSH hosts the user approves, an in-app SSH terminal for them, and
// agents may run ssh/scp only to approved hosts, under review; key files, tunnels and ProxyCommand
// stay blocked" (2026-11-26). This module is the list: it is the only place that validates a host,
// builds an ssh command line, or decides which host keys are trusted.
//
// What holds here:
// - A host is three validated fields (host, port, user). No free-text arguments, no jump hosts, and
//   the person's ssh config is never read (-F none on every command line).
// - A key is trusted only after the person confirmed its fingerprint. The key probe only shows
//   what the server presented; it never trusts it and never writes the pinned file.
// - ssh trusts a key for a host and port, whoever signs in: when a server shows another key, every
//   entry for it is blocked, and taking trust away does not wait for (or depend on) the disk.
// - The store file is the source of truth. The pinned-keys file is written whole from the pinned
//   records on every change and at start, so a line added to it by hand does not survive.
// - The key blob never leaves this process: the shape sent to the window carries fingerprints only.
// - Logs carry event names, a host id and counts. Never a host name, a path, a command line or a
//   fingerprint.
//
// Found on the target machine (2026-11-26, OpenSSH_for_Windows_9.5p2): ssh-keyscan fails against a
// current server, so the probe is ssh itself with every sign-in method off; an unknown -o option
// is fatal, so no option newer than the client is passed; and a known-hosts path with a space
// needs literal double quotes inside the option value, or ssh splits it and writes the first piece.

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { writePrivateFileAtomicAsync } = require("./atomic-file.cjs");
const { runOffThread } = require("./off-thread-run.cjs");

const STORE_VERSION = 1;
const DEFAULT_PORT = 22;
const MAX_HOSTS = 200;
/** The probe's hard wall-clock limit; the child is ended when it passes. */
const PROBE_TIMEOUT_MS = 25_000;
const VERSION_TIMEOUT_MS = 10_000;
/** A client that could not be read is asked again only after this long, not on every list. */
const VERSION_RETRY_MS = 60_000;
const STORE_READ_RETRY_DELAYS_MS = Object.freeze([100, 250, 500]);
const MAX_PROBE_FILE_BYTES = 64 * 1024;
const MAX_KEY_BLOB_CHARS = 16 * 1024;
const OPERATIONS = Object.freeze(["list", "add", "update", "remove", "fetch_key", "confirm_key"]);
const STATES = Object.freeze(["draft", "pinned", "changed"]);
const PINNED_FILE_HEADER = "# Coding Tools writes this file from its SSH hosts list. Changes made here are lost.";

/** A refusal worded for the person: its message is shown on the hosts page as it is. */
class SshHostsError extends Error {
  constructor(message, code = "invalid") {
    super(message);
    this.name = "SshHostsError";
    this.code = code;
  }
}

function refuse(message, code) {
  throw new SshHostsError(message, code);
}

const accepted = (value) => ({ ok: true, value });
const rejected = (error) => ({ ok: false, error });

function describeCharacter(character) {
  if (character === "\"") return "A double quote";
  if (character === "'") return "A single quote";
  if (character === "`") return "A backtick";
  return `"${character}"`;
}

/** The name shown to the person: 1 to 60 characters, nothing invisible. */
function validateLabel(input) {
  if (typeof input !== "string" || !input.trim()) return rejected("Name: enter a name for this host.");
  const label = input.trim();
  if ([...label].length > 60) return rejected("Name: use at most 60 characters.");
  if (/[\p{C}\p{Zl}\p{Zp}]/u.test(label)) return rejected("Name: a name cannot contain line breaks or invisible characters.");
  return accepted(label);
}

/** The eight 16-bit groups of an IPv6 address already checked by net.isIPv6 (hex digits and colons only). */
function ipv6Groups(text) {
  const groups = (part) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
  if (!text.includes("::")) return groups(text);
  const [head, tail] = text.split("::");
  const left = groups(head);
  const right = groups(tail);
  return [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}

/**
 * Whether the client writes this address with an IPv4 address inside it. Checked on the target
 * machine with `ssh -G` (2026-11-27, OpenSSH_for_Windows_9.5p2): "::ffff:c000:201" is written
 * "::ffff:192.0.2.1", "::1:0" is "::0.1.0.0" and "fe80::200:5efe:c000:201" is
 * "fe80::200:5efe:192.0.2.1". The host field takes hex and colons only, so such an address could
 * never match the name ssh gives its key; mapped, compatible, translated and ISATAP forms are refused.
 */
function embedsIpv4(groups) {
  const zero = (from, to) => groups.slice(from, to).every((group) => group === 0);
  if (zero(0, 5) && (groups[5] === 0xffff || (groups[5] === 0 && groups[6] !== 0))) return true;
  if (zero(0, 4) && groups[4] === 0xffff && groups[5] === 0) return true;
  return groups[5] === 0x5efe && (groups[4] & 0xfdff) === 0;
}

/**
 * A host name, an IPv4 address or an IPv6 address, stored lower-case. The client's own checks are
 * not relied on (it accepts a user name with a space): what passes here is all that reaches argv.
 */
function validateHost(input) {
  if (typeof input !== "string" || input === "") return rejected("Host: enter a host name or an IP address.");
  if (input.length > 253) return rejected("Host: a host name can be at most 253 characters.");
  if (/[\s\x00-\x1f\x7f]/.test(input)) return rejected("Host: a host name cannot contain spaces, tabs or line breaks. Remove them and try again.");
  if (/[^\x21-\x7e]/.test(input)) return rejected("Host: use plain ASCII letters and digits only. For an international name, enter its xn-- form.");
  if (input.includes("://")) return rejected("Host: enter the host name only, not an ssh:// address. The user and the port have their own fields.");
  if (input.includes("@")) return rejected("Host: enter the host name only. The user has its own field.");
  if (input.startsWith("-")) return rejected("Host: a host name cannot start with a hyphen.");
  if (/[[\]]/.test(input)) return rejected("Host: enter an IPv6 address without square brackets. The port has its own field.");
  if (input.includes("%") && input.includes(":")) return rejected("Host: an IPv6 address with a zone (the part after %) is not supported.");
  const unusable = input.match(/[^A-Za-z0-9.:-]/);
  if (unusable) return rejected(`Host: ${describeCharacter(unusable[0])} is not allowed in a host name. Use letters, digits, dots and hyphens.`);
  if (input.includes(":")) {
    if (/^[^:]+:[0-9]+$/.test(input)) return rejected("Host: enter the host name only. The port has its own field.");
    if (!/^[0-9A-Fa-f:]+$/.test(input) || !net.isIPv6(input)) {
      return rejected("Host: this is not a valid IPv6 address. Use hex digits and colons only, like 2001:db8::1.");
    }
    if (embedsIpv4(ipv6Groups(input))) {
      return rejected("Host: this IPv6 address has an IPv4 address inside it, which ssh writes another way. Enter the server's IPv4 address, or another IPv6 address of it.");
    }
    // ssh writes an address in its short form before it looks up or saves its key ("2001:0db8::1"
    // is "2001:db8::1", checked with `ssh -G` on the target machine, 2026-11-27). Kept as typed, its
    // key could never be fetched, and two spellings of one server would be two hosts with two keys.
    return accepted(new URL(`http://[${input}]`).hostname.slice(1, -1));
  }
  const host = input.toLowerCase();
  // A name that ends in a number is an address to the resolver ("127.1", "0x7f.1" and a bare
  // "2130706433" all reach 127.0.0.1 on some systems), so it must be a full dotted address.
  const last = host.slice(host.lastIndexOf(".") + 1);
  if (/^[0-9.]+$/.test(host) || /^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) {
    if (!net.isIPv4(host)) return rejected("Host: this looks like an IP address but is not a valid one. Use four numbers from 0 to 255, like 192.0.2.10.");
    return accepted(host);
  }
  if (!/^[a-z0-9]/.test(host) || !/[a-z0-9]$/.test(host)) return rejected("Host: a host name starts and ends with a letter or a digit.");
  if (host.includes("..")) return rejected("Host: a host name cannot have two dots in a row.");
  if (host.split(".").some((label) => label.length > 63)) return rejected("Host: each part of a host name (between dots) can be at most 63 characters.");
  return accepted(host);
}

function validateUser(input) {
  if (typeof input !== "string" || input === "") return rejected("User: enter the user name you sign in with on the server.");
  if (input.length > 32) return rejected("User: a user name can be at most 32 characters.");
  if (/[\s\x00-\x1f\x7f]/.test(input)) return rejected("User: a user name cannot contain spaces, tabs or line breaks.");
  if (input.includes("@")) return rejected("User: enter the user name only, without @ and the host. The host has its own field.");
  if (input.includes("\\")) return rejected("User: Windows domain logins (DOMAIN\\name) are not supported. Enter the user name only.");
  if (input.startsWith("-")) return rejected("User: a user name cannot start with a hyphen.");
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(input)) {
    return rejected("User: use letters, digits, dots, underscores and hyphens only, starting with a letter, a digit or an underscore.");
  }
  return accepted(input);
}

/** Digits only, 1 to 65535; nothing given means 22. */
function validatePort(input) {
  if (input === undefined || input === null || input === "") return accepted(DEFAULT_PORT);
  const text = typeof input === "number" && Number.isInteger(input) ? String(input) : input;
  if (typeof text !== "string" || !/^[0-9]{1,5}$/.test(text)) return rejected("Port: use digits only, from 1 to 65535. Leave it empty for 22.");
  const port = Number(text);
  if (port < 1 || port > 65535) return rejected("Port: use a number from 1 to 65535. Leave it empty for 22.");
  return accepted(port);
}

/** What is wrong with a key file's path, or null. */
function identityFileProblem(text, windows) {
  if (text.length > 1024) return "Key file: the path is too long.";
  if (/[\x00-\x1f\x7f]/.test(text)) return "Key file: the path cannot contain line breaks or control characters.";
  if (text.includes("\"")) return "Key file: the path cannot contain double quotes.";
  // ssh expands % tokens and ${NAME} in a key path, so the file it opened would not be the one named.
  if (text.includes("%") || text.includes("${")) return "Key file: the path cannot contain % or ${ (ssh would replace them). Move or rename the file.";
  if (windows ? !/^[A-Za-z]:[\\/]/.test(text) : !text.startsWith("/")) {
    return windows
      ? "Key file: enter the full path, starting with a drive letter (for example C:\\Users\\you\\.ssh\\id_ed25519)."
      : "Key file: enter the full path, starting with /.";
  }
  // Windows drops trailing dots and spaces from a name: "id.pub." and "id.pub " open id.pub.
  if (windows ? /\.pub[. ]*$/i.test(text) : /\.pub$/i.test(text)) return "Key file: choose the private key, not the .pub file next to it.";
  return null;
}

/**
 * The private key's path, or null. Only its shape is judged here; that a file is there is checked
 * when the host is added and again before a terminal opens (createSshConnections' fileExists). The
 * path alone is kept, never contents.
 */
function validateIdentityFile(input, { platform = process.platform } = {}) {
  if (input === undefined || input === null || input === "") return accepted(null);
  if (typeof input !== "string") return rejected("Key file: choose the private key file by its full path.");
  const windows = platform === "win32";
  const typed = identityFileProblem(input, windows);
  if (typed) return rejected(typed);
  // The rules are judged again on the path as it is kept: "id_ed25519.pub\." passed as typed and is
  // the .pub file once normalised (review, 2026-11-27). A kept path must pass this same check at the
  // next start, or the host would be dropped from the list there.
  const file = (windows ? path.win32 : path.posix).normalize(input);
  const kept = identityFileProblem(file, windows);
  return kept ? rejected(kept) : accepted(file);
}

const NEW_HOST_FIELDS = Object.freeze(["label", "host", "port", "user", "identityFile", "production"]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every field of a new host, or the first field that is wrong. */
function validateNewHost(input, { platform = process.platform } = {}) {
  if (!plainObject(input)) return rejected("Enter the host's name, host, port and user.");
  if (Object.keys(input).some((name) => !NEW_HOST_FIELDS.includes(name))) return rejected("SSH hosts take no extra options or arguments.");
  const value = {};
  for (const [name, check] of [
    ["label", validateLabel], ["host", validateHost], ["port", validatePort], ["user", validateUser],
    ["identityFile", (file) => validateIdentityFile(file, { platform })],
  ]) {
    const result = check(input[name]);
    if (!result.ok) return result;
    value[name] = result.value;
  }
  if (input.production !== undefined && typeof input.production !== "boolean") return rejected("Production: choose on or off.");
  value.production = input.production === true;
  return accepted(value);
}

/** The key bytes of a base64 blob, or null when it is not exactly base64. */
function keyBytes(blob) {
  if (typeof blob !== "string" || !blob || blob.length > MAX_KEY_BLOB_CHARS || blob.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;
  const bytes = Buffer.from(blob, "base64");
  return bytes.toString("base64") === blob ? bytes : null;
}

/** The key type a blob names itself: its first field, a length-prefixed string. */
function keyTypeIn(bytes) {
  if (!bytes || bytes.length < 5) return null;
  const length = bytes.readUInt32BE(0);
  if (length < 1 || length > 64 || length > bytes.length - 4) return null;
  const type = bytes.subarray(4, 4 + length).toString("latin1");
  return /^[a-z0-9@.-]+$/.test(type) ? type : null;
}

/** The fingerprint as ssh prints it: "SHA256:" and the unpadded base64 SHA-256 of the key bytes. */
function fingerprintOf(blob) {
  const bytes = keyBytes(blob);
  if (!bytes) throw new SshHostsError("The host key is not valid.", "malformed_key");
  return `SHA256:${crypto.createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`;
}

/** How a host is named in a known-hosts file: the host, or [host]:port for any other port. */
function knownHostsName(host, port) {
  return port === DEFAULT_PORT ? host : `[${host}]:${port}`;
}

/** One line of a known-hosts file as { name, type, blob }, or null for anything else. */
function parseKnownHostsLine(line) {
  if (typeof line !== "string") return null;
  const fields = line.trim().split(/[ \t]+/);
  // A marker line (@cert-authority, @revoked) would trust or revoke far more than one key.
  if (fields.length < 3 || fields[0].startsWith("@") || fields[0].startsWith("#")) return null;
  const [name, type, blob] = fields;
  if (keyTypeIn(keyBytes(blob)) !== type) return null;
  return { name, type, blob };
}

/** The pinned file's line for one host and its confirmed key. */
function knownHostsLine({ host, port, key }) {
  const name = validateHost(host);
  const number = validatePort(port);
  if (!name.ok || name.value !== host || !number.ok || number.value !== port) throw new SshHostsError("This host cannot be pinned.", "invalid");
  if (!key || keyTypeIn(keyBytes(key.blob)) !== key.type) throw new SshHostsError("The host key is not valid.", "malformed_key");
  return `${knownHostsName(host, port)} ${key.type} ${key.blob}`;
}

/** The whole pinned-keys file: one line for each pinned record, nothing else. */
function pinnedKeysText(records) {
  const lines = new Set();
  for (const record of records) {
    if (record?.state !== "pinned" || !record.key) continue;
    lines.add(knownHostsLine(record));
  }
  return `${[PINNED_FILE_HEADER, ...lines].join("\n")}\n`;
}

/**
 * %SystemRoot% as the contract names it, when it is a plain folder path. windir is not read: it is a
 * variable one `setx windir` sets for the user. A root that walks elsewhere ("C:\Windows\..\Users")
 * or is a drive's top folder (anyone may make C:\System32) is not used either (review, 2026-11-27).
 */
function usableSystemRoot(value) {
  if (typeof value !== "string" || !/^[A-Za-z]:\\[^"<>|?*\x00-\x1f]+$/.test(value)) return false;
  // normalize changes a path with "." or ".." parts, forward slashes or doubled separators.
  if (path.win32.normalize(value) !== value) return false;
  return value.slice(3).split("\\").filter(Boolean).every((part) => !/[. ]$/.test(part));
}

/** ssh by absolute path, never from PATH or the current folder: a planted ssh there must not run. */
function sshProgram({ platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32") return "/usr/bin/ssh";
  const root = [env.SystemRoot, env.SYSTEMROOT].find(usableSystemRoot);
  return path.win32.join(root || "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
}

// What the child may see. Nothing of the app's own (its gateway key, proxy settings) and no
// SSH_ASKPASS or agent socket: the probe must never be able to prompt or offer a credential.
const CHILD_ENVIRONMENT = new Set([
  "systemroot", "systemdrive", "windir", "temp", "tmp", "userprofile", "homedrive", "homepath", "username",
  "userdomain", "computername", "programdata", "allusersprofile", "localappdata", "appdata",
  "home", "user", "logname", "lang", "lc_all", "tz",
]);

function childEnvironment(source = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(source || {})) {
    if (typeof value === "string" && CHILD_ENVIRONMENT.has(name.toLowerCase())) env[name] = value;
  }
  return env;
}

/** { version, major, minor } from what `ssh -V` prints ("OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2"). */
function parseClientVersion(text) {
  const found = String(text ?? "").match(/OpenSSH[A-Za-z_]*_([0-9]{1,3})\.([0-9]{1,3})(?:p[0-9]{1,3})?/);
  if (!found) return null;
  return { version: found[0], major: Number(found[1]), minor: Number(found[2]) };
}

/** Whether the client is at least major.minor; an unread version counts as current. */
function clientAtLeast(client, major, minor) {
  if (!client || !Number.isInteger(client.major) || !Number.isInteger(client.minor)) return true;
  return client.major > major || (client.major === major && client.minor >= minor);
}

/**
 * A file path as an ssh option value. The value is read as a config line, so a path with a space is
 * split unless it sits in double quotes inside the value; forward slashes keep a backslash from
 * being read as an escape, and %% keeps a percent sign from being read as a token.
 */
function optionPath(file, platform = process.platform) {
  const windows = platform === "win32";
  if (typeof file !== "string" || !(windows ? path.win32 : path.posix).isAbsolute(file)
    || /[\x00-\x1f\x7f"]/.test(file) || file.includes("${") || (!windows && file.includes("\\"))) {
    throw new SshHostsError("The app's data folder has a name ssh cannot be given.", "unsupported_path");
  }
  return `"${(windows ? file.replaceAll("\\", "/") : file).replaceAll("%", "%%")}"`;
}

function optionArguments(pairs) {
  return pairs.flatMap(([name, value]) => ["-o", `${name}=${value}`]);
}

/**
 * The host-key options that open every command line. Before OpenSSH 8.5 CheckHostIP was on unless
 * turned off: the probe's line then names "host,address", which is not the name asked for, and a
 * terminal adds the address to the pinned file. From 8.5 it is off, and the option is not passed.
 */
function hostKeyOptions(strict, knownHostsFile, client, platform) {
  return [
    ["StrictHostKeyChecking", strict],
    ["UserKnownHostsFile", optionPath(knownHostsFile, platform)],
    ["GlobalKnownHostsFile", "none"],
    ...(clientAtLeast(client, 8, 5) ? [] : [["CheckHostIP", "no"]]),
  ];
}

// On every command line, after the host-key options: nothing is forwarded, nothing local runs,
// no connection is shared, and no agent is asked for keys.
const LOCKED_OPTIONS = Object.freeze([
  ["UpdateHostKeys", "no"], ["VerifyHostKeyDNS", "no"],
  ["ForwardAgent", "no"], ["ForwardX11", "no"], ["ForwardX11Trusted", "no"], ["ClearAllForwardings", "yes"], ["Tunnel", "no"],
  ["PermitLocalCommand", "no"], ["ProxyCommand", "none"], ["ControlMaster", "no"], ["ControlPath", "none"],
  ["Compression", "no"], ["IdentityAgent", "none"], ["AddKeysToAgent", "no"],
]);

/** The destination's three fields, validated again here so that nothing unchecked reaches argv. */
function destination({ host, port, user }) {
  const name = validateHost(host);
  const number = validatePort(port);
  const login = validateUser(user);
  for (const result of [name, number, login]) if (!result.ok) throw new SshHostsError(result.error, "invalid");
  if (name.value !== host) throw new SshHostsError("Host: use the stored lower-case host name (an IPv6 address in its short form).", "invalid");
  return ["-p", String(number.value), "-l", login.value, "--", name.value];
}

/**
 * The key probe: ssh with every sign-in method off, writing the key the server presents into a
 * throwaway file. It exits 255 ("Permission denied") and leaves one line there. Nothing is
 * trusted: the throwaway file is read, compared and deleted, and the pinned file is not named.
 */
function probeArgv({ host, port, user, knownHostsFile, client = null, platform = process.platform }) {
  if (!clientAtLeast(client, 7, 6)) throw new SshHostsError("This computer's OpenSSH is too old to check a host key safely. Update OpenSSH, then try again.", "old_client");
  return [
    "-F", "none",
    ...optionArguments([
      ...hostKeyOptions("accept-new", knownHostsFile, client, platform),
      ...LOCKED_OPTIONS,
      ["BatchMode", "yes"], ["PubkeyAuthentication", "no"], ["PasswordAuthentication", "no"],
      // The option's name before OpenSSH 8.7; an unknown option is fatal.
      [clientAtLeast(client, 8, 7) ? "KbdInteractiveAuthentication" : "ChallengeResponseAuthentication", "no"],
      ["ConnectTimeout", "8"], ["ConnectionAttempts", "1"],
    ]),
    "-T", "-n", ...destination({ host, port, user }),
  ];
}

/**
 * The in-app terminal's command line for a pinned host: the server must show the pinned key, the
 * person answers every prompt in the terminal, and nothing follows the host.
 */
function terminalArgv({ host, port, user, identityFile = null, state, knownHostsFile, client = null, platform = process.platform }) {
  if (state !== "pinned") throw new SshHostsError("Confirm this host's key before opening a terminal to it.", "not_pinned");
  const key = validateIdentityFile(identityFile, { platform });
  if (!key.ok) throw new SshHostsError(key.error, "invalid");
  return [
    "-F", "none",
    ...optionArguments([
      ...hostKeyOptions("yes", knownHostsFile, client, platform),
      ...LOCKED_OPTIONS,
      ["EscapeChar", "none"],
      // Added in OpenSSH 9.2; an older client stops at an option it does not know.
      ...(clientAtLeast(client, 9, 2) ? [["EnableEscapeCommandline", "no"]] : []),
      ["ConnectTimeout", "15"], ["ConnectionAttempts", "1"],
      ["ServerAliveInterval", "30"], ["ServerAliveCountMax", "3"],
      ["BatchMode", "no"],
      ...(key.value ? [["IdentitiesOnly", "yes"]] : []),
    ]),
    ...(key.value ? ["-i", key.value] : []),
    "-t", ...destination({ host, port, user }),
  ];
}

function publicKey(key) {
  return key ? { type: key.type, fingerprint: key.fingerprint, pinnedAt: key.pinnedAt, method: key.method } : null;
}

function publicCandidate(candidate) {
  return candidate ? { type: candidate.type, fingerprint: candidate.fingerprint, fetchedAt: candidate.fetchedAt } : null;
}

/** The record as the window sees it: every field but the key blobs. */
function publicHost(record) {
  return {
    id: record.id, label: record.label, host: record.host, port: record.port, user: record.user,
    identityFile: record.identityFile, production: record.production, state: record.state,
    key: publicKey(record.key), candidate: publicCandidate(record.candidate), createdAt: record.createdAt,
  };
}

function storedTime(value) {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** A key as saved, with its fingerprint worked out again from the blob; null when it is not a key. */
function storedKey(raw, timeField) {
  if (!plainObject(raw) || typeof raw.type !== "string" || keyTypeIn(keyBytes(raw.blob)) !== raw.type) return null;
  const at = storedTime(raw[timeField]);
  return at ? { type: raw.type, blob: raw.blob, fingerprint: fingerprintOf(raw.blob), [timeField]: at } : null;
}

/** One saved record, checked field by field as a new one is; null when any part of it is not right. */
function storedRecord(raw, platform) {
  if (!plainObject(raw) || typeof raw.id !== "string" || !/^[0-9a-f]{12}$/.test(raw.id)) return null;
  const fields = validateNewHost({
    label: raw.label, host: raw.host, port: raw.port, user: raw.user, identityFile: raw.identityFile,
  }, { platform });
  if (!fields.ok || fields.value.host !== raw.host || fields.value.port !== raw.port || !STATES.includes(raw.state)) return null;
  const createdAt = storedTime(raw.createdAt);
  if (!createdAt) return null;
  const pinned = storedKey(raw.key, "pinnedAt");
  const key = pinned && ["pasted", "compared"].includes(raw.key.method) ? { ...pinned, method: raw.key.method } : null;
  // A record that says pinned or changed without a confirmed key is a draft: nothing is trusted for it.
  const state = key ? raw.state : "draft";
  return {
    // A production flag that is not a boolean reads as on: the stricter rule, never the looser one.
    id: raw.id, ...fields.value, production: raw.production !== false, state,
    key: state === "draft" ? null : key, candidate: storedKey(raw.candidate, "fetchedAt"), createdAt,
  };
}

/** ssh trusts a host key for a host and port, whoever signs in: two entries that share both are one server. */
const sameServer = (one, other) => one.host === other.host && one.port === other.port;
const sameEntry = (one, other) => sameServer(one, other) && one.user === other.user;
const otherKey = (one, other) => one.type !== other.type || one.blob !== other.blob;

/**
 * Whether what is known of a pinned record's server says it shows another key now: another entry
 * for the same host and port approved with a different key (ssh would accept either for each), or
 * a key fetched from that server, through any entry, since this one was approved that is not this
 * one. Such a record is not approved, whatever its state says.
 */
function disputed(record, records) {
  if (record.state !== "pinned" || !record.key) return false;
  const pinnedAt = Date.parse(record.key.pinnedAt);
  return records.some((entry) => sameServer(entry, record) && (
    (entry.id !== record.id && entry.state === "pinned" && entry.key && otherKey(entry.key, record.key))
    || (entry.candidate && otherKey(entry.candidate, record.key) && !(Date.parse(entry.candidate.fetchedAt) < pinnedAt))));
}

/** What the probe left in its throwaway file: the one key line for `expected`, or why there is none. */
function readProbe(text, expected) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (!lines.length) return { ok: false, reason: "no_key" };
  if (lines.length > 1) return { ok: false, reason: "unexpected_answer" };
  const line = parseKnownHostsLine(lines[0]);
  if (!line) return { ok: false, reason: "malformed_answer" };
  if (line.name !== expected) return { ok: false, reason: "wrong_host" };
  return { ok: true, type: line.type, blob: line.blob, fingerprint: fingerprintOf(line.blob) };
}

const NOTHING_SAVED = "No key was saved.";
const UNREADABLE_NOTICE = "The saved SSH hosts list could not be read, so no host is approved. The next change keeps that file beside a new list; nothing in it is deleted.";
const BLOCK_NOT_SAVED = "This server showed a key other than the one you approved, so it is blocked. The block could not be saved and would be lost when the app restarts. Check the disk, then check the key again.";

/** A probe that left no key, said plainly. ssh's own words pick the sentence and are not repeated. */
function probeFailure(reason, stderr = "") {
  if (reason === "timeout") return `The server did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds. Check the host, the port and your network, then try again. ${NOTHING_SAVED}`;
  if (reason === "not_started") return `OpenSSH could not be started on this computer. ${NOTHING_SAVED}`;
  if (reason !== "no_key") return `The answer did not match this host, so it was not used. Try again. ${NOTHING_SAVED}`;
  if (/could not resolve hostname/i.test(stderr)) return `The host name could not be found. Check its spelling. ${NOTHING_SAVED}`;
  if (/connection refused/i.test(stderr)) return `The server refused the connection. Check the port. ${NOTHING_SAVED}`;
  if (/timed out/i.test(stderr)) return `The server did not answer. Check the host, the port and your network, then try again. ${NOTHING_SAVED}`;
  if (/bad configuration option|unsupported option/i.test(stderr)) return `This computer's OpenSSH did not accept the app's settings. Update OpenSSH, then try again. ${NOTHING_SAVED}`;
  return `The server sent no host key. Check the host, the port and your network, then try again. ${NOTHING_SAVED}`;
}

/** Starts the program itself with an argv array: no shell, no window, nothing on its input. */
async function runProgram(executable, argv, { timeoutMs, env, cwd } = {}) {
  const reply = await runOffThread({ file: executable, args: argv, cwd, env, timeoutMs, maxBytes: 64 * 1024 });
  if (reply?.timedOut) return { code: null, stdout: "", stderr: "", timedOut: true };
  if (reply?.error || typeof reply?.code !== "number") return { code: null, stdout: "", stderr: "", failed: true };
  return { code: reply.code, stdout: reply.stdout, stderr: reply.stderr };
}

const isRegularFile = (target) => fs.promises.stat(target).then((found) => found.isFile(), () => false);

function errorCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "unexpected";
}

/**
 * The SSH hosts store. `run(executable, argv, { timeoutMs, env, cwd })` resolves { code, stdout,
 * stderr } (and timedOut: true when it ended the program at the limit). `after`, when given, is
 * awaited before the store file is read: the store this one replaces must have finished writing.
 */
function createSshConnections({
  file,
  knownHostsFile,
  probeDir,
  run = runProgram,
  now = Date.now,
  logger = null,
  fileExists = isRegularFile,
  program = sshProgram(),
  platform = process.platform,
  environment = () => childEnvironment(),
  after = null,
  // Both files are flushed to disk before they replace the old ones (atomic-file.cjs `durable`):
  // a power cut must not leave the hosts list or the pinned keys torn. Tests turn the flush off.
  durable = true,
} = {}) {
  if (!file || !knownHostsFile || !probeDir) throw new Error("The SSH hosts store needs its files");
  let hosts = [];
  let unreadable = false;
  // Records were left out at load (damaged, doubled, past the limit): the file is copied aside once
  // before the first save writes the list without them.
  let keepCopy = false;
  let disposed = false;
  let closing = null;
  let client = null;
  let clientAsked = null;
  let clientFailedAt = null;
  const probes = new Map(); // host id -> the fetch in flight for it
  const timestamp = () => new Date(now()).toISOString();
  const log = (level, event, fields = {}) => { try { logger?.[level]?.(event, fields); } catch { /* a log never fails an action */ } };
  const writeOptions = { durable: durable !== false, protectDirectory: false };

  // One change at a time, in the order asked: each reads the list the one before it left.
  let queue = Promise.resolve();
  function exclusive(work) {
    const done = queue.then(work);
    queue = done.catch(() => {});
    return done;
  }

  async function writePinned({ onlyIfDifferent = false } = {}) {
    const text = pinnedKeysText(hosts);
    if (onlyIfDifferent) {
      const current = await fs.promises.readFile(knownHostsFile, "utf8").catch(() => null);
      if (current === text) return;
    }
    await writePrivateFileAtomicAsync(knownHostsFile, text, writeOptions);
  }

  async function clearProbes() {
    const entries = await fs.promises.readdir(probeDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^p-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
      await fs.promises.rm(path.join(probeDir, entry.name), { recursive: true, force: true }).catch(() => {});
    }
  }

  /** The store file's text, or null when there is none yet. */
  async function readStoreFile() {
    // A file held for a moment (a scan, a backup) is read again before the list is called
    // unreadable: an unreadable list approves no host until the app starts again.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fs.promises.readFile(file, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        if (attempt >= STORE_READ_RETRY_DELAYS_MS.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, STORE_READ_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  /** What the store file holds: { records, dropped, repaired, unreadable }. */
  async function readSaved() {
    const nothing = (cannotRead) => ({ records: [], dropped: 0, repaired: 0, unreadable: cannotRead });
    let saved;
    try {
      const text = await readStoreFile();
      if (text === null) return nothing(false);
      saved = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      return nothing(true);
    }
    if (saved?.version !== STORE_VERSION || !Array.isArray(saved.hosts)) return nothing(true);
    const kept = [];
    let repaired = 0;
    for (const raw of saved.hosts) {
      const record = kept.length < MAX_HOSTS ? storedRecord(raw, platform) : null;
      // A saved list holds to what add allows: one entry for each host, port and user.
      if (!record || kept.some((entry) => entry.id === record.id || sameEntry(entry, record))) continue;
      if (typeof raw.production !== "boolean") repaired += 1;
      kept.push(record);
    }
    // A pinned record whose server is known to show another key (see disputed) loads blocked, as
    // fetch_key would have left it: two keys approved for one server are two keys ssh accepts.
    const records = kept.map((record) => (disputed(record, kept) ? { ...record, state: "changed" } : record));
    repaired += records.filter((record, index) => record !== kept[index]).length;
    return { records, dropped: saved.hosts.length - kept.length, repaired, unreadable: false };
  }

  function loaded(saved, again = false) {
    hosts = saved.records;
    unreadable = saved.unreadable;
    keepCopy = saved.dropped > 0;
    log(saved.unreadable || saved.dropped || saved.repaired ? "warn" : "info", "ssh.store_loaded", {
      hosts: hosts.length, pinned: hosts.filter((record) => record.state === "pinned").length,
      dropped: saved.dropped, repaired: saved.repaired, unreadable: saved.unreadable, ...(again ? { again } : {}),
    });
  }

  async function load() {
    loaded(await readSaved());
    await clearProbes();
    // A line added by hand since the last run goes now; an unchanged file is not written again.
    await writePinned({ onlyIfDifferent: true }).catch((error) => log("warn", "ssh.pinned_write_failed", { code: errorCode(error) }));
  }

  const ready = Promise.resolve(after).catch(() => {}).then(load).catch((error) => log("error", "ssh.store_load_failed", { code: errorCode(error) }));

  /**
   * A name beside the store file that nothing has yet: ssh-hosts.json.unreadable, then names with
   * the time. A copy set aside earlier is never replaced (rename would replace a file of that name).
   */
  async function freeAsideName() {
    const stamp = timestamp().replace(/\.[0-9]+Z$/, "Z").replace(/[-:]/g, "");
    const names = [`${file}.unreadable`, `${file}.unreadable-${stamp}`, ...Array.from({ length: 8 }, (_, index) => `${file}.unreadable-${stamp}-${index + 2}`)];
    for (const name of names) {
      const taken = await fs.promises.lstat(name).then(() => true, (error) => error?.code !== "ENOENT");
      if (!taken) return name;
    }
    return null;
  }

  /**
   * Before the first save: a file that could not be read is moved aside, and a file some records
   * were left out of is copied aside. Either may hold the person's whole list.
   */
  async function setAside() {
    if (!unreadable && !keepCopy) return;
    const moving = unreadable;
    try {
      const name = await freeAsideName();
      if (!name) throw Object.assign(new Error("no free name"), { code: "EEXIST" });
      if (moving) await fs.promises.rename(file, name);
      else await fs.promises.copyFile(file, name, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        log("error", "ssh.store_save_failed", { code: errorCode(error) });
        refuse(moving
          ? "The saved SSH hosts list could not be read, and it could not be set aside, so nothing was changed. Restart the app, then try again."
          : "Some saved SSH hosts could not be read, and a copy of the list could not be kept, so nothing was changed. Check the disk, then try again.", "save_failed");
      }
    }
    unreadable = false;
    keepCopy = false;
  }

  /**
   * Saves `next`, makes it the list, then writes the pinned file from it. A failed save changes
   * nothing, except where trust is taken away:
   * - `withdraws`: the change holds from the start, so no host stays approved while a slow disk
   *   flushes the file; a failed save then puts the list back.
   * - `ifUnsaved` (the sentence the refusal says): not even a failed save undoes it. A server that
   *   showed another key stays blocked until the app stops, whatever the disk did (review, 2026-11-27).
   */
  async function commit(next, { withdraws = false, ifUnsaved = null } = {}) {
    const before = hosts;
    if (withdraws || ifUnsaved) hosts = next;
    try {
      await setAside();
      await writePrivateFileAtomicAsync(file, `${JSON.stringify({ version: STORE_VERSION, hosts: next }, null, 2)}\n`, writeOptions);
    } catch (error) {
      if (!(error instanceof SshHostsError)) log("error", "ssh.store_save_failed", { code: errorCode(error) });
      if (ifUnsaved) {
        await writePinned().catch((failure) => log("error", "ssh.pinned_write_failed", { code: errorCode(failure) }));
        refuse(ifUnsaved, "not_saved");
      }
      hosts = before;
      if (error instanceof SshHostsError) throw error;
      refuse("The SSH hosts list could not be saved, so nothing was changed. Check the disk, then try again.", "save_failed");
    }
    hosts = next;
    try {
      await writePinned();
    } catch (error) {
      log("error", "ssh.pinned_write_failed", { code: errorCode(error) });
      refuse("The change was saved, but the pinned keys file could not be written. Change any host again to retry.", "pinned_write_failed");
    }
  }

  const restarting = () => new SshHostsError("SSH hosts are restarting. Try again in a moment.", "restarting");

  /** Queues one change. A stopped store takes no new one; a change asked for before the stop still lands. */
  function change(work) {
    if (disposed) return Promise.reject(restarting());
    return exclusive(async () => {
      await ready;
      // A list that could not be read at start is read once more before a change sets it aside:
      // held for a moment by another program, it would otherwise be replaced by one host.
      if (unreadable) {
        const saved = await readSaved();
        if (!saved.unreadable) {
          loaded(saved, true);
          await writePinned().catch((error) => log("warn", "ssh.pinned_write_failed", { code: errorCode(error) }));
        }
      }
      return work();
    });
  }

  function argumentsOf(args, allowed) {
    if (args === undefined || args === null) return {};
    if (!plainObject(args)) refuse("SSH hosts take no extra options or arguments.", "unknown_field");
    if (Object.keys(args).some((name) => !allowed.includes(name))) refuse("SSH hosts take no extra options or arguments.", "unknown_field");
    return args;
  }

  function found(id) {
    const record = typeof id === "string" ? hosts.find((entry) => entry.id === id) : null;
    return record || refuse("This host is no longer in the list.", "not_found");
  }

  const replaced = (record) => hosts.map((entry) => (entry.id === record.id ? record : entry));

  async function clientInfo() {
    if (client) return client;
    if (clientFailedAt !== null && now() - clientFailedAt < VERSION_RETRY_MS) return null;
    clientAsked ??= (async () => {
      try {
        // It prints its version to the error stream.
        const result = await run(program, ["-V"], { timeoutMs: VERSION_TIMEOUT_MS, env: environment() });
        const read = result?.code === 0 ? parseClientVersion(`${result.stderr ?? ""}\n${result.stdout ?? ""}`) : null;
        if (read) client = { path: program, ...read };
      } catch { /* reported as no client */ }
      if (!client) clientFailedAt = now();
      return client;
    })().finally(() => { clientAsked = null; });
    return clientAsked;
  }

  async function list() {
    await ready;
    const info = await clientInfo();
    return {
      ok: true, client: info ? { path: info.path, version: info.version } : null, hosts: hosts.map(publicHost),
      // An empty list is not shown as if it were the person's: it says why, and that nothing is lost.
      ...(unreadable ? { notice: UNREADABLE_NOTICE } : {}),
    };
  }

  function add(args) {
    return change(async () => {
      const checked = validateNewHost(args, { platform });
      if (!checked.ok) refuse(checked.error, "invalid");
      const fields = checked.value;
      if (fields.identityFile && !(await fileExists(fields.identityFile))) {
        refuse("Key file: no file was found at that path. Choose the private key file.", "invalid");
      }
      if (hosts.some((entry) => entry.host === fields.host && entry.port === fields.port && entry.user === fields.user)) {
        refuse("This host is already in the list with that port and user.", "duplicate");
      }
      if (hosts.length >= MAX_HOSTS) refuse(`The list holds up to ${MAX_HOSTS} hosts. Remove one first.`, "full");
      let id;
      do { id = crypto.randomBytes(6).toString("hex"); } while (hosts.some((entry) => entry.id === id));
      // A draft: nothing can be opened or approved for it until its key is confirmed.
      const record = { id, ...fields, state: "draft", key: null, candidate: null, createdAt: timestamp() };
      await commit([...hosts, record]);
      log("info", "ssh.host_added", { hostId: id });
      return { ok: true, host: publicHost(record) };
    });
  }

  function update(args) {
    return change(async () => {
      // Trust is bound to the host, port and user: changing one would carry a key to another server.
      if (plainObject(args) && ["host", "port", "user", "identityFile"].some((name) => name in args)) {
        refuse("The host, port, user and key file cannot be changed, because the pinned key belongs to them. Remove this host and add it again.", "fixed_field");
      }
      const input = argumentsOf(args, ["id", "label", "production"]);
      const record = found(input.id);
      const next = { ...record };
      if (input.label !== undefined) {
        const label = validateLabel(input.label);
        if (!label.ok) refuse(label.error, "invalid");
        next.label = label.value;
      }
      if (input.production !== undefined) {
        if (typeof input.production !== "boolean") refuse("Production: choose on or off.", "invalid");
        next.production = input.production;
      }
      if (next.label !== record.label || next.production !== record.production) {
        await commit(replaced(next));
        log("info", "ssh.host_updated", { hostId: record.id });
      }
      return { ok: true, host: publicHost(next) };
    });
  }

  function remove(args) {
    return change(async () => {
      const record = found(argumentsOf(args, ["id"]).id);
      await commit(hosts.filter((entry) => entry.id !== record.id), { withdraws: true });
      log("info", "ssh.host_removed", { hostId: record.id });
      return { ok: true, hosts: hosts.map(publicHost) };
    });
  }

  /** Runs the probe for one record and returns the key the server presented. Trusts nothing. */
  async function probe(record) {
    const info = await clientInfo();
    if (!info) refuse(`OpenSSH was not found on this computer, so the server's key could not be fetched. ${NOTHING_SAVED}`, "no_client");
    await fs.promises.mkdir(probeDir, { recursive: true, mode: 0o700 });
    const folder = await fs.promises.mkdtemp(path.join(probeDir, "p-"));
    const throwaway = path.join(folder, "known_hosts");
    try {
      const argv = probeArgv({ host: record.host, port: record.port, user: record.user, knownHostsFile: throwaway, client: info, platform });
      let result;
      try {
        result = await run(program, argv, { timeoutMs: PROBE_TIMEOUT_MS, env: environment(), cwd: folder });
      } catch {
        result = { failed: true };
      }
      if (result?.timedOut) return { ok: false, reason: "timeout", stderr: "" };
      // No exit code means ssh never ran to its end: whatever sits in the throwaway file is not read.
      if (result?.failed || typeof result?.code !== "number") return { ok: false, reason: "not_started", stderr: "" };
      let text = "";
      try {
        const size = (await fs.promises.stat(throwaway)).size;
        if (size > MAX_PROBE_FILE_BYTES) return { ok: false, reason: "unexpected_answer", stderr: "" };
        text = await fs.promises.readFile(throwaway, "utf8");
      } catch { /* nothing was written */ }
      const read = readProbe(text, knownHostsName(record.host, record.port));
      return read.ok ? read : { ...read, stderr: String(result?.stderr ?? "") };
    } finally {
      await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function fetchKey(args) {
    await ready;
    if (disposed) throw restarting();
    const asked = found(argumentsOf(args, ["id"]).id);
    // A second click while the first probe runs gets that probe's answer.
    const running = probes.get(asked.id);
    if (running) return running;
    const fetching = (async () => {
      const answer = await probe(asked);
      // Stopped while the probe ran (its throwaway folder may be gone too): whatever it found is dropped.
      if (disposed) throw restarting();
      if (!answer.ok) {
        log("warn", "ssh.key_fetch_failed", { hostId: asked.id, reason: answer.reason });
        refuse(probeFailure(answer.reason, answer.stderr), answer.reason);
      }
      return change(async () => {
        // The list may have changed while the probe ran (the host removed, or its key confirmed):
        // the answer is judged against the record as it is now.
        const record = found(asked.id);
        const candidate = { type: answer.type, blob: answer.blob, fingerprint: answer.fingerprint, fetchedAt: timestamp() };
        // Fetched, not trusted. A pinned host whose server shows another key is blocked until the
        // person confirms the new one; a changed host never returns to pinned by itself. ssh trusts
        // a key for a host and port, whoever signs in, so every entry for this server approved with
        // another key is blocked with it, each keeping its old key beside the one shown now: one
        // blocked entry left a second one approved for the same server (review, 2026-11-27).
        const blocks = (entry) => sameServer(entry, record) && entry.state === "pinned" && Boolean(entry.key) && otherKey(entry.key, candidate);
        const next = hosts.map((entry) => {
          if (blocks(entry)) return { ...entry, candidate, state: "changed" };
          return entry.id === record.id ? { ...entry, candidate } : entry;
        });
        const blocked = hosts.filter(blocks).length;
        const fetched = next.find((entry) => entry.id === record.id);
        const fields = { hostId: record.id, changed: fetched.state === "changed", blocked };
        try {
          await commit(next, blocked ? { ifUnsaved: BLOCK_NOT_SAVED } : {});
        } catch (error) {
          if (error?.code === "not_saved") log("warn", "ssh.key_fetched", { ...fields, saved: false });
          throw error;
        }
        log("info", "ssh.key_fetched", fields);
        return { ok: true, host: publicHost(fetched) };
      });
    })();
    probes.set(asked.id, fetching);
    const forget = () => { if (probes.get(asked.id) === fetching) probes.delete(asked.id); };
    fetching.then(forget, forget);
    return fetching;
  }

  function confirmKey(args) {
    return change(async () => {
      const input = argumentsOf(args, ["id", "fingerprint", "pasted"]);
      const record = found(input.id);
      const candidate = record.candidate;
      if (!candidate) refuse("Fetch the server's key first, then confirm it.", "no_candidate");
      if (typeof input.fingerprint !== "string" || input.fingerprint !== candidate.fingerprint) {
        refuse("The key on screen is not the one last fetched from this server. Fetch the key again.", "stale_fingerprint");
      }
      let method = "compared";
      if (input.pasted !== undefined && input.pasted !== null) {
        // The person pasted the value they got from the server by another route: it must be this key.
        if (typeof input.pasted !== "string" || input.pasted.trim() !== candidate.fingerprint) {
          refuse("The pasted fingerprint does not match this server's key.", "pasted_mismatch");
        }
        method = "pasted";
      }
      // ssh trusts a key for a host and port, whoever signs in. A second key approved for the same
      // server would be accepted for every entry of it, beside the one key each entry shows.
      const other = hosts.find((entry) => entry.id !== record.id && entry.state === "pinned" && entry.key
        && entry.host === record.host && entry.port === record.port
        && (entry.key.type !== candidate.type || entry.key.blob !== candidate.blob));
      if (other) {
        refuse(`"${other.label}" is the same server and has a different approved key. Check that host's key first, then approve this one.`, "other_key_approved");
      }
      const key = { type: candidate.type, blob: candidate.blob, fingerprint: candidate.fingerprint, pinnedAt: timestamp(), method };
      const next = { ...record, state: "pinned", key, candidate: null };
      await commit(replaced(next));
      log("info", "ssh.key_pinned", { hostId: record.id, method });
      return { ok: true, host: publicHost(next) };
    });
  }

  /**
   * The hosts agents may be reviewed for: pinned ones only. A draft or a changed host is not one,
   * nor a pinned one whose server is known to show another key (disputed; load and fetch_key block
   * those, and this holds should any be left).
   */
  function approvedHosts() {
    return hosts.filter((record) => record.state === "pinned" && record.key && !disputed(record, hosts)).map((record) => ({
      id: record.id, label: record.label, host: record.host, port: record.port, user: record.user, production: record.production,
    }));
  }

  /** Every action answers { ok: false, error } in the person's terms instead of throwing. */
  async function answered(operation, work) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SshHostsError) return { ok: false, error: error.message, code: error.code };
      log("error", "ssh.operation_failed", { operation, code: errorCode(error) });
      return { ok: false, error: "The SSH hosts list could not finish that. Try again.", code: "unexpected" };
    }
  }

  const actions = {
    list: () => list(),
    add,
    update,
    remove,
    fetch_key: fetchKey,
    confirm_key: confirmKey,
  };

  /** The app module's dispatcher (app-handler/ssh-connections). */
  function call(operation, args) {
    if (!Object.hasOwn(actions, operation)) return Promise.resolve({ ok: false, error: "The SSH hosts list has no such action.", code: "unknown_operation" });
    return answered(operation, () => actions[operation](args));
  }

  /**
   * The in-app terminal's command for one pinned host: { ok, program, argv, env }, for the main
   * process to start (milestone 2) with exactly `env` as its environment, nothing of the app's own
   * added: an inherited SSH_ASKPASS with SSH_ASKPASS_REQUIRE=force would make ssh start that program
   * for a prompt, and SSH_SK_PROVIDER names a library it loads (review, 2026-11-27). Not an
   * app-module operation, so the window never receives a command line. The pinned file is written
   * again from the list first: between two changes a line added to it by hand would still be there,
   * and ssh would accept that key for the host.
   */
  function terminalCommand(args) {
    return answered("terminal_command", () => change(async () => {
      const record = found(argumentsOf(args, ["id"]).id);
      const info = await clientInfo();
      if (!info) refuse("OpenSSH was not found on this computer, so the terminal was not opened.", "no_client");
      const argv = terminalArgv({ ...record, knownHostsFile, client: info, platform });
      if (disputed(record, hosts)) refuse("This server showed another key. Review it on the SSH hosts page before opening a terminal.", "not_pinned");
      // A key file that is gone is not skipped by ssh: it warns, drops -i and offers the person's
      // default keys to the host, IdentitiesOnly or not (review, 2026-11-27, ssh -G on the target machine).
      if (record.identityFile && !(await fileExists(record.identityFile))) {
        refuse("Key file: no file was found at that path, so the terminal was not opened. Put the key file back, or remove this host and add it again.", "key_file_missing");
      }
      try {
        await writePinned();
      } catch (error) {
        log("error", "ssh.pinned_write_failed", { code: errorCode(error) });
        refuse("The pinned keys file could not be written, so the terminal was not opened. Try again.", "pinned_write_failed");
      }
      return { ok: true, program, argv, env: environment() };
    }));
  }

  /**
   * Stops this store: it takes no further change, and a key fetch still running saves nothing.
   * Resolves once the changes already asked for have landed, so the store that replaces it reads
   * what they left.
   */
  function dispose() {
    if (!closing) {
      disposed = true;
      closing = ready.then(() => queue);
    }
    return closing;
  }

  return Object.freeze({
    ready: () => ready,
    list: () => call("list"),
    add: (args) => call("add", args),
    update: (args) => call("update", args),
    remove: (args) => call("remove", args),
    fetchKey: (args) => call("fetch_key", args),
    confirmKey: (args) => call("confirm_key", args),
    approvedHosts,
    terminalCommand,
    call,
    dispose,
  });
}

module.exports = {
  DEFAULT_PORT,
  OPERATIONS,
  PROBE_TIMEOUT_MS,
  SshHostsError,
  childEnvironment,
  createSshConnections,
  fingerprintOf,
  knownHostsLine,
  knownHostsName,
  parseClientVersion,
  parseKnownHostsLine,
  pinnedKeysText,
  probeArgv,
  publicHost,
  sshProgram,
  terminalArgv,
  validateHost,
  validateIdentityFile,
  validateLabel,
  validateNewHost,
  validatePort,
  validateUser,
};
