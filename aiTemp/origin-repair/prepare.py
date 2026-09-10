"""Materialize the single response-policy repair and focused regression harness."""
from pathlib import Path
import os,shutil,subprocess
changed=[]
def once(s,old,new):
    assert s.count(old)==1,(old[:90],s.count(old))
    return s.replace(old,new,1)
def save(name,s):
    path=Path(name);old=path.read_text(encoding='utf-8')
    if s==old:return
    backup=Path('aiTemp/Trash/origin-repair')/os.environ['GITHUB_RUN_ID']/name
    backup.parent.mkdir(parents=True,exist_ok=True)
    assert not backup.exists() and not path.is_symlink()
    shutil.copy2(path,backup);path.write_text(s,encoding='utf-8');changed.append(name)
name='src-tauri/src/auth/http_security.rs';s=Path(name).read_text()
s=once(s,'''        response
            .headers_mut()
            .insert("content-security-policy", policy);
''','''        response
            .headers_mut()
            .insert("content-security-policy", policy);
        // For native HTML form POSTs, no-referrer serializes Origin as null.
        // Only a validated consent page receives this exception. strict-origin
        // preserves the real source without exposing OAuth paths/query strings.
        // Keep null-origin rejection and no-referrer on all other responses.
        response
            .headers_mut()
            .insert("referrer-policy", HeaderValue::from_static("strict-origin"));
''')
save(name,s)
name='aiTemp/oauth-popup/origin_policy.rs';s=Path(name).read_text()
s+='''
#[test]
fn oauth_popup_form_referrer_is_scoped_and_survives_outer_guard() {
    use crate::auth::http_security::{secure_response, with_oauth_form_redirect};
    use axum::response::IntoResponse;
    let mut forged = StatusCode::OK.into_response();
    forged.headers_mut().insert("referrer-policy", "strict-origin".parse().unwrap());
    let ordinary = secure_response(forged);
    assert_eq!(ordinary.headers()["referrer-policy"], "no-referrer");
    let callback = url::Url::parse("https://chatgpt.com/connector/oauth/fixture").unwrap();
    let consent = with_oauth_form_redirect(StatusCode::OK.into_response(), &callback);
    let consent = secure_response(secure_response(consent));
    assert_eq!(consent.headers()["referrer-policy"], "strict-origin", "VALID_CONSENT_MUST_PRESERVE_ORIGIN");
    assert_eq!(consent.headers()["cache-control"], "no-store");
    assert!(consent.headers()["content-security-policy"].to_str().unwrap().contains("form-action 'self' https://chatgpt.com"));
    let invalid = url::Url::parse("https://user:password@attacker.invalid/").unwrap();
    let denied = with_oauth_form_redirect(StatusCode::BAD_REQUEST.into_response(), &invalid);
    assert_eq!(denied.headers()["referrer-policy"], "no-referrer");
}
'''
save(name,s)
name='aiTemp/oauth-popup/http_flow.rs';s=Path(name).read_text()
s=once(s,'    // Raw Host/Forwarded input must not become a trusted origin or issuer.', '''    // The browser receives every production response header and submits through
    // this live Rust listener. The old replay omitted Referrer-Policy and missed
    // the real Origin:null rejection. No real account or external traffic is used.
    if let Ok(script) = std::env::var("OAUTH_BROWSER_PROBE") {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let mut command = tokio::process::Command::new("python");
        command.arg(script).arg(&local).current_dir(repo).kill_on_drop(true);
        let result = tokio::time::timeout(Duration::from_secs(120), command.output())
            .await.expect("Browser probe timed out").expect("Python browser probe could not start");
        println!("{}", String::from_utf8_lossy(&result.stdout));
        eprintln!("{}", String::from_utf8_lossy(&result.stderr));
        assert!(result.status.success(), "REAL_BROWSER_ORIGIN_FLOW_FAILED");
    }

    // Raw Host/Forwarded input must not become a trusted origin or issuer.''')
s=once(s,'        let html = page.text().await.unwrap();','''        let browser_headers: HashMap<String, String> = page.headers().iter()
            .map(|(key, value)| (key.to_string(), value.to_str().unwrap().to_owned()))
            .collect();
        assert_eq!(browser_headers["referrer-policy"], "strict-origin");
        let html = page.text().await.unwrap();''')
s=once(s,'"authorize_url":authorize_url.as_str(),"html":html,"csp":csp,"set_cookie":browser_cookie,','"authorize_url":authorize_url.as_str(),"html":html,"csp":csp,"set_cookie":browser_cookie,"response_headers":browser_headers,')
save(name,s)
for name in ['package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','README.md','README.en.md']:
    s=Path(name).read_text(encoding='utf-8');assert '0.4.3-rc.4' in s,name
    save(name,s.replace('0.4.3-rc.4','0.4.3-rc.5'))
for name in ['src-tauri/src/auth/http_security.rs','aiTemp/oauth-popup/origin_policy.rs','aiTemp/oauth-popup/http_flow.rs']:
    subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
subprocess.run(['git','add','--',*changed],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
