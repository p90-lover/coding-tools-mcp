"""Complete the staged patch without overwriting prior work or weakening guards."""
from pathlib import Path
import ast, os, runpy, shutil, subprocess

def once(text, old, new):
    assert text.count(old) == 1, (old[:100], text.count(old))
    return text.replace(old, new, 1)

def save(name, text):
    path = Path(name)
    if path.read_text(encoding='utf-8') == text:
        return
    backup = Path('aiTemp/Trash/live-context-before') / os.environ['GITHUB_RUN_ID'] / name
    backup.parent.mkdir(parents=True, exist_ok=True)
    assert not backup.exists() and not path.is_symlink()
    shutil.copy2(path, backup)
    path.write_text(text, encoding='utf-8')

# The earlier staged preparer stopped because its label anchor occurs five times.
# Scope that one replacement to the form's opening; keep all other assertions.
path = Path('aiTemp/live-refresh/prepare.py')
source = path.read_text(encoding='utf-8')
old = "s=once(s,'>\\n  <label class=\"grid gap-1\">','>\\n  <fieldset disabled={saving} class=\"grid gap-3\" onchange={() => void changed()}>\\n  <label class=\"grid gap-1\">')"
new = "s=once(s,'  }}\\n>\\n  <label class=\"grid gap-1\">','  }}\\n>\\n  <fieldset disabled={saving} class=\"grid gap-3\" onchange={() => void changed()}>\\n  <label class=\"grid gap-1\">')"
source = once(source, old, new)
ast.parse(source)
exec(compile(source, str(path) + ' (unique form anchor)', 'exec'), {'__name__': '__main__'})
runpy.run_path('aiTemp/live-refresh/refinements.py', run_name='__main__')

name = 'src-tauri/src/harness/tools.rs'
text = Path(name).read_text(encoding='utf-8')
text = once(text, '    Ok(json!({"task": task, "events": events, "truncated": false}))', '''    let limit = args.get("max_bytes").and_then(Value::as_u64).unwrap_or(32768).clamp(8192,131072) as usize;
    let task = serde_json::to_value(task).map_err(|error| tool_error("SERIALIZE_FAILED", error.to_string()))?;
    let events = serde_json::to_value(events).map_err(|error| tool_error("SERIALIZE_FAILED", error.to_string()))?;
    Ok(super::context_view::render(task, events, limit))''')
save(name, text)
name = 'src-tauri/src/harness/mod.rs'
text = Path(name).read_text(encoding='utf-8')
assert 'mod context_view;' not in text
save(name, text + '\npub(crate) mod context_view;\n')

# ToolContext stale-root isolation is not a claim of revoking an already-running
# external process or the pre-existing explicit absolute-read allowance.
# Document these limits instead of silently broadening/removing prior policy.
for name in ['src-tauri/src/harness/tools.rs', 'src-tauri/src/harness/mod.rs', 'src-tauri/src/harness/context_view.rs']:
    subprocess.run(['rustfmt', '--edition', '2021', '--config', 'skip_children=true', name], check=True)
subprocess.run(['git','add','--','src-tauri/src/harness/tools.rs','src-tauri/src/harness/mod.rs','src-tauri/src/harness/context_view.rs'],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
print('LIVE_FINISH: unique form anchor, bounded task_context and staged live-policy/root/scan changes materialized; originals retained')
