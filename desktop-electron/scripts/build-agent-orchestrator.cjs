"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "../..");
const sourceRoot = path.resolve(process.env.CODING_TOOLS_AO_SOURCE_DIR || path.join(projectRoot, "module", "agent-orchestrator"));
// Upstream base. The superproject pins a fork commit carrying the Coding Tools integration on top.
const upstreamCommit = "73473d45f0c18f3a81f66f150868459e3098ca35";
const stageRoot = path.resolve(process.env.CODING_TOOLS_AO_STAGE_DIR || path.join(projectRoot, "aiTemp", "ao-source-build"));
const frontendRoot = path.join(stageRoot, "frontend");
const outputRoot = path.resolve(process.env.CODING_TOOLS_AO_OUTPUT_DIR || path.join(projectRoot, "desktop-electron", "build", "agent-orchestrator"));
// AO's packaged ACP runtime (pinned Node + @agentclientprotocol/claude-agent-acp). The daemon looks
// for it at resources/acp-runtime beside resources/agent-orchestrator; Claude Code's chat mode and
// model catalog need it.
const acpOutputRoot = path.join(projectRoot, "desktop-electron", "build", "acp-runtime");

/** Builds AO's ACP runtime with AO's own pinned recipe (checksum-verified Node, npm ci from a
 * lockfile, no install scripts) and copies it next to the daemon build when it changed. */
function buildAcpRuntime() {
  run(process.execPath, [path.join(sourceRoot, "frontend", "scripts", "build-acp-runtime.mjs")], path.join(sourceRoot, "frontend"));
  const built = path.join(sourceRoot, "frontend", "resources", "acp-runtime");
  const marker = (directory) => {
    try { return fs.readFileSync(path.join(directory, ".ao-acp-runtime.json"), "utf8"); } catch { return ""; }
  };
  const current = marker(built);
  if (!current) throw new Error("AO ACP runtime build produced no marker");
  if (marker(acpOutputRoot) === current) return JSON.parse(current);
  // Retain the previous runtime in aiTemp/Trash (this repository never deletes build output).
  if (fs.existsSync(acpOutputRoot)) {
    const trash = path.join(projectRoot, "aiTemp", "Trash", "acp-runtime");
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(acpOutputRoot, path.join(trash, new Date().toISOString().replace(/[:.]/g, "-")));
  }
  fs.cpSync(built, acpOutputRoot, { recursive: true });
  return JSON.parse(current);
}

function run(command, arguments_, cwd, env = {}) {
  console.log(`[AO build] ${command} ${arguments_.join(" ")}`);
  const result = spawnSync(command, arguments_, {
    cwd, env: { ...process.env, ...env }, stdio: "inherit", windowsHide: true,
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
  if (result.error || result.status !== 0) throw result.error || new Error(`Build exited ${result.status}`);
}

async function main() {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).stdout.trim();
  const pin = spawnSync("git", ["rev-parse", "HEAD:module/agent-orchestrator"], { cwd: projectRoot, encoding: "utf8" });
  const pinned = pin.status === 0 ? pin.stdout.trim() : "";
  // Either a checkout of the pinned fork commit, or the upstream base with the same integration
  // present as working-tree changes; anything else is an unreviewed source.
  assert.ok(head === pinned || head === upstreamCommit, `Unexpected AO source revision ${head} (pinned ${pinned || "none"})`);
  const provenance = head === pinned && head !== upstreamCommit
    ? { repository: "p90-lover/agent-orchestrator", commit: head }
    : { repository: "Untrivial-ai/agent-orchestrator", commit: upstreamCommit, workingTreeIntegration: true };
  fs.mkdirSync(stageRoot, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  for (const directory of ["frontend", "packages"]) {
    fs.cpSync(path.join(sourceRoot, directory), path.join(stageRoot, directory), {
      recursive: true,
      filter: (source) => !["node_modules", ".git", ".vite", "dist", "out", "package-lock.json", "package.json"]
        .includes(path.basename(source)),
    });
  }
  // Packages outside frontend must not inherit the host repository's Svelte tsconfig.
  fs.writeFileSync(path.join(stageRoot,"tsconfig.json"),JSON.stringify({compilerOptions:{
    target:"ES2022",module:"ESNext",moduleResolution:"Bundler",jsx:"react-jsx",
    esModuleInterop:true,skipLibCheck:true,resolveJsonModule:true
  }},null,2));
  const rendererPatch = path.join(projectRoot, "desktop-electron", "patches", "agent-orchestrator", "mission-live-config-usage.patch");
  const stageRelative = path.relative(projectRoot,stageRoot).split(path.sep).join("/");
  assert.ok(stageRelative.startsWith("aiTemp/") && !stageRelative.split("/").includes(".."), "AO staging must stay inside project aiTemp");
  run("git",["apply","--check","--directory="+stageRelative,rendererPatch],projectRoot);
  run("git",["apply","--directory="+stageRelative,rendererPatch],projectRoot);
  // Build only the renderer. Electron Forge/native desktop installers are not part of the host integration.
  const upstream = JSON.parse(fs.readFileSync(path.join(sourceRoot, "frontend", "package.json")));
  const lock = JSON.parse(fs.readFileSync(path.join(sourceRoot, "frontend", "package-lock.json")));
  const excluded = new Set(["@aoagents/product-ui", "@sentry/electron", "@workos-inc/node", "better-sqlite3", "electron-updater"]);
  const buildTools = ["@tailwindcss/vite", "@tanstack/router-plugin", "@vitejs/plugin-react", "tailwindcss", "tw-animate-css", "typescript", "vite", "vitest"];
  const dependencies = {};
  for (const name of [...Object.keys(upstream.dependencies).filter((name) => !excluded.has(name)), ...buildTools]) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry?.version && entry.resolved?.startsWith("https://registry.npmjs.org/"), `Non-registry dependency: ${name}`);
    dependencies[name] = entry.version;
  }
  fs.writeFileSync(path.join(frontendRoot, "package.json"), `${JSON.stringify({ name: "coding-tools-ao-renderer", private: true, type: "module", dependencies }, null, 2)}\n`);
  const dependencyDigest = crypto.createHash("sha256").update(JSON.stringify(dependencies)).digest("hex");
  const marker = path.join(frontendRoot, ".dependencies-ready");
  if (!fs.existsSync(marker) || fs.readFileSync(marker, "utf8") !== dependencyDigest) {
    run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], frontendRoot);
    fs.writeFileSync(marker, dependencyDigest);
  }
  run(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "vite.renderer.config.ts", "--outDir", path.join(outputRoot, "renderer")], frontendRoot, {
    VITE_NO_ELECTRON: "0", VITE_CODING_TOOLS_EMBEDDED: "1", VITE_AO_POSTHOG_KEY: "", VITE_AO_SENTRY_DSN: "",
  });
  if (process.env.CODING_TOOLS_AO_RENDERER_ONLY === "1") {
    fs.writeFileSync(path.join(outputRoot,"renderer-manifest.json"), JSON.stringify({...provenance,dependencyDigest,
      rendererPatchSha256:crypto.createHash("sha256").update(fs.readFileSync(rendererPatch)).digest("hex")},null,2));
    console.log("[AO build] Renderer verified; daemon and ACP runtime were not rebuilt or replaced.");
    return;
  }
  // The daemon needs Go 1.27.1; keep the portable toolchain in .tools (aiTemp is cleared as scratch).
  const portableGo = [
    path.join(projectRoot, ".tools", "go1.27.1", "bin", "go.exe"),
    path.join(projectRoot, "aiTemp", "ao-go-toolchain-1.27.1", "go", "bin", "go.exe"),
  ].find((candidate) => fs.existsSync(candidate));
  const goExecutable = process.env.CODING_TOOLS_GO || portableGo || "go";
  const daemonPath = path.join(outputRoot, process.platform === "win32" ? "ao-daemon.exe" : "ao-daemon");
  run(goExecutable, ["build", "-trimpath", "-ldflags", "-X=github.com/aoagents/agent-orchestrator/backend/internal/config.CodingToolsLocalOnly=1", "-o", daemonPath, "./cmd/ao"], path.join(sourceRoot, "backend"), {
    GOWORK: "off", GOTOOLCHAIN: "local",
  });
  fs.copyFileSync(path.join(sourceRoot, "LICENSE"), path.join(outputRoot, "LICENSE"));
  const acpRuntime = buildAcpRuntime();
  fs.writeFileSync(path.join(outputRoot, "manifest.json"), `${JSON.stringify({
    ...provenance,
    source: "module/agent-orchestrator", standaloneInstall: false, localOnly: true,
    daemonSha256: crypto.createHash("sha256").update(fs.readFileSync(daemonPath)).digest("hex"),
    renderer: "renderer/index.html", dependencyDigest,
    acpRuntime: { path: "../acp-runtime", node: acpRuntime.node, signature: acpRuntime.signature },
  }, null, 2)}\n`);
  console.log(`[AO build] Published source integration to ${outputRoot}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
