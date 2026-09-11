//! Cooperative scan budgets; errors never become trusted partial baselines.
use super::{model::{BaselineEntry,ProjectBaseline},store::{HarnessError,HarnessResult}};
use sha2::{Digest,Sha256};
use std::{collections::HashSet,fs::File,io::Read,path::{Path,PathBuf},process::{Command,Stdio},sync::{Mutex,OnceLock},time::{Duration,Instant,SystemTime,UNIX_EPOCH}};
use walkdir::WalkDir;
const FILE_BYTES:u64=32*1024*1024;
const TOTAL_BYTES:u64=128*1024*1024;
const MAX_ENTRIES:usize=20_000;
const DEADLINE:Duration=Duration::from_secs(8);
static ACTIVE:OnceLock<Mutex<HashSet<PathBuf>>>=OnceLock::new();
struct Lease(PathBuf);
impl Drop for Lease {fn drop(&mut self){if let Ok(mut active)=ACTIVE.get_or_init(Default::default).lock(){active.remove(&self.0);}}}
fn failure(code:&'static str,detail:&str)->HarnessError{HarnessError::new(code,format!("{detail}; baseline not accepted. Inspect the selected project scope; do not repeatedly retry an unchanged failing scan."))}
fn skipped(path:&Path,root:&Path)->bool{
 path.strip_prefix(root).ok().is_some_and(|r|r.components().any(|p|matches!(p.as_os_str().to_str(),Some(".git"|".mcp-probe-kit"|"node_modules"|"target"|"dist"|"build"|".svelte-kit"))))
}
fn check(start:Instant)->HarnessResult<()>{if start.elapsed()>=DEADLINE{Err(failure("BASELINE_SCAN_LIMIT","Eight-second cooperative scan deadline reached"))}else{Ok(())}}
pub fn capture(root:&Path)->HarnessResult<ProjectBaseline>{
 let mut active=ACTIVE.get_or_init(Default::default).lock().map_err(|_|failure("BASELINE_SCAN_BUSY","Scan admission unavailable"))?;
 if !active.insert(root.to_path_buf()){return Err(failure("BASELINE_SCAN_BUSY","This workspace already has a baseline scan in progress"));}
 drop(active);let _lease=Lease(root.to_path_buf());let started=Instant::now();
 let mut total=0u64;let mut visited=0usize;let mut entries=Vec::new();let mut buffer=[0u8;65536];
 let iter=WalkDir::new(root).follow_links(false).into_iter().filter_entry(|item|item.path()==root||!skipped(item.path(),root));
 for item in iter{
  check(started)?;visited+=1;if visited>MAX_ENTRIES{return Err(failure("BASELINE_SCAN_LIMIT","Directory-entry limit reached"));}
  let item=item.map_err(|_|failure("BASELINE_SCAN_INCOMPLETE","Directory enumeration failed"))?;
  if item.path()==root||!item.file_type().is_file(){continue;}
  let path=item.path();let before=path.symlink_metadata().map_err(|_|failure("BASELINE_SCAN_INCOMPLETE","File metadata changed"))?;
  if before.file_type().is_symlink()||!before.is_file(){return Err(failure("BASELINE_SCAN_INCOMPLETE","Input type changed during scan"));}
  if before.len()>FILE_BYTES||before.len()>TOTAL_BYTES.saturating_sub(total){return Err(failure("BASELINE_SCAN_LIMIT","32 MiB file or 128 MiB aggregate input limit reached"));}
  let canonical=path.canonicalize().map_err(|_|failure("BASELINE_SCAN_INCOMPLETE","Input disappeared"))?;
  if !canonical.starts_with(root){return Err(failure("BASELINE_SCAN_INCOMPLETE","Input escaped workspace"));}
  let mut input=File::open(&canonical).map_err(|_|failure("BASELINE_SCAN_INCOMPLETE","Input could not be opened"))?;
  let mut hasher=Sha256::new();let mut length=0u64;let mut binary=false;
  loop{
   check(started)?;
   let n=input.read(&mut buffer).map_err(|_|failure("BASELINE_SCAN_INCOMPLETE","Input read failed"))?;
   if n==0{break;}length+=n as u64;total+=n as u64;
   if length>FILE_BYTES||total>TOTAL_BYTES{return Err(failure("BASELINE_SCAN_LIMIT","Input grew past scan budget"));}
   binary|=buffer[..n].contains(&0);hasher.update(&buffer[..n]);
  }
  let after=input.metadata().map_err(|_|failure("BASELINE_SCAN_INCOMPLETE","Input metadata unavailable after read"))?;
  if before.len()!=length||after.len()!=length||before.modified().ok()!=after.modified().ok(){return Err(failure("BASELINE_SCAN_INCOMPLETE","Input changed during hashing"));}
  entries.push(BaselineEntry{path:path.strip_prefix(root).unwrap().to_string_lossy().replace('\\',"/"),exists:true,is_binary:binary,sha256:format!("{:x}",hasher.finalize()),bytes:length});
 }
 entries.sort_by(|a,b|a.path.cmp(&b.path));let mut fingerprint=Sha256::new();
 for entry in &entries{fingerprint.update(entry.path.as_bytes());fingerprint.update(entry.sha256.as_bytes());fingerprint.update(entry.bytes.to_le_bytes());}
 check(started)?;
 let branch=git_value(root,&["rev-parse","--abbrev-ref","HEAD"],started)?;
 let head=git_value(root,&["rev-parse","HEAD"],started)?;
 Ok(ProjectBaseline{branch,head,worktree_fingerprint:format!("{:x}",fingerprint.finalize()),entries,captured_at:SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().to_string()})
}
fn git_value(root:&Path,args:&[&str],started:Instant)->HarnessResult<Option<String>>{
 check(started)?;let mut cmd=Command::new("git");cmd.arg("-C").arg(root).args(args).env("GIT_TERMINAL_PROMPT","0").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
 #[cfg(windows)]{use std::os::windows::process::CommandExt;cmd.creation_flags(0x08000000|0x00000200);}
 let mut child=match cmd.spawn(){Ok(c)=>c,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err(failure("BASELINE_SCAN_INCOMPLETE","Git could not start"))};
 let git_started=Instant::now();
 loop{
  match child.try_wait(){
   Ok(Some(status))=>{
    if !status.success(){return Ok(None);}
    let mut bytes=Vec::new();child.stdout.take().unwrap().take(4097).read_to_end(&mut bytes).map_err(|_|failure("BASELINE_SCAN_INCOMPLETE","Git output unreadable"))?;
    if bytes.len()>4096{return Err(failure("BASELINE_SCAN_INCOMPLETE","Git metadata exceeded 4 KiB"));}
    return Ok(String::from_utf8(bytes).ok().map(|v|v.trim().to_string()).filter(|v|!v.is_empty()));
   }
   Ok(None) if git_started.elapsed()<Duration::from_secs(1)&&started.elapsed()<DEADLINE=>std::thread::sleep(Duration::from_millis(10)),
   _=>{let _=child.kill();let _=child.wait();return Err(failure("BASELINE_SCAN_LIMIT","Git metadata deadline reached"));}
  }
 }
}
