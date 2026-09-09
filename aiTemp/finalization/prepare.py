"""Prepare the bounded 0.4.2 candidate; preserve originals and commit real source."""
from pathlib import Path
import os
import shutil
import subprocess

BASE = 'fa7f323aa52ee5b5c143f61ff46fc534264f79ff'
MCP = '09238bed2a609205252f4872fa2d8dae3e0eb03d'
MCP_FILES = [
    'src-tauri/src/mcp/listener.rs', 'src-tauri/src/mcp/server.rs',
    'src-tauri/src/mcp/transport.rs', 'src-tauri/src/tools/registry_definitions.rs',
    'aiTemp/connection-tests/http.rs', 'docs/guides/mcp-connection-repair.md',
]
CHANGED = MCP_FILES + [
    'src-tauri/src/codex_bridge/mod.rs', 'src/routes/work/+page.svelte',
    'aiTemp/release-verification/native_turn_fixture.rs',
    'docs/features/native-codex-runtime.md',
]


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def once(text, old, new):
    assert text.count(old) == 1, f'Expected exactly one source marker: {old[:100]!r}'
    return text.replace(old, new, 1)


def preserve(name):
    source = Path(name)
    if source.exists():
        assert source.is_file() and not source.is_symlink(), name
        target = Path('aiTemp/Trash/finalization-before') / os.environ['GITHUB_RUN_ID'] / name
        target.parent.mkdir(parents=True, exist_ok=True)
        assert not target.exists(), target
        shutil.copy2(source, target)


def prepare():
    Path('aiTemp/evidence').mkdir(parents=True, exist_ok=True)
    for name in CHANGED:
        preserve(name)
    subprocess.run(['git', 'fetch', '--no-tags', 'origin', BASE, MCP], check=True)
    patch = subprocess.check_output(['git', 'diff', '--binary', BASE, MCP, '--', *MCP_FILES])
    patch_path = Path('aiTemp/finalization/pinned-mcp.patch')
    patch_path.write_bytes(patch)
    subprocess.run(['git', 'apply', '--check', str(patch_path)], check=True)
    subprocess.run(['git', 'apply', str(patch_path)], check=True)

    path = Path('src-tauri/src/codex_bridge/mod.rs')
    text = path.read_text(encoding='utf-8')
    start = text.index('            // Named permissions replace removed readOnly.access')
    end = text.index('            let id = value["thread"]["id"]', start)
    text = text[:start] + '''            // The built-in read-only profile is supported by native Windows and macOS.
            // Split filesystem read restrictions are not supported by the unelevated
            // Windows sandbox. Never substitute an unsandboxed permission profile.
            const PROFILE: &str = ":read-only";
            let value = self.rpc("thread/start", json!({"cwd":self.root,"model":self.options.model,
                "permissions":PROFILE,"approvalPolicy":"on-request","approvalsReviewer":"user","ephemeral":true,
                "developerInstructions":"Work only on the explicitly requested task. Never delete files; use Trash for unwanted files and aiTemp for temporary files. Do not change permissions or use unsandboxed fallbacks. Explain evidence and uncertainty. Do not launch extra agents unless explicitly requested."}))?;
            if value["activePermissionProfile"]["id"].as_str() != Some(PROFILE) {
                self.stop("native_permission_profile_mismatch");
                return Err("Native runtime did not confirm the built-in read-only profile; no turn submitted".into());
            }
''' + text[end:]
    text = once(text,
        '// Inherit the confirmed thread-scoped profile; never reset it to legacy broad reads.\n                "cwd":self.root,"model":self.options.model,"approvalPolicy":"on-request"',
        '// Reassert the same supported boundary on every turn, including send.\n                "permissions":":read-only","approvalsReviewer":"user",\n                "cwd":self.root,"model":self.options.model,"approvalPolicy":"on-request"')
    env_marker = '            .stderr(Stdio::null());\n        OwnedProcess::configure(&mut command);'
    if 'command.env("CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG", "1")' not in text:
        text = once(text, env_marker, '''            .stderr(Stdio::null());
        #[cfg(test)]
        if std::env::var_os("NATIVE_CODEX_PROBE_BIN").is_some() {
            command.env("CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG", "1");
        }
        OwnedProcess::configure(&mut command);''')
    receive_marker = '        if let Some(method) = value["method"].as_str() {\n'
    text = once(text, receive_marker, receive_marker + '''            #[cfg(test)]
            if std::env::var_os("NATIVE_CODEX_PROBE_BIN").is_some()
                && (method == "error" || (method == "turn/completed" && value["params"]["turn"]["status"] == "failed"))
            {
                // Credential-free fixture only; no production logging of payloads.
                eprintln!("SYNTHETIC_NATIVE_FAILURE {}", bounded(&value.to_string(), 4096));
            }
''')
    marker = '        "item/completed" if params["item"]["type"] == "contextCompaction" => {'
    text = once(text, marker, '''        "item/completed" if params["item"]["type"] == "exitedReviewMode" => {
            if params["turnId"].as_str() != thread.turn_id.as_deref() {
                return;
            }
            if let (Some(item), Some(review)) = (
                params["item"]["id"].as_str().filter(|s| token(s)),
                params["item"]["review"].as_str(),
            ) {
                thread.item_id = item.into();
                thread.answer = bounded(review, MAX_TEXT);
                thread.answer_truncated = review.len() > MAX_TEXT;
            }
        }
''' + marker)
    path.write_text(text, encoding='utf-8')

    path = Path('aiTemp/release-verification/native_turn_fixture.rs')
    text = path.read_text(encoding='utf-8')
    marker = 'fn go(hub: &Hub, operation: &str, id: &str, thread: Option<&str>, text: Option<&str>) -> Value {\n'
    text = once(text, marker, marker + '    eprintln!("NATIVE_LIFECYCLE_STAGE {operation}");\n')
    marker = '    assert_eq!(review["ok"], true, "{review}");\n    terminal(&hub, id);'
    text = once(text, marker, '''    assert_eq!(review["ok"], true, "{review}");
    let reviewed = terminal(&hub, id);
    assert!(reviewed["answer"].as_str().is_some_and(|s| s.contains("Synthetic protocol fixture")), "{reviewed}");''')
    path.write_text(text, encoding='utf-8')

    path = Path('src/routes/work/+page.svelte')
    text = path.read_text(encoding='utf-8')
    text = once(text, '<select bind:value={initialState}>', '<select bind:value={initialState} aria-label={t($locale, \'Initial status\', \'初始狀態\')}>')
    text = once(text, '<select value={detail.state} disabled={!canEdit}', '<select aria-label={t($locale, \'Move task to\', \'移動任務至\')} value={detail.state} disabled={!canEdit}')
    path.write_text(text, encoding='utf-8')

    path = Path('docs/features/native-codex-runtime.md')
    with path.open('a', encoding='utf-8') as stream:
        stream.write('''\n## 0.4.2 release boundary / 發行範圍\n\nThe native bridge uses Codex 0.153.4's built-in `:read-only` profile and reasserts\nit for subsequent turns. Read-only is not a promise that only workspace files\nare readable: native platform read access can be broader. The bridge never\nrequests an unsandboxed fallback and declines unsupported approval requests.\nInline review output is read from the native `exitedReviewMode` event. Native\nconnection and inference remain explicitly opt-in in the visible local UI.\nCI uses an isolated loopback synthetic Responses provider, not paid inference,\na real code review, or acceptance of the user's live provider/ChatGPT setup.\n\n原生橋接使用 Codex 0.153.4 內建的 `:read-only` 權限設定，後續回合亦會\n明確套用相同設定。唯讀不表示只能讀取工作區；原生平台的可讀範圍可能更廣。\n不會自動改用無沙箱模式，不支援的授權要求會被拒絕。行內審查會讀取\n`exitedReviewMode` 事件的結果；原生連線及模型使用仍須於可見的本機 UI 明確啟用。\nCI 只使用隔離的本機模擬 Responses 服務，不代表付費推論、真實程式碼審查，\n或使用者的實際供應商／ChatGPT 環境已完成驗收。\n''')
    subprocess.run(['rustfmt', '--edition', '2021', '--config', 'skip_children=true',
        *[name for name in CHANGED if name.endswith('.rs')]], check=True)
    subprocess.run(['git', 'diff', '--check'], check=True)
    assert not run('git', 'diff', '--diff-filter=D', '--name-only'), 'File deletion is prohibited'
    subprocess.run(['git', 'add', '--', *CHANGED], check=True)
    subprocess.run(['git', 'diff', '--cached', '--check'], check=True)
    Path('aiTemp/evidence/preparation.txt').write_text(
        run('git', 'diff', '--cached', '--stat') + '\nMCP source: ' + MCP + '\n', encoding='utf-8')


if __name__ == '__main__':
    prepare()
