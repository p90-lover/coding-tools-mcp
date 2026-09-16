from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> bool:
    text = path.read_text(encoding="utf-8")
    if new in text and old not in text:
        return False
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


def require_final_newline(path: Path) -> None:
    if not path.read_text(encoding="utf-8").endswith("\n"):
        raise SystemExit(f"{path}: missing final newline")


changed = False

profile = Path("desktop-electron/electron/profile.cjs")
changed |= replace_once(
    profile,
    'const DEVELOPMENT_PROFILE = "development";\n\n',
    'const DEVELOPMENT_PROFILE = "development";\n\n'
    'function browserPartitionForLauncherProfile(profile) {\n'
    '  if (profile === PRODUCTION_PROFILE) return "persist:coding-tools-chatgpt";\n'
    '  if (profile === DEVELOPMENT_PROFILE) return "persist:coding-tools-dev-chatgpt";\n'
    '  throw new Error("Launcher profile is invalid");\n'
    '}\n\n',
    "profile helper",
)
changed |= replace_once(
    profile,
    '      browserPartition: "persist:coding-tools-chatgpt",\n',
    '      browserPartition: browserPartitionForLauncherProfile(PRODUCTION_PROFILE),\n',
    "production browser partition",
)
changed |= replace_once(
    profile,
    '    browserPartition: "persist:coding-tools-dev-chatgpt",\n',
    '    browserPartition: browserPartitionForLauncherProfile(DEVELOPMENT_PROFILE),\n',
    "development browser partition",
)
changed |= replace_once(
    profile,
    'module.exports = {\n  DEVELOPMENT_PROFILE,\n  PRODUCTION_PROFILE,\n  resolveLauncherProfile,\n};\n',
    'module.exports = {\n  DEVELOPMENT_PROFILE,\n  PRODUCTION_PROFILE,\n  browserPartitionForLauncherProfile,\n  resolveLauncherProfile,\n};\n',
    "profile export",
)

browser_host = Path("desktop-electron/electron/browser-host.cjs")
changed |= replace_once(
    browser_host,
    'const { processRunning } = require("./process-tree.cjs");\n',
    'const { processRunning } = require("./process-tree.cjs");\n'
    'const { browserPartitionForLauncherProfile } = require("./profile.cjs");\n',
    "browser host profile import",
)
changed |= replace_once(
    browser_host,
    '    partition = "persist:codex-web-gpt-chatgpt",\n',
    '    partition,\n',
    "browser host partition default",
)
changed |= replace_once(
    browser_host,
    '    if (profile !== "production" && profile !== "development") {\n'
    '      throw new Error("Browser host profile is invalid");\n'
    '    }\n'
    '    const expectedPartition = profile === "development"\n'
    '      ? "persist:codex-web-gpt-dev-chatgpt"\n'
    '      : "persist:codex-web-gpt-chatgpt";\n'
    '    if (partition !== expectedPartition) throw new Error("Browser host partition does not match its profile");\n'
    '    this.partition = partition;\n',
    '    const expectedPartition = browserPartitionForLauncherProfile(profile);\n'
    '    const resolvedPartition = partition ?? expectedPartition;\n'
    '    if (resolvedPartition !== expectedPartition) {\n'
    '      throw new Error("Browser host partition does not match its profile");\n'
    '    }\n'
    '    this.partition = resolvedPartition;\n',
    "browser host partition validation",
)

smoke_package = Path("desktop-electron/scripts/smoke-package.cjs")
changed |= replace_once(
    smoke_package,
    '    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(scratch, "launcher-data"),\n'
    '    CODEX_CHATGPT_WEB_HOME: coreHome,\n',
    '    CODING_TOOLS_LAUNCHER_DATA_DIR: path.join(scratch, "launcher-data"),\n'
    '    CODING_TOOLS_HOME: coreHome,\n',
    "smoke profile environment",
)
changed |= replace_once(
    smoke_package,
    '    fatalLogPath: path.join(env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR, "logs", "launcher-fatal.log"),\n',
    '    fatalLogPath: path.join(env.CODING_TOOLS_LAUNCHER_DATA_DIR, "logs", "launcher-fatal.log"),\n',
    "smoke fatal log path",
)

main = Path("desktop-electron/electron/main.cjs")
changed |= replace_once(
    main,
    'const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);\n',
    'const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);\n'
    'const LAUNCHER_SMOKE_TEST = process.argv.includes("--launcher-smoke-test");\n',
    "smoke mode constant",
)
changed |= replace_once(
    main,
    '  const launcherSmokeTest = process.argv.includes("--launcher-smoke-test");\n',
    '  const launcherSmokeTest = LAUNCHER_SMOKE_TEST;\n',
    "smoke mode reuse",
)
changed |= replace_once(
    main,
    '  try {\n'
    '    dialog.showErrorBox("Codex Web GPT could not start", message);\n'
    '  } catch {}\n'
    '  app.exit(1);\n'
    '});\n',
    '  try {\n'
    '    if (!LAUNCHER_SMOKE_TEST) {\n'
    '      dialog.showErrorBox("Codex Web GPT could not start", message);\n'
    '    }\n'
    '  } catch {}\n'
    '  app.exit(1);\n'
    '});\n',
    "non-modal smoke failure",
)

for candidate in (profile, browser_host, smoke_package, main):
    require_final_newline(candidate)

print(f"BROWSER_PROFILE_SMOKE_FIX_OK changed={str(changed).lower()}")
