"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "../..");
const sourceRoot = path.join(projectRoot, "module", "agent-orchestrator");
const sourceCommit = "73473d45f0c18f3a81f66f150868459e3098ca35";
const stageRoot = path.join(projectRoot, "aiTemp", "ao-source-build");
const frontendRoot = path.join(stageRoot, "frontend");
const outputRoot = path.join(projectRoot, "desktop-electron", "build", "agent-orchestrator");

function run(command, arguments_, cwd, env = {}) {
  console.log(`[AO build] ${command} ${arguments_.join(" ")}`);
  const result = spawnSync(command, arguments_, {
    cwd, env: { ...process.env, ...env }, stdio: "inherit", windowsHide: true,
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
  if (result.error || result.status !== 0) throw result.error || new Error(`Build exited ${result.status}`);
}

async function main() {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" });
  assert.equal(revision.stdout.trim(), sourceCommit, "Unexpected AO source revision");
  fs.mkdirSync(stageRoot, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  for (const directory of ["frontend", "packages"]) {
    fs.cpSync(path.join(sourceRoot, directory), path.join(stageRoot, directory), {
      recursive: true,
      filter: (source) => !["node_modules", ".git", ".vite", "dist", "out", "package-lock.json", "package.json"]
        .includes(path.basename(source)),
    });
  }
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
  const portableGo = path.join(projectRoot, "aiTemp", "ao-go-toolchain-1.27.1", "go", "bin", "go.exe");
  const goExecutable = process.env.CODING_TOOLS_GO || (fs.existsSync(portableGo) ? portableGo : "go");
  const daemonPath = path.join(outputRoot, process.platform === "win32" ? "ao-daemon.exe" : "ao-daemon");
  run(goExecutable, ["build", "-trimpath", "-ldflags", "-X=github.com/aoagents/agent-orchestrator/backend/internal/config.CodingToolsLocalOnly=1", "-o", daemonPath, "."], path.join(sourceRoot, "backend"), {
    GOWORK: "off", GOTOOLCHAIN: "local",
  });
  fs.copyFileSync(path.join(sourceRoot, "LICENSE"), path.join(outputRoot, "LICENSE"));
  fs.writeFileSync(path.join(outputRoot, "manifest.json"), `${JSON.stringify({
    repository: "Untrivial-ai/agent-orchestrator", commit: sourceCommit,
    source: "module/agent-orchestrator", standaloneInstall: false, localOnly: true,
    daemonSha256: crypto.createHash("sha256").update(fs.readFileSync(daemonPath)).digest("hex"),
    renderer: "renderer/index.html", dependencyDigest,
  }, null, 2)}\n`);
  console.log(`[AO build] Published source integration to ${outputRoot}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
