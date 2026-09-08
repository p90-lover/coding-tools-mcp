// Browser QA only. Never imported by the application or included in a release.
window.__QA_CALLS__=[];
const profiles=[{id:'qa-main',name:'QA · Product website',path:'C:\\Projects\\product-website',auth:{type:'oauth'},runtime:{permission_mode:'workspace-write',allow_screen_capture:true,local_port:28766},tunnel:{type:'cloudflare',cloudflare_mode:'quick',public_url:''},actions:{auth_type:'api_key',permission_mode:'read-only',local_port:8787}}, {id:'qa-tools',name:'QA · MCP toolkit',path:'C:\\Projects\\mcp-toolkit',auth:{type:'bearer'},runtime:{permission_mode:'read-only',allow_screen_capture:false,local_port:28767},tunnel:{type:'none',public_url:''}}];
const task=(id,title,status,ws='qa-main',description='')=>({id,workspace_id:ws,title,description,status,priority:status==='REVIEW'?'high':'normal',review_note:status==='DONE'?'Review fixture':'',verification_note:status==='DONE'?'Verification fixture':'',revision:1,created_at:Date.now()-600000,updated_at:Date.now()-10000,archived:false});
const state={data:{paseo:{enabled:true,url:'ws://127.0.0.1:6767/ws'},anneal:{enabled:true,url:'http://127.0.0.1:5173/api'},tasks:[task('qa-0001','Document the connection flow','BACKLOG','qa-tools','Explain how a stable hostname keeps MCP connections consistent.'),task('qa-0002','Improve workspace onboarding','TODO','qa-main','Define the first-run steps and clear acceptance criteria.'),task('qa-0003','Review keyboard navigation','DOING','qa-main','Check focus states, search and dialog shortcuts.'),task('qa-0004','Check the session directory','REVIEW','qa-tools'),task('qa-0005','Preserve memory-only previews','DONE','qa-tools')]},paseo_has_token:false,anneal_has_token:false,execution:'observation_only'};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>123,unregisterCallback:()=>{},convertFileSrc:x=>x,invoke:async(cmd,args={})=>{
 window.__QA_CALLS__.push({cmd,args});
 switch(cmd){
 case'center_load':return structuredClone(state);
 case'center_save_task':{const draft=args.draft;let i=state.data.tasks.findIndex(t=>t.id===draft.id);if(i>=0&&state.data.tasks[i].revision!==draft.expected_revision)throw Error('Task changed; refresh first.');if(draft.status==='DONE'&&(!draft.review_note.trim()||!draft.verification_note.trim()))throw Error('Review and verification notes required.');const t={...draft,id:draft.id||'qa-new-'+Date.now(),created_at:Date.now(),updated_at:Date.now(),revision:(i>=0?state.data.tasks[i].revision:0)+1};if(i>=0)state.data.tasks[i]=t;else state.data.tasks.push(t);return structuredClone(t);}
 case'center_save_connection':state.data[args.provider]={url:args.url,enabled:args.enabled};return null;
 case'center_sync':{if(!state.data[args.provider].enabled)throw Error('Connect first.');return {source:args.provider,read_only:true,observed_at:Date.now(),has_more:false,next_cursor:null,items:args.provider==='paseo'?[{id:'qa-session-01',title:'QA · Existing review session',provider:'claude',model:'existing-model',status:'idle',path:'C:\\Projects\\product-website'},{id:'qa-session-02',title:'QA · Existing toolkit session',provider:'codex',model:'existing-model',status:'idle',path:'C:\\Projects\\mcp-toolkit'}]:[{id:'qa-anneal-001',title:'QA · Anneal board task',status:'REVIEW',chain_id:'qa-chain-1',chain_name:'QA · Review workflow',chain_status:'paused',assignee:'Existing reviewer',review_gate:true,failure_reason:''}]};}
 case'list_workspaces':return profiles;
 case'list_linked_projects':return [];
 case'get_runtime_status':case'get_actions_runtime_status':return {state:cmd==='get_runtime_status'?'running':'stopped',pid:null,localMessage:'QA service metadata',publicMessage:'',localEndpoint:'http://127.0.0.1:28766/mcp',publicEndpoint:''};
 case'computer_local_poll':return {state:'stopped'};
 case'computer_local_permissions':return {remembered:false,approved_apps:[]};
 case'computer_local_targets':return [{window_id:100,pid:700,title:'QA fixture window'}];
 case'sandbox_local_status':return {available:false,release_status:'withheld_pending_native_verification',reason:'Not included in this release'};
 case'plugin:window|is_minimized':return false;
 case'plugin:event|listen':return 1;
 case'get_proxy':return {mode:'none',url:''};
 case'list_frp_profiles':return [];
 case'get_workspace':return profiles.find(x=>x.id===args.id);
 default:return null;
 }
}};
