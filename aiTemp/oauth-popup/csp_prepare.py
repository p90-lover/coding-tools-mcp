"""Allow only the validated callback origin through the login form's CSP."""
from pathlib import Path
import os,shutil,subprocess
paths=['src-tauri/src/auth/http_security.rs','src-tauri/src/auth/oauth_flow.rs','aiTemp/oauth-popup/http_flow.rs','aiTemp/oauth-popup/probe.py']
def once(text,old,new):
    assert text.count(old)==1,old[:140]
    return text.replace(old,new,1)
def save(name,text):
    p=Path(name)
    if p.read_text(encoding='utf-8')==text:return
    dest=Path('aiTemp/Trash/oauth-csp-before')/os.environ['GITHUB_RUN_ID']/p
    dest.parent.mkdir(parents=True,exist_ok=True);assert not dest.exists() and not p.is_symlink();shutil.copy2(p,dest)
    p.write_text(text,encoding='utf-8')
p=Path(paths[0]);s=p.read_text(encoding='utf-8')
if 'struct OAuthFormRedirect' not in s:
    s=once(s,'pub fn secure_response(mut response: Response) -> Response {', '''// A response-only marker cannot be supplied by a request header. Only the OAuth
// handler calls this after validating the complete redirect URI against its policy.
#[derive(Clone)]
struct OAuthFormRedirect(HeaderValue);

pub(super) fn with_oauth_form_redirect(mut response: Response, callback: &url::Url) -> Response {
    if matches!(callback.scheme(), "https" | "http")
        && callback.host().is_some()
        && callback.username().is_empty()
        && callback.password().is_none()
        && callback.fragment().is_none()
    {
        // Serializing only the origin excludes query data, wildcards and header injection.
        let policy = format!("default-src 'none'; style-src 'unsafe-inline'; form-action 'self' {}; frame-ancestors 'none'; base-uri 'none'", callback.origin().ascii_serialization());
        if let Ok(policy) = HeaderValue::from_str(&policy) {
            response.extensions_mut().insert(OAuthFormRedirect(policy));
        }
    }
    secure_response(response)
}

pub fn secure_response(mut response: Response) -> Response {''')
    s=once(s,'    ] { response.headers_mut().insert(name, HeaderValue::from_static(value)); }\n    response', '''    ] { response.headers_mut().insert(name, HeaderValue::from_static(value)); }
    // The outer HTTP guard reapplies security headers; retain the trusted OAuth
    // form target without accepting a caller-provided CSP or widening other pages.
    if let Some(policy) = response.extensions().get::<OAuthFormRedirect>().map(|value| value.0.clone()) {
        response.headers_mut().insert("content-security-policy", policy);
    }
    response''')
    save(p,s)
p=Path(paths[1]);s=p.read_text(encoding='utf-8')
if 'with_oauth_form_redirect(response, &callback)' not in s:
    s=once(s,'''    response.headers_mut().insert("set-cookie", cookie);
    response
}

fn consent_cookie_name''','''    response.headers_mut().insert("set-cookie", cookie);
    let Ok(callback) = url::Url::parse(&params.redirect_uri) else {
        return html_error("Invalid callback URL", StatusCode::BAD_REQUEST);
    };
    super::http_security::with_oauth_form_redirect(response, &callback)
}

fn consent_cookie_name''')
    save(p,s)
p=Path(paths[2]);s=p.read_text(encoding='utf-8')
if 'browser_snapshot' not in s:
    s=once(s,'    for round in 0..2 {','''    let mut bad_query = query;
    bad_query.iter_mut().find(|(key, _)| *key == "redirect_uri").unwrap().1 = "https://attacker.invalid/callback";
    let rejected = client.get(format!("{local}/oauth/authorize")).query(&bad_query)
        .header("Origin", "https://chatgpt.com").send().await.unwrap();
    assert_eq!(rejected.status().as_u16(), 400);
    assert!(!rejected.headers()["content-security-policy"].to_str().unwrap().contains("attacker.invalid"));
    let mut browser_snapshot = Value::Null;
    for round in 0..2 {''')
    s=once(s,'        assert_eq!(page.headers()["cache-control"], "no-store");','''        assert_eq!(page.headers()["cache-control"], "no-store");
        let csp = page.headers()["content-security-policy"].to_str().unwrap().to_owned();
        assert_eq!(csp.split(';').map(str::trim).find(|value| value.starts_with("form-action ")),
            Some("form-action 'self' https://chatgpt.com"), "CSP_MUST_ALLOW_VALIDATED_CALLBACK_ONLY");
        assert!(csp.contains("default-src 'none'") && csp.contains("frame-ancestors 'none'"));
        let browser_cookie = page.headers()["set-cookie"].to_str().unwrap().to_owned();''')
    s=once(s,'        assert_eq!(returned["state"], state_value);','''        assert_eq!(returned["state"], state_value);
        let mut authorize_url = url::Url::parse("https://old-popup.example/oauth/authorize").unwrap();
        authorize_url.query_pairs_mut().extend_pairs(query);
        browser_snapshot = json!({"source":std::env::var("SOURCE").unwrap_or_else(|_| "local-test".into()),
            "authorize_url":authorize_url.as_str(),"html":html,"csp":csp,"set_cookie":browser_cookie,
            "callback_url":format!("{callback}?code=synthetic_browser_fixture&state={state_value}"),
            "redirect_status":redirect.status().as_u16(),"password":"fixture-password-not-real",
            "transport":"recorded production HTTP responses; the browser replay does not contact ChatGPT"});''')
    s=once(s,'    shutdown_tx.send(()).unwrap();','''    assert!(!browser_snapshot.is_null());
    let fixture_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent()
        .expect("desktop crate must have a repository parent").join("aiTemp/oauth-popup");
    std::fs::create_dir_all(&fixture_dir).unwrap();
    std::fs::write(fixture_dir.join("browser-fixture.json"), serde_json::to_vec_pretty(&browser_snapshot).unwrap()).unwrap();
    shutdown_tx.send(()).unwrap();''')
    save(p,s)
p=Path(paths[3]);s=p.read_text(encoding='utf-8')
if 'url="2"' not in s:
    s=once(s,'[dependencies]\\naxum=', '[dependencies]\\nurl="2"\\naxum=')
    save(p,s)
for name in paths[:3]:
    subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
subprocess.run(['git','add','--',*paths],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
Path('aiTemp/evidence/preparation.txt').write_text(subprocess.check_output(['git','diff','--cached','--stat'],text=True),encoding='utf-8')
