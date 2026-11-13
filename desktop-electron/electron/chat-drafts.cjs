"use strict";

// Each chat composer's unsent draft: what was typed, the files and images attached, and the
// annotations (words selected in an answer). They lived only in the chat view's memory, so a crash,
// a renderer reload or a restart lost a long prompt being written, as Claude Code and Codex do not:
// both keep the unsent prompt. The view saves its draft here a moment after each change and reads it
// back when the composer opens; a message being sent keeps its saved draft until the send is done.
//
// A file attached by path keeps only its path (the file stays where it is); one read in as text keeps
// its text, up to ATTACHMENT_TEXT_LIMIT. The thumbnail of an image is rebuilt from its path.

const { createStateFileWriter, readStateFile } = require("./durable-state.cjs");

const STATE_VERSION = 1;
const DRAFT_LIMIT = 200;
const KEY_LIMIT = 512;
const TEXT_LIMIT = 64 * 1024;
const ATTACHMENTS_LIMIT = 30;
const ATTACHMENT_TEXT_LIMIT = 256 * 1024;
const ANNOTATIONS_LIMIT = 50;
const ANNOTATION_TEXT_LIMIT = 8192;

const str = (value, limit) => (typeof value === "string" ? value.slice(0, limit) : "");

function cleanAttachment(item) {
  if (!item || typeof item !== "object") return null;
  const name = str(item.name, 260);
  const path = str(item.path, 2048);
  const text = str(item.text, ATTACHMENT_TEXT_LIMIT);
  // Nothing to bring back without its file or its text.
  if (!name || (!path && !text)) return null;
  return { name, ...(path ? { path } : {}), ...(!path && text ? { text } : {}),
    ...(item.image === true ? { image: true } : {}), ...(typeof item.markup === "string" && item.markup ? { markup: str(item.markup, TEXT_LIMIT) } : {}) };
}

function cleanAnnotation(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const out = {};
  for (const [field, value] of Object.entries(item)) {
    if (field === "id") continue;
    if (typeof value === "string") out[field] = value.slice(0, ANNOTATION_TEXT_LIMIT);
    else if (typeof value === "number" && Number.isFinite(value)) out[field] = value;
    else if (field === "anchor" && value && typeof value === "object"
      && ["answer", "start", "end"].every((part) => Number.isInteger(value[part]))) out.anchor = { answer: value.answer, start: value.start, end: value.end };
  }
  return Object.keys(out).length ? out : null;
}

/** A draft as saved, or null when there is nothing in it. */
function cleanDraft(draft) {
  if (!draft || typeof draft !== "object") return null;
  const text = str(draft.text, TEXT_LIMIT);
  const attachments = (Array.isArray(draft.attachments) ? draft.attachments : []).map(cleanAttachment).filter(Boolean).slice(0, ATTACHMENTS_LIMIT);
  const annotations = (Array.isArray(draft.annotations) ? draft.annotations : []).map(cleanAnnotation).filter(Boolean).slice(0, ANNOTATIONS_LIMIT);
  if (!text.trim() && !attachments.length && !annotations.length) return null;
  return { text, attachments, annotations };
}

/**
 * The drafts, saved in a small JSON file with a copy (durable-state.cjs), so they survive a crash, a
 * restart and a torn file. Without a file (tests) they live in memory. Keys are the chat view's own
 * (a chat's task, or a new chat's project and pane), scoped by project.
 */
function createChatDraftStore({ file = null, now = Date.now, logger = null } = {}) {
  let drafts = {};
  if (file) {
    const read = readStateFile(file, (raw) => {
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object" || typeof saved.drafts !== "object" || Array.isArray(saved.drafts)) throw new Error("not a chat drafts file");
      return saved.drafts;
    }, { now });
    if (read.value) drafts = read.value;
    if (read.source === "backup" || read.source === "unreadable") {
      logger?.warn?.(read.source === "backup" ? "chat_drafts.restored_from_copy" : "chat_drafts.unreadable", { message: String(read.error?.message || "").slice(0, 200) });
    }
  }
  const writer = file ? createStateFileWriter(file, { protectDirectory: false,
    onError: (error) => logger?.warn?.("chat_drafts.save_failed", { message: String(error?.message || error).slice(0, 200) }) }) : null;
  const persist = () => writer?.save(`${JSON.stringify({ version: STATE_VERSION, drafts })}\n`);
  const name = (workspaceId, key) => `${str(workspaceId, 200)}\u0000${str(key, KEY_LIMIT)}`;
  return {
    /** Resolves once every change so far is on disk (tests, and a caller about to exit). */
    saved: async () => writer?.saved(),
    /** The saved draft for `key` in `workspaceId`, or null. */
    get(workspaceId, key) {
      const entry = drafts[name(workspaceId, key)];
      const draft = cleanDraft(entry);
      return draft ? { ...draft, at: Number.isFinite(entry.at) ? entry.at : 0 } : null;
    },
    /** Saves `draft` for `key` (an empty one, or null, removes it). Returns whether one is kept. */
    set(workspaceId, key, draft) {
      if (!str(workspaceId, 200) || !str(key, KEY_LIMIT)) throw new Error("A draft needs its project and chat");
      const clean = cleanDraft(draft);
      const slot = name(workspaceId, key);
      if (!clean) {
        if (!(slot in drafts)) return false;
        delete drafts[slot];
        persist();
        return false;
      }
      drafts[slot] = { ...clean, at: now() };
      // The oldest drafts make room past DRAFT_LIMIT.
      const names = Object.keys(drafts);
      if (names.length > DRAFT_LIMIT) {
        for (const old of names.sort((a, b) => (drafts[a].at || 0) - (drafts[b].at || 0)).slice(0, names.length - DRAFT_LIMIT)) delete drafts[old];
      }
      persist();
      return true;
    },
  };
}

module.exports = { createChatDraftStore, cleanDraft };
