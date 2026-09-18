from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "desktop-electron/electron/managed-components.cjs"

text = TARGET.read_text(encoding="utf-8")

constants_anchor = '''const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
'''
constants_replacement = '''const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FORBIDDEN_COMMANDS = new Set([
  "del",
  "erase",
  "rd",
  "remove-item",
  "rmdir",
  "rm",
  "shred",
  "unlink",
]);
const SHELL_COMMANDS = new Set(["bash", "cmd", "powershell", "pwsh", "sh"]);
const DESTRUCTIVE_SHELL_PATTERN = /(?:^|[;&|\\s])(?:del|erase|rd|remove-item|rmdir|rm|shred|unlink)(?:$|[;&|\\s])/iu;
const SHA256 = /^[a-f0-9]{64}$/;
'''
if constants_replacement not in text:
    if text.count(constants_anchor) != 1:
        raise SystemExit("managed command constant anchor was not unique")
    text = text.replace(constants_anchor, constants_replacement, 1)

function_anchor = '''function assertSafeCommand(step, label) {
'''
function_replacement = '''function assertNonDestructiveCommand(executable, argumentsValue, label) {
  const rawBase = path.basename(String(executable || "")).toLowerCase();
  const base = rawBase.replace(/\\.(?:bat|cmd|exe|ps1)$/iu, "");
  const args = Array.isArray(argumentsValue) ? argumentsValue.map(String) : [];
  if (FORBIDDEN_COMMANDS.has(base)) throw new Error(`${label} contains a destructive executable`);
  if (base === "git" && args[0]?.toLowerCase() === "clean") {
    throw new Error(`${label} must not run git clean`);
  }
  if (base === "docker" && args.some((value) => value.toLowerCase() === "down")) {
    throw new Error(`${label} must not destroy the managed Docker topology`);
  }
  if (SHELL_COMMANDS.has(base) && DESTRUCTIVE_SHELL_PATTERN.test(args.join(" "))) {
    throw new Error(`${label} contains a destructive shell command`);
  }
}

function assertSafeCommand(step, label) {
'''
if function_replacement not in text:
    if text.count(function_anchor) != 1:
        raise SystemExit("assertSafeCommand anchor was not unique")
    text = text.replace(function_anchor, function_replacement, 1)

call_anchor = '''    for (const argument of step.arguments) {
      if (typeof argument !== "string" || argument.includes("\\0") || argument.length > 4_096) {
        throw new Error(`${label} contains an invalid argument`);
      }
    }
  }
'''
call_replacement = '''    for (const argument of step.arguments) {
      if (typeof argument !== "string" || argument.includes("\\0") || argument.length > 4_096) {
        throw new Error(`${label} contains an invalid argument`);
      }
    }
    assertNonDestructiveCommand(step.executable, step.arguments, label);
  }
'''
if call_replacement not in text:
    if text.count(call_anchor) != 1:
        raise SystemExit("assertSafeCommand call anchor was not unique")
    text = text.replace(call_anchor, call_replacement, 1)

TARGET.write_text(text, encoding="utf-8")
print("hardened managed component command boundary")
