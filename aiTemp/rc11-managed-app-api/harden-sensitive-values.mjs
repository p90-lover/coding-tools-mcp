import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const target = path.join(root, "desktop-electron/electron/managed-app-api.cjs");

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) {
    throw new Error(`Cannot harden ${label}: expected source marker is missing`);
  }
  return source.replace(before, after);
}

const original = fs.readFileSync(target, "utf8");
let next = original;

const originalValueRedaction = String.raw`    .replace(/\b(authorization|token|secret|password|api[_-]?key|management[_-]?key|caller[_-]?key|set[-_]?cookie|cookies?)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\buser_[A-Za-z0-9._~-]+/g, "user_[REDACTED]")`;
const hardenedValueRedaction = String.raw`    .replace(/\b(authorization|token|secret|password|api[_-]?key|management[_-]?key|caller[_-]?key|set[-_]?cookie|cookies?)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bya29\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\buser_[A-Za-z0-9._~-]+/g, "user_[REDACTED]")`;
next = replaceRequired(
  next,
  originalValueRedaction,
  hardenedValueRedaction,
  "bare sensitive values",
);

const optionalIdentifierBlock = `function optionalIdentifier(value, name, maximum = 160) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(\`${"${name}"} must be text\`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || normalized.includes("\\0")) {
    throw new Error(\`${"${name}"} is invalid\`);
  }
  return normalized;
}
`;
const hardenedIdentifierBlock = `${optionalIdentifierBlock}
function validateReconcileReason(value) {
  const reason = optionalIdentifier(value, "reason", 128) || "managed-app-api";
  if (redactText(reason, 128) !== reason) {
    throw new Error("Managed app reconcile reason must not contain credentials, sensitive values, or tokens");
  }
  return reason;
}
`;
next = replaceRequired(
  next,
  optionalIdentifierBlock,
  hardenedIdentifierBlock,
  "reconcile reason validation",
);

next = replaceRequired(
  next,
  '    const reason = optionalIdentifier(input.reason, "reason", 128) || "managed-app-api";',
  '    const reason = validateReconcileReason(input.reason);',
  "reconcile reason use",
);

next = replaceRequired(
  next,
  `  sanitizePublic,
});`,
  `  sanitizePublic,
  validateReconcileReason,
});`,
  "reconcile reason export",
);

if (next !== original) {
  fs.writeFileSync(target, next, "utf8");
  console.log("RC11_MANAGED_APP_SENSITIVE_VALUES_HARDENED");
} else {
  console.log("RC11_MANAGED_APP_SENSITIVE_VALUES_ALREADY_HARDENED");
}
