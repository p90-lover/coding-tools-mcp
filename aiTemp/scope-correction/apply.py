"""Correct the read-scope contract against exact existing source; preserve originals."""
from pathlib import Path
import os
import shutil
import subprocess

changes = {
    'src-tauri/src/tools/native_sandbox.rs': [
        ('    let value: Value = serde_json::from_slice(&bytes)', '    let mut value: Value = serde_json::from_slice(&bytes)'),
        ('    Ok(value)\n}\npub fn local_setup', '    value["read_scope"] = json!("sandbox_account_acl_not_path_whitelist");\n    value["read_scope_notice"] = json!("Shared Windows-readable files outside the workspace may remain readable. Read-only limits workspace writes; it is not a read-path privacy boundary.");\n    Ok(value)\n}\npub fn local_setup'),
        ('        "filesystem":"read_only","network":"restricted","setup_requires_local_consent":true,"model_calls":false,', '        "filesystem":"read_only","network":"restricted","setup_requires_local_consent":true,"model_calls":false,\n        "read_scope":"sandbox_account_acl_not_path_whitelist","read_scope_notice":"Shared Windows-readable files outside the workspace may remain readable; private files depend on Windows ACLs",'),
    ],
    'src-tauri/src/tools/registry.rs': [
        ('read-only scoped filesystem, restricted network and private desktop.', 'blocked workspace writes, restricted network and private desktop. Read access follows the sandbox account Windows ACLs; shared files outside the workspace may remain readable, so this is not a read-path whitelist.'),
    ],
    'src/lib/components/SandboxControl.svelte': [
        ('The sandbox has read-only workspace/platform access and restricted networking.', 'The sandbox blocks workspace writes and restricts networking. Read access follows the sandbox account Windows permissions: shared readable files outside the workspace may remain accessible. This is not a read-path privacy boundary.'),
        ('沙箱僅可讀取工作區／平台檔案並限制網絡，不啟動 Codex Agent。', '沙箱會阻止工作區寫入並限制網絡，但讀取範圍取決於沙箱帳戶的 Windows 權限；工作區外可供共用讀取的檔案仍可能可讀。這不是限制讀取路徑的私隱隔離環境，也不啟動 Codex Agent。'),
        ('Read-only execution in a private desktop; separate from computer-use permissions.', 'Read-only workspace execution in a private desktop; separate from computer-use permissions. Shared Windows-readable files outside the workspace may remain readable. 唯讀不等於工作區外所有檔案均不可讀。'),
    ],
    'docs/features/native-command-sandbox.md': [
        ('The policy is fixed to read-only access for the selected workspace and explicit platform/helper roots.', 'The policy blocks workspace writes and restricts direct networking. Explicit workspace/platform/helper roots are used for setup grants, not a read-path whitelist. Reads remain subject to the dedicated sandbox account Windows ACLs; shared or world-readable files outside the workspace can remain readable. This follows the upstream write-restricted-token design. Do not treat this as a confidentiality boundary for otherwise shared files.'),
        ('then checks permitted reads, denied writes/out-of-scope reads and denied direct loopback networking.', 'then checks permitted workspace/shared reads, denied workspace writes, denied reads of an ACL-protected private fixture and denied direct loopback networking. The private fixture has an unsandboxed positive-read control; shared-file readability is deliberately reported rather than falsely counted as denied.'),
        ('預設只讀取工作區與明確平台根目錄。', '阻止工作區寫入並限制網絡。讀取依據獨立沙箱帳戶的 Windows ACL，並非僅限工作區的路徑白名單；範圍外可共用讀取的檔案仍可能可讀。'),
    ],
}
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip() == os.environ['GITHUB_SHA']
for name, pairs in changes.items():
    path = Path(name)
    assert not path.is_symlink()
    text = path.read_text(encoding='utf-8')
    saved = Path('aiTemp/Trash/before-read-scope') / os.environ['GITHUB_RUN_ID'] / name
    saved.parent.mkdir(parents=True, exist_ok=True)
    assert not saved.exists()
    shutil.copy2(path, saved)
    for old, new in pairs:
        assert text.count(old) == 1, (name, old)
        text = text.replace(old, new)
    path.write_text(text, encoding='utf-8')
subprocess.run(['git','add','--',*changes],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
print('Updated API/tool descriptions, explicit local consent and documentation; OS enforcement unchanged')
