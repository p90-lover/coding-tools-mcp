from __future__ import annotations

from pathlib import Path


def patch_once(pathname: str, old: str, new: str, sentinel: str) -> None:
    path = Path(pathname)
    text = path.read_text(encoding="utf-8")
    if sentinel in text:
        print(f"already patched: {pathname} [{sentinel}]")
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {pathname}, found {count}: {old[:80]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"patched: {pathname} [{sentinel}]")


def replace_count(pathname: str, old: str, new: str, expected: int, sentinel: str) -> None:
    path = Path(pathname)
    text = path.read_text(encoding="utf-8")
    if sentinel in text:
        print(f"already patched: {pathname} [{sentinel}]")
        return
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"expected {expected} anchors in {pathname}, found {count}: {old[:80]!r}")
    path.write_text(text.replace(old, new), encoding="utf-8")
    print(f"patched: {pathname} [{sentinel}]")


manager = "desktop-electron/electron/managed-components.cjs"

patch_once(
    manager,
    '''const SECRET_VERSION = 1;

function requiredComponentId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!COMPONENT_ID_SET.has(id)) throw new Error(`Unknown managed component: ${id || "missing"}`);
  return id;
}
''',
    '''const SECRET_VERSION = 1;
const MAX_SETUP_SECRET_LENGTH = 4_096;
const SETUP_SECRET_INPUT_KEYS = new Set(["githubReadToken"]);
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

function requiredComponentId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!COMPONENT_ID_SET.has(id)) throw new Error(`Unknown managed component: ${id || "missing"}`);
  return id;
}

function normalizeSetupSecrets(componentId, input = {}) {
  const id = requiredComponentId(componentId);
  if (input === undefined || input === null) return Object.freeze({});
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Managed component setup input must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!SETUP_SECRET_INPUT_KEYS.has(key)) {
      throw new Error(`Managed component setup input contains unsupported field: ${key}`);
    }
  }
  if (input.githubReadToken !== undefined && typeof input.githubReadToken !== "string") {
    throw new Error("GitHub read token must be a string");
  }
  const token = typeof input.githubReadToken === "string" ? input.githubReadToken.trim() : "";
  if (token.includes("\\0") || token.length > MAX_SETUP_SECRET_LENGTH) {
    throw new Error("GitHub read token is invalid or exceeds the size limit");
  }
  if (token && id !== "anneal") {
    throw new Error("GitHub read token is only accepted for Anneal setup");
  }
  return Object.freeze(token ? { GITHUB_READ_TOKEN: token } : {});
}

function redactSensitiveText(value, context = {}) {
  let output = String(value ?? "");
  const secrets = [
    ...Object.values(context.transientEnvironment || {}),
    ...Object.values(context.secrets || {}),
  ]
    .filter((candidate) => typeof candidate === "string" && candidate.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) output = output.split(secret).join("[REDACTED]");
  return output;
}
''',
    "function normalizeSetupSecrets(componentId, input = {})",
)

patch_once(
    manager,
    '''    for (const argument of step.arguments) {
      if (typeof argument !== "string" || argument.includes("\\0") || argument.length > 4_096) {
        throw new Error(`${label} contains an invalid argument`);
      }
    }
  }
  if (step.kind === "assert-file") assertSafeRelativePath(step.path, `${label} path`);
}
''',
    '''    for (const argument of step.arguments) {
      if (typeof argument !== "string" || argument.includes("\\0") || argument.length > 4_096) {
        throw new Error(`${label} contains an invalid argument`);
      }
    }
    if (step.requiredEnvironment !== undefined) {
      if (!Array.isArray(step.requiredEnvironment) || step.requiredEnvironment.length > 16) {
        throw new Error(`${label} requiredEnvironment must be a bounded array`);
      }
      for (const name of step.requiredEnvironment) {
        if (typeof name !== "string" || !ENVIRONMENT_NAME.test(name)) {
          throw new Error(`${label} contains an invalid required environment name`);
        }
      }
    }
  }
  if (step.kind === "assert-file") assertSafeRelativePath(step.path, `${label} path`);
}
''',
    "requiredEnvironment must be a bounded array",
)

patch_once(
    manager,
    '''    const environment = Object.fromEntries(Object.entries(entry.environment || {}).map(([key, value]) => [
      key,
      expandToken(value, context),
    ]));
    const managedMode = entry.execution === "managed-mode";
''',
    '''    const environment = Object.fromEntries(Object.entries(entry.environment || {}).map(([key, value]) => [
      key,
      expandToken(value, context),
    ]));
    const requiredEnvironment = Object.fromEntries((entry.requiredEnvironment || []).flatMap((name) => {
      const value = context.transientEnvironment?.[name] ?? env[name];
      return typeof value === "string" && value ? [[name, value]] : [];
    }));
    const commandEnvironment = {
      ...environment,
      ...requiredEnvironment,
      ...(context.transientEnvironment || {}),
    };
    const managedMode = entry.execution === "managed-mode";
''',
    "const commandEnvironment = {",
)

patch_once(
    manager,
    "      const exported = Object.entries(environment)\n",
    "      const exported = Object.entries(commandEnvironment)\n",
    "Object.entries(commandEnvironment)",
)

replace_count(
    manager,
    "          env: { ...env, ...environment },\n",
    "          env: { ...env, ...commandEnvironment },\n",
    2,
    "env: { ...env, ...commandEnvironment }",
)

patch_once(
    manager,
    '''      child.stdout?.on?.("data", (chunk) => {
        stdout = boundedOutput(chunk, stdout);
        const message = String(chunk || "").trim().slice(-2_000);
        if (message) logger?.debug?.("managed-component.stdout", { componentId: context.id, step: entry.id, message });
      });
      child.stderr?.on?.("data", (chunk) => {
        stderr = boundedOutput(chunk, stderr);
        const message = String(chunk || "").trim().slice(-2_000);
        if (message) logger?.debug?.("managed-component.stderr", { componentId: context.id, step: entry.id, message });
      });
      child.once?.("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once?.("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${entry.id} failed (${code ?? signal ?? "unknown"}): ${stderr.trim() || stdout.trim()}`));
      });
''',
    '''      child.stdout?.on?.("data", (chunk) => {
        stdout = boundedOutput(chunk, stdout);
        const message = redactSensitiveText(String(chunk || ""), context).trim().slice(-2_000);
        if (message) logger?.debug?.("managed-component.stdout", { componentId: context.id, step: entry.id, message });
      });
      child.stderr?.on?.("data", (chunk) => {
        stderr = boundedOutput(chunk, stderr);
        const message = redactSensitiveText(String(chunk || ""), context).trim().slice(-2_000);
        if (message) logger?.debug?.("managed-component.stderr", { componentId: context.id, step: entry.id, message });
      });
      child.once?.("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(redactSensitiveText(error instanceof Error ? error.message : String(error), context)));
      });
      child.once?.("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const safeStdout = redactSensitiveText(stdout, context);
        const safeStderr = redactSensitiveText(stderr, context);
        if (code === 0) resolve({ stdout: safeStdout, stderr: safeStderr });
        else reject(new Error(`${entry.id} failed (${code ?? signal ?? "unknown"}): ${safeStderr.trim() || safeStdout.trim()}`));
      });
''',
    "const safeStdout = redactSensitiveText(stdout, context);",
)

patch_once(
    manager,
    '''  async function executeInstallSteps(manifest, stagingHome, artifact) {
    const context = {
      id: manifest.id,
      home: stagingHome,
      artifact,
      runtime: resolveRuntimeExecutable(),
      npm: npmExecutable(),
      secrets: ensureComponentSecrets(manifest.id),
      mode: platformMode(manifest),
    };
    for (const step of manifest.install.steps) {
      if (["download", "verify", "git-checkout", "activate"].includes(step.kind)) continue;
      setOperation(manifest.id, { state: "installing", step: step.id, error: null });
      if (step.kind === "assert-file") {
        const expected = path.join(stagingHome, assertSafeRelativePath(step.path, `${step.id} path`));
        assertWithin(stagingHome, expected, "Managed component assertion");
        if (!fs.existsSync(expected) || !fs.statSync(expected).isFile()) {
          throw new Error(`${manifest.name} is missing required file ${step.path}`);
        }
        continue;
      }
      await runCommand(step, context);
    }
  }
''',
    '''  async function executeInstallSteps(manifest, stagingHome, artifact, transientEnvironment) {
    const context = {
      id: manifest.id,
      home: stagingHome,
      artifact,
      runtime: resolveRuntimeExecutable(),
      npm: npmExecutable(),
      secrets: ensureComponentSecrets(manifest.id),
      transientEnvironment,
      mode: platformMode(manifest),
    };
    for (const step of manifest.install.steps) {
      if (["download", "verify", "git-checkout", "activate"].includes(step.kind)) continue;
      setOperation(manifest.id, { state: "installing", step: step.id, error: null });
      if (step.kind === "assert-file") {
        const expected = path.join(stagingHome, assertSafeRelativePath(step.path, `${step.id} path`));
        assertWithin(stagingHome, expected, "Managed component assertion");
        if (!fs.existsSync(expected) || !fs.statSync(expected).isFile()) {
          throw new Error(`${manifest.name} is missing required file ${step.path}`);
        }
        continue;
      }
      for (const name of step.requiredEnvironment || []) {
        const value = transientEnvironment[name] ?? env[name];
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(`${manifest.name} requires ${name} for ${step.id}`);
        }
      }
      await runCommand(step, context);
    }
  }
''',
    "async function executeInstallSteps(manifest, stagingHome, artifact, transientEnvironment)",
)

patch_once(
    manager,
    '''  async function installComponent(idValue, { repair = false } = {}) {
    const id = requiredComponentId(idValue);
    const manifest = manifestFor(id);
''',
    '''  async function installComponent(idValue, { repair = false, setupSecrets = {} } = {}) {
    const id = requiredComponentId(idValue);
    const transientEnvironment = normalizeSetupSecrets(id, setupSecrets);
    const manifest = manifestFor(id);
''',
    "setupSecrets = {}",
)

patch_once(
    manager,
    "      await executeInstallSteps(manifest, stagingHome, prepared.artifact);\n",
    "      await executeInstallSteps(manifest, stagingHome, prepared.artifact, transientEnvironment);\n",
    "prepared.artifact, transientEnvironment",
)

patch_once(
    manager,
    '''    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(path.join(stagingRoot, "FAILED.json"), {
        schemaVersion: 1,
        id,
        failedAt: now(),
        error: message,
      });
      setOperation(id, { state: "error", step: null, error: message });
      throw error;
    }
  }

  function repairComponent(id) {
    return installComponent(id, { repair: true });
  }
''',
    '''    } catch (error) {
      const message = redactSensitiveText(
        error instanceof Error ? error.message : String(error),
        { transientEnvironment, secrets: secretFor(id) },
      );
      writeJson(path.join(stagingRoot, "FAILED.json"), {
        schemaVersion: 1,
        id,
        failedAt: now(),
        error: message,
      });
      setOperation(id, { state: "error", step: null, error: message });
      throw new Error(message);
    }
  }

  function repairComponent(id, { setupSecrets = {} } = {}) {
    return installComponent(id, { repair: true, setupSecrets });
  }
''',
    "function repairComponent(id, { setupSecrets = {} } = {})",
)

patch_once(
    manager,
    '''  assertSafeManifest,
  createManagedComponentController,
  loadManagedManifest,
  verifySha256,
};
''',
    '''  assertSafeManifest,
  createManagedComponentController,
  loadManagedManifest,
  normalizeSetupSecrets,
  redactSensitiveText,
  verifySha256,
};
''',
    "normalizeSetupSecrets,\n  redactSensitiveText,",
)

combined = "desktop-electron/electron/managed-external-services.cjs"
patch_once(
    combined,
    '''  async function installManagedComponent(serviceId) {
    await managedController.installComponent(serviceId);
''',
    '''  async function installManagedComponent(serviceId, input = {}) {
    await managedController.installComponent(serviceId, { setupSecrets: input });
''',
    "async function installManagedComponent(serviceId, input = {})",
)
patch_once(
    combined,
    '''  async function repairManagedComponent(serviceId) {
    try { await managedController.stopComponent(serviceId); } catch {}
    await managedController.repairComponent(serviceId);
''',
    '''  async function repairManagedComponent(serviceId, input = {}) {
    try { await managedController.stopComponent(serviceId); } catch {}
    await managedController.repairComponent(serviceId, { setupSecrets: input });
''',
    "async function repairManagedComponent(serviceId, input = {})",
)

main = "desktop-electron/electron/main.cjs"
patch_once(
    main,
    '''function validateBrowserInteractionMode(value) {
  if (value !== "automatic" && value !== "manual") {
    throw new Error("Browser interaction mode must be automatic or manual");
  }
  return value;
}
''',
    '''function validateBrowserInteractionMode(value) {
  if (value !== "automatic" && value !== "manual") {
    throw new Error("Browser interaction mode must be automatic or manual");
  }
  return value;
}

function managedComponentInstallInput(serviceId, input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Managed component install input must be an object");
  }
  const allowed = new Set(["githubReadToken"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Unsupported managed component install field: ${key}`);
  }
  if (input.githubReadToken !== undefined && typeof input.githubReadToken !== "string") {
    throw new Error("GitHub read token must be a string");
  }
  const githubReadToken = typeof input.githubReadToken === "string"
    ? input.githubReadToken.trim()
    : "";
  if (githubReadToken.includes("\\0") || githubReadToken.length > 4_096) {
    throw new Error("GitHub read token is invalid or exceeds the size limit");
  }
  if (githubReadToken && serviceId !== "anneal") {
    throw new Error("GitHub read token is only accepted for Anneal setup");
  }
  return githubReadToken ? { githubReadToken } : {};
}
''',
    "function managedComponentInstallInput(serviceId, input = {})",
)

patch_once(
    main,
    '''  handle("launcher:managed-component-install", (event, serviceId) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("Managed components controller is unavailable");
    return externalServicesController.installManagedComponent(serviceId);
  });
  handle("launcher:managed-component-repair", (event, serviceId) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("Managed components controller is unavailable");
    return externalServicesController.repairManagedComponent(serviceId);
  });
''',
    '''  handle("launcher:managed-component-install", (event, serviceId, input = {}) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("Managed components controller is unavailable");
    return externalServicesController.installManagedComponent(
      serviceId,
      managedComponentInstallInput(serviceId, input),
    );
  });
  handle("launcher:managed-component-repair", (event, serviceId, input = {}) => {
    assertFocusedMainWindow(event, true);
    if (!externalServicesController) throw new Error("Managed components controller is unavailable");
    return externalServicesController.repairManagedComponent(
      serviceId,
      managedComponentInstallInput(serviceId, input),
    );
  });
''',
    "managedComponentInstallInput(serviceId, input)",
)

preload = "desktop-electron/electron/preload.cjs"
patch_once(
    preload,
    '''  installManagedComponent: (serviceId) => ipcRenderer.invoke("launcher:managed-component-install", serviceId),
  repairManagedComponent: (serviceId) => ipcRenderer.invoke("launcher:managed-component-repair", serviceId),
''',
    '''  installManagedComponent: (serviceId, input = {}) => ipcRenderer.invoke(
    "launcher:managed-component-install",
    serviceId,
    input,
  ),
  repairManagedComponent: (serviceId, input = {}) => ipcRenderer.invoke(
    "launcher:managed-component-repair",
    serviceId,
    input,
  ),
''',
    "installManagedComponent: (serviceId, input = {})",
)

types = "desktop-electron/src/types.ts"
patch_once(
    types,
    '''export type ManagedComponentInstallState =
''',
    '''export interface ManagedComponentInstallInput {
  githubReadToken?: string;
}

export type ManagedComponentInstallState =
''',
    "export interface ManagedComponentInstallInput",
)
patch_once(
    types,
    '''  installManagedComponent(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
  repairManagedComponent(serviceId: ExternalServiceId): Promise<ExternalServiceSnapshot>;
''',
    '''  installManagedComponent(
    serviceId: ExternalServiceId,
    input?: ManagedComponentInstallInput,
  ): Promise<ExternalServiceSnapshot>;
  repairManagedComponent(
    serviceId: ExternalServiceId,
    input?: ManagedComponentInstallInput,
  ): Promise<ExternalServiceSnapshot>;
''',
    "input?: ManagedComponentInstallInput",
)

surface = "desktop-electron/src/features/ExternalServicesSurface.tsx"
patch_once(
    surface,
    '''  const [callerKey, setCallerKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
''',
    '''  const [callerKey, setCallerKey] = useState("");
  const [githubReadToken, setGithubReadToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
''',
    "const [githubReadToken, setGithubReadToken] = useState(\"\")",
)
patch_once(
    surface,
    '''      setDraft(draftFrom(selected));
      setCallerKey("");
      setNotice("");
''',
    '''      setDraft(draftFrom(selected));
      setCallerKey("");
      setGithubReadToken("");
      setNotice("");
''',
    "setGithubReadToken(\"\");\n      setNotice",
)
patch_once(
    surface,
    '''  const installOrRepair = () => run("managed-install", async () => {
    if (!api || !selected) return;
    const repair = selected.managedInstall.state === "repair-required"
      || selected.managedInstall.state === "error";
    if (repair) await api.repairManagedComponent(selected.id);
    else await api.installManagedComponent(selected.id);
    setNotice(text(
      language,
      `${serviceName(language, selected.id)} is installed and started by Coding Tools.`,
      `${serviceName(language, selected.id)} 已由 Coding Tools 安裝並啟動。`,
    ));
  });
''',
    '''  const installOrRepair = () => run("managed-install", async () => {
    if (!api || !selected) return;
    const repair = selected.managedInstall.state === "repair-required"
      || selected.managedInstall.state === "error";
    const input = selected.id === "anneal" && githubReadToken.trim()
      ? { githubReadToken: githubReadToken.trim() }
      : {};
    try {
      if (repair) await api.repairManagedComponent(selected.id, input);
      else await api.installManagedComponent(selected.id, input);
      setNotice(text(
        language,
        `${serviceName(language, selected.id)} is installed and started by Coding Tools.`,
        `${serviceName(language, selected.id)} 已由 Coding Tools 安裝並啟動。`,
      ));
    } finally {
      setGithubReadToken("");
    }
  });
''',
    "const input = selected.id === \"anneal\" && githubReadToken.trim()",
)
patch_once(
    surface,
    '''              {selected.managedInstall.error ? <small className="managed-install-error">{selected.managedInstall.error}</small> : null}
            </div>
            <button
''',
    '''              {selected.managedInstall.error ? <small className="managed-install-error">{selected.managedInstall.error}</small> : null}
              {selected.id === "anneal" ? (
                <label className="managed-install-secret">
                  <span>{text(language, "One-time GitHub read token", "一次性 GitHub 唯讀 Token")}</span>
                  <input
                    autoComplete="off"
                    onChange={(event) => setGithubReadToken(event.target.value)}
                    placeholder={text(
                      language,
                      "Required for first setup unless GITHUB_READ_TOKEN is already configured",
                      "首次設定需要；如已設定 GITHUB_READ_TOKEN 則可留空",
                    )}
                    type="password"
                    value={githubReadToken}
                  />
                  <small>{text(
                    language,
                    "Used only for this install or repair request and never stored by Coding Tools.",
                    "只用於今次安裝或修復請求，Coding Tools 不會儲存。",
                  )}</small>
                </label>
              ) : null}
            </div>
            <button
''',
    "className=\"managed-install-secret\"",
)

print("RC9_ANNEAL_SETUP_SECRET_PATCH_OK")
