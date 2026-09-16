//! Extensions of the existing workflow tool contracts. No new implicit grant
//! or caller-supplied endpoint/provider/root is accepted by MCP.
use serde_json::{json,Value};
pub fn extend(name:&str,mut schema:Value)->Value{
 let id=json!({"type":"string","minLength":1,"maxLength":128});
 if name=="workflow_list"{
  schema["properties"]["mission_id"]=id;
  schema["properties"]["refresh_source"]=json!({"type":"boolean","default":false,"description":"Request a bounded background read of this mission's source. Never starts or repeats a worker. Requires mission_id."});
 }else if name=="workflow_update"{
  let branches=schema["properties"]["change"]["oneOf"].as_array_mut().expect("workflow schema");
  branches.push(json!({"type":"object","additionalProperties":false,"required":["operation","binding_id","task_id","mission_id"],"properties":{
   "operation":{"const":"agent_prepare"},"binding_id":id,"task_id":id,"mission_id":id}}));
  branches.push(json!({"type":"object","additionalProperties":false,"required":["operation","mission_id","request_key","action"],"properties":{
   "operation":{"const":"agent_control"},"mission_id":id,"request_key":id,
   "action":{"enum":["create","start","inspect","events","hold","resume","cancel","close"]}}}));
  branches.push(json!({"type":"object","additionalProperties":false,"required":["operation","mission_id","note","evidence","accepted"],"properties":{
   "operation":{"const":"agent_review"},"mission_id":id,"note":{"type":"string","minLength":1,"maxLength":4096},"accepted":{"type":"boolean"},
   "evidence":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string","minLength":1,"maxLength":1024}}}}));
  schema["properties"]["expected_revision"]["description"]=json!("Board revision for ordinary board changes/agent_prepare; mission revision for agent_control/agent_review. Source mutations may invoke a separately approved provider model. Never retry an uncertain operation under a new request_key.");
 }
 schema
}
