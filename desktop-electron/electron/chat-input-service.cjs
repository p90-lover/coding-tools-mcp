"use strict";

const fs = require("node:fs");
const { createChatInputStore } = require("./chat-input-store.cjs");
const { LIMITS, fail, identity, digest, encode, boundedText } = require("./chat-input-schema.cjs");
const DRAFT_REFUSALS = new Set(["INPUT_INVALID", "INPUT_TOO_LARGE", "INPUT_STORAGE_FULL",
  "ATTACHMENT_INVALID", "ATTACHMENT_CHANGED", "ATTACHMENT_MISSING", "ATTACHMENT_CORRUPT"]);

function createChatInputService({ file, attachmentsRoot, legacyDraftsFile = null, store = null } = {}) {
  const journal = store ?? createChatInputStore({ file, attachmentsRoot });
  const loading = new Map();
  const dispatching = new Map();
  let legacyRead = null;
  async function readLegacy() {
    if (!legacyDraftsFile) return {};
    let damaged = false;
    for (const candidate of [legacyDraftsFile, `${legacyDraftsFile}.bak`]) {
      try {
        const info = await fs.promises.stat(candidate);
        if (!info.isFile() || info.size > 64 * 1024 * 1024) throw fail("INPUT_LEGACY_INVALID", "The legacy draft file needs recovery before importing");
        const parsed = JSON.parse(await fs.promises.readFile(candidate, "utf8"));
        if (parsed?.version !== 1 || !parsed.drafts || typeof parsed.drafts !== "object" || Array.isArray(parsed.drafts)) throw fail("INPUT_LEGACY_INVALID", "Legacy drafts have an unsupported format");
        return parsed.drafts;
      } catch (error) {
        if (error.code !== "ENOENT") damaged = true;
      }
    }
    if (damaged) throw fail("INPUT_LEGACY_INVALID", "Saved drafts could not be read; original files were kept for recovery");
    return {};
  }
  async function load(args) {
    const workspaceId = identity(args.workspaceId, "Project", 200), key = identity(args.key, "Composer", 512), slot = encode([workspaceId, key]);
    if (loading.has(slot)) return loading.get(slot);
    const reading = (async () => {
      let current = await journal.call("draftGet", { workspaceId, key });
      if (current.revision !== 0) return current;
      legacyRead ??= readLegacy().catch(error => { legacyRead = null; throw error; });
      const legacy = (await legacyRead)[`${workspaceId}\0${key}`];
      if (!legacy) return current;
      const draft = { text: legacy.text ?? "", attachments: legacy.attachments ?? [], annotations: legacy.annotations ?? [] };
      const importId = `draft-${digest(encode([workspaceId, key, draft]))}`;
      await journal.call("importDrafts", { importId, drafts: [{ workspaceId, key, draft }] });
      current = await journal.call("draftGet", { workspaceId, key });
      return current;
    })();
    loading.set(slot, reading);
    try { return await reading; } finally { if (loading.get(slot) === reading) loading.delete(slot); }
  }
  async function call(args) {
    const workspaceId = identity(args.workspaceId, "Project", 200);
    switch (args.action) {
      case "draft_get": return { ok: true, ...await load(args) };
      case "draft_save": {
        await load(args);
        try {
          return { ok: true, ...await journal.call("draftSave", { workspaceId, key: args.key, expectedRevision: args.expectedRevision, mutationId: args.mutationId, draft: args.draft }) };
        } catch (error) {
          if (!DRAFT_REFUSALS.has(error?.code)) throw error;
          return { ok: true, saved: false, reason: error.message };
        }
      }
      case "draft_conflicts": return { ok: true, conflicts: await journal.call("draftConflicts", { workspaceId, key: args.key }) };
      case "accept": {
        const destination = args.destination;
        if (!destination || typeof destination !== "object" || Array.isArray(destination)) throw fail("INPUT_INVALID", "Choose a chat destination");
        const message = boundedText(destination.message, LIMITS.message, "Chat message");
        if (!message.trim() || message.length > 8192) throw fail("INPUT_INVALID", "Chat messages must contain 1 to 8192 characters");
        const allowed = new Set(["message", "taskId", "title", "goal", "executionMode", "singleRoute", "teamId", "teamRevision", "executable", "restart", "rewind"]);
        if (Object.keys(destination).some(key => !allowed.has(key))) throw fail("INPUT_INVALID", "Chat destination contains an unsupported field");
        return { ok: true, ...await journal.call("accept", { workspaceId, key: args.key, inputId: args.inputId, mode: args.mode, payload: args.payload,
          destination, ...(args.draftRevision === undefined ? {} : { draftRevision: args.draftRevision }) }) };
      }
      case "restore_draft": return { ok: true, ...await journal.call("restoreDraft", { workspaceId, key: args.key,
        inputId: args.inputId, expectedRevision: args.expectedRevision, mutationId: args.mutationId, draft: args.draft }) };
      case "cancel": return { ok: true, input: await journal.call("settle", { workspaceId, inputId: args.inputId, expectedState: "queued", state: "cancelled" }) };
      case "pending": return { ok: true, ...await journal.call("pending", { workspaceId, key: args.key, ...(args.after === undefined ? {} : { after: args.after }) }) };
      case "get": return { ok: true, input: await journal.call("get", { workspaceId, inputId: args.inputId }) };
      case "list": return { ok: true, ...await journal.call("list", { workspaceId, key: args.key, ...(args.after === undefined ? {} : { after: args.after }), ...(args.limit === undefined ? {} : { limit: args.limit }) }) };
      default: throw fail("INPUT_INVALID", "Choose a supported chat input action");
    }
  }
  async function reconcileSaved(saved, { steer, reconcile, reconcileSteer }) {
    const { workspaceId, inputId, receipt: binding } = saved;
    let receipt;
    if (binding?.stage === "native-steer-target") {
      const found = await reconcileSteer?.(binding);
      if (found?.state === "accepted" && ["workspaceId", "sessionId", "turnId", "inputId"].every(field => found[field] === binding[field])) {
        const { taskId, runId, nodeId, sessionId, turnId } = binding;
        receipt = { inputId, stage: "steer", result: { ok: true, steered: true, taskId, runId, nodeId, sessionId, turnId, inputId, status: "recovered" } };
      }
    } else if (!steer && reconcile) {
      const found = await reconcile({ workspaceId, inputId });
      if (found?.ok === true && found.found === true && found.input_id === inputId && found.run?.workspace_id === workspaceId
        && typeof found.run_id === "string" && found.run_id && found.run_id === found.run.id
        && typeof found.task_id === "string" && found.task_id && found.task_id === found.run.project_id
        && (!saved.destination.taskId || found.task_id === saved.destination.taskId)) {
        receipt = { inputId, stage: "host-run", result: { ok: true, taskId: found.task_id, runId: found.run_id, run: found.run, status: "recovered" } };
      }
    }
    if (!receipt) throw fail("INPUT_DELIVERY_UNKNOWN", "Delivery is unknown. Your input is saved; reconcile its receipt before sending it again");
    await journal.call("settle", { workspaceId, inputId, expectedState: saved.state, state: "accepted", receipt });
    return receipt.result;
  }
  async function dispatch(args, execute, { steer = false, reconcile = null, reconcileSteer = null } = {}) {
    const workspaceId = identity(args.workspaceId, "Project", 200), inputId = identity(args.inputId, "Input ID");
    const saved = await journal.call("get", { workspaceId, inputId });
    if (saved.destination.taskId && args.taskId && saved.destination.taskId !== args.taskId) throw fail("INPUT_SCOPE", "The saved input belongs to a different chat");
    if (args.message !== undefined && args.message !== saved.destination.message) throw fail("INPUT_ID_CONFLICT", "The saved message differs from the message being sent");
    if (saved.state === "accepted" || saved.state === "completed") return saved.receipt?.result;
    const key = encode([workspaceId, inputId]);
    if (dispatching.has(key)) return dispatching.get(key);
    const work = (async () => {
      if (saved.state === "unknown" || saved.state === "dispatching") return reconcileSaved(saved, { steer, reconcile, reconcileSteer });
      const claimed = await journal.call("dispatch", { workspaceId, inputId });
      if (!claimed.claimed) throw fail("INPUT_STATE_CONFLICT", "This saved input can no longer be dispatched");
      try {
        const bindNativeSteer = steer ? target => journal.call("bindNativeSteer", { workspaceId, inputId, target }) : undefined;
        const result = await execute({ ...saved.destination, workspaceId, inputId, ...(args.deferStart === true ? { deferStart: true } : {}) }, bindNativeSteer);
        if (steer && result?.ok === true && result.steered === false) {
          await journal.call("defer", { workspaceId, inputId });
          return result;
        }
        if (!result || result.ok === false || steer && result.steered !== true) throw fail("INPUT_DELIVERY_UNKNOWN", "Delivery did not return a confirmed receipt; your input remains saved");
        const receipt = { inputId, stage: steer ? "steer" : "host-run", result };
        await journal.call("settle", { workspaceId, inputId, expectedState: "dispatching", state: "accepted", receipt });
        return result;
      } catch (error) {
        await journal.call("settle", { workspaceId, inputId, expectedState: "dispatching", state: "unknown" }).catch(() => {});
        throw error;
      }
    })();
    dispatching.set(key, work);
    try { return await work; } finally { if (dispatching.get(key) === work) dispatching.delete(key); }
  }
  return Object.freeze({ call, dispatch, get: (workspaceId, inputId) => journal.call("get", { workspaceId, inputId }),
    bindNativeSendTarget: (scope, sessionId) => journal.call("bindNativeSendTarget", { ...scope, sessionId }),
    readNativeSendTarget: scope => journal.call("readNativeSendTarget", scope),
    pending: (after = 0) => journal.call("pending", { after }),
    cancel: (workspaceId, inputId) => journal.call("settle", { workspaceId, inputId, expectedState: "queued", state: "cancelled" }),
    saved: () => journal.saved(), close: () => journal.close() });
}

module.exports = { createChatInputService };
