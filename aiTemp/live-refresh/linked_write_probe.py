"""Focused Windows path/patch integration; real production methods and mapping loader.
Only the surrounding ToolContext/AppError types are reduced for compilation; no
policy/auth conclusion is drawn here. The full listener test remains a release gate.
"""
from pathlib import Path
import os,subprocess,sys
root=Path.cwd().resolve();baseline='--baseline' in sys.argv
out=root/'aiTemp'/('linked-write-red' if baseline else 'linked-write-green')
(out/'src').mkdir(parents=True,exist_ok=True)
ref='d8960481cc63c532f8e531d94d4c64e5f47a7534'
(out/'Cargo.toml').write_text('[package]\nname="linked-write-fixture"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nserde={version="1",features=["derive"]}\nserde_json="1"\nthiserror="2"\nsha2="0.10"\nuuid={version="1",features=["v4"]}\n')
files={'mapping':'src-tauri/src/workspace/linked_projects.rs','workspace':'src-tauri/src/tools/workspace.rs','patch':'src-tauri/src/tools/patch.rs'}
for name,path in files.items():
 text=subprocess.check_output(['git','show',ref+':'+path]).decode() if baseline else (root/path).read_text(encoding='utf-8')
 # Select only the focused test; existing app test modules are not this harness.
 text=text.replace('#[cfg(test)]','#[cfg(any())]')
 (out/(name+'.rs')).write_text(text)
code='''pub mod error {#[derive(Debug,thiserror::Error)] pub enum AppError {#[error("{0}")] Message(String)} pub type AppResult<T>=Result<T,AppError>;}
pub mod workspace {
'''+f'#[path="{(out/"mapping.rs").as_posix()}"]pub mod linked_projects;\n'+'''}
pub mod tools {
'''+f'#[path="{(out/"workspace.rs").as_posix()}"]pub mod workspace;\n'+'''pub mod context {pub struct ToolContext {pub workspace:super::workspace::Workspace}}
'''+f'#[path="{(out/"patch.rs").as_posix()}"]pub mod patch;\n'+r'''}
#[test]
fn linked_write_contract_canonical_targets_and_boundaries(){
 use std::{fs,path::Path};use serde_json::json;
 use tools::{workspace::Workspace,context::ToolContext,patch::apply_patch};
 let base=std::env::current_dir().unwrap().join("aiTemp/linked-write-fixture").join(uuid::Uuid::new_v4().to_string());
 let primary=base.join("primary");let linked=base.join("second");let outside=base.join("second-not-approved");let readonly=base.join("readonly");
 for path in [&primary,&linked,&outside,&readonly]{fs::create_dir_all(path).unwrap();}
 let old=Workspace::new(primary.clone()).unwrap().request_snapshot();
 let mapping=workspace::linked_projects::quick_add_linked_project_for_root(&primary,&linked,Some("second")).unwrap();
 let ws=Workspace::new(primary.clone()).unwrap().request_snapshot();
 let resolved=ws.resolve_for_write("@second/fresh.txt").unwrap();
 let canonical=linked.canonicalize().unwrap();
 println!("LINKED_PATH_DIAGNOSTIC {}",json!({"stored_root":mapping.path,"canonical_root":canonical,"new_target":resolved.path,"target_canonical_prefix":resolved.path.starts_with(&canonical)}));
 let ctx=ToolContext{workspace:ws};
 let first=apply_patch(&ctx,&json!({"patch":"*** Begin Patch\n*** Add File: @second/fresh.txt\n+fresh\n*** End Patch\n"}));
 assert!(first.is_ok(),"LINKED_WRITE_PATH_REPRESENTATION_MISMATCH {first:?}");
 assert!(resolved.path.starts_with(&canonical));
 assert_eq!(fs::read_to_string(linked.join("fresh.txt")).unwrap(),"fresh\n");
 let nested=apply_patch(&ctx,&json!({"patch":"*** Begin Patch\n*** Add File: @second/nested path/child.txt\n+nested\n*** End Patch\n"})).unwrap();
 assert_eq!(nested["ok"],true);
 assert_eq!(fs::read_to_string(linked.join("nested path/child.txt")).unwrap(),"nested\n");
 let updated=apply_patch(&ctx,&json!({"patch":"*** Begin Patch\n*** Update File: @second/fresh.txt\n@@\n-fresh\n+updated\n*** End Patch\n"})).unwrap();
 assert_eq!(updated["ok"],true);
 assert_eq!(fs::read_to_string(linked.join("fresh.txt")).unwrap(),"updated\n");
 let abs=linked.join("absolute.txt");
 let patch=format!("*** Begin Patch\n*** Add File: {}\n+absolute\n*** End Patch\n",abs.to_string_lossy());
 assert_eq!(apply_patch(&ctx,&json!({"patch":patch})).unwrap()["ok"],true);
 assert!(old.resolve_for_write("@second/old-request.txt").is_err());
 for target in ["@second/../second-not-approved/blocked.txt","@second/.git/config","@second/.github/workflows/work.yml"]{
  assert!(ctx.workspace.resolve_for_write(target).is_err(),"Unsafe target accepted: {target}");
 }
 assert!(ctx.workspace.resolve_for_write(outside.join("blocked.txt").to_str().unwrap()).is_err());
 let mapping_file=primary.join(".mcp-paths/readonly.txt");
 fs::write(&mapping_file,format!("path={}\nmode=read-only\n",readonly.display())).unwrap();
 let ro=Workspace::new(primary.clone()).unwrap().request_snapshot();
 assert!(ro.resolve_for_write("@readonly/blocked.txt").is_err());
 assert!(!outside.join("blocked.txt").exists()&&!readonly.join("blocked.txt").exists());
 // A symlink to an unapproved root must remain blocked, with no deletions.
 #[cfg(windows)]std::os::windows::fs::symlink_dir(&outside,linked.join("escape")).unwrap();
 #[cfg(unix)]std::os::unix::fs::symlink(&outside,linked.join("escape")).unwrap();
 assert!(ro.resolve_for_write("@second/escape/blocked.txt").is_err());
 assert!(!outside.join("blocked.txt").exists());
 assert!(linked.join(Path::new("aiTemp").join("Trash")).is_dir(),"Replaced original remains in Trash");
 println!("LINKED_WRITE_PASS: new/nested/existing/approved-absolute writes succeed; stale roots, outside, read-only and symlink escape denied; originals retained");
}
'''
(out/'src/lib.rs').write_text(code)
result=subprocess.run(['cargo','test','--manifest-path',str(out/'Cargo.toml'),'linked_write_contract_','--','--test-threads=1','--nocapture'])
sys.exit(result.returncode)
