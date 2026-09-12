//! Bounded durable metadata embedded in AppData. Credentials never enter this
//! structure. The service must persist a successful reservation before IO.
use super::{model::*,protocol::endpoint};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
 pub id:String,pub workspace_id:String,pub root:String,pub roots_revision:String,
 pub policy_stamp:String,pub generation:String,pub engine:Engine,pub endpoint:String,
 pub provider:String,pub model:String,pub mode:String,
 pub project_id:Option<String>,pub repo_id:Option<String>,pub assignee_id:Option<String>,
 pub max_duration_min:u32,pub allow_codex:bool,pub enabled:bool,
}
impl Binding {
 pub fn validate(&self)->Result<(),String>{
  for id in [&self.id,&self.workspace_id,&self.generation]{identifier(id)?;}
  endpoint(self.engine,&self.endpoint)?;
  if self.provider.eq_ignore_ascii_case("codex")&&!self.allow_codex{return Err("Codex model execution needs its own explicit local quota consent; native computer tools do not".into())}
  for v in [&self.roots_revision,&self.policy_stamp]{if v.is_empty()||v.len()>256{return Err("Invalid scope revision".into())}}
  self.spec("binding-validation","binding-validation","Binding validation","No task submission").validate()
 }
 pub fn spec(&self,mission:&str,task:&str,title:&str,brief:&str)->Spec{
  Spec{engine:self.engine,mission_id:mission.into(),workspace_id:self.workspace_id.clone(),task_id:task.into(),cwd:self.root.clone(),provider:self.provider.clone(),model:self.model.clone(),mode:self.mode.clone(),project_id:self.project_id.clone(),repo_id:self.repo_id.clone(),assignee_id:self.assignee_id.clone(),title:title.into(),brief:brief.into(),max_duration_min:self.max_duration_min}
 }
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
 pub binding_id:String,pub binding_generation:String,pub mission:Mission,
 pub owner_runtime:Option<String>,pub created_at:u64,pub updated_at:u64,
 pub observed_at:Option<u64>,pub source_revision:Option<String>,
 pub last_error:Option<String>,pub observation:Value,
}
#[derive(Clone,Debug,Default,Serialize,Deserialize)]
#[serde(default,deny_unknown_fields)]
pub struct Book {pub revision:u64,pub bindings:Vec<Binding>,pub missions:Vec<Entry>}
fn err(s:&str)->String{s.into()}
fn active_writer(e:&Entry)->bool{
 matches!(e.mission.phase,Phase::Creating|Phase::StartRequested|Phase::Running|Phase::HoldRequested|Phase::SchedulingHeld|Phase::CloseRequested|Phase::Unknown)
}
impl Book {
 fn bump(&self)->Result<u64,String>{self.revision.checked_add(1).ok_or_else(||err("Execution book revision exhausted"))}
 pub fn size_check(&self)->Result<(),String>{
  if self.bindings.len()>32||self.missions.len()>128||serde_json::to_vec(self).map_err(|_|err("Invalid execution metadata"))?.len()>4*1024*1024{return Err(err("Execution metadata limit reached; all prior records were retained"))}Ok(())
 }
 pub fn configure(&mut self,binding:Binding,expected:u64)->Result<(),String>{
  binding.validate()?;if self.revision!=expected{return Err(err("Provider settings changed; refresh before saving"))}
  if self.bindings.iter().any(|b|b.id==binding.id&&b.workspace_id!=binding.workspace_id){return Err(err("Provider ID belongs to another workspace"))}
  if self.missions.iter().any(|e|e.binding_id==binding.id&&!matches!(e.mission.phase,Phase::Closed|Phase::Accepted|Phase::Draft)){return Err(err("Unclosed missions retain this binding; reconnect its existing credentials instead of replacing it"))}
  let mut next=self.clone();next.revision=self.bump()?;
  if let Some(row)=next.bindings.iter_mut().find(|b|b.id==binding.id){*row=binding}else{next.bindings.push(binding)}
  next.size_check()?;*self=next;Ok(())
 }
 pub fn binding(&self,workspace:&str,id:&str)->Result<&Binding,String>{
  self.bindings.iter().find(|b|b.id==id&&b.workspace_id==workspace&&b.enabled).ok_or_else(||err("Provider is not locally enabled for this workspace"))
 }
 pub fn find(&self,workspace:&str,id:&str)->Result<&Entry,String>{
  self.missions.iter().find(|e|e.mission.spec.mission_id==id&&e.mission.spec.workspace_id==workspace).ok_or_else(||err("Mission is not in the selected workspace"))
 }
 pub fn find_mut(&mut self,workspace:&str,id:&str)->Result<&mut Entry,String>{
  self.missions.iter_mut().find(|e|e.mission.spec.mission_id==id&&e.mission.spec.workspace_id==workspace).ok_or_else(||err("Mission is not in the selected workspace"))
 }
 pub fn prepare(&mut self,workspace:&str,binding_id:&str,task_id:&str,mission_id:&str,title:&str,brief:&str,now:u64)->Result<(),String>{
  identifier(mission_id)?;identifier(task_id)?;
  if let Some(e)=self.missions.iter().find(|e|e.mission.spec.mission_id==mission_id){
   return if e.mission.spec.workspace_id==workspace&&e.mission.spec.task_id==task_id&&e.binding_id==binding_id{Ok(())}else{Err(err("Preparation key already identifies a different mission"))};
  }
  let b=self.binding(workspace,binding_id)?;
  let entry=Entry{binding_id:b.id.clone(),binding_generation:b.generation.clone(),mission:Mission::new(b.spec(mission_id,task_id,title,brief))?,owner_runtime:None,created_at:now,updated_at:now,observed_at:None,source_revision:None,last_error:None,observation:Value::Null};
  let mut next=self.clone();next.revision=self.bump()?;next.missions.push(entry);next.size_check()?;*self=next;Ok(())
 }
 pub fn reserve(&mut self,workspace:&str,id:&str,expected:u64,key:&str,runtime:&str,action:Action)->Result<Reservation,String>{
  identifier(runtime)?;
  let row=self.find(workspace,id)?;
  // A known key is only queried here; it can never dispatch again, even after a
  // revoked binding. Scope still must match and a key cannot change its action.
  if row.mission.receipts.contains_key(key){return self.find_mut(workspace,id)?.mission.reserve(expected,key,action)}
  let b=self.binding(workspace,&row.binding_id)?;
  if b.generation!=row.binding_generation{return Err(err("Mission belongs to an older provider grant"))}
  if matches!(action,Action::Create|Action::Start|Action::Resume)&&self.missions.iter().any(|e|e.mission.spec.workspace_id==workspace&&e.mission.spec.mission_id!=id&&active_writer(e)){
   return Err(err("Another mission may still own workspace writes; hold or reconcile it first"));
  }
  let mut next=self.clone();next.revision=self.bump()?;
  let row=next.find_mut(workspace,id)?;let result=row.mission.reserve(expected,key,action)?;
  if result.dispatch{row.owner_runtime=Some(runtime.into());row.last_error=None;}
  next.size_check()?;*self=next;Ok(result)
 }
 pub fn acknowledge(&mut self,workspace:&str,id:&str,key:&str,reply:Reply,now:u64)->Result<(),String>{
  let mut next=self.clone();next.revision=self.bump()?;let row=next.find_mut(workspace,id)?;
  row.mission.settle(key,reply)?;row.owner_runtime=None;row.updated_at=now;row.last_error=None;
  next.size_check()?;*self=next;Ok(())
 }
 pub fn uncertain(&mut self,workspace:&str,id:&str,key:&str,reason:&str,now:u64)->Result<(),String>{
  if reason.len()>256{return Err(err("Status reason exceeds metadata limit"))}
  let mut next=self.clone();next.revision=self.bump()?;let row=next.find_mut(workspace,id)?;
  row.mission.uncertain(key)?;row.owner_runtime=None;row.last_error=Some(reason.into());row.updated_at=now;
  next.size_check()?;*self=next;Ok(())
 }
 pub fn recover(&mut self,workspace:&str,runtime:&str,now:u64)->Result<(),String>{
  let unresolved=self.missions.iter().filter(|e|e.mission.spec.workspace_id==workspace&&e.mission.pending.is_some()&&e.owner_runtime.as_deref()!=Some(runtime))
    .filter(|e|e.mission.pending.as_ref().and_then(|k|e.mission.receipts.get(k)).is_some_and(|r|r.state==ReceiptState::Reserved))
    .map(|e|(e.mission.spec.mission_id.clone(),e.mission.pending.clone().unwrap())).collect::<Vec<_>>();
  let mut next=self.clone();for (id,key) in unresolved{next.uncertain(workspace,&id,&key,"Previous Desktop instance lost the acknowledgement; inspect, never resubmit",now)?;}
  *self=next;Ok(())
 }
 pub fn disable(&mut self,workspace:&str,id:&str)->Result<(),String>{
  let revision=self.bump()?;
  let b=self.bindings.iter_mut().find(|b|b.id==id&&b.workspace_id==workspace).ok_or_else(||err("Binding not found"))?;
  b.enabled=false;self.revision=revision;Ok(())
 }
 pub fn suspend_recovered(&mut self){
  for b in &mut self.bindings{b.enabled=false;}
  // Backup recovery is not proof that any remote process stopped. Do not
  // resume or retransmit anything from recovered application metadata.
  for e in &mut self.missions {if active_writer(e){e.mission.phase=Phase::Unknown;e.last_error=Some("Recovered application backup; verify external task state".into());}}
 }
 pub fn view(&self,workspace:&str,mission:Option<&str>)->Result<Value,String>{
  if let Some(id)=mission{self.find(workspace,id)?;}
  let bindings=self.bindings.iter().filter(|b|b.workspace_id==workspace).collect::<Vec<_>>();
  let missions=self.missions.iter().filter(|e|e.mission.spec.workspace_id==workspace&&mission.is_none_or(|id|e.mission.spec.mission_id==id)).collect::<Vec<_>>();
  Ok(json!({"revision":self.revision,"bindings":bindings,"missions":missions,
   "persistence":"application data with retained backups; credentials remain RAM-only",
   "automatic_replay":false,"external_runtime_sandbox_inherited":false,
   "review_identity":"coordinator attestation, not fabricated human approval"}))
 }
}
