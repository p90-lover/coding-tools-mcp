"""Apply the reviewed listener wiring, preserving originals; never run an agent."""
from pathlib import Path
import hashlib, os, shutil, subprocess

p=Path('src-tauri/src/mcp/listener.rs')
s=p.read_text(encoding='utf-8')
paths=['src-tauri/src/mcp/listener.rs','src-tauri/src/mcp/transport.rs','aiTemp/connection-tests/http.rs','package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json']
def save(path, text):
    path=Path(path)
    if path.read_text(encoding='utf-8')==text:return
    backup=Path('aiTemp/Trash/connection-before')/os.environ['GITHUB_RUN_ID']/path
    backup.parent.mkdir(parents=True,exist_ok=True)
    assert not backup.exists() and not path.is_symlink()
    shutil.copy2(path,backup)
    path.write_text(text,encoding='utf-8')
if 'mod transport;' not in s:
    raw=p.read_bytes()
    assert hashlib.sha1(f'blob {len(raw)}\0'.encode()+raw).hexdigest()=='a19182754a6a4a6f4b5e4c48c82098d4527eecbb'
    edits=[
      ('pub type ShutdownSender = oneshot::Sender<()>;', '#[path = "transport.rs"]\nmod transport;\n\npub type ShutdownSender = oneshot::Sender<()>;'),
      ('get(mcp_discovery).post(mcp_post)', 'get(transport::get_handler).post(mcp_post)'),
      ('        .route(\n            "/oauth/authorize",', '        .route(\n            "/.well-known/oauth-protected-resource/mcp",\n            get(oauth_protected_resource_metadata),\n        )\n        .route(\n            "/oauth/authorize",'),
      ('    if let Some(response) = require_mcp_auth(&state, request.headers()) {\n        return response;\n    }', '    if let Some(response) = require_mcp_auth(&state, request.headers()) {\n        append_profile_log(&state.workspace_id, "mcp-requests.log", &format!("[transport] authentication_rejected status={}", response.status().as_u16()));\n        return response;\n    }'),
      ('    let method = body\n', '    if let Some(response) = transport::early_response(&body) {\n        append_profile_log(&state.workspace_id, "mcp-requests.log", &format!("[transport] envelope_handled status={}", response.status().as_u16()));\n        return response;\n    }\n    let method = body\n'),
      ('            Json(response).into_response()', '            if method == "tools/list" {\n                if let Some(tools) = response.pointer("/result/tools").and_then(Value::as_array) {\n                    append_profile_log(&profile_id, "mcp-requests.log", &format!("[discovery] catalog_served tools_count={}", tools.len()));\n                }\n            }\n            Json(response).into_response()'),
      ('return verify_oauth_bearer_header(headers, oauth, &server_url);', 'return verify_oauth_bearer_header(headers, oauth, &server_url)\n                .map(|response| transport::oauth_challenge(response, &server_url));'),
    ]
    for old,new in edits:
        assert s.count(old)==1,old
        s=s.replace(old,new,1)
    save(p,s)
for name in paths[3:]:
    text=Path(name).read_text(encoding='utf-8')
    assert '0.4.1-rc.1' in text or '0.4.1-rc.2' in text,name
    save(name,text.replace('0.4.1-rc.1','0.4.1-rc.2'))
for name in paths[:3]:
    subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',name],check=True)
subprocess.run(['git','add','--',*paths],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
