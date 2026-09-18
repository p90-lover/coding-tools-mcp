"use strict";

const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const aiTempRoot = path.join(repositoryRoot, "aiTemp");

const REQUIRED_FIVE_STACK_ASAR_FILES = Object.freeze([
  "electron/main-with-provider.cjs",
  "electron/main.cjs",
  "electron/preload.cjs",
  "electron/runtime-supervisor.cjs",
  "electron/provider-bootstrap.cjs",
  "electron/provider-execution-router.cjs",
  "electron/provider-network.cjs",
  "electron/upstream-tools.cjs",
  "electron/ipc-schema.cjs",
  "vendor/upstream/five-stack.json",
  "vendor/upstream/paseo.json",
  "vendor/upstream/anneal.json",
]);

const EXPECTED_INTEGRATIONS = Object.freeze([
  "codex-router",
  "cpa-provider-hub",
  "commandcode-proxy",
  "paseo",
  "anneal",
]);

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function normalizeEntries(entries) {
  return [...new Set(entries.map((entry) => String(entry)
    .replaceAll("\\", "/")
    .replace(/^\/+/, ""))
    .filter(Boolean))]
    .sort();
}

function assertRequiredEntries(entries) {
  const present = new Set(normalizeEntries(entries));
  const missing = REQUIRED_FIVE_STACK_ASAR_FILES.filter((entry) => !present.has(entry));
  if (missing.length) fail("FIVE_STACK_ASAR_REQUIRED_FILE_MISSING", missing.join(", "));
  return REQUIRED_FIVE_STACK_ASAR_FILES.length;
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateManifestObjects(stack, paseo, anneal) {
  if (!plain(stack) || stack.schemaVersion !== 1 || !Array.isArray(stack.integrations)) {
    fail("FIVE_STACK_REGISTRY_INVALID", JSON.stringify(stack));
  }
  const integrationIds = stack.integrations.map((entry) => entry?.id);
  if (JSON.stringify(integrationIds) !== JSON.stringify(EXPECTED_INTEGRATIONS)) {
    fail("FIVE_STACK_REGISTRY_IDENTITY_MISMATCH", JSON.stringify(integrationIds));
  }
  for (const integration of stack.integrations) {
    if (!plain(integration) || integration.insideApp !== true
      || typeof integration.surface !== "string" || !integration.surface
      || typeof integration.controller !== "string" || !integration.controller
      || typeof integration.healthContract !== "string" || !integration.healthContract) {
      fail("FIVE_STACK_REGISTRY_ENTRY_INVALID", JSON.stringify(integration));
    }
  }

  if (!plain(paseo) || paseo.id !== "paseo"
    || paseo.defaultEndpoint !== "http://127.0.0.1:6767/"
    || paseo.managed?.strategy !== "pinned-source"
    || paseo.managed?.autoInstall !== true
    || paseo.managed?.source?.commit !== paseo.commit
    || JSON.stringify(paseo.managed?.services?.map((service) => service.id)) !== JSON.stringify(["daemon"])) {
    fail("FIVE_STACK_PASEO_MANIFEST_INVALID", JSON.stringify(paseo));
  }

  if (!plain(anneal) || anneal.id !== "anneal"
    || anneal.defaultEndpoint !== "http://127.0.0.1:5173/"
    || anneal.managed?.strategy !== "pinned-source"
    || anneal.managed?.autoInstall !== true
    || anneal.managed?.platformModes?.win32 !== "wsl2"
    || anneal.managed?.source?.commit !== anneal.commit
    || JSON.stringify(anneal.managed?.services?.map((service) => service.id))
      !== JSON.stringify(["postgres", "api", "runner", "web"])) {
    fail("FIVE_STACK_ANNEAL_MANIFEST_INVALID", JSON.stringify(anneal));
  }

  return {
    integrations: integrationIds,
    paseoCommit: paseo.commit,
    annealCommit: anneal.commit,
  };
}

function asarApi() {
  let resolved;
  try {
    resolved = require.resolve("@electron/asar", { paths: [desktopRoot] });
  } catch {
    fail("FIVE_STACK_ASAR_READER_UNAVAILABLE", "@electron/asar is required");
  }
  const api = require(resolved);
  if (typeof api.extractFile !== "function" || typeof api.listPackage !== "function") {
    fail("FIVE_STACK_ASAR_READER_INVALID", resolved);
  }
  return api;
}

function walkForAsar(root, matches, depth = 0) {
  if (depth > 5) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkForAsar(absolute, matches, depth + 1);
    else if (entry.isFile() && entry.name === "app.asar") matches.push(absolute);
  }
}

function findAsar(inputPath) {
  const input = path.resolve(inputPath);
  if (!fs.existsSync(input)) fail("FIVE_STACK_PACKAGE_INPUT_MISSING", input);
  if (fs.statSync(input).isFile()) {
    if (path.basename(input) !== "app.asar") fail("FIVE_STACK_PACKAGE_INPUT_INVALID", input);
    return input;
  }
  if (!fs.statSync(input).isDirectory()) fail("FIVE_STACK_PACKAGE_INPUT_INVALID", input);

  const direct = path.join(input, "resources", "app.asar");
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;

  const matches = [];
  walkForAsar(input, matches);
  const preferred = matches.filter((candidate) => candidate.replaceAll("\\", "/").includes("/win-unpacked/resources/app.asar"));
  const selected = preferred.length === 1 ? preferred : matches;
  if (selected.length !== 1) {
    fail("FIVE_STACK_ASAR_COUNT_MISMATCH", selected.join(", ") || "none");
  }
  return selected[0];
}

function readAsarJson(api, asarPath, relativePath) {
  try {
    return JSON.parse(Buffer.from(api.extractFile(asarPath, relativePath)).toString("utf8"));
  } catch (error) {
    fail("FIVE_STACK_ASAR_JSON_INVALID", `${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function verifyFiveStackPackage(inputPath) {
  const api = asarApi();
  const asarPath = findAsar(inputPath);
  const entries = normalizeEntries(api.listPackage(asarPath));
  const requiredFileCount = assertRequiredEntries(entries);
  const manifest = validateManifestObjects(
    readAsarJson(api, asarPath, "vendor/upstream/five-stack.json"),
    readAsarJson(api, asarPath, "vendor/upstream/paseo.json"),
    readAsarJson(api, asarPath, "vendor/upstream/anneal.json"),
  );
  return {
    ok: true,
    asarPath,
    requiredFileCount,
    entryCount: entries.length,
    ...manifest,
  };
}

function writeEvidence(filePath, value) {
  const target = path.resolve(filePath);
  const relative = path.relative(aiTempRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("FIVE_STACK_EVIDENCE_PATH_OUTSIDE_AITEMP", target);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function parseArguments(argv) {
  const args = [...argv];
  const input = args.shift();
  if (!input) fail("FIVE_STACK_PACKAGE_USAGE", "node verify-five-stack-package.cjs <package-root-or-app.asar> [--json-out <aiTemp path>]");
  let jsonOut = null;
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (flag !== "--json-out" || !value || jsonOut) fail("FIVE_STACK_PACKAGE_USAGE", String(flag));
    jsonOut = value;
  }
  return { input, jsonOut };
}

if (require.main === module) {
  try {
    const { input, jsonOut } = parseArguments(process.argv.slice(2));
    const result = verifyFiveStackPackage(input);
    if (jsonOut) writeEvidence(jsonOut, result);
    process.stdout.write(`FIVE_STACK_PACKAGE_VERIFICATION_PASS ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  EXPECTED_INTEGRATIONS,
  REQUIRED_FIVE_STACK_ASAR_FILES,
  assertRequiredEntries,
  findAsar,
  normalizeEntries,
  validateManifestObjects,
  verifyFiveStackPackage,
};
