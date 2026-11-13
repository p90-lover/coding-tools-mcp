"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_INPUTS = 16;
const MAX_BYTES = 2 * 1024 * 1024;
const NOTE = "Advisory only: compares declared files, not undeclared dependencies or the execution environment. Inspect the command output and preserve required CI/security/release gates. Never treat this receipt as authorization or an automatic reason to skip a requested command.";
const VERIFICATION_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["inputs"],
  description: "Optional evidence for a focused check. List source, test and config inputs (at most 16 files, 2 MiB total). Receipts never skip or approve commands. Retain the returned receipt in your existing task handoff for use after restart.",
  properties: {
    inputs: { type: "array", minItems: 1, maxItems: MAX_INPUTS, uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 1024 }, description: "Files relative to the workspace root, not the command's workdir." },
    context: { type: "string", maxLength: 256, description: "Optional non-secret dependency/environment identifier; caller-declared, not independently verified." },
  },
});
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function verificationSpec(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["inputs", "context"].includes(key))
    || !Array.isArray(value.inputs) || value.inputs.length < 1 || value.inputs.length > MAX_INPUTS
    || value.context !== undefined && (typeof value.context !== "string" || value.context.length > 256)) {
    throw new Error("verification requires 1–16 workspace-relative input files and an optional context of at most 256 characters");
  }
  const inputs = value.inputs.map(input => {
    if (typeof input !== "string" || !input || input.length > 1024 || /[\x00-\x1f:*?<>|"]/.test(input)
      || path.isAbsolute(input) || input.startsWith("\\") || input.split(/[\\/]/).some(part => !part || part === ".." || /[. ]$/.test(part))) {
      throw new Error("verification inputs must be ordinary workspace-relative file paths without parent traversal");
    }
    return input.replace(/\\/g, "/");
  });
  if (new Set(inputs).size !== inputs.length) throw new Error("verification inputs must not contain duplicates");
  return { inputs: inputs.sort(), context: value.context ?? "" };
}

async function fingerprintInputs(root, spec) {
  const canonicalRoot = await fs.realpath(root);
  const hash = crypto.createHash("sha256").update(JSON.stringify([canonicalRoot, spec.context, spec.inputs]));
  let remaining = MAX_BYTES;
  for (const input of spec.inputs) {
    const file = await fs.realpath(path.resolve(canonicalRoot, input));
    if (!inside(canonicalRoot, file)) throw new Error("verification input resolves outside the workspace");
    const handle = await fs.open(file, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > remaining) throw new Error("verification inputs must be regular files totaling at most 2 MiB");
      const fileHash = crypto.createHash("sha256");
      const buffer = Buffer.alloc(Math.min(64 * 1024, remaining + 1));
      let total = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining - total + 1), total);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > remaining) throw new Error("verification inputs exceed the 2 MiB limit");
        fileHash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error("verification input changed while being read");
      }
      remaining -= total;
      hash.update(JSON.stringify([input, file, total, fileHash.digest("hex")]));
    } finally { await handle.close(); }
  }
  return hash.digest("hex");
}

async function prepareVerification(root, args, commands, now) {
  const spec = verificationSpec(args.verification);
  const before = await fingerprintInputs(root, spec);
  const commandKey = digest(JSON.stringify([root, args.cmd, args.stdin ?? "", args.workdir ?? args.cwd ?? ".", spec]));
  const duplicate = [...commands.values()].reverse().find(command => command.verification?.commandKey === commandKey
    && command.verification.outcome === "passed" && command.verification.scope === "unchanged" && command.verification.after === before);
  return { root, spec, before, commandKey, startedAt: now, outcome: "running", scope: "pending",
    duplicateOf: duplicate?.id ?? null, finishedAt: null, after: null, exitCode: null };
}

async function observeVerification(record, value, now) {
  if (record.finishedAt !== null || !value || value.ok === false || value.finalization_pending === true
    || ["running", "terminating"].includes(value.status)) return;
  // Transport success alone cannot prove process success or even process completion.
  if (!["exited", "completed", "failed", "killed", "timed_out"].includes(value.status)) return;
  if (record.settling) return record.settling;
  record.settling = (async () => {
    record.finishedAt = now;
    record.exitCode = Number.isInteger(value.exit_code) ? value.exit_code : null;
    const interrupted = ["killed", "timed_out", "cancelled"].includes(value.termination_reason)
      || ["failed", "killed", "timed_out"].includes(value.status);
    record.outcome = interrupted || value.command_ok === false || record.exitCode !== null && record.exitCode !== 0
      ? "failed" : record.exitCode === 0 ? "passed" : "unknown";
    try {
      record.after = await fingerprintInputs(record.root, record.spec);
      record.scope = record.after === record.before ? "unchanged" : "changed";
    } catch { record.scope = "unavailable"; }
  })();
  await record.settling;
}

async function verificationReceipt(record, now, refresh = false) {
  if (record.settling) await record.settling;
  let current = record.scope;
  if (refresh && record.finishedAt !== null && record.scope === "unchanged") {
    try { current = await fingerprintInputs(record.root, record.spec) === record.after ? "unchanged" : "changed"; }
    catch { current = "unavailable"; }
  }
  return {
    command_fingerprint: record.commandKey, input_fingerprint: record.before,
    inputs: record.spec.inputs, context: record.spec.context,
    outcome: record.outcome, exit_code: record.exitCode, input_status: current,
    started_at_ms: record.startedAt, completed_at_ms: record.finishedAt,
    elapsed_ms: Math.max(0, (record.finishedAt ?? now) - record.startedAt),
    ...(record.duplicateOf ? { duplicate_of: record.duplicateOf,
      advisory: "An earlier identical check passed with matching declared inputs. This requested command still ran; avoid further repeats unless relevant inputs or assumptions changed." } : {}),
    advisory_only: true, scope_note: NOTE,
  };
}

module.exports = { VERIFICATION_SCHEMA, verificationSpec, fingerprintInputs, prepareVerification, observeVerification, verificationReceipt };
