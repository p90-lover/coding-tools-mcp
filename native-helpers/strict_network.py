"""Require account-scoped WFP denial for all network protocols, including loopback.

The upstream port-specific filters supplement its firewall, but are insufficient
for this adapter's full read-restricted token. Match both access-check passes
without adding the real user, Everyone, or the sandbox account to restricting SIDs.
"""
from pathlib import Path
import shutil,sys,uuid
crate=Path(sys.argv[1]).resolve()
backup=crate.parents[1]/'aiTemp/Trash/strict-network-originals'
def replace(name,old,new):
    p=crate/name;s=p.read_text(encoding='utf-8');assert s.count(old)==1,name
    b=backup/name;b.parent.mkdir(parents=True,exist_ok=True)
    if not b.exists():shutil.copy2(p,b)
    p.write_text(s.replace(old,new),encoding='utf-8')

replace('src/wfp.rs','''        let mut security_descriptor: PSECURITY_DESCRIPTOR = null_mut();''','''        // ALE_USER_ID is an access check, not merely a numeric TokenUser
        // comparison. Its first pass must match the offline account; its second
        // pass must also recognize the Restricted Code SID used by our token.
        // This descriptor is used ONLY to match a blocking WFP filter. It grants
        // no filesystem/registry access and does not alter any process token.
        let restricted_code = crate::LocalSid::from_string("S-1-5-12")?;
        let mut restricted_access: EXPLICIT_ACCESS_W = unsafe { zeroed() };
        restricted_access.grfAccessPermissions = FWP_ACTRL_MATCH_FILTER;
        restricted_access.grfAccessMode = GRANT_ACCESS;
        restricted_access.Trustee.TrusteeForm = windows_sys::Win32::Security::Authorization::TRUSTEE_IS_SID;
        restricted_access.Trustee.ptstrName = restricted_code.as_ptr().cast();
        let entries = [access, restricted_access];
        let mut security_descriptor: PSECURITY_DESCRIPTOR = null_mut();''')
replace('src/wfp.rs','''                1,
                &access,
                0,''','''                entries.len() as u32,
                entries.as_ptr(),
                0,''')

name='src/wfp/filter_specs.rs'
entries=[]
for label,layer in [('all_connect_v4','FWPM_LAYER_ALE_AUTH_CONNECT_V4'),('all_connect_v6','FWPM_LAYER_ALE_AUTH_CONNECT_V6'),('all_assign_v4','FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4'),('all_assign_v6','FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V6')]:
    ident=uuid.uuid5(uuid.NAMESPACE_URL,'https://github.com/p90-lover/coding-tools-mcp/network-deny-v1/'+label).hex
    entries.append(f'''    FilterSpec {{
        key: GUID::from_u128(0x{ident}),
        name: "coding_tools_mcp_{label}",
        description: "Block every network protocol for the offline sandbox account",
        layer_key: {layer},
        conditions: &[ConditionSpec::User],
    }},''')
replace(name,'pub(super) const FILTER_SPECS: &[FilterSpec] = &[','pub(super) const FILTER_SPECS: &[FilterSpec] = &[\n'+'\n'.join(entries))
replace('src/bin/setup_main/win.rs','''    if repairing_disabled_accounts {
        // Ordinary setup keeps its best-effort WFP behavior. Recovery must not reopen logons
        // after cleanup removed protections unless restoring those protections succeeded.
        wfp_result?;''','''    // No best-effort success: this adapter requires complete kernel-level
    // network denial before provisioning or account recovery reports ready.
    wfp_result?;
    if repairing_disabled_accounts {''')
print('Added mandatory all-protocol IPv4/IPv6 connect/bind denial with full-token matching')
