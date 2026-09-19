import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const target = path.join(root, "desktop-electron/electron/managed-app-api.cjs");

const originalSensitiveKey = 'const SENSITIVE_KEY = /(?:^|_)(?:access_token|refresh_token|api_key|private_key|client_secret|password|secret|token|credential|bearer|authorization|caller_key|proxy_api_key|management_key|session_cookie)(?:_|$)/i;';
const hardenedSensitiveKey = 'const SENSITIVE_KEY = /(?:^|_)(?:access_token|refresh_token|api_key|private_key|client_secret|password|secret|token|credential|bearer|authorization|caller_key|proxy_api_key|management_key|session_cookie|cookies?)(?:_|$)/i;';

const originalTextRedaction = '    .replace(/\\b(authorization|token|secret|password|api[_-]?key|management[_-]?key|caller[_-]?key)\\s*[:=]\\s*[^\\s,;]+/gi, "$1=[REDACTED]")';
const hardenedTextRedaction = '    .replace(/\\b(authorization|token|secret|password|api[_-]?key|management[_-]?key|caller[_-]?key|set[-_]?cookie|cookies?)\\s*[:=]\\s*[^\\s,;]+/gi, "$1=[REDACTED]")';

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) {
    throw new Error(`Cannot harden ${label}: expected source marker is missing`);
  }
  return source.replace(before, after);
}

const original = fs.readFileSync(target, "utf8");
let next = replaceRequired(
  original,
  originalSensitiveKey,
  hardenedSensitiveKey,
  "sensitive cookie keys",
);
next = replaceRequired(
  next,
  originalTextRedaction,
  hardenedTextRedaction,
  "cookie header text",
);

if (next !== original) {
  fs.writeFileSync(target, next, "utf8");
  console.log("Hardened managed-app API cookie redaction");
} else {
  console.log("Managed-app API cookie redaction already hardened");
}
