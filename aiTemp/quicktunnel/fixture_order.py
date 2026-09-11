"""The old socket fixture must accept parallel request order without losing route checks."""
from pathlib import Path
import os,shutil,subprocess
path=Path('src-tauri/src/tunnel/connection.rs');text=path.read_text(encoding='utf-8')
if '_seen_expected_routes' not in text:
    def once(old,new):
        global text
        assert text.count(old)==1,(old[:100],text.count(old))
        text=text.replace(old,new,1)
    once('''            for path in ["/health", "/.well-known/oauth-authorization-server"] {''','''            // _seen_expected_routes: parallel requests may arrive in either order.
            // Still require exactly these two routes, once each, without credentials.
            let mut expected = std::collections::HashSet::from([
                "/health", "/.well-known/oauth-authorization-server"
            ]);
            for _ in 0..2 {''')
    once('''                assert!(headers.starts_with(&format!("get {path} http/1.1\\r\\n")));''','''                let path = headers.lines().next().unwrap().split_whitespace().nth(1).unwrap();
                assert!(headers.starts_with(&format!("get {path} http/1.1\\r\\n")));
                assert!(expected.remove(path), "Unexpected or duplicate discovery route");''')
    # This exact final write/server boundary occurs only in the Actions fixture.
    once('''                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });''','''                socket.write_all(response.as_bytes()).await.unwrap();
            }
            assert!(expected.is_empty());
        });''')
    backup=Path('aiTemp/Trash/quick-fixture')/os.environ['GITHUB_RUN_ID']/path
    backup.parent.mkdir(parents=True,exist_ok=True);assert not backup.exists()
    shutil.copy2(path,backup);path.write_text(text,encoding='utf-8')
    subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',str(path)],check=True)
    subprocess.run(['git','add','--',str(path)],check=True)
print('Actions fixture accepts either request order; exact routes and credential rejection remain enforced')
