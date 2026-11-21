"use strict";

const { parentPort, workerData, isMainThread } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { LIMITS, fail, identity, revision, encode, digest, draftPayload } = require("./chat-input-schema.cjs");
const { createAttachmentStore } = require("./chat-attachment-store.cjs");

function runInputWorker() {
  const { DatabaseSync } = require("node:sqlite");
  let db, owner;
  try {
    const { file, attachmentsRoot, maxStoredBytes = 64 * 1024 * 1024 } = workerData;
    if (typeof file !== "string" || !path.isAbsolute(file) || typeof attachmentsRoot !== "string" || !path.isAbsolute(attachmentsRoot)) throw fail("INPUT_ROOT_REQUIRED", "Choose explicit absolute input and attachment storage paths");
    if (!Number.isSafeInteger(maxStoredBytes) || maxStoredBytes < 1024) throw fail("INPUT_INVALID", "Input storage capacity is invalid");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    owner = new DatabaseSync(`${file}.owner.sqlite`);
    try { owner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
    catch { throw fail("INPUT_STORE_IN_USE", "Another input-store worker owns this data file"); }
    db = new DatabaseSync(file);
    const one = (sql, ...args) => db.prepare(sql).get(...args);
    const run = (sql, ...args) => db.prepare(sql).run(...args);
    const version = one("PRAGMA user_version").user_version;
    if (![0, 1].includes(version)) throw fail("INPUT_SCHEMA_UNSUPPORTED", "Saved input schema is newer than this app; it was not changed");
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; PRAGMA wal_autocheckpoint=0");
    const transaction = fn => {
      db.exec("BEGIN IMMEDIATE");
      try { const value = fn(); db.exec("COMMIT"); return value; }
      catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    };
    if (version === 0) transaction(() => db.exec(`
      CREATE TABLE usage(id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL);
      INSERT INTO usage VALUES(1,0);
      CREATE TABLE drafts(workspace TEXT NOT NULL, composer TEXT NOT NULL, revision INTEGER NOT NULL,
        payload TEXT, bytes INTEGER NOT NULL, mutation TEXT NOT NULL, digest TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(workspace,composer));
      CREATE TABLE conflicts(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, composer TEXT NOT NULL,
        mutation TEXT NOT NULL, digest TEXT NOT NULL, expected INTEGER NOT NULL, payload TEXT, created_at INTEGER NOT NULL,
        UNIQUE(workspace,composer,mutation));
      CREATE INDEX conflicts_by_composer ON conflicts(workspace,composer,created_at);
      CREATE TABLE inputs(ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, workspace TEXT NOT NULL,
        composer TEXT NOT NULL, mode TEXT NOT NULL, destination TEXT NOT NULL, payload TEXT NOT NULL,
        digest TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX inputs_by_composer ON inputs(workspace,composer,ordinal);
      CREATE INDEX inputs_by_state ON inputs(state,ordinal);
      CREATE TABLE blobs(hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, type TEXT NOT NULL);
      CREATE TABLE imports(id TEXT PRIMARY KEY, digest TEXT NOT NULL, imported_at INTEGER NOT NULL);
      PRAGMA user_version=1;`));
    transaction(() => run("UPDATE inputs SET state='unknown',updated_at=? WHERE state='dispatching'", Date.now()));
    const blobs = createAttachmentStore(attachmentsRoot);
    const scope = args => [identity(args.workspaceId, "Project", 200), identity(args.key, "Composer", 512)];
    const loadDraft = (workspace, composer) => one("SELECT * FROM drafts WHERE workspace=? AND composer=?", workspace, composer);
    const viewDraft = row => ({ revision: row?.revision ?? 0, draft: row?.payload ? JSON.parse(row.payload) : null, updatedAt: row?.updated_at ?? null });
    const charge = delta => {
      const used = one("SELECT bytes FROM usage WHERE id=1").bytes;
      if (used + delta > maxStoredBytes) throw fail("INPUT_STORAGE_FULL", "Saved input storage is full; pending input was not removed");
      run("UPDATE usage SET bytes=bytes+? WHERE id=1", delta);
    };
    function ownedAttachment(item, force) {
      const known = one("SELECT bytes FROM blobs WHERE hash=?", item.blobId);
      if (!known) throw fail("ATTACHMENT_MISSING", "Saved attachment reference is unavailable");
      try { return blobs.verify(item.blobId, known.bytes, { force, name: item.name }); }
      catch (error) {
        if (error.code === "ENOENT") throw fail("ATTACHMENT_MISSING", "The saved attachment is missing; this input was not sent");
        throw error;
      }
    }
    function preserve(value, verifyContent = false) {
      const draft = draftPayload(value);
      if (!draft) return null;
      draft.attachments = draft.attachments.map(item => {
        if (!item.path) return item;
        const saved = item.blobId ? ownedAttachment(item, verifyContent) : blobs.put({ sourcePath: item.path, name: item.name });
        run("INSERT OR IGNORE INTO blobs(hash,bytes,type) VALUES(?,?,?)", saved.blobId, saved.size, saved.type ?? "application/octet-stream");
        return { ...item, path: saved.path, blobId: saved.blobId };
      });
      return draft;
    }
    function saveDraft(args) {
      const [workspace, composer] = scope(args), expected = revision(args.expectedRevision), mutation = identity(args.mutationId, "Draft mutation");
      const raw = draftPayload(args.draft), requestDigest = digest(encode({ expected, draft: raw }));
      return transaction(() => {
        const current = loadDraft(workspace, composer);
        if (current?.mutation === mutation) {
          if (current.digest !== requestDigest) throw fail("INPUT_ID_CONFLICT", "Draft mutation belongs to different content");
          return { ...viewDraft(current), duplicate: true };
        }
        if ((current?.revision ?? 0) !== expected) {
          const prior = one("SELECT id,digest FROM conflicts WHERE workspace=? AND composer=? AND mutation=?", workspace, composer, mutation);
          if (prior && prior.digest !== requestDigest) throw fail("INPUT_ID_CONFLICT", "Draft mutation belongs to different content");
          if (prior) return { conflict: true, conflictId: prior.id, ...viewDraft(current) };
          const candidate = preserve(raw), body = candidate === null ? null : encode(candidate), id = randomUUID();
          charge(Buffer.byteLength(body ?? ""));
          run("INSERT INTO conflicts VALUES(?,?,?,?,?,?,?,?)", id, workspace, composer, mutation, requestDigest, expected, body, Date.now());
          return { conflict: true, conflictId: id, ...viewDraft(current) };
        }
        const value = preserve(raw), body = value === null ? null : encode(value), bytes = Buffer.byteLength(body ?? "");
        charge(bytes - (current?.bytes ?? 0));
        run(`INSERT INTO drafts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workspace,composer) DO UPDATE SET
          revision=excluded.revision,payload=excluded.payload,bytes=excluded.bytes,mutation=excluded.mutation,digest=excluded.digest,updated_at=excluded.updated_at`,
          workspace, composer, expected + 1, body, bytes, mutation, requestDigest, Date.now());
        return { ...viewDraft(loadDraft(workspace, composer)), duplicate: false };
      });
    }
    const input = (workspace, id) => {
      const row = one("SELECT * FROM inputs WHERE workspace=? AND id=?", identity(workspace, "Project", 200), identity(id, "Input ID"));
      if (!row) throw fail("INPUT_NOT_FOUND", "Saved input was not found in this project");
      return row;
    };
    const viewInput = row => ({ inputId: row.id, workspaceId: row.workspace, key: row.composer, ordinal: row.ordinal, mode: row.mode,
      destination: JSON.parse(row.destination), payload: JSON.parse(row.payload), state: row.state,
      receipt: row.receipt ? JSON.parse(row.receipt) : null, createdAt: row.created_at, updatedAt: row.updated_at });
    function accept(args) {
      const [workspace, composer] = scope(args), id = identity(args.inputId, "Input ID"), mode = args.mode;
      if (!["send", "queue", "steer"].includes(mode)) throw fail("INPUT_INVALID", "Choose send, queue or steer");
      const raw = draftPayload(args.payload);
      if (!raw) throw fail("INPUT_INVALID", "Input is empty");
      const destination = encode(args.destination ?? {}), requestDigest = digest(encode({ workspace, composer, mode, destination, payload: raw }));
      return transaction(() => {
        const previous = one("SELECT * FROM inputs WHERE id=?", id);
        if (previous) {
          if (previous.digest !== requestDigest) throw fail("INPUT_ID_CONFLICT", "Input ID belongs to different content");
          return { ...viewInput(previous), duplicate: true, draft: viewDraft(loadDraft(workspace, composer)) };
        }
        const preserved = preserve(raw, true), payload = encode(preserved), target = JSON.parse(destination);
        if (typeof target.message === "string") {
          const replacements = new Map(raw.attachments.flatMap((attachment, index) => attachment.path && preserved.attachments[index]?.path
            ? [[`${attachment.image ? "Attached image: " : "Attached file: "}${attachment.path}`, `${attachment.image ? "Attached image: " : "Attached file: "}${preserved.attachments[index].path}`]] : []));
          target.message = target.message.split("\n").map(line => replacements.get(line) ?? line).join("\n");
          if (target.message.length > 8192 || Buffer.byteLength(target.message) > LIMITS.message) throw fail("INPUT_TOO_LARGE", "The saved attachment paths make this message too long; shorten the text before sending");
        }
        const savedDestination = encode(target);
        charge(Buffer.byteLength(payload) + Buffer.byteLength(savedDestination));
        const at = Date.now();
        run("INSERT INTO inputs(id,workspace,composer,mode,destination,payload,digest,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?)", id, workspace, composer, mode, savedDestination, payload, requestDigest, at, at);
        const current = loadDraft(workspace, composer);
        if (args.draftRevision !== undefined) {
          revision(args.draftRevision);
          if (current?.revision === args.draftRevision && current.payload === payload) {
            charge(-current.bytes);
            run("UPDATE drafts SET revision=revision+1,payload=NULL,bytes=0,mutation=?,digest=?,updated_at=? WHERE workspace=? AND composer=?", `accepted-${id}`, requestDigest, at, workspace, composer);
          }
        }
        return { ...viewInput(input(workspace, id)), duplicate: false, draft: viewDraft(loadDraft(workspace, composer)) };
      });
    }
    const operations = {
      draftGet(args) { return viewDraft(loadDraft(...scope(args))); },
      draftSave: saveDraft,
      draftConflicts(args) {
        const [workspace, composer] = scope(args);
        return db.prepare("SELECT id,expected,payload,created_at FROM conflicts WHERE workspace=? AND composer=? ORDER BY created_at,id LIMIT 50").all(workspace, composer)
          .map(row => ({ id: row.id, expectedRevision: row.expected, draft: row.payload ? JSON.parse(row.payload) : null, createdAt: row.created_at }));
      },
      restoreDraft(args) {
        const [workspace, composer] = scope(args), expected = revision(args.expectedRevision), mutation = identity(args.mutationId, "Draft mutation");
        const raw = draftPayload(args.draft);
        const requestDigest = digest(encode({ inputId: args.inputId, expected, draft: raw }));
        return transaction(() => {
          const currentInput = input(workspace, args.inputId), currentDraft = loadDraft(workspace, composer);
          const previous = currentInput.receipt ? JSON.parse(currentInput.receipt) : null;
          if (currentInput.state === "cancelled" && previous?.stage === "restored-draft" && previous.mutationId === mutation) {
            if (previous.digest !== requestDigest) throw fail("INPUT_ID_CONFLICT", "Draft restoration belongs to different content");
            return { restored: true, duplicate: true, draft: viewDraft(currentDraft) };
          }
          if (currentInput.composer !== composer || currentInput.state !== "queued") throw fail("INPUT_STATE_CONFLICT", "Only this composer's unsent input can be edited");
          if ((currentDraft?.revision ?? 0) !== expected) throw fail("INPUT_STATE_CONFLICT", "The draft changed before the queued input could be restored; both were kept");
          const saved = preserve(raw), body = saved === null ? null : encode(saved), bytes = Buffer.byteLength(body ?? "");
          const receipt = encode({ stage: "restored-draft", mutationId: mutation, digest: requestDigest });
          charge(bytes - (currentDraft?.bytes ?? 0) + Buffer.byteLength(receipt) - Buffer.byteLength(currentInput.receipt ?? ""));
          run(`INSERT INTO drafts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workspace,composer) DO UPDATE SET
            revision=excluded.revision,payload=excluded.payload,bytes=excluded.bytes,mutation=excluded.mutation,digest=excluded.digest,updated_at=excluded.updated_at`,
            workspace, composer, expected + 1, body, bytes, mutation, requestDigest, Date.now());
          run("UPDATE inputs SET state='cancelled',receipt=?,updated_at=? WHERE id=?", receipt, Date.now(), currentInput.id);
          return { restored: true, duplicate: false, draft: viewDraft(loadDraft(workspace, composer)) };
        });
      },
      accept,
      get(args) { return viewInput(input(args.workspaceId, args.inputId)); },
      list(args) {
        const [workspace, composer] = scope(args), after = revision(args.after ?? 0);
        const limit = args.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw fail("INPUT_INVALID", "Input page limit must be 1 to 200");
        const rows = db.prepare("SELECT * FROM inputs WHERE workspace=? AND composer=? AND ordinal>? ORDER BY ordinal LIMIT ?").all(workspace, composer, after, limit + 1);
        const hasMore = rows.length > limit;
        if (hasMore) rows.pop();
        return { items: rows.map(viewInput), cursor: rows.at(-1)?.ordinal ?? after, hasMore };
      },
      pending(args) {
        const after = revision(args.after ?? 0);
        const rows = args.workspaceId !== undefined
          ? db.prepare("SELECT ordinal,id,workspace,composer,mode,destination,state FROM inputs WHERE workspace=? AND composer=? AND state IN ('queued','unknown','dispatching') AND ordinal>? ORDER BY ordinal LIMIT 26").all(...scope(args), after)
          : db.prepare("SELECT ordinal,id,workspace,composer,mode,destination,state FROM inputs WHERE state IN ('queued','unknown','dispatching') AND ordinal>? ORDER BY ordinal LIMIT 26").all(after);
        const hasMore = rows.length > 25;
        if (hasMore) rows.pop();
        return { items: rows.map(row => ({ inputId: row.id, workspaceId: row.workspace, key: row.composer, mode: row.mode, destination: JSON.parse(row.destination), state: row.state })),
          cursor: rows.at(-1)?.ordinal ?? after, hasMore };
      },
      dispatch(args) {
        return transaction(() => {
          const current = input(args.workspaceId, args.inputId);
          if (current.state !== "queued") return { ...viewInput(current), claimed: false };
          const checked = new Set();
          for (const file of JSON.parse(current.payload).attachments) {
            if (!file.path) continue;
            const snapshot = ownedAttachment(file, !checked.has(file.blobId));
            if (snapshot.path !== file.path) throw fail("ATTACHMENT_CORRUPT", "The saved attachment path changed; this input was not sent");
            checked.add(file.blobId);
          }
          run("UPDATE inputs SET state='dispatching',updated_at=? WHERE id=?", Date.now(), current.id);
          return { ...viewInput(input(args.workspaceId, args.inputId)), claimed: true };
        });
      },
      bindNativeSteer(args) {
        return transaction(() => {
          const current = input(args.workspaceId, args.inputId);
          const { taskId, runId, nodeId, sessionId, turnId } = args.target ?? {};
          if (current.state !== "dispatching" || taskId !== JSON.parse(current.destination).taskId) {
            throw fail("INPUT_SCOPE", "The native steer must bind to this dispatch and chat");
          }
          if (typeof sessionId !== "string" || !/^native:[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw fail("INPUT_SCOPE", "Choose a native session identity");
          const receipt = encode({ stage: "native-steer-target", workspaceId: current.workspace, inputId: current.id, sessionId,
            taskId: identity(taskId, "Task"), runId: identity(runId, "Run"), nodeId: identity(nodeId, "Node"), turnId: identity(turnId, "Turn") });
          if (current.receipt === receipt) return { bound: true };
          if (current.receipt !== null) throw fail("INPUT_STATE_CONFLICT", "This steer is already bound to another receiver");
          charge(Buffer.byteLength(receipt));
          run("UPDATE inputs SET receipt=?,updated_at=? WHERE id=?", receipt, Date.now(), current.id);
          return { bound: true };
        });
      },
      defer(args) {
        return transaction(() => {
          const current = input(args.workspaceId, args.inputId);
          if (current.state !== "dispatching") throw fail("INPUT_STATE_CONFLICT", "Only a confirmed undelivered request can be deferred");
          const binding = current.receipt && JSON.parse(current.receipt);
          const receipt = binding?.stage === "native-steer-target" ? null : current.receipt;
          charge(Buffer.byteLength(receipt ?? "") - Buffer.byteLength(current.receipt ?? ""));
          run("UPDATE inputs SET state='queued',receipt=?,updated_at=? WHERE id=?", receipt, Date.now(), current.id);
          return viewInput(input(args.workspaceId, args.inputId));
        });
      },
      settle(args) {
        const transitions = { dispatching: ["accepted", "unknown", "failed"], unknown: ["accepted", "cancelled"], accepted: ["completed", "failed", "cancelled"], queued: ["cancelled"] };
        return transaction(() => {
          const current = input(args.workspaceId, args.inputId);
          const receipt = args.receipt === undefined ? current.receipt : encode(args.receipt);
          if (current.state === args.state && current.receipt === receipt) return viewInput(current);
          if (current.state !== args.expectedState || !transitions[current.state]?.includes(args.state)) throw fail("INPUT_STATE_CONFLICT", "Input delivery changed; reconcile its exact receipt before retrying");
          if (args.state === "accepted") {
            const proof = receipt && JSON.parse(receipt);
            if (!proof || proof.inputId !== current.id) throw fail("INPUT_INVALID", "Delivery acceptance needs this input's exact receipt");
            const target = current.receipt && JSON.parse(current.receipt);
            if (target?.stage === "native-steer-target" && (proof.stage !== "steer"
              || ["taskId", "runId", "nodeId", "sessionId", "turnId", "inputId"].some(field => proof.result?.[field] !== target[field]))) {
              throw fail("INPUT_SCOPE", "The exact native steer receiver did not acknowledge this input");
            }
            if (proof.stage === "host-run" || proof.stage === "steer") {
              if (proof.result?.ok !== true || typeof proof.result.runId !== "string" || !proof.result.runId
                || proof.stage === "host-run" && (typeof proof.result.taskId !== "string" || !proof.result.taskId)
                || proof.stage === "steer" && proof.result.steered !== true) throw fail("INPUT_INVALID", "Host acceptance receipt is incomplete");
            } else if (!proof.engine || !proof.sessionId || !proof.turnId) throw fail("INPUT_INVALID", "Engine acceptance receipt is incomplete");
          }
          charge(Buffer.byteLength(receipt ?? "") - Buffer.byteLength(current.receipt ?? ""));
          run("UPDATE inputs SET state=?,receipt=?,updated_at=? WHERE id=?", args.state, receipt, Date.now(), current.id);
          return viewInput(input(args.workspaceId, args.inputId));
        });
      },
      importDrafts(args) {
        const id = identity(args.importId, "Import ID"), rows = args.drafts;
        if (!Array.isArray(rows) || rows.length > 50) throw fail("INPUT_INVALID", "Import at most 50 drafts per batch");
        const hash = digest(encode(rows));
        return transaction(() => {
          const previous = one("SELECT digest FROM imports WHERE id=?", id);
          if (previous) {
            if (previous.digest !== hash) throw fail("INPUT_ID_CONFLICT", "Import ID belongs to different content");
            return { imported: 0, duplicate: true };
          }
          let count = 0;
          for (const row of rows) {
            const [workspace, composer] = scope(row);
            if (loadDraft(workspace, composer)) continue;
            const body = encode(preserve(row.draft)), bytes = Buffer.byteLength(body);
            charge(bytes);
            run("INSERT INTO drafts VALUES(?,?,?,?,?,?,?,?)", workspace, composer, 1, body, bytes, `import-${id}`, digest(body), Date.now());
            count += 1;
          }
          run("INSERT INTO imports VALUES(?,?,?)", id, hash, Date.now());
          return { imported: count, duplicate: false };
        });
      },
      barrier() { return { saved: true }; },
      checkpoint() { return db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get(); },
    };
    const checkpoint = new DatabaseSync(file);
    checkpoint.exec("PRAGMA busy_timeout=0");
    let changed = false;
    const maintenance = setInterval(() => {
      if (!changed) return;
      try {
        const state = checkpoint.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
        if (!state.busy && state.checkpointed >= state.log) changed = false;
      } catch { /* Foreground commands keep priority; maintenance retries later. */ }
    }, 30_000);
    maintenance.unref();
    parentPort.postMessage({ ready: true });
    parentPort.on("message", ({ requestId, operation, args }) => {
      try {
        if (operation === "close") {
          clearInterval(maintenance); checkpoint.close();
          db.close(); db = null; owner.close(); owner = null;
          parentPort.postMessage({ requestId, result: { closed: true } }); parentPort.close(); return;
        }
        if (!Object.hasOwn(operations, operation)) throw fail("INPUT_INVALID", "Unsupported input-store operation");
        const result = operations[operation](args ?? {});
        if (["draftSave", "restoreDraft", "accept", "dispatch", "bindNativeSteer", "defer", "settle", "importDrafts"].includes(operation)) changed = true;
        parentPort.postMessage({ requestId, result });
      } catch (error) {
        parentPort.postMessage({ requestId, error: { code: error.code ?? "INPUT_STORE_FAILED",
          message: error.code?.startsWith("INPUT_") || error.code?.startsWith("ATTACHMENT_") ? error.message : "Input could not be saved; the previous saved copy was kept" } });
      }
    });
  } catch (error) {
    try { db?.close(); } catch {}
    try { owner?.close(); } catch {}
    parentPort.postMessage({ startupError: { code: error.code ?? "INPUT_STORE_FAILED", message: error.code?.startsWith("INPUT_") ? error.message : "Input storage could not be opened; existing files were not replaced" } });
    parentPort.close();
  }
}

if (!isMainThread && workerData?.chatInputStore === true) runInputWorker();
module.exports = { runInputWorker };
