from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, before: str, after: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    if after in text:
        print(f"already applied: {relative}")
        return
    count = text.count(before)
    if count != 1:
        raise SystemExit(
            f"expected one anchor in {relative}, found {count}: {before[:180]!r}"
        )
    path.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"patched: {relative}")


def patch_external_services() -> None:
    path = "desktop-electron/electron/external-services.cjs"
    replace_once(
        path,
        '''  paseo: Object.freeze({
    name: "Paseo",
    endpoint: "http://127.0.0.1:6768/",
    home: "",
    executable: process.platform === "win32" ? "npm.cmd" : "npm",
    arguments: ["run", "dev:server"],
    enabled: true,
    autoStart: false,
  }),
''',
        '''  paseo: Object.freeze({
    name: "Paseo",
    endpoint: "http://127.0.0.1:6768/",
    home: "",
    executable: process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm",
    arguments: process.platform === "win32"
      ? ["/d", "/s", "/c", "npm", "run", "dev:server"]
      : ["run", "dev:server"],
    enabled: true,
    autoStart: false,
  }),
''',
    )
    replace_once(
        path,
        '''  anneal: Object.freeze({
    name: "Anneal",
    endpoint: "http://127.0.0.1:3000/",
    home: "",
    executable: process.platform === "win32" ? "npm.cmd" : "npm",
    arguments: ["run", "dev:web"],
    enabled: true,
    autoStart: false,
  }),
''',
        '''  anneal: Object.freeze({
    name: "Anneal",
    endpoint: "http://127.0.0.1:3000/",
    home: "",
    executable: process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm",
    arguments: process.platform === "win32"
      ? ["/d", "/s", "/c", "npm", "run", "dev:web"]
      : ["run", "dev:web"],
    enabled: true,
    autoStart: false,
  }),
''',
    )
    replace_once(
        path,
        '''  return value.map((argument) => {
    if (typeof argument !== "string") throw new Error("Service arguments must be strings");
    if (argument.length > 2_048) throw new Error("Service argument is too long");
    return argument;
  });
''',
        '''  return value.map((argument) => {
    if (typeof argument !== "string") throw new Error("Service arguments must be strings");
    if (argument.includes("\\0")) throw new Error("Service arguments must not contain null bytes");
    if (argument.length > 2_048) throw new Error("Service argument is too long");
    return argument;
  });
''',
    )
    replace_once(
        path,
        '''  function secretFor(id) {
    return codec.decrypt(state.secrets[id]) || {};
  }
''',
        '''  function secretFor(id) {
    const stored = codec.decrypt(state.secrets[id]) || {};
    if (id !== "codex-router" || stored.callerKey) return stored;
    const environmentCallerKey = typeof env.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY === "string"
      ? env.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY.trim()
      : "";
    return CALLER_KEY.test(environmentCallerKey)
      ? { callerKey: environmentCallerKey }
      : stored;
  }

  function redactServiceSecrets(value) {
    let result = String(value || "");
    const callerKey = secretFor("codex-router").callerKey;
    if (callerKey) {
      result = result
        .split(callerKey).join("[REDACTED]")
        .split(encodeURIComponent(callerKey)).join("[REDACTED]");
    }
    return result;
  }
''',
    )
    replace_once(
        path,
        '''      const reachable = response.ok
        || (id === "commandcode-proxy" && response.status >= 400 && response.status < 500);
''',
        '''      const toleratesApplicationResponse = id === "commandcode-proxy"
        || id === "paseo"
        || id === "anneal";
      const reachable = response.ok
        || (toleratesApplicationResponse && response.status >= 400 && response.status < 500);
''',
    )
    replace_once(
        path,
        '''        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
''',
        '''        error: redactServiceSecrets(error instanceof Error ? error.message : String(error)),
      });
    } finally {
''',
    )
    replace_once(
        path,
        '''  function upstreamConfiguration(idValue) {
''',
        '''  function runtimeEnvironment() {
    const router = state.services["codex-router"];
    const commandCode = state.services["commandcode-proxy"];
    const callerKey = secretFor("codex-router").callerKey;
    return Object.freeze({
      CODING_TOOLS_CODEX_ROUTER_URL: router.endpoint.replace(/\\/$/, ""),
      ...(callerKey ? { CODING_TOOLS_CODEX_ROUTER_CALLER_KEY: callerKey } : {}),
      CODING_TOOLS_COMMANDCODE_URL: commandCode.endpoint.replace(/\\/$/, ""),
    });
  }

  function upstreamConfiguration(idValue) {
''',
    )
    replace_once(
        path,
        '''    syncCodexRouter,
    upstreamConfiguration,
''',
        '''    syncCodexRouter,
    runtimeEnvironment,
    upstreamConfiguration,
''',
    )


def patch_runtime_supervisor() -> None:
    path = "desktop-electron/electron/runtime-supervisor.cjs"
    replace_once(
        path,
        '''    publishOperation,
    runtimeInvocationFactory = runtimeInvocation,
''',
        '''    publishOperation,
    runtimeInvocationFactory = runtimeInvocation,
    getRuntimeEnvironment = () => ({}),
''',
    )
    replace_once(
        path,
        '''    this.publishOperation = publishOperation;
    this.runtimeInvocationFactory = runtimeInvocationFactory;
''',
        '''    this.publishOperation = publishOperation;
    this.runtimeInvocationFactory = runtimeInvocationFactory;
    this.getRuntimeEnvironment = typeof getRuntimeEnvironment === "function"
      ? getRuntimeEnvironment
      : () => ({});
''',
    )
    replace_once(
        path,
        '''  spawnChild(name, invocation) {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      detached: DETACH_OWNED_CHILD,
      env: {
        ...process.env,
        CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: this.browserDescriptorPath,
      },
''',
        '''  spawnChild(name, invocation) {
    const suppliedRuntimeEnvironment = this.getRuntimeEnvironment() || {};
    if (typeof suppliedRuntimeEnvironment !== "object" || Array.isArray(suppliedRuntimeEnvironment)) {
      throw new Error("Runtime environment provider returned an invalid value");
    }
    const runtimeEnvironment = Object.fromEntries(
      Object.entries(suppliedRuntimeEnvironment).filter(([key, value]) => (
        /^[A-Z][A-Z0-9_]*$/.test(key) && typeof value === "string" && value.length > 0
      )),
    );
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      detached: DETACH_OWNED_CHILD,
      env: {
        ...process.env,
        ...runtimeEnvironment,
        CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: this.browserDescriptorPath,
      },
''',
    )


def patch_main() -> None:
    path = "desktop-electron/electron/main.cjs"
    replace_once(
        path,
        '''    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
  });
''',
        '''    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
    getRuntimeEnvironment: () => externalServicesController.runtimeEnvironment(),
  });
''',
    )


def main() -> None:
    patch_external_services()
    patch_runtime_supervisor()
    patch_main()
    print("RC8_ROUTER_RUNTIME_ENV_APPLIED")


if __name__ == "__main__":
    main()
