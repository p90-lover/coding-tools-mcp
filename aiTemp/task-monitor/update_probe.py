"""Compile the actual update comparator, not a reimplementation; no desktop/model."""
from pathlib import Path
import subprocess,sys
root=Path.cwd().resolve(); baseline='--baseline' in sys.argv
out=root/'aiTemp'/('update-red' if baseline else 'update-green');(out/'src').mkdir(parents=True,exist_ok=True)
path='src-tauri/src/update/mod.rs'
source=subprocess.check_output(['git','show','2517b2e7fe0ae2038eb3b72caa8761756927feb4:'+path]).decode() if baseline else Path(path).read_text(encoding='utf-8')
body=source[source.index('pub fn normalize_tag('):source.index('pub fn parse_latest_release(')]
(out/'Cargo.toml').write_text('[package]\nname="release-comparison-probe"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nsemver="1"\n')
(out/'src/lib.rs').write_text('use std::cmp::Ordering;\n'+body+'''
#[test]fn task_monitor_release_upgrade_precedence(){
 assert_eq!(compare_versions("0.4.4", "0.4.4-rc.5"),Some(Ordering::Greater),"UPDATER_PRERELEASE_COLLISION");
 assert_eq!(compare_versions("0.4.4-rc.10", "0.4.4-rc.9"),Some(Ordering::Greater));
 assert_eq!(compare_versions("0.4.4+build.2", "v0.4.4+build.1"),Some(Ordering::Equal));
 assert_eq!(compare_versions("0.4.4", "0.3.2"),Some(Ordering::Greater));
 assert_eq!(compare_versions("0.4.4-rc.5", "0.4.4"),Some(Ordering::Less));
 assert!(compare_versions("0.4.4.9", "0.4.4").is_none());
 println!("UPDATE_PRECEDENCE_PASS: old stable, candidate-to-stable, numeric candidate, metadata and malformed versions");
}
''',encoding='utf-8')
sys.exit(subprocess.run(['cargo','test','--manifest-path',str(out/'Cargo.toml'),'task_monitor_release_','--','--nocapture']).returncode)
