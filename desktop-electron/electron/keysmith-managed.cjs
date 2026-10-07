const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RELEASE_SHA256 = "837ec25713851a2fb6d8646dd078ee03a2e23fe17b19e97e093cedb02349979d";
const MAX_MARKDOWN_BYTES = 128 * 1024;

function createKeysmithManaged({
  scriptPath,
  pythonExecutable,
  codexDir,
  expectedScriptSha256 = RELEASE_SHA256,
  execFileImpl = execFile,
}) {
  if (expectedScriptSha256 !== RELEASE_SHA256) throw new Error("Unsupported Keysmith release hash");
  if (typeof pythonExecutable !== "string" || !pythonExecutable.trim()) {
    throw new Error("Python 3.10+ executable is required");
  }
  let previewed = null;
  let removalPreviewed = null;
  let busy = false;
  let pythonVersion = null;
  const pythonArgs = /^(py|py\.exe)$/i.test(path.basename(pythonExecutable)) ? ["-3"] : [];

  const pinnedScript = () => {
    try {
      if (typeof scriptPath !== "string" || !path.isAbsolute(scriptPath)
        || !fs.lstatSync(scriptPath).isFile()) throw new Error("unavailable");
      const script = fs.realpathSync(scriptPath);
      const hash = createHash("sha256").update(fs.readFileSync(script)).digest("hex");
      if (hash !== RELEASE_SHA256) throw new Error("checksum");
      return script;
    } catch (error) {
      if (error?.message === "checksum") throw new Error("Bundled Keysmith script checksum mismatch");
      throw new Error("Bundled Keysmith script is unavailable");
    }
  };
  const targetHome = () => {
    try {
      if (typeof codexDir !== "string" || !path.isAbsolute(codexDir)) throw new Error("unavailable");
      const home = fs.realpathSync(codexDir);
      if (!fs.statSync(home).isDirectory()) throw new Error("unavailable");
      return home;
    } catch {
      throw new Error("Codex home is unavailable");
    }
  };
  const configSha256 = (home) => {
    try {
      return createHash("sha256").update(fs.readFileSync(path.join(home, "config.toml"))).digest("hex");
    } catch {
      throw new Error("Codex configuration is unavailable");
    }
  };
  const managedManifestSha256 = (home) => {
    try {
      const manifestPath = path.join(home, ".codex-keysmith-manifest.json");
      if (!fs.lstatSync(manifestPath).isFile()) return null;
      const bytes = fs.readFileSync(manifestPath);
      if (JSON.parse(bytes.toString("utf8"))?.md?.path !== "coding-tools-keysmith.md") return null;
      return createHash("sha256").update(bytes).digest("hex");
    } catch {
      return null;
    }
  };
  const reviewedFile = (file) => {
    if (typeof file !== "string" || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".md") {
      throw new Error("Select an absolute Markdown file");
    }
    let stat;
    try { stat = fs.lstatSync(file); }
    catch { throw new Error("Selected Markdown file is unavailable"); }
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MARKDOWN_BYTES) {
      throw new Error("Markdown must be a nonempty regular file no larger than 128 KiB");
    }
    let resolved;
    let bytes;
    try {
      resolved = fs.realpathSync(file);
      bytes = fs.readFileSync(resolved);
      if (bytes.length > MAX_MARKDOWN_BYTES) throw new Error("too large");
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Selected Markdown must be readable UTF-8 text");
    }
    return { path: resolved, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const checkPythonVersion = () => {
    if (pythonVersion) return Promise.resolve(pythonVersion);
    pinnedScript();
    return new Promise((resolve, reject) => {
      try {
        execFileImpl(pythonExecutable, [
          ...pythonArgs, "-I", "-B", "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))",
        ], {
          encoding: "utf8", maxBuffer: 4096, shell: false, timeout: 10_000, windowsHide: true,
        }, (error, stdout = "") => {
          if (error?.code === "ENOENT") return reject(new Error("Python 3.10+ is unavailable"));
          if (error) return reject(new Error("Python version check failed"));
          const match = stdout.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
          if (!match) return reject(new Error("Python version could not be determined"));
          if (Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 10)) {
            return reject(new Error("Python 3.10+ is required"));
          }
          pythonVersion = match[0];
          resolve(pythonVersion);
        });
      } catch {
        reject(new Error("Python version check could not start"));
      }
    });
  };
  const invoke = (args, exposeOutput = false) => {
    if (busy) throw new Error("Another Keysmith operation is running");
    const script = pinnedScript();
    busy = true;
    return new Promise((resolve, reject) => {
      const done = (error, stdout = "", stderr = "") => {
        busy = false;
        if (error?.code === "ENOENT") return reject(new Error("Python 3.10+ is unavailable"));
        if (error?.killed || error?.signal === "SIGTERM") {
          return reject(new Error("Keysmith timed out; inspect status before retrying"));
        }
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return reject(new Error("Keysmith output exceeded its limit"));
        }
        if (error && !Number.isInteger(error.code)) {
          return reject(new Error("Keysmith command could not run"));
        }
        resolve({
          ok: !error,
          stdout: !error && exposeOutput ? stdout : "",
          stderr: !error && exposeOutput ? stderr : "",
          exitCode: error?.code || 0,
          ...(error ? { error: `Keysmith failed (exit ${error.code}); check status before retrying` } : {}),
        });
      };
      try {
        const child = execFileImpl(pythonExecutable, [...pythonArgs, "-I", "-B", script, "--lang", "en", ...args], {
          encoding: "utf8",
          maxBuffer: 128 * 1024,
          shell: false,
          timeout: 90_000,
          windowsHide: true,
        }, done);
        child?.stdin?.end();
      } catch {
        busy = false;
        reject(new Error("Keysmith command could not start"));
      }
    });
  };
  const deployArgs = (home, file) => [
    "--codex-dir", home,
    ...(file == null ? [] : ["--file", file]),
    "--name", "coding-tools-keysmith",
    "--skip-hooks-isolation",
  ];

  return {
    async status() {
      const version = await checkPythonVersion();
      const home = targetHome();
      const result = await invoke(["--codex-dir", home, "--status"], true);
      const state = result.stdout.match(/^\s*Config activation:\s*(active|inactive-by-config|conflict|not-installed)\b/m)?.[1];
      const managedByCodingTools = managedManifestSha256(home) !== null;
      if (!result.ok || !state) {
        return { ...result, ok: false, stdout: "", stderr: "", installed: false, managedByCodingTools, state: "unknown", pythonVersion: version };
      }
      return {
        ...result,
        installed: state === "active" || state === "inactive-by-config",
        managedByCodingTools,
        state,
        pythonVersion: version,
      };
    },
    async preview(instructionFile) {
      previewed = null;
      const home = targetHome();
      const file = instructionFile == null ? { path: null, sha256: RELEASE_SHA256 } : reviewedFile(instructionFile);
      const configBefore = configSha256(home);
      const result = await invoke([...deployArgs(home, file.path), "--dry-run"], true);
      if (!result.ok) return result;
      if ((file.path && reviewedFile(instructionFile).sha256 !== file.sha256) || configSha256(home) !== configBefore) {
        throw new Error("Markdown or Codex configuration changed during Keysmith preview");
      }
      previewed = { home, filePath: file.path, fileSha256: file.sha256, configSha256: configBefore };
      return { ...result, fileSha256: file.sha256 };
    },
    async apply({ instructionFile, confirmed, expectedFileSha256 } = {}) {
      if (confirmed !== true) throw new Error("Keysmith apply requires native confirmation");
      const approved = previewed;
      previewed = null;
      if (!approved) throw new Error("Preview Keysmith changes before applying");
      const home = targetHome();
      const file = instructionFile == null ? { path: null, sha256: RELEASE_SHA256 } : reviewedFile(instructionFile);
      if (home !== approved.home || file.path !== approved.filePath
        || file.sha256 !== approved.fileSha256
        || configSha256(home) !== approved.configSha256
        || (expectedFileSha256 && expectedFileSha256 !== approved.fileSha256)) {
        throw new Error("Keysmith target or Markdown changed; preview again");
      }
      return invoke([...deployArgs(home, file.path), "--yes"]);
    },
    async previewUninstall() {
      removalPreviewed = null;
      const home = targetHome();
      const manifestSha256 = managedManifestSha256(home);
      if (!manifestSha256) throw new Error("Keysmith installation is not managed by Coding Tools");
      const before = configSha256(home);
      const result = await invoke(["--codex-dir", home, "--uninstall"], true);
      if (!result.ok) return result;
      const after = configSha256(home);
      if (after !== before) throw new Error("Codex configuration changed during Keysmith preview");
      removalPreviewed = { home, configSha256: before, manifestSha256 };
      return result;
    },
    async uninstall({ confirmed } = {}) {
      if (confirmed !== true) throw new Error("Keysmith removal requires native confirmation");
      const approved = removalPreviewed;
      removalPreviewed = null;
      if (!approved) throw new Error("Preview Keysmith removal before continuing");
      const home = targetHome();
      if (managedManifestSha256(home) !== approved.manifestSha256
        || home !== approved.home || configSha256(home) !== approved.configSha256) {
        throw new Error("Codex configuration changed; preview removal again");
      }
      return invoke(["--codex-dir", home, "--uninstall", "--yes"]);
    },
  };
}

module.exports = { createKeysmithManaged };
