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

/** An image's kind from its first bytes, so a file named .png that is not one is never shown. */
function imageType(head) {
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/**
 * An attached image as a data: URL for its thumbnail in the chat (the page may show data: images
 * only). Only an existing image file up to 20 MB, recognized by its bytes; anything else is refused.
 */
async function readImagePreview(file) {
  if (typeof file !== "string" || file.length > 4096 || !path.isAbsolute(file)) throw new Error("Choose an absolute file path");
  const resolved = path.resolve(file);
  const stat = await fs.promises.stat(resolved).catch(() => null);
  if (!stat?.isFile()) throw new Error("This file no longer exists");
  if (stat.size > ATTACHMENT_BYTES) throw new Error("The image is larger than 20 MB");
  const bytes = await fs.promises.readFile(resolved);
  const type = imageType(bytes.subarray(0, 12));
  if (!type) throw new Error("This file is not an image");
  return `data:${type};base64,${bytes.toString("base64")}`;
}

module.exports = { ATTACHMENT_BYTES, ATTACHMENT_TYPES, readImagePreview, saveChatAttachment };
