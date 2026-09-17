"""Wire the model-free subagent smoke to an explicit portable Codex binary.

The original script is retained under Trash/. No provider/model call is added;
the existing smoke continues to use its local scripted Responses server.
"""
from pathlib import Path
import os
import shutil
import subprocess

path = Path("runtime-web/scripts/smoke-codex-subagents.ts")
source = path.read_text(encoding="utf-8")
import_anchor = 'import type { AdapterEvent } from "../src/types";\n'
import_replacement = import_anchor + 'import { resolveCodexSmokeExecutable } from "./codex-smoke-path";\n'
old = '''const codexArg = process.argv.slice(2).find(argument => argument !== "--v1" && argument !== "--v2");
const codex = resolve(codexArg ?? "/Applications/ChatGPT.app/Contents/Resources/codex");'''
new = '''const codex = resolveCodexSmokeExecutable(
  process.argv.slice(2),
  process.env,
  process.platform,
);'''
assert source.count(import_anchor) == 1
assert source.count(old) == 1
assert "resolveCodexSmokeExecutable" not in source
updated = source.replace(import_anchor, import_replacement, 1).replace(old, new, 1)

backup = Path("Trash/electron-codex-smoke") / os.environ["GITHUB_RUN_ID"] / path
backup.parent.mkdir(parents=True, exist_ok=True)
assert not backup.exists(), f"Refusing to overwrite retained original: {backup}"
assert not path.is_symlink(), f"Refusing to rewrite symlink: {path}"
shutil.copy2(path, backup)
path.write_text(updated, encoding="utf-8")

subprocess.run(["git", "add", "--", str(path), str(backup)], check=True)
subprocess.run(["git", "diff", "--cached", "--check"], check=True)
assert not subprocess.check_output(
    ["git", "diff", "--cached", "--diff-filter=D", "--name-only"]
).strip()
print("CODEX_SMOKE_PATH_REPAIR_PASS: explicit argument > CODEX_SMOKE_BIN > macOS local default")
