//! Shared GUI/MCP execution admission. Provider credentials are RAM-only and
//! supplied by local operator consent, never by MCP task arguments. Background
//! workers survive a dropped HTTP waiter; no failed write is auto-replayed.
use super::{book::{Binding,Entry},model::*,observation,protocol,transport};
use crate::{data::{AppData,DataStore},error::{AppError,AppResult},tools::{ToolContext,registry}};
use serde::Deserialize;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::HashMap,sync::{Arc,Mutex,OnceLock,atomic::{AtomicBool,Ordering}},time::{SystemTime,UNIX_EPOCH}};
use tokio::sync::Semaphore;
fn fail(s:impl Into<String>)->AppError{AppError::Message(s.into())}
fn now()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64}
fn runtime()->&'static str{static ID:OnceLock<String>=OnceLock::new();ID.get_or_init(||uuid::Uuid::new_v4().to_string())}
fn stamp(ctx:&ToolContext)->String{format!("{:x}",Sha256::digest(format!("{:?}|{}",ctx.policy,ctx.tool_profile).as_bytes()))}
pub fn scope(ctx:&ToolContext,data:&AppData)->AppResult<String>{
 if !matches!(ctx.auth.auth_type.as_str(),"bearer"|"oauth"|"api_key"){return Err(fail("Authenticated workspace access required"))}
 let id=ctx.workspace_id.as_deref().ok_or_else(||fail("Workspace-bound listener required"))?;
 let p=data.profiles.iter().find(|p|p.id==id).ok_or_else(||fail("Workspace no longer exists"))?;
 if std::path::Path::new(&p.path).canonicalize()?!=ctx.workspace.root(){return Err(fail("Workspace changed; execution denied"))}
 ctx.workspace.ensure_roots_current().map_err(|e|fail(e.message()))?;Ok(id.into())
}
fn permit(ctx:&ToolContext,b:&Binding,write:bool)->AppResult<()> {
 if !b.enabled||ctx.workspace_id.as_deref()!=Some(&b.workspace_id)||std::path::Path::new(&b.root).canonicalize()?!=ctx.workspace.root()||b.roots_revision!=ctx.workspace.roots_revision(){return Err(fail("Provider grant does not match current approved workspace roots"))}
 if write&&(ctx.permission_mode=="read-only"||!registry::exposed_tool_names(&ctx.tool_profile).contains(&"workflow_update")||b.policy_stamp!=stamp(ctx)){
  return Err(fail("Execution policy changed or is read-only; locally reconnect this provider under current settings"));
 }
 Ok(())
}
#[derive(Clone)]struct Connection{credential:Arc<String>,enabled:Arc<AtomicBool>}
fn vault()->&'static Mutex<HashMap<String,Connection>>{static V:OnceLock<Mutex<HashMap<String,Connection>>>=OnceLock::new();V.get_or_init(Default::default)}
fn key(b:&Binding)->String{format!("{}:{}",b.id,b.generation)}
fn connection(b:&Binding)->AppResult<Connection>{vault().lock().map_err(|_|fail("Provider credential store unavailable"))?.get(&key(b)).filter(|c|c.enabled.load(Ordering::SeqCst)).cloned().ok_or_else(||fail("Provider disconnected. Reconnect locally; stored missions are preserved"))}
fn invalidate(id:&str){if let Ok(mut v)=vault().lock(){for (k,c) in v.iter(){if k.starts_with(&format!("{id}:")){c.enabled.store(false,Ordering::SeqCst);}}v.retain(|k,_|!k.starts_with(&format!("{id}:")));}}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
 pub id:Option<String>,pub engine:Engine,pub endpoint:String,pub provider:String,pub model:String,pub mode:String,
 pub project_id:Option<String>,pub repo_id:Option<String>,pub assignee_id:Option<String>,
 pub max_duration_min:u32,pub allow_codex:bool,pub confirm_external_execution:bool,
}
/// Call ONLY from a focused, visible main-window command. Changing the binding
/// invalidates old credential sessions; this function never starts a daemon.
pub fn configure(ctx:&ToolContext,expected:u64,s:Settings,credential:String)->AppResult<Value>{
 if !s.confirm_external_execution{return Err(fail("Explicit local acknowledgement of provider execution and costs is required"))}
 if ctx.permission_mode=="read-only"{return Err(fail("Read-only workspace cannot enable external execution"))}
 if credential.len()>4096||credential.chars().any(char::is_control){return Err(fail("Invalid provider credential"))}
 let _guard=ctx.policy_execution_guard().map_err(|e|fail(e.message()))?;
 let binding=DataStore::update_file(|data|{
  let workspace=scope(ctx,data)?;
  let b=Binding{id:s.id.unwrap_or_else(||uuid::Uuid::new_v4().to_string()),workspace_id:workspace,root:ctx.workspace.root_display(),roots_revision:ctx.workspace.roots_revision(),policy_stamp:stamp(ctx),generation:uuid::Uuid::new_v4().to_string(),engine:s.engine,endpoint:protocol::endpoint(s.engine,&s.endpoint).map_err(fail)?.to_string(),provider:s.provider,model:s.model,mode:s.mode,project_id:s.project_id,repo_id:s.repo_id,assignee_id:s.assignee_id,max_duration_min:s.max_duration_min,allow_codex:s.allow_codex,enabled:true};
  data.execution_book.configure(b.clone(),expected).map_err(fail)?;Ok(b)
 })?;
 invalidate(&binding.id);
 vault().lock().map_err(|_|fail("Credential store unavailable; no work was started"))?.insert(key(&binding),Connection{credential:Arc::new(credential),enabled:Arc::new(AtomicBool::new(true))});
 view(ctx,None)
}
pub fn reconnect(ctx:&ToolContext,id:&str,credential:String,confirmed:bool)->AppResult<Value>{
 if !confirmed||credential.len()>4096||credential.chars().any(char::is_control){return Err(fail("Confirm the existing provider connection locally with a valid credential"))}
 let _guard=ctx.policy_execution_guard().map_err(|e|fail(e.message()))?;
 let binding=DataStore::update_file(|data|{
  let workspace=scope(ctx,data)?;
  let b=data.execution_book.bindings.iter().find(|b|b.id==id&&b.workspace_id==workspace).cloned().ok_or_else(||fail("Binding not found"))?;
  let mut candidate=b.clone();candidate.enabled=true;candidate.policy_stamp=stamp(ctx);permit(ctx,&candidate,true)?;
  let updated=data.execution_book.bindings.iter_mut().find(|b|b.id==id).unwrap();updated.enabled=true;updated.policy_stamp=candidate.policy_stamp.clone();
  data.execution_book.revision=data.execution_book.revision.checked_add(1).ok_or_else(||fail("Revision exhausted"))?;
  Ok(candidate)
 })?;
 invalidate(id);vault().lock().map_err(|_|fail("Credential store unavailable"))?.insert(key(&binding),Connection{credential:Arc::new(credential),enabled:Arc::new(AtomicBool::new(true))});
 view(ctx,None)
}
pub fn disable(ctx:&ToolContext,id:&str)->AppResult<Value>{
 DataStore::update_file(|data|{let workspace=scope(ctx,data)?;data.execution_book.disable(&workspace,id).map_err(fail)})?;
 invalidate(id);view(ctx,None)
}
pub fn view(ctx:&ToolContext,mission:Option<&str>)->AppResult<Value>{
 let mut result=DataStore::update_file(|data|{
  let id=scope(ctx,data)?;data.execution_book.recover(&id,runtime(),now()).map_err(fail)?;
  data.execution_book.view(&id,mission).map_err(fail)
 })?;
 if let Some(rows)=result["bindings"].as_array_mut(){for row in rows{let b:Binding=serde_json::from_value(row.clone()).map_err(|_|fail("Invalid stored binding"))?;row["connected"]=json!(connection(&b).is_ok());row["current_scope_valid"]=json!(permit(ctx,&b,false).is_ok());}}
 result["runtime_id"]=json!(runtime());Ok(result)
}
#[derive(Deserialize)]
#[serde(tag="operation",rename_all="snake_case",deny_unknown_fields)]
pub enum Change {
 AgentPrepare{binding_id:String,task_id:String,mission_id:String},
 AgentControl{mission_id:String,request_key:String,action:Action},
 AgentReview{mission_id:String,note:String,evidence:Vec<String>,accepted:bool},
}
pub fn change(ctx:&ToolContext,expected:u64,change:Change)->AppResult<Value>{
 match change {
  Change::AgentPrepare{binding_id,task_id,mission_id}=>{
   DataStore::update_file(|data|{
    let workspace=scope(ctx,data)?;
    if data.control_board.revision!=expected{return Err(fail("Board changed before mission preparation"))}
    let task=data.control_board.tasks.iter().find(|t|t.id==task_id&&t.workspace_id==workspace&&t.state!="archived").ok_or_else(||fail("Select an existing task in this workspace"))?;
    let b=data.execution_book.binding(&workspace,&binding_id).map_err(fail)?;permit(ctx,b,true)?;connection(b)?;
    data.execution_book.prepare(&workspace,&binding_id,&task_id,&mission_id,&task.title,&task.description,now()).map_err(fail)
   })?;view(ctx,Some(&mission_id))
  },
  Change::AgentControl{mission_id,request_key,action}=>{
   if !action.writes(){return refresh(ctx,&mission_id);}
   submit(ctx,&mission_id,expected,&request_key,action)?;view(ctx,Some(&mission_id))
  },
  Change::AgentReview{mission_id,note,evidence,accepted}=>{
   DataStore::update_file(|data|{
    let workspace=scope(ctx,data)?;let b=data.execution_book.find(&workspace,&mission_id).map_err(fail)?;
    let binding=data.execution_book.binding(&workspace,&b.binding_id).map_err(fail)?;permit(ctx,binding,true)?;
    if b.mission.revision!=expected||b.observed_at.is_none_or(|t|now().saturating_sub(t)>30000){return Err(fail("Refresh source evidence before reviewing this revision"))}
    data.execution_book.find_mut(&workspace,&mission_id).map_err(fail)?.mission.review("chatgpt-or-local-coordinator",&note,&evidence,accepted).map_err(fail)?;
    data.execution_book.size_check().map_err(fail)
   })?;view(ctx,Some(&mission_id))
  }
 }
}
struct Job{ctx:ToolContext,workspace:String,entry:Entry,binding:Binding,connection:Connection,key:String,action:Action,_slot:tokio::sync::OwnedSemaphorePermit}
fn slots(read:bool)->AppResult<tokio::sync::OwnedSemaphorePermit>{
 static WRITES:OnceLock<Arc<Semaphore>>=OnceLock::new();static READS:OnceLock<Arc<Semaphore>>=OnceLock::new();
 let slots=if read{&READS}else{&WRITES};slots.get_or_init(||Arc::new(Semaphore::new(2))).clone().try_acquire_owned().map_err(|_|fail("Execution control capacity is busy; no new operation was submitted"))
}
fn spawn(job:Job)->AppResult<()> {
 let workspace=job.workspace.clone();let id=job.entry.mission.spec.mission_id.clone();let key=job.key.clone();let write=job.action.writes();
 #[cfg(test)]let test_file=crate::data::current_test_file();
 let started=std::thread::Builder::new().name("mcp-provider-control".into()).spawn(move||{
  let execute=||{
   let run=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{
    tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_|fail("Provider transport runtime unavailable"))?.block_on(process(&job))
   }));
   let error=match run{Ok(Ok(()))=>None,Ok(Err(e))=>Some(e.to_string()),Err(_)=>Some("Provider control worker interrupted; outcome unknown".into())};
   if let Some(error)=error {let _=DataStore::update_file(|data|{
    if write {data.execution_book.uncertain(&job.workspace,&job.entry.mission.spec.mission_id,&job.key,&error.chars().take(240).collect::<String>(),now()).map_err(fail)?;}
    else if let Ok(row)=data.execution_book.find_mut(&job.workspace,&job.entry.mission.spec.mission_id){if row.mission.revision==job.entry.mission.revision{row.last_error=Some(error.chars().take(240).collect());}}
    Ok(())
   });}
  };
  #[cfg(test)]if let Some(path)=test_file{crate::data::with_test_file(path,execute);return;}
  execute();
 });
 if started.is_err(){
  if write {DataStore::update_file(|d|d.execution_book.acknowledge(&workspace,&id,&key,Reply::Rejected,now()).map_err(fail))?;}
  return Err(fail("Could not start provider transport; no source request was sent"));
 }
 Ok(())
}
fn submit(ctx:&ToolContext,id:&str,expected:u64,key:&str,action:Action)->AppResult<()> {
 let slot=slots(false)?;
 let work=DataStore::update_file(|data|{
  let workspace=scope(ctx,data)?;data.execution_book.recover(&workspace,runtime(),now()).map_err(fail)?;
  let entry=data.execution_book.find(&workspace,id).map_err(fail)?.clone();
  if entry.mission.receipts.contains_key(key){data.execution_book.reserve(&workspace,id,expected,key,runtime(),action).map_err(fail)?;return Ok(None);}
  let b=data.execution_book.binding(&workspace,&entry.binding_id).map_err(fail)?.clone();permit(ctx,&b,true)?;let connection=connection(&b)?;
  data.execution_book.reserve(&workspace,id,expected,key,runtime(),action).map_err(fail)?;
  let entry=data.execution_book.find(&workspace,id).map_err(fail)?.clone();
  Ok(Some(Job{ctx:ctx.clone(),workspace,entry,binding:b,connection,key:key.into(),action,_slot:slot}))
 })?;
 if let Some(job)=work{spawn(job)?;}Ok(())
}
pub fn refresh(ctx:&ToolContext,id:&str)->AppResult<Value>{
 let slot=slots(true)?;
 let job=DataStore::update_file(|data|{
  let workspace=scope(ctx,data)?;data.execution_book.recover(&workspace,runtime(),now()).map_err(fail)?;
  let entry=data.execution_book.find(&workspace,id).map_err(fail)?.clone();
  if entry.mission.record_id.is_none(){return Err(fail("No confirmed source ID yet; do not repeat an uncertain Create"))}
  if entry.mission.pending.as_ref().and_then(|k|entry.mission.receipts.get(k)).is_some_and(|r|r.state==ReceiptState::Reserved){return Err(fail("Source request is still pending; inspect its receipt before refreshing"))}
  let b=data.execution_book.binding(&workspace,&entry.binding_id).map_err(fail)?.clone();permit(ctx,&b,false)?;
  let connected=connection(&b)?;
  Ok(Job{ctx:ctx.clone(),workspace,entry,binding:b,connection:connected,key:uuid::Uuid::new_v4().to_string(),action:Action::Inspect,_slot:slot})
 })?;
 spawn(job)?;let mut result=view(ctx,Some(id))?;result["refresh_requested"]=json!(true);Ok(result)
}
async fn inspect_source(job:&Job)->AppResult<observation::Evidence>{
 let spec=&job.entry.mission.spec;
 let request=protocol::build(spec,job.entry.mission.record_id.as_deref(),job.entry.mission.run_id.as_deref(),Action::Inspect,&uuid::Uuid::new_v4().to_string()).map_err(fail)?;
 let response=transport::send(spec.engine,&job.binding.endpoint,&job.connection.credential,&request).await.map_err(|e|fail(e.to_string()))?;
 observation::inspect(spec,spec_record(&job.entry)?,&response.body).map_err(fail)
}
fn spec_record(e:&Entry)->AppResult<&str>{e.mission.record_id.as_deref().ok_or_else(||fail("No confirmed provider record"))}
async fn process(job:&Job)->AppResult<()> {
 let current=job.ctx.for_request().map_err(|e|fail(e.message()))?;
 permit(&current,&job.binding,job.action.writes())?;
 if !job.connection.enabled.load(Ordering::SeqCst){return Err(fail("Provider disconnected before source submission"))}
 DataStore::read_file(|d|{scope(&current,d)?;let b=d.execution_book.binding(&job.workspace,&job.binding.id).map_err(fail)?;if b.generation!=job.binding.generation{return Err(fail("Provider grant changed before submission"))}Ok(())})?;
 if job.action==Action::Inspect {
  let evidence=inspect_source(job).await?;
  DataStore::update_file(|d|{
   scope(&current,d)?;let row=d.execution_book.find_mut(&job.workspace,&job.entry.mission.spec.mission_id).map_err(fail)?;
   if row.mission.revision!=job.entry.mission.revision{return Err(fail("Newer mission state supersedes this observation"))}
   observation::apply(row,evidence,now()).map_err(fail)?;d.execution_book.size_check().map_err(fail)
  })?;return Ok(());
 }
 if job.action!=Action::Create {
  let evidence=inspect_source(job).await?;
  if matches!(job.action,Action::Start|Action::Resume|Action::Close)&&!evidence.observation.quiescent{return Err(fail("Source still has active work or pending permissions; no new command was sent"))}
  if job.action==Action::Cancel&&job.binding.engine==Engine::Anneal&&evidence.observation.run_id!=job.entry.mission.run_id{return Err(fail("Owned Anneal run changed; refresh before cancellation"))}
 }
 let spec=&job.entry.mission.spec;
 let request=protocol::build(spec,job.entry.mission.record_id.as_deref(),job.entry.mission.run_id.as_deref(),job.action,&job.key).map_err(fail)?;
 // The short policy fence ends at admission. External side effects already
 // transmitted cannot be undone by a later local setting change.
 {let latest=job.ctx.for_request().map_err(|e|fail(e.message()))?;let _guard=latest.policy_execution_guard().map_err(|e|fail(e.message()))?;permit(&latest,&job.binding,true)?;if !job.connection.enabled.load(Ordering::SeqCst){return Err(fail("Local provider access revoked before send"))}}
 let response=transport::send(spec.engine,&job.binding.endpoint,&job.connection.credential,&request).await.map_err(|e|fail(e.to_string()))?;
 let reply=match job.action {
  Action::Create=>Reply::Created{record_id:response.body[if spec.engine==Engine::Paseo{"agentId"}else{"id"}].as_str().ok_or_else(||fail("Missing created record ID"))?.into()},
  Action::Start=>Reply::Started{run_id:response.body["runId"].as_str().map(str::to_owned)},
  Action::Resume if spec.engine==Engine::Paseo=>Reply::Started{run_id:None},
  // A chain resume is not proof of a started worker. Preserve an unknown
  // state and require fresh source evidence rather than inventing Running.
  Action::Resume=>{return DataStore::update_file(|d|d.execution_book.uncertain(&job.workspace,&spec.mission_id,&job.key,"Anneal scheduling resume acknowledged; inspect actual run state",now()).map_err(fail));},
  Action::Hold|Action::Cancel=>Reply::HoldAcknowledged{worker_stopped:false},
  Action::Close=>Reply::Closed,
  _=>return Err(fail("Unsupported background operation")),
 };
 DataStore::update_file(|data|data.execution_book.acknowledge(&job.workspace,&spec.mission_id,&job.key,reply,now()).map_err(fail))?;
 Ok(())
}
