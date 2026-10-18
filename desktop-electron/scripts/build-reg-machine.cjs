"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repo = path.resolve(__dirname, "../..");
const moduleRoot = path.join(repo, "app-handler", "reg-machine");
const requestedBuildRoot = path.resolve(process.env.REG_MACHINE_BUILD_ROOT || path.join(repo, "aiTemp", "reg-machine-build"));
fs.mkdirSync(requestedBuildRoot, { recursive: true });
// Vite must see one physical root when scratch storage is a Windows junction.
const buildRoot = fs.realpathSync(requestedBuildRoot);
const output = path.join(buildRoot, "resources");
const stagedModule = path.join(output, "module");
const frontend = path.join(buildRoot, "frontend");
const venv = path.join(buildRoot, "venv");
const python = path.join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const env = { ...process.env,
  PIP_CACHE_DIR: path.join(buildRoot, "pip-cache"),
  npm_config_cache: path.join(buildRoot, "npm-cache"),
  PLAYWRIGHT_BROWSERS_PATH: path.join(output, "browsers"),
  CAMOUFOX_CACHE_DIR: path.join(output, "camoufox"),
  PYTHONDONTWRITEBYTECODE: "1",
  TEMP: path.join(buildRoot, "temp"), TMP: path.join(buildRoot, "temp"),
  PYINSTALLER_CONFIG_DIR: path.join(buildRoot, "pyinstaller-cache"),
  LOCALAPPDATA: path.join(buildRoot, "local-app-data"), APPDATA: path.join(buildRoot, "app-data"),
  XDG_CACHE_HOME: path.join(buildRoot, "cache"), CI: "1",
};
fs.mkdirSync(env.TEMP, { recursive: true });

function run(command, args, cwd = buildRoot, shell = false) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", shell, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`Register build command failed: ${path.basename(command)} (exit ${result.status ?? "unavailable"})`);
  }
}

function patch(file, before, after) {
  const original = fs.readFileSync(file, "utf8");
  if (!original.includes(before)) throw new Error("Register source adapter no longer matches " + path.basename(file));
  fs.writeFileSync(file, original.replace(before, after));
}

function build() {
  console.log("[Register] preparing isolated source and dependencies");
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(moduleRoot, stagedModule, { recursive: true, filter: (file) => !/(^|[\\/])(__pycache__|node_modules)([\\/]|$)/.test(file) });
  if (!fs.existsSync(python)) run(process.env.REG_MACHINE_PYTHON || (process.platform === "win32" ? "python" : "python3"), ["-m", "venv", venv]);
  run(python, ["-m", "pip", "install", "--disable-pip-version-check", "--quiet",
    "-r", path.join(moduleRoot, "source", "requirements.txt"),
    "-r", path.join(moduleRoot, "source", "customer_portal_api", "requirements.txt")]);
  // The browser session is authenticated by the host protocol; its secret never enters localStorage.
  fs.cpSync(path.join(moduleRoot, "source", "frontend"), frontend, { recursive: true });
  patch(path.join(frontend, "src", "App.tsx"), "else if (getAuthToken())", "else if (data.authenticated || getAuthToken())");
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], frontend, process.platform === "win32");
  run(process.execPath, [path.join(frontend, "node_modules", "vite", "bin", "vite.js"), "build",
    "--outDir", path.join(stagedModule, "source", "static")], frontend);
  // Portal source mixes standalone app imports with package imports; keep one SQLModel registry.
  for (const file of fs.readdirSync(path.join(stagedModule, "source", "customer_portal_api"), { recursive: true })) {
    if (!file.endsWith(".py")) continue;
    const target = path.join(stagedModule, "source", "customer_portal_api", file);
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replaceAll("from app.", "from customer_portal_api.app."));
  }
  // Reuse Electron's embedded Node for the optional local authenticator service.
  patch(path.join(stagedModule, "source", "api", "authenticator.py"),
    'subprocess.Popen(["node", str(project / "src" / "server.js")], cwd=project,',
    'subprocess.Popen([os.environ.get("REG_MACHINE_NODE_EXECUTABLE", "node"), str(project / "src" / "server.js")], cwd=project,');
  patch(path.join(stagedModule, "source", "api", "authenticator.py"),
    "env=child_env, creationflags=", 'env={**child_env, "ELECTRON_RUN_AS_NODE": "1"}, creationflags=');


  const solverFile = path.join(stagedModule, "source", "services", "solver_manager.py");
  let solver = fs.readFileSync(solverFile, "utf8").replaceAll("\r\n", "\n");
  const fallback = solver.indexOf("\n        # 2.", solver.indexOf("\ndef stop("));
  const fallbackEnd = solver.indexOf("\n\ndef _kill_by_port", fallback);
  if (fallback < 0 || fallbackEnd < 0) throw new Error("Register solver ownership adapter no longer matches");
  solver = solver.slice(0, fallback) + solver.slice(fallbackEnd);
  const originalHealth = "def is_running() -> bool:\n    try:";
  if (!solver.includes(originalHealth)) throw new Error("Register solver health adapter no longer matches");
  solver = solver.replace(originalHealth, "def is_running() -> bool:\n    if _proc is None or _proc.poll() is not None:\n        return False\n    try:");
  const startGuard = "    with _lock:\n        if is_running():";
  if (!solver.includes(startGuard)) throw new Error("Register solver start adapter no longer matches");
  solver = solver.replace(startGuard, "    with _lock:\n        if _proc is None or _proc.poll() is not None:\n            import socket\n            with socket.socket() as port_probe:\n                port_probe.settimeout(1)\n                if port_probe.connect_ex(('127.0.0.1', SOLVER_PORT)) == 0:\n                    _last_failure_reason = 'Solver port is occupied by another process'\n                    return\n        if is_running():");
  fs.writeFileSync(solverFile, solver);
  patch(path.join(stagedModule, "source", "services", "turnstile_solver", "api_solver.py"),
    "default=\'0.0.0.0\'", "default=\'127.0.0.1\'");

  console.log("[Register] bundling browser runtimes");
  run(python, ["-m", "playwright", "install", "chromium"]);
  run(python, ["-m", "patchright", "install", "chromium"]);
  run(python, [path.join(stagedModule, "browser_runtime.py"), path.join(output, "camoufox")]);

  run(python, [path.join(stagedModule, "desktop_entry.py"), "--verify-browsers"]);
  console.log("[Register] freezing the complete backend");
  const args = ["-m", "PyInstaller", "--noconfirm", "--onedir", "--name", "register-backend",
    "--distpath", path.join(buildRoot, "frozen"), "--workpath", path.join(buildRoot, "freeze-work"),
    "--specpath", path.join(buildRoot, "freeze-spec"),
    "--paths", stagedModule, "--paths", path.join(stagedModule, "source"),
    "--add-data", path.join(stagedModule, "source") + path.delimiter + "source"];
  for (const name of ["api", "application", "core", "domain", "infrastructure", "platforms", "providers", "services", "customer_portal_api"]) {
    args.push("--collect-submodules", name);
  }
  for (const name of ["camoufox", "fpgen", "patchright", "playwright", "quart", "rich", "curl_cffi",
    "browserforge", "apify_fingerprint_datapoints", "language_tags", "hypercorn"]) args.push("--collect-all", name);
  args.push(path.join(stagedModule, "desktop_entry.py"));
  run(python, args);
  fs.cpSync(path.join(buildRoot, "frozen", "register-backend"), path.join(output, "backend"), { recursive: true });
  const executable = path.join(output, "backend", process.platform === "win32" ? "register-backend.exe" : "register-backend");
  if (!fs.existsSync(executable) || !fs.existsSync(path.join(stagedModule, "source", "static", "index.html"))) {
    throw new Error("Register package is incomplete");
  }
  fs.writeFileSync(path.join(output, "BUILD.json"), JSON.stringify({
    version: 1, platform: process.platform, arch: process.arch, source: "module/SOURCE_SNAPSHOT.json",
    backend: path.relative(output, executable).replaceAll("\\", "/"), frontend: "module/source/static/index.html",
  }, null, 2));
  console.log("[Register] build complete: " + output);
}

if (require.main === module) {
  try { build(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build };
