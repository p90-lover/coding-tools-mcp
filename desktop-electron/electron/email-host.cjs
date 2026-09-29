"use strict";

// Runtime -> Email: the only place the Cloudflare mail Worker admin credential lives.
//
// Boundary: this module runs in the main process. It holds the encrypted admin credential,
// makes the x-admin-auth calls to the configured Worker origin through the app's proxy-aware
// fetchNative, and returns ONLY normalized objects with every secret/JWT stripped. The renderer
// (and the sandboxed email preview) never receive the credential, the raw upstream response,
// or any Authorization header. See docs/specs/runtime-cloudflare-email/design.md.

const crypto = require("node:crypto");
const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // NFR-1: 10 MiB inline/response ceiling.
const MAX_ID = Number.MAX_SAFE_INTEGER;
// A configured address on the Worker's own domain. Deliberately narrow: no path, no port games.
const ADDRESS_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

// --- credential codec (mirrors provider-network.cjs / external-services.cjs) --------------

function createSecretCodec({ safeStorage, keyPath }) {
  let fallbackKey = null;
  const encryptionAvailable = () => {
    try { return Boolean(safeStorage?.isEncryptionAvailable?.()); } catch { return false; }
  };
  const loadFallbackKey = () => {
    if (fallbackKey) return fallbackKey;
    try {
      const existing = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64");
      if (existing.length === 32) return (fallbackKey = existing);
    } catch {}
    fallbackKey = crypto.randomBytes(32);
    writePrivateFileAtomic(keyPath, `${fallbackKey.toString("base64")}\n`);
    return fallbackKey;
  };
  return {
    encryptionAvailable,
    encrypt(value) {
      const plain = JSON.stringify(value);
      if (encryptionAvailable()) {
        return { scheme: "electron-safe-storage-v1", data: safeStorage.encryptString(plain).toString("base64") };
      }
      const key = loadFallbackKey();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return {
        scheme: "aes-256-gcm-v1",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: encrypted.toString("base64"),
      };
    },
    decrypt(envelope) {
      if (!envelope || typeof envelope !== "object") return null;
      try {
        if (envelope.scheme === "electron-safe-storage-v1" && encryptionAvailable()) {
          return JSON.parse(safeStorage.decryptString(Buffer.from(envelope.data, "base64")));
        }
        if (envelope.scheme !== "aes-256-gcm-v1") return null;
        const key = loadFallbackKey();
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        const plain = Buffer.concat([
          decipher.update(Buffer.from(envelope.data, "base64")),
          decipher.final(),
        ]).toString("utf8");
        return JSON.parse(plain);
      } catch { return null; }
    },
  };
}

// --- validation helpers -------------------------------------------------------------------

function normalizeOrigin(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("Enter a valid https:// mail API origin"); }
  if (url.protocol !== "https:") throw new Error("The mail API origin must use https");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("Enter only the origin, without a path");
  if (url.search || url.hash) throw new Error("Enter only the origin, without query or fragment");
  return url.origin;
}

function boundedInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function pageSize(value) {
  return boundedInt(value, { min: 1, max: MAX_PAGE_SIZE, fallback: DEFAULT_PAGE_SIZE });
}

function offset(value) {
  return boundedInt(value, { min: 0, max: 1_000_000, fallback: 0 });
}

function positiveId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_ID) throw new Error("Invalid message or mailbox id");
  return n;
}

// --- normalizers: strip every secret/token before anything crosses IPC --------------------

// Keys we refuse to forward to the renderer even if the Worker adds them to a row.
const SENSITIVE_ROW_KEYS = new Set([
  "password", "jwt", "token", "access_token", "refresh_token", "id_token",
  "secret", "credential", "authorization", "cookie", "mail_password",
]);

function pickString(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === "string" && value.length) return value;
  }
  return null;
}

function normalizeMailbox(row) {
  if (!row || typeof row !== "object") return null;
  const id = Number(row.id);
  const address = pickString(row, ["name", "address", "mail"]);
  if (!Number.isInteger(id) || !address) return null;
  return {
    id,
    address,
    createdAt: pickString(row, ["created_at", "createdAt"]),
    updatedAt: pickString(row, ["updated_at", "updatedAt"]),
    mailCount: boundedInt(row.mail_count ?? row.mailCount, { min: 0, max: MAX_ID, fallback: null }),
  };
}

// A list row: never carry the raw MIME across IPC — only a bounded preview.
function normalizeMessageListRow(row) {
  if (!row || typeof row !== "object") return null;
  const id = Number(row.id);
  if (!Number.isInteger(id)) return null;
  const preview = pickString(row, ["message", "text", "snippet", "preview"]);
  return {
    id,
    mailbox: pickString(row, ["address", "mailbox"]),
    from: pickString(row, ["source", "from", "sender"]),
    subject: pickString(row, ["subject"]),
    receivedAt: pickString(row, ["created_at", "createdAt", "date"]),
    preview: preview ? preview.replace(/\s+/g, " ").slice(0, 240) : null,
  };
}

function collect(payload) {
  if (Array.isArray(payload)) return { results: payload, count: payload.length };
  if (payload && Array.isArray(payload.results)) {
    return { results: payload.results, count: Number(payload.count) || payload.results.length };
  }
  return { results: [], count: 0 };
}

// --- host ---------------------------------------------------------------------------------

function createEmailHost({ logger, filePath, keyPath, safeStorage, fetchNative, parseMessage, sanitizeHtml }) {
  const codec = createSecretCodec({ safeStorage, keyPath });
  let connection = null; // { origin, adminAuth }
  let capabilities = null; // { version, domains, sendEnabled, ... } from /open_api/settings
  let lastRefresh = null;
  let lastError = null;

  function load() {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const decrypted = codec.decrypt(saved?.credential);
      if (decrypted?.origin && decrypted?.adminAuth) connection = decrypted;
    } catch {}
  }
  load();

  function persist() {
    if (!connection) {
      try { fs.rmSync(filePath, { force: true }); } catch {}
      return;
    }
    writePrivateFileAtomic(filePath, `${JSON.stringify({ credential: codec.encrypt(connection) })}\n`);
  }

  // Every privileged call funnels through here. The credential is attached in this process only.
  async function call(pathAndQuery, { method = "GET", body = null, admin = true } = {}) {
    if (!connection) throw new Error("Email is not connected");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("The mail API timed out")), REQUEST_TIMEOUT_MS);
    try {
      const headers = { accept: "application/json" };
      if (admin) headers["x-admin-auth"] = connection.adminAuth;
      if (body != null) headers["content-type"] = "application/json";
      const response = await fetchNative(`${connection.origin}${pathAndQuery}`, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("The mail API redirected unexpectedly");
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error("The mail credential was rejected");
      }
      if (!response.ok) throw new Error(`The mail API returned HTTP ${response.status}`);
      const text = await readBounded(response);
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function readBounded(response) {
    const reader = response.body?.getReader?.();
    if (!reader) return await response.text();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new Error("The mail API response exceeded the 10 MiB limit");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  }

  function status() {
    return {
      configured: Boolean(connection),
      origin: connection?.origin ?? null,
      encryptionAvailable: codec.encryptionAvailable(),
      capabilities,
      lastRefresh,
      error: lastError,
    };
  }

  async function refreshCapabilities() {
    const settings = await call("/open_api/settings", { admin: false });
    capabilities = {
      version: pickString(settings ?? {}, ["version"]),
      domains: Array.isArray(settings?.domains)
        ? settings.domains.map((d) => (typeof d === "string" ? d : d?.value)).filter(Boolean)
        : [],
      sendEnabled: settings?.enableSend === true,
    };
    return capabilities;
  }

  return {
    status,

    async connect(input) {
      const origin = normalizeOrigin(input?.origin);
      const adminAuth = String(input?.adminAuth ?? "");
      if (!adminAuth) throw new Error("Enter the Worker admin credential");
      const candidate = { origin, adminAuth };
      // Verify with a read-only, non-mutating call before we persist anything.
      const previous = connection;
      connection = candidate;
      try {
        await call("/admin/statistics", { admin: true });
        await refreshCapabilities();
        lastError = null;
        lastRefresh = new Date().toISOString();
        persist();
        logger?.info?.("email.connected", { origin });
        return status();
      } catch (error) {
        connection = previous;
        lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },

    disconnect() {
      connection = null;
      capabilities = null;
      lastRefresh = null;
      lastError = null;
      persist();
      logger?.info?.("email.disconnected");
      return status();
    },

    async listMailboxes(input) {
      const params = new URLSearchParams({ limit: String(pageSize(input?.limit)), offset: String(offset(input?.offset)) });
      const query = typeof input?.query === "string" ? input.query.trim().slice(0, 128) : "";
      if (query) params.set("query", query);
      const { results, count } = collect(await call(`/admin/address?${params}`));
      lastRefresh = new Date().toISOString();
      return { mailboxes: results.map(normalizeMailbox).filter(Boolean), count };
    },

    async listMessages(input) {
      const params = new URLSearchParams({ limit: String(pageSize(input?.limit)), offset: String(offset(input?.offset)) });
      if (typeof input?.address === "string" && input.address.trim()) {
        params.set("address", input.address.trim().slice(0, 320));
      }
      const { results, count } = collect(await call(`/admin/mails?${params}`));
      lastRefresh = new Date().toISOString();
      return { messages: results.map(normalizeMessageListRow).filter(Boolean), count };
    },

    async getMessage(input) {
      const id = positiveId(input?.id);
      const row = await call(`/admin/mails/${id}`);
      if (!row || typeof row !== "object") return { message: null };
      // Parse MIME and sanitize in the main process; the renderer only ever gets clean, bounded content.
      const raw = pickString(row, ["raw", "message", "mail"]);
      const parsed = raw ? await parseMessage(raw) : { text: null, html: null, attachments: [] };
      return {
        message: {
          id: Number(row.id),
          from: parsed.from ?? pickString(row, ["source", "from"]),
          to: parsed.to ?? pickString(row, ["address", "to"]),
          subject: parsed.subject ?? pickString(row, ["subject"]),
          receivedAt: pickString(row, ["created_at", "createdAt"]) ?? parsed.date ?? null,
          text: parsed.text ? String(parsed.text).slice(0, MAX_RESPONSE_BYTES) : null,
          html: parsed.html ? sanitizeHtml(String(parsed.html)).slice(0, MAX_RESPONSE_BYTES) : null,
          attachments: Array.isArray(parsed.attachments)
            ? parsed.attachments.slice(0, 50).map((a) => ({
                filename: typeof a?.filename === "string" ? a.filename.slice(0, 256) : null,
                mimeType: typeof a?.mimeType === "string" ? a.mimeType.slice(0, 128) : null,
                size: boundedInt(a?.size, { min: 0, max: MAX_ID, fallback: null }),
              }))
            : [],
        },
      };
    },

    // --- mutations: each is gated by a renderer-side confirmation; the host still validates ---

    async createAddress(input) {
      const name = String(input?.name ?? "").trim();
      if (!ADDRESS_NAME_RE.test(name)) throw new Error("Address name may use letters, digits, dot, underscore, hyphen");
      const domain = String(input?.domain ?? "").trim();
      const allowed = capabilities?.domains ?? [];
      if (!allowed.includes(domain)) throw new Error("Choose one of the Worker's configured domains");
      const created = await call("/admin/new_address", { method: "POST", body: { name, domain, enablePrefix: false } });
      // Discard any generated mailbox JWT; return only the address the UI needs.
      return { address: pickString(created ?? {}, ["address", "name"]) ?? `${name}@${domain}` };
    },

    async deleteMessage(input) {
      const id = positiveId(input?.id);
      await call(`/admin/mails/${id}`, { method: "DELETE" });
      return { deleted: id };
    },

    async clearInbox(input) {
      const id = positiveId(input?.id);
      await call(`/admin/clear_inbox/${id}`, { method: "DELETE" });
      return { clearedMailboxId: id };
    },

    async removeMailbox(input) {
      const id = positiveId(input?.id);
      await call(`/admin/delete_address/${id}`, { method: "DELETE" });
      logger?.info?.("email.mailbox_removed", { id });
      return { removedMailboxId: id };
    },
  };
}

module.exports = {
  createEmailHost,
  // exported for focused tests
  normalizeOrigin,
  normalizeMailbox,
  normalizeMessageListRow,
  pageSize,
  positiveId,
};
