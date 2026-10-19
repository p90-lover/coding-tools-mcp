"use strict";

// A file attached to a chat with no path of its own (a pasted screenshot, a clipboard file) is
// saved under the app's data so the agent can open it by path, as Claude Code saves pasted images.
// Only kinds a model reads, at most 20 MB, under a name of the app's choosing in a dated folder.

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const ATTACHMENT_TYPES = new Map([
  ["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/gif", ".gif"], ["image/webp", ".webp"],
  ["application/pdf", ".pdf"], ["text/plain", ".txt"], ["text/markdown", ".md"], ["text/csv", ".csv"], ["application/json", ".json"],
]);
const ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Saves one attachment under root/<yyyy-mm-dd>/ and returns its path; throws a message for the person. */
async function saveChatAttachment(root, input, now = new Date()) {
  const type = typeof input?.type === "string" ? input.type.toLowerCase() : "";
  const extension = ATTACHMENT_TYPES.get(type);
  if (!extension) throw new Error("This kind of file cannot be attached");
  const bytes = input?.bytes instanceof Uint8Array ? input.bytes : input?.bytes instanceof ArrayBuffer ? new Uint8Array(input.bytes) : null;
  if (!bytes || !bytes.byteLength) throw new Error("The file is empty");
  if (bytes.byteLength > ATTACHMENT_BYTES) throw new Error("The file is larger than 20 MB");
  const stem = String(input?.name || "pasted").replace(/\.[^.]*$/, "").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "pasted";
  const folder = path.join(root, now.toISOString().slice(0, 10));
  await fs.promises.mkdir(folder, { recursive: true });
  const file = path.join(folder, `${stem}-${randomUUID().slice(0, 8)}${extension}`);
  await fs.promises.writeFile(file, bytes, { flag: "wx" });
  return file;
}

module.exports = { ATTACHMENT_BYTES, ATTACHMENT_TYPES, saveChatAttachment };
