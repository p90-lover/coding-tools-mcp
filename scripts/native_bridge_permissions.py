"""Migrate only the reviewed legacy read boundary; no provisioning or broader fallback."""
from pathlib import Path
import os
import shutil


def replace_once(text: str, before: str, after: str) -> str:
    if after in text:
        assert before not in text
        return text
    assert text.count(before) == 1, before[:100]
    return text.replace(before, after, 1)


def main() -> None:
    path = Path('src-tauri/src/codex_bridge/mod.rs')
    text = path.read_text(encoding='utf-8')
    old = text
    if "native_permission_profile_mismatch" in text:
        assert '"sandboxPolicy":{"type":"readOnly","access"' not in text
        return
    text = replace_once(text, '"capabilities":{"experimentalApi":false}', '"capabilities":{"experimentalApi":true}')
    text = replace_once(text,
        'let value = self.rpc("thread/start", json!({"cwd":self.root,"model":self.options.model,\n                "sandbox":"read-only","approvalPolicy":"on-request","approvalsReviewer":"user","ephemeral":true,',
        '''// Named permissions replace removed readOnly.access in native 0.153.4.
            // A fresh profile avoids inheriting another configured profile's rules.
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "System clock unavailable")?.as_nanos();
            let profile = format!("coding_tools_readonly_{}_{nonce}", std::process::id());
            let value = self.rpc("thread/start", json!({"cwd":self.root,"model":self.options.model,
                "permissions":profile,
                "config":{"permissions":{(profile.clone()):{
                    "filesystem":{":root":"deny",":minimal":"read",":workspace_roots":{".":"read"}},
                    "network":{"enabled":false}}}},
                "approvalPolicy":"on-request","approvalsReviewer":"user","ephemeral":true,''')
    text = replace_once(text,
        'let id = value["thread"]["id"]',
        '''if value["activePermissionProfile"]["id"].as_str() != Some(profile.as_str()) {
                self.stop("native_permission_profile_mismatch");
                return Err("Native runtime did not confirm the requested read-only profile; no turn submitted".into());
            }
            let id = value["thread"]["id"]''')
    text = replace_once(text,
        '"cwd":self.root,"model":self.options.model,"approvalPolicy":"on-request",\n                "sandboxPolicy":{"type":"readOnly","access":{"type":"restricted","includePlatformDefaults":true,"readableRoots":[self.root]}}}',
        '// Inherit the confirmed thread-scoped profile; never reset it to legacy broad reads.\n                "cwd":self.root,"model":self.options.model,"approvalPolicy":"on-request"}')
    if text != old:
        backup = Path('aiTemp/Trash/native-permissions-migration') / os.environ['GITHUB_RUN_ID'] / path
        backup.parent.mkdir(parents=True, exist_ok=True)
        if not backup.exists(): shutil.copy2(path, backup)
        path.write_text(text, encoding='utf-8')
    assert '"sandboxPolicy":{"type":"readOnly","access"' not in text
    assert 'native_permission_profile_mismatch' in text

if __name__ == '__main__': main()
