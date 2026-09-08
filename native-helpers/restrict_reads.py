"""Constrain the pinned elevated backend to actual per-root read capabilities.

WRITE_RESTRICTED skips the second token check for reads. The upstream readonly
branch also shares a capability across workspaces. Neither enforces this app's
explicit readable-root contract. This adapter keeps full restricted-token checks
and grants read/execute only to a capability unique to each allowed root.
"""
from pathlib import Path
import shutil
import sys

crate = Path(sys.argv[1]).resolve()
backup = crate.parents[1] / 'aiTemp/Trash/read-isolation-originals'

def replace(name, old, new):
    path = crate / name
    text = path.read_text(encoding='utf-8')
    assert text.count(old) == 1, f'Pinned source anchor changed: {name}'
    saved = backup / name
    if not saved.exists():
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, saved)
    path.write_text(text.replace(old, new), encoding='utf-8')

token = crate / 'src/token.rs'
text = token.read_text(encoding='utf-8')
start = text.index('pub unsafe fn create_readonly_token_with_caps_and_user_from(')
end = text.index('\nunsafe fn create_token_with_caps_user_and_additional_restrictions_from(', start)
replace('src/token.rs', text[start:end], r'''pub unsafe fn create_readonly_token_with_caps_and_user_from(
    base_token: HANDLE,
    psid_capabilities: &[*mut c_void],
    additional_restricting_sids: &[*mut c_void],
) -> Result<HANDLE> {
    // Do not add Everyone or the sandbox user: ordinary shared-file ACLs must
    // not satisfy the capability check. The fresh logon SID permits session
    // kernel objects, not previously existing filesystem data.
    if psid_capabilities.is_empty() || !additional_restricting_sids.is_empty() {
        return Err(anyhow!("read-confined adapter requires explicit root capabilities without proxy identities"));
    }
    let mut logon = get_logon_sid_bytes(base_token)?;
    let logon_sid = logon.as_mut_ptr() as *mut c_void;
    let mut sids = psid_capabilities.to_vec();
    sids.push(logon_sid);
    let mut entries: Vec<SID_AND_ATTRIBUTES> = sids.iter().map(|sid|
        SID_AND_ATTRIBUTES { Sid: *sid, Attributes: 0 }
    ).collect();
    // Windows shared runtime sections (KnownDlls) explicitly permit Restricted
    // Code. Without it the loader exits STATUS_ACCESS_DENIED before main.
    // It is NOT granted in filesystem ACEs, the private desktop, or the default
    // DACL; ordinary Everyone/Users access still cannot satisfy the second check.
    let runtime_identity = LocalSid::from_string("S-1-5-12")?;
    entries.push(SID_AND_ATTRIBUTES { Sid: runtime_identity.as_ptr(), Attributes: 0 });
    let mut restricted: HANDLE = 0;
    // No WRITE_RESTRICTED flag: reads AND writes require both access checks.
    if CreateRestrictedToken(base_token, DISABLE_MAX_PRIVILEGE | LUA_TOKEN,
        0, std::ptr::null(), 0, std::ptr::null(), entries.len() as u32,
        entries.as_mut_ptr(), &mut restricted) == 0 {
        return Err(anyhow!("CreateRestrictedToken (read-confined) failed: {}", GetLastError()));
    }
    let initialized = (|| -> Result<()> {
        set_default_dacl(restricted, &sids)?;
        enable_single_privilege(restricted, "SeChangeNotifyPrivilege")?;
        Ok(())
    })();
    if let Err(err) = initialized {
        CloseHandle(restricted);
        return Err(err);
    }
    Ok(restricted)
}
''')

replace('src/elevated_impl.rs', '''            let sid = LocalSid::from_string(&caps.readonly)?;
            (sid, vec![caps.readonly])''', '''            // Root-scoped capabilities, never the shared readonly SID. A root
            // granted to an earlier workspace is absent from this token.
            let read_roots = crate::setup::gather_read_roots(cwd, &permissions, &env_map, codex_home);
            let cap_sids = read_roots.iter()
                .map(|root| workspace_write_cap_sid_for_root(codex_home, cwd, root))
                .collect::<Result<Vec<_>>>()?;
            if cap_sids.is_empty() { anyhow::bail!("no readable root capabilities"); }
            (LocalSid::from_string(&cap_sids[0])?, cap_sids)''')

name = 'src/bin/setup_main/win.rs'
text = (crate / name).read_text(encoding='utf-8')
start = text.index('    if payload.read_roots.is_empty() {', text.index('fn run_setup_full('))
end = text.index('\n    if refresh_only {', start)
replace(name, text[start:end], '    // Read capabilities are granted synchronously after persistent directories are locked.\n')
replace(name, '''    if !refresh_only {
        lock_persistent_sandbox_dirs(payload, &sandbox_group_sid)?;
    }

    unsafe {''', '''    if !refresh_only {
        lock_persistent_sandbox_dirs(payload, &sandbox_group_sid)?;
    }

    // Complete both base-identity and capability grants before declaring setup
    // ready. Do not skip the capability ACE just because Users/Everyone can read.
    if !payload.write_roots.is_empty() {
        anyhow::bail!("this adapter is read-only; writable roots are unsupported");
    }
    for root in &payload.read_roots {
        let sid_string = workspace_write_cap_sid_for_root(
            &payload.codex_home, &payload.command_cwd, root)?;
        let sid = codex_windows_sandbox::LocalSid::from_string(&sid_string)?;
        unsafe {
            ensure_allow_mask_aces_with_inheritance(
                root, &[sandbox_group_psid, sid.as_ptr()],
                FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
            )?;
        }
    }

    unsafe {''')
print('Applied read-confined token, per-root capabilities, and synchronous read grants')
