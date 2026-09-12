"""Focused tests against the real Harness writer and monitor without Tauri."""
from pathlib import Path
import subprocess,sys
root=Path.cwd().resolve();out=root/'aiTemp/task-monitor-probe';(out/'src').mkdir(parents=True,exist_ok=True)
(out/'Cargo.toml').write_text('[package]\nname="task-monitor-history-probe"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nserde={version="1",features=["derive"]}\nserde_json="1"\nthiserror="2"\nuuid={version="1",features=["v4"]}\nsha2="0.10"\nwalkdir="2"\ndirs="6"\ntempfile="3"\n')
code='pub mod harness {\n'
for name in ['model','store','bounded_scan','state','monitor']:
    code+='#[path="'+(root/f'src-tauri/src/harness/{name}.rs').as_posix()+'"]pub mod '+name+';\n'
code+='pub use state::Harness;}\ninclude!("'+(root/'aiTemp/task-monitor/monitor_contract.rs').as_posix()+'");\n'
(out/'src/lib.rs').write_text(code)
sys.exit(subprocess.run(['cargo','test','--manifest-path',str(out/'Cargo.toml'),'task_monitor_history_','--','--test-threads=1','--nocapture']).returncode)
