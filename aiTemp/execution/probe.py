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
tokio-tungstenite={version="=0.28.0",default-features=false,features=["connect","handshake"]}
futures-util="0.3"
axum="0.8"
''')
(out/'src/lib.rs').write_text('#[path="'+(root/'src-tauri/src/integrations/execution/mod.rs').as_posix()+'"]pub mod execution;\n#[cfg(test)]mod contracts {use crate::execution;include!("'+(root/'aiTemp/execution/contracts.rs').as_posix()+'");}\n')
result=subprocess.run(['cargo','test','--manifest-path',str(out/'Cargo.toml'),'execution_','--','--test-threads=1','--nocapture'])
if result.returncode:sys.exit(result.returncode)
# Export real builder output for validation by pinned upstream schemas; no IO.
fixture=next(line for line in (root/'aiTemp/execution/contracts.rs').read_text().splitlines() if line.startswith('fn spec('))
main='use execution_contract_fixture::execution::{model::*,protocol::*};\n'+fixture+'''\nfn main(){let mut samples=Vec::new();for e in [Engine::Paseo,Engine::Anneal]{for a in [Action::Create,Action::Start,Action::Inspect,Action::Events,Action::Hold,Action::Resume,Action::Cancel,Action::Close]{samples.push(build(&spec(e),Some("record-one"),Some("run-one"),a,"request-one").unwrap());}}println!("{}",serde_json::to_string(&samples).unwrap());}\n'''
(out/'src/main.rs').write_text(main)
evidence=root/'aiTemp/evidence';evidence.mkdir(parents=True,exist_ok=True)
with (evidence/'wire-samples.json').open('wb') as stream:
    subprocess.run(['cargo','run','--quiet','--manifest-path',str(out/'Cargo.toml')],stdout=stream,check=True)
print('WIRE_SAMPLES: real request builders exported; no provider or model invoked')
