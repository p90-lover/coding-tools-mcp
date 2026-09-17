"use strict";

const fs = require("node:fs");
const path = require("node:path");

const filePath = path.resolve(__dirname, "../../desktop-electron/electron/main.cjs");
let source = fs.readFileSync(filePath, "utf8");

function count(needle) {
  return source.split(needle).length - 1;
}

function removeOnce(block, label) {
  const occurrences = count(block);
  if (occurrences === 0) return;
  if (occurrences !== 1) throw new Error(`${label}: expected one block, found ${occurrences}`);
  source = source.replace(block, "");
}

function shrinkOnce(before, after, label) {
  const occurrences = count(before);
  if (occurrences === 0) {
    if (!source.includes(after)) throw new Error(`${label}: neither source nor replacement exists`);
    return;
  }
  if (occurrences !== 1) throw new Error(`${label}: expected one block, found ${occurrences}`);
  source = source.replace(before, after);
}

removeOnce(
  `function storedProviderCredential(secret) {\n  if (!secret || typeof secret !== "object") return "";\n  for (const key of ["apiKey", "token", "credential", "password"]) {\n    const value = secret[key];\n    if (typeof value === "string" && value.trim()) return value.trim();\n  }\n  return "";\n}\n\nfunction accountNeedsStoredCredential(auth) {\n  return auth === "api_key" || auth === "local_proxy";\n}\n\n`,
  "obsolete provider-secret helpers",
);

shrinkOnce(
  `    let settings = input.settings;\n    let credential = "";\n`,
  `    let settings = input.settings;\n`,
  "obsolete execution credential variable",
);

removeOnce(
  `      const secret = providerNetwork.store.accountSecret(plan.account.id);\n      credential = storedProviderCredential(secret);\n      if (accountNeedsStoredCredential(plan.account.auth) && !credential) {\n        throw new Error(\`Provider account \${plan.account.id} has no usable stored credential\`);\n      }\n`,
  "provider-secret control-plane leak",
);

if (!source.includes('      credential: input.controlCredential ?? "",\n')) {
  throw new Error("separate control credential is not wired to the execution sidecar");
}
if (/accountSecret\s*\(/u.test(source.slice(
  source.indexOf('handle("coding-tools:execution:provider"'),
  source.indexOf('handle("coding-tools:execution:update"'),
))) {
  throw new Error("provider account secret still appears inside execution-provider IPC");
}

fs.writeFileSync(filePath, source, "utf8");
console.log("main-process credential boundary repaired");
