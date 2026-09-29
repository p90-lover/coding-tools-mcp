"""Refine the new controller before it is exposed or released."""
from pathlib import Path
import os,shutil,subprocess
changed=[]
def save(name,text):
 p=Path(name)
 if text==p.read_text(encoding='utf-8'):return
 if name not in changed:
  backup=Path('aiTemp/Trash/execution-refinements')/os.environ['GITHUB_RUN_ID']/p
  backup.parent.mkdir(parents=True,exist_ok=True);assert not backup.exists();shutil.copy2(p,backup);changed.append(name)
 p.write_text(text,encoding='utf-8')
def once(name,old,new):
 text=Path(name).read_text(encoding='utf-8')
 if new in text:return
 assert text.count(old)==1,(name,old[:70],text.count(old));save(name,text.replace(old,new,1))
p='src-tauri/src/integrations/execution/service.rs'
once(p,'fn stamp(ctx:&ToolContext)->String{format!("{:x}",Sha256::digest(format!("{:?}|{}",ctx.policy,ctx.tool_profile).as_bytes()))}', '''fn stamp(ctx:&ToolContext)->String{
 let mut commands=ctx.policy.allowed_commands.iter().collect::<Vec<_>>();commands.sort();
 let mut extensions=ctx.policy.workspace_script_extensions.iter().collect::<Vec<_>>();extensions.sort();
 let value=json!([commands,extensions,ctx.policy.permission_mode,ctx.policy.approval_mode,ctx.policy.allow_screen_capture,ctx.policy.workspace_local_entries,ctx.policy.max_patch_bytes,ctx.tool_profile]);
 format!("{:x}",Sha256::digest(value.to_string().as_bytes()))
}''')
once(p,'if !action.writes(){return refresh(ctx,&mission_id);}', 'if !action.writes(){return refresh_as(ctx,&mission_id,action);}')
once(p,'pub fn refresh(ctx:&ToolContext,id:&str)->AppResult<Value>{', 'pub fn refresh(ctx:&ToolContext,id:&str)->AppResult<Value>{refresh_as(ctx,id,Action::Inspect)}\nfn refresh_as(ctx:&ToolContext,id:&str,action:Action)->AppResult<Value>{')
once(p,'key:uuid::Uuid::new_v4().to_string(),action:Action::Inspect,_slot:slot', 'key:uuid::Uuid::new_v4().to_string(),action,_slot:slot')
once(p,' if job.action==Action::Inspect {', ''' if job.action==Action::Events {
  let _owned=inspect_source(job).await?;
  let spec=&job.entry.mission.spec;
  let request=protocol::build(spec,job.entry.mission.record_id.as_deref(),job.entry.mission.run_id.as_deref(),Action::Events,&job.key).map_err(fail)?;
  let response=transport::send(spec.engine,&job.binding.endpoint,&job.connection.credential,&request).await.map_err(|e|fail(e.to_string()))?;
  let rows=if spec.engine==Engine::Paseo{response.body["entries"].as_array()}else{response.body.as_array()}.ok_or_else(||fail("Source events have an unsupported response shape"))?;
  let projected=rows.iter().rev().take(50).map(|v|{
   let mut row=json!({});for k in ["id","seq","type","kind","timestamp","createdAt","actorType"]{
    if let Some(text)=v[k].as_str(){row[k]=json!(text.chars().take(256).collect::<String>());}else if v[k].is_u64(){row[k]=v[k].clone();}
   }row
  }).collect::<Vec<_>>();
  DataStore::update_file(|data|{
   scope(&current,data)?;let entry=data.execution_book.find_mut(&job.workspace,&spec.mission_id).map_err(fail)?;
   if entry.mission.revision!=job.entry.mission.revision{return Err(fail("Newer mission state supersedes these events"))}
   if !entry.observation.is_object(){entry.observation=json!({});}
   entry.observation["event_page"]=json!({"fetched_at":now(),"items":projected,"metadata_only":true,"original_count":rows.len(),"truncated":rows.len()>50,"raw_output_persisted":false});
   data.execution_book.size_check().map_err(fail)
  })?;return Ok(());
 }
 if job.action==Action::Inspect {''')
once(p,'&task.title,&task.description,now()', '&task.title,if task.description.trim().is_empty(){&task.title}else{&task.description},now()')
p='src-tauri/src/integrations/execution/observation.rs'
text=Path(p).read_text();start=text.index('            let provider =') if '            let provider =' in text else text.index('   let provider=')
end=text.index('let runs',start)
# Current source may have been rustfmt-ed by the core contract workflow.
old=text[start:end]
new='''            let agent=&body["assigneeAgent"];
            let provider=agent["runnerPreference"].as_str().ok_or("Anneal worker omitted explicit runner selection")?;
            if !provider.eq_ignore_ascii_case(&spec.provider) || agent["model"]!=spec.model {
                return Err("Anneal requires the explicitly selected runner and model; AUTO/INHERIT or changed bindings need source configuration and local reapproval".into());
            }
            '''
text=text[:start]+new+text[end:];save(p,text)
p='src-tauri/src/integrations/execution/book.rs';text=Path(p).read_text()
# Keep the same source expression before and after rustfmt.
old='self.provider.eq_ignore_ascii_case("codex") && !self.allow_codex'
if old not in text:old='self.provider.eq_ignore_ascii_case("codex")&&!self.allow_codex'
assert old in text
text=text.replace(old,'(self.provider.eq_ignore_ascii_case("codex") || self.model.to_ascii_lowercase().contains("codex")) && !self.allow_codex',1)
# Mission detail is a projection, never the stored authoritative object. Keep
# scopes/receipt keys but bound human text and show the omission explicitly.
start=text.index('let missions =') if 'let missions =' in text else text.index('let missions=')
end=text.index('Ok(json!',start) if 'Ok(json!' in text[start:] else -1
assert end>start
text=text[:start]+'''let matching=self.missions.iter().filter(|e|e.mission.spec.workspace_id==workspace&&mission.is_none_or(|id|e.mission.spec.mission_id==id)).collect::<Vec<_>>();
        let count=matching.len();
        let missions=matching.into_iter().rev().take(if mission.is_some(){1}else{20}).map(|e|{
            let mut value=serde_json::to_value(e).expect("serializable mission");
            value["mission"]["spec"]["brief"]=json!(e.mission.spec.brief.chars().take(if mission.is_some(){4096}else{0}).collect::<String>());
            if mission.is_none(){value["mission"]["receipts"]=json!({});value["mission"]["reviews"]=json!([]);value["observation"]=json!({});}
            else if let Some(reviews)=value["mission"]["reviews"].as_array_mut(){
                let len=reviews.len();if len>8{*reviews=reviews[len-8..].to_vec();}
                for r in reviews {if let Some(note)=r["note"].as_str(){r["note"]=json!(note.chars().take(512).collect::<String>());}if let Some(items)=r["evidence"].as_array_mut(){items.truncate(4);}}
            }
            value["display_bounded"]=json!(true);value
        }).collect::<Vec<_>>();
        '''+text[end:]
text=text.replace('"missions":missions,','"missions":missions,"total_missions":count,"has_more":count>20&&mission.is_none(),',1)
save(p,text)
for p in changed:
 if p.endswith('.rs'):subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true',p],check=True)
subprocess.run(['git','add','--',*changed],check=True)
print('EXECUTION_REFINEMENTS: bounded mission output, stable policy fingerprints, actual event routing and explicit Anneal runner checks')
