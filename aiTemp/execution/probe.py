from pathlib import Path
import subprocess,sys
root=Path.cwd().resolve();out=root/'aiTemp/execution-probe';(out/'src').mkdir(parents=True,exist_ok=True)
(out/'Cargo.toml').write_text('''[package]
name="execution-contract-fixture"
version="0.0.0"
edition="2021"
[dependencies]
serde={version="1",features=["derive"]}
serde_json="1"
url="2"
tokio={version="1",features=["rt-multi-thread","macros","net","time","sync"]}
reqwest={version="0.12",default-features=false,features=["json","rustls-tls"]}
tokio-tungstenite={version="0.26",features=["rustls-tls-webpki-roots"]}
futures-util="0.3"
axum="0.8"
''')
(out/'src/lib.rs').write_text('#[path="'+(root/'src-tauri/src/integrations/execution/mod.rs').as_posix()+'"]pub mod execution;\n#[cfg(test)]mod contracts {include!("'+(root/'aiTemp/execution/contracts.rs').as_posix()+'");}\n')
sys.exit(subprocess.run(['cargo','test','--manifest-path',str(out/'Cargo.toml'),'execution_','--','--test-threads=1','--nocapture']).returncode)
