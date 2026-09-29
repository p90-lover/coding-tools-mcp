"""Apply a bounded fixture repair; preserve originals and never enable a real provider."""
from pathlib import Path
import os
import shutil


def update(name, before, after):
    path = Path(name)
    source = path.read_text(encoding='utf-8')
    if after and after in source:
        assert before not in source
        return
    if not after and before not in source:
        return
    assert source.count(before) == 1, (name, source.count(before))
    backup = Path('aiTemp/Trash/studio-protocol-before') / os.environ['GITHUB_RUN_ID'] / name
    backup.parent.mkdir(parents=True, exist_ok=True)
    if not backup.exists():
        shutil.copy2(path, backup)
    path.write_text(source.replace(before, after, 1), encoding='utf-8')


# Named profiles and sandbox_mode do not compose. Only the isolated fixture config changes.
update('aiTemp/release-verification/native_turn_fixture.rs',
       'sandbox_mode = \\"read-only\\"\\n', '')
# Report the response that actually failed, not an unrelated legacy diagnostic session.
update('src-tauri/src/codex_bridge/mod.rs',
       'let result = if value.get("error").is_some() {',
       'let result = if value.get("error").is_some() {\n                    #[cfg(test)]\n                    if std::env::var_os("NATIVE_CODEX_PROBE_BIN").is_some() {\n                        eprintln!("Isolated bridge RPC error: {}", bounded(&value["error"].to_string(), 2048));\n                    }')
