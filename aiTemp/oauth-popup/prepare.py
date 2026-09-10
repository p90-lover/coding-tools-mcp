"""Apply the reviewed scoped-origin repair and version wiring; preserve originals."""
from pathlib import Path
import hashlib,os,shutil,subprocess
paths=['src-tauri/src/auth/http_security.rs','src-tauri/src/auth/mod.rs','src-tauri/src/mcp/listener.rs','package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','README.md','README.en.md']
def save(path,text):
    path=Path(path)
    if path.read_text(encoding='utf-8')==text:return
    backup=Path('aiTemp/Trash/oauth-popup-before')/os.environ['GITHUB_RUN_ID']/path
    backup.parent.mkdir(parents=True,exist_ok=True);assert not backup.exists() and not path.is_symlink()
    shutil.copy2(path,backup);path.write_text(text,encoding='utf-8')
def once(text,old,new):
    assert text.count(old)==1,old
    return text.replace(old,new,1)
p=Path(paths[0]);s=p.read_text(encoding='utf-8')
if 'fn allowed_request_origin' not in s:
    raw=p.read_bytes();assert hashlib.sha1(f'blob {len(raw)}\0'.encode()+raw).hexdigest()=='36d19c834195c4f8fdafd3449600e4e2eb76f6ed'
    start=s.index('    fn allowed_origin(&self, origin: &str) -> bool {')
    end=s.index('        [\n',start)
    s=s[:start]+'''    fn allowed_request_origin(&self, origin: &str, method: &axum::http::Method, path: &str) -> bool {
        // Browser OAuth entry is distinct from authorization to call MCP tools.
        // The consent handler still validates client, redirect, PKCE, password,
        // request-bound nonce and cookie. Never trust caller-supplied Host or Forwarded.
        self.allowed_origin(origin)
            || (path == "/oauth/authorize"
                && matches!(method.as_str(), "GET" | "POST")
                && matches!(origin, "https://chatgpt.com" | "https://chat.openai.com" | "https://www.chatgpt.com"))
    }

    fn allowed_origin(&self, origin: &str) -> bool {
'''+s[end:]
    s=once(s,'''    let host = request
        .headers()
        .get("host")
        .and_then(|value| value.to_str().ok());
''','    let path = request.uri().path();\n')
    s=once(s,'security.allowed_origin_for_host(value, host)','security.allowed_request_origin(value, request.method(), path)')
    s=once(s,'    let path = request.uri().path();\n    let permitted =','    let permitted =')
    s=once(s,'''        assert!(guard.allowed_origin("https://chatgpt.com"));
        assert!(guard.allowed_origin_for_host(
            "https://bringing-flower-james-five.trycloudflare.com",
            Some("bringing-flower-james-five.trycloudflare.com"),
        ));''','''        assert!(!guard.allowed_origin("https://chatgpt.com"));
        assert!(guard.allowed_request_origin("https://chatgpt.com", &axum::http::Method::GET, "/oauth/authorize"));
        assert!(!guard.allowed_origin("https://unregistered.trycloudflare.com"));''')
    save(p,s)
for name,module in [('src-tauri/src/auth/mod.rs','origin_policy'),('src-tauri/src/mcp/listener.rs','http_flow')]:
    p=Path(name);s=p.read_text(encoding='utf-8')
    marker=f'mod oauth_popup_{module};'
    if marker not in s:
        save(p,s+f'\n#[cfg(test)]\n#[path = "../../../aiTemp/oauth-popup/{module}.rs"]\n{marker}\n')
for name in paths[3:8]:
    p=Path(name);text=p.read_text(encoding='utf-8')
    assert '0.4.3-rc.2' in text or '0.4.3-rc.3' in text
    save(p,text.replace('0.4.3-rc.2','0.4.3-rc.3'))
for name in paths[8:]:
    p=Path(name);text=p.read_text(encoding='utf-8')
    updated=text.replace('0.4.3-rc.2','0.4.3-rc.3').replace('accurate catalog selection and tool-exposure diagnostics','scoped OAuth popup origin repair').replace('準確目錄選擇與工具公開診斷','限定 OAuth 彈出視窗來源修正')
    save(p,updated)
for name in [paths[0],'aiTemp/oauth-popup/origin_policy.rs','aiTemp/oauth-popup/http_flow.rs']:
    subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
subprocess.run(['git','add','--',*paths,'aiTemp/oauth-popup/origin_policy.rs','aiTemp/oauth-popup/http_flow.rs'],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
Path('aiTemp/evidence').mkdir(parents=True,exist_ok=True)
Path('aiTemp/evidence/preparation.txt').write_text(subprocess.check_output(['git','diff','--cached','--stat'],text=True))
