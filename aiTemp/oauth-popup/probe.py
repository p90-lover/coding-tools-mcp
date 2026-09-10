"""Compile the real guard with a fixed trusted-origin dependency, not a mock guard."""
from pathlib import Path
import shutil, subprocess, sys
label=sys.argv[1]
assert label in ('released','main','fixed')
root=Path('aiTemp/oauth-popup')/('probe-'+label);root.mkdir(parents=True,exist_ok=False)
(root/'auth').mkdir()
ref={'released':'ac6a7b21df3391277f6687a2a5a6aef0314663b7','main':'07faa97255e6b60d909f956fa2cebd3b829bbf97'}.get(label)
content=subprocess.check_output(['git','show',ref+':src-tauri/src/auth/http_security.rs']) if ref else Path('src-tauri/src/auth/http_security.rs').read_bytes()
(root/'auth/http_security.rs').write_bytes(content)
(root/'lib.rs').write_text('pub mod auth {pub mod http_security; pub fn trusted_external_base_url(_id:&str,_actions:bool,_port:u16,configured:&str)->String{configured.into()}}\n#[cfg(test)] #[path="../origin_policy.rs"] mod regression;\n')
(root/'Cargo.toml').write_text('[package]\nname="oauth-origin-'+label+'"\nversion="0.1.0"\nedition="2021"\n[workspace]\n[lib]\npath="lib.rs"\n[dependencies]\naxum={version="0.8",features=["form"]}\ntokio={version="1",features=["rt-multi-thread","macros","sync","time"]}\ntower={version="0.5",features=["util"]}\n')
