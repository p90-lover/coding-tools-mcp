//! Serializable mission state; persist the successful reservation BEFORE IO.
//! No credentials or raw upstream output are stored here. Validation failures
//! leave state untouched. Review records are coordinator attestations, not a
//! claim that the provider or a human actually inspected the code.
use serde::{Deserialize,Serialize};
use std::collections::BTreeMap;
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Engine { Paseo, Anneal }
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Action { Create, Start, Inspect, Events, Hold, Resume, Cancel, Close }
impl Action { pub fn writes(self)->bool{!matches!(self,Self::Inspect|Self::Events)} }
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spec {
 pub engine:Engine,pub mission_id:String,pub workspace_id:String,pub task_id:String,
 pub cwd:String,pub provider:String,pub model:String,pub mode:String,
 pub project_id:Option<String>,pub repo_id:Option<String>,pub assignee_id:Option<String>,
 pub title:String,pub brief:String,pub max_duration_min:u32,
}
pub fn identifier(s:&str)->Result<(),String>{
 if s.is_empty()||s.len()>128||!s.bytes().all(|b|b.is_ascii_alphanumeric()||b"-_".contains(&b)){return Err("Identifier must contain 1..128 letters, digits, hyphens or underscores".into())}Ok(())
}
fn bounded(s:&str,max:usize,required:bool)->Result<(),String>{
 if (required&&s.trim().is_empty())||s.len()>max||s.chars().any(|c|c.is_control()&&!matches!(c,'\n'|'\t')){return Err("Text is empty, too large or contains controls".into())}Ok(())
}
impl Spec {
 pub fn validate(&self)->Result<(),String>{
  for s in [&self.mission_id,&self.workspace_id,&self.task_id]{identifier(s)?;}
  for s in [&self.project_id,&self.repo_id,&self.assignee_id].into_iter().flatten(){identifier(s)?;}
  bounded(&self.cwd,2048,true)?;if self.cwd.chars().any(char::is_control){return Err("Invalid working directory".into())}
  bounded(&self.title,200,true)?;bounded(&self.brief,32768,true)?;
  for s in [&self.provider,&self.model,&self.mode]{bounded(s,128,true)?;}
  if !(1..=1440).contains(&self.max_duration_min){return Err("Duration must be 1..1440 minutes".into())}
  if self.engine==Engine::Anneal&&(self.project_id.is_none()||self.repo_id.is_none()||self.assignee_id.is_none()){return Err("Anneal requires an explicit project, repository and agent binding".into())}
  Ok(())
 }
}
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Phase { Draft,Creating,Ready,StartRequested,Running,HoldRequested,SchedulingHeld,Held,ReviewRequired,ChangesRequested,Accepted,CloseRequested,Closed,Unknown,Failed }
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum ReceiptState { Reserved,Acknowledged,Unknown,Rejected }
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {pub action:Action,pub state:ReceiptState,pub previous:Phase}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Review {pub reviewer_id:String,pub note:String,pub evidence:Vec<String>,pub accepted:bool,pub attempt:u32,pub source:String}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mission {
 pub spec:Spec,pub phase:Phase,pub revision:u64,pub record_id:Option<String>,pub run_id:Option<String>,
 pub receipts:BTreeMap<String,Receipt>,pub pending:Option<String>,pub reviews:Vec<Review>,
 pub attempts:u32,pub quiescent:bool,pub last_status:Option<String>,pub hold_desired:bool,
}
#[derive(Clone,Debug,Serialize)]
pub struct Reservation {pub dispatch:bool,pub request_key:String,pub phase:Phase,pub revision:u64}
#[derive(Clone,Debug)]
pub enum Reply {Created{record_id:String},Started{run_id:Option<String>},HoldAcknowledged{worker_stopped:bool},Closed,Rejected}
#[derive(Clone,Debug)]
pub struct Observation {pub record_id:String,pub status:String,pub run_id:Option<String>,pub quiescent:bool}
impl Mission {
 pub fn new(spec:Spec)->Result<Self,String>{spec.validate()?;Ok(Self{spec,phase:Phase::Draft,revision:0,record_id:None,run_id:None,receipts:BTreeMap::new(),pending:None,reviews:vec![],attempts:0,quiescent:false,last_status:None,hold_desired:false})}
 fn next(&self)->Result<u64,String>{self.revision.checked_add(1).ok_or_else(||"Mission revision exhausted".into())}
 pub fn reserve(&mut self,expected:u64,key:&str,action:Action)->Result<Reservation,String>{
  identifier(key)?;
  if let Some(old)=self.receipts.get(key){
   if old.action!=action{return Err("A request key cannot be reused for another action".into())}
   return Ok(Reservation{dispatch:false,request_key:key.into(),phase:self.phase,revision:self.revision});
  }
  if expected!=self.revision{return Err("Mission changed; read before issuing a new action".into())}
  if self.pending.is_some(){return Err("An operation is unresolved; inspect it instead of resubmitting".into())}
  if !action.writes(){return Err("Observation does not reserve a mutation".into())}
  if self.receipts.len()>=128{return Err("Retained receipt limit reached; nothing was removed or dispatched".into())}
  let next=self.next()?;
  let phase=match action {
   Action::Create if self.phase==Phase::Draft=>Phase::Creating,
   Action::Start if matches!(self.phase,Phase::Ready|Phase::ChangesRequested)&&self.record_id.is_some()&&self.attempts<20=>Phase::StartRequested,
   Action::Resume if self.phase==Phase::Held&&self.record_id.is_some()&&self.attempts<20=>Phase::StartRequested,
   Action::Hold if matches!(self.phase,Phase::Running|Phase::Unknown)&&self.record_id.is_some()=>Phase::HoldRequested,
   Action::Cancel if matches!(self.phase,Phase::Running|Phase::SchedulingHeld|Phase::Unknown)&&self.record_id.is_some()=>Phase::HoldRequested,
   Action::Close if matches!(self.phase,Phase::Ready|Phase::Held|Phase::ReviewRequired|Phase::Accepted|Phase::ChangesRequested)&&self.quiescent&&self.record_id.is_some()=>Phase::CloseRequested,
   _=>return Err("Action is not allowed in the observed mission state".into()),
  };
  self.receipts.insert(key.into(),Receipt{action,state:ReceiptState::Reserved,previous:self.phase});
  self.pending=Some(key.into());self.phase=phase;self.revision=next;
  if matches!(action,Action::Hold|Action::Cancel){self.hold_desired=true;}
  Ok(Reservation{dispatch:true,request_key:key.into(),phase,revision:next})
 }
 pub fn uncertain(&mut self,key:&str)->Result<(),String>{
  if self.pending.as_deref()!=Some(key){return Err("Unknown or superseded operation".into())}
  let next=self.next()?;let receipt=self.receipts.get_mut(key).ok_or("Missing receipt")?;
  receipt.state=ReceiptState::Unknown;self.phase=Phase::Unknown;self.revision=next;
  // Retain the pending key. Only reconciliation can reopen admission.
  Ok(())
 }
 pub fn settle(&mut self,key:&str,reply:Reply)->Result<(),String>{
  if self.pending.as_deref()!=Some(key){return Err("A late response does not own the current operation".into())}
  let receipt=self.receipts.get(key).ok_or("Missing receipt")?;let action=receipt.action;let previous=receipt.previous;let next=self.next()?;
  // Validate into local values before publishing any change.
  let mut record=self.record_id.clone();let mut run=self.run_id.clone();let mut attempts=self.attempts;
  let mut stopped=self.quiescent;let mut hold=self.hold_desired;let rejected=matches!(reply,Reply::Rejected);
  let phase=match reply {
   Reply::Created{record_id} if action==Action::Create=>{identifier(&record_id)?;record=Some(record_id);stopped=true;Phase::Ready},
   Reply::Started{run_id} if matches!(action,Action::Start|Action::Resume)=>{if let Some(id)=&run_id{identifier(id)?;}run=run_id;attempts=attempts.checked_add(1).ok_or("Attempt counter exhausted")?;stopped=false;hold=false;Phase::Running},
   Reply::HoldAcknowledged{worker_stopped} if matches!(action,Action::Hold|Action::Cancel)=>{stopped=worker_stopped;hold=true;if stopped{Phase::Held}else{Phase::SchedulingHeld}},
   Reply::Closed if action==Action::Close=>{stopped=true;Phase::Closed},
   Reply::Rejected=>{hold=matches!(previous,Phase::Held|Phase::SchedulingHeld);previous},
   _=>return Err("Response does not match the reserved action".into()),
  };
  self.record_id=record;self.run_id=run;self.attempts=attempts;self.quiescent=stopped;self.hold_desired=hold;
  self.phase=phase;self.pending=None;self.revision=next;
  self.receipts.get_mut(key).expect("validated receipt").state=if rejected{ReceiptState::Rejected}else{ReceiptState::Acknowledged};Ok(())
 }
 pub fn observe(&mut self,o:Observation)->Result<(),String>{
  if self.record_id.as_deref()!=Some(&o.record_id){return Err("Observation belongs to a different mission record".into())}
  if let Some(id)=&o.run_id{identifier(id)?;}
  bounded(&o.status,64,true)?;
  let status=o.status.to_ascii_lowercase();
  let terminal=matches!(status.as_str(),"idle"|"done"|"review"|"cancelled"|"canceled"|"closed"|"archived"|"error"|"failed");
  if o.quiescent&&!terminal{return Err("A running/unknown status cannot confirm quiescence".into())}
  if self.phase==Phase::Closed{return Err("Closed mission cannot be reactivated by an observation".into())}
  // Never race an unresolved transmitted action with a stale observation. A
  // receipt explicitly marked unknown may be reconciled for safety controls,
  // but its history is not rewritten into proof of exactly-once execution.
  if let Some(key)=self.pending.as_ref(){if self.receipts.get(key).is_some_and(|r|r.state==ReceiptState::Reserved){return Err("Mutation acknowledgement is still pending".into())}}
  let next=self.next()?;
  let phase=if self.phase==Phase::Accepted {Phase::Accepted}
   else if matches!(status.as_str(),"error"|"failed"){Phase::Failed}
   else if matches!(status.as_str(),"closed"|"archived")&&o.quiescent{Phase::Closed}
   else if self.hold_desired {if o.quiescent{Phase::Held}else{Phase::SchedulingHeld}}
   else if o.quiescent&&self.attempts>0{Phase::ReviewRequired}
   else if o.quiescent{Phase::Ready}
   else if matches!(status.as_str(),"running"|"doing"|"initializing"){Phase::Running}
   else{Phase::Unknown};
  self.phase=phase;self.quiescent=o.quiescent;self.last_status=Some(o.status);if o.run_id.is_some(){self.run_id=o.run_id;}
  self.pending=None;self.revision=next;Ok(())
 }
 pub fn review(&mut self,reviewer:&str,note:&str,evidence:&[String],accepted:bool)->Result<(),String>{
  if self.phase!=Phase::ReviewRequired||!self.quiescent||self.pending.is_some(){return Err("A settled worker result must be observed before review".into())}
  identifier(reviewer)?;
  if self.record_id.as_deref()==Some(reviewer)||self.spec.assignee_id.as_deref()==Some(reviewer){return Err("Assigned worker cannot approve its own result".into())}
  bounded(note,4096,true)?;
  if evidence.is_empty()||evidence.len()>32||self.reviews.len()>=64{return Err("Review requires 1..32 evidence references and available retention capacity".into())}
  for e in evidence{bounded(e,1024,true)?;}
  let next=self.next()?;
  self.reviews.push(Review{reviewer_id:reviewer.into(),note:note.into(),evidence:evidence.to_vec(),accepted,attempt:self.attempts,source:"coordinator_review_attestation".into()});
  self.phase=if accepted{Phase::Accepted}else{Phase::ChangesRequested};self.revision=next;Ok(())
 }
}
