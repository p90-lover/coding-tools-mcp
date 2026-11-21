"use strict";

const { createHash } = require("node:crypto");
const fail = (code, message) => Object.assign(new Error(message), { code });
const LIMITS = Object.freeze({ message: 8192 - 256, text: 1024 * 1024, attachmentText: 256 * 1024, attachments: 30, annotations: 50, payload: 4 * 1024 * 1024, blob: 20 * 1024 * 1024 });

function boundedText(value, limit, label, fallback = "") {
  if (value === undefined) value = fallback;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > limit || value.includes("\0")) throw fail("INPUT_INVALID", `${label} is invalid or exceeds its limit`);
  return value;
}
function identity(value, label, limit = 128) {
  const text = boundedText(value, limit, label);
  if (!text.trim()) throw fail("INPUT_INVALID", `${label} is required`);
  return text;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw fail("INPUT_INVALID", "A saved draft revision is required");
  return value;
}
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw fail("INPUT_INVALID", "Input must contain JSON values only");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function encode(value) {
  let body;
  try { body = canonical(value); } catch (error) { if (error.code === "INPUT_INVALID") throw error; throw fail("INPUT_INVALID", "Input is not a bounded JSON value"); }
  if (Buffer.byteLength(body) > LIMITS.payload) throw fail("INPUT_TOO_LARGE", "Input exceeds the saved payload limit");
  return body;
}
function digest(value) { return createHash("sha256").update(typeof value === "string" ? value : encode(value)).digest("hex"); }
function draftPayload(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("INPUT_INVALID", "Choose a valid draft");
  const text = boundedText(value.text, LIMITS.text, "Draft text");
  const attachments = value.attachments ?? [], annotations = value.annotations ?? [];
  if (!Array.isArray(attachments) || attachments.length > LIMITS.attachments) throw fail("INPUT_TOO_LARGE", "Too many draft attachments");
  if (!Array.isArray(annotations) || annotations.length > LIMITS.annotations) throw fail("INPUT_TOO_LARGE", "Too many draft annotations");
  const files = attachments.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw fail("INPUT_INVALID", "Choose a valid attachment");
    const file = { name: identity(item.name, "Attachment name", 1024) };
    if (item.path !== undefined) file.path = identity(item.path, "Attachment path", 4096);
    if (item.text !== undefined) file.text = boundedText(item.text, LIMITS.attachmentText, "Attachment text");
    if (!file.path && !file.text) throw fail("INPUT_INVALID", "Attachment content is missing");
    if (item.image === true) file.image = true;
    if (item.markup !== undefined) file.markup = boundedText(item.markup, LIMITS.text, "Image annotations");
    if (item.blobId !== undefined) {
      if (typeof item.blobId !== "string" || !/^[a-f0-9]{64}$/.test(item.blobId)) throw fail("INPUT_INVALID", "Attachment identity is invalid");
      file.blobId = item.blobId;
    }
    return file;
  });
  const notes = annotations.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw fail("INPUT_INVALID", "Choose a valid annotation");
    const note = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "id"));
    encode(note);
    return note;
  });
  const result = { text, attachments: files, annotations: notes };
  if (value.selection !== undefined) result.selection = JSON.parse(encode(value.selection));
  encode(result);
  return text.length || files.length || notes.length ? result : null;
}

module.exports = { LIMITS, fail, boundedText, identity, revision, encode, digest, draftPayload };
