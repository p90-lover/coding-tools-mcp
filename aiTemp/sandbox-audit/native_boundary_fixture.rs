//! End-to-end permission proof against an official runtime, never an AI provider.
use super::*;
use std::net::TcpListener;

#[test]
#[ignore = "official pinned native runtime plus a compiled access-probe child on isolated CI only"]
fn audit_native_readonly_network_timeout_and_no_model() {
    let model_trap=TcpListener::bind("127.0.0.1:0").unwrap();model_trap.set_nonblocking(true).unwrap();
    let network_trap=TcpListener::bind("127.0.0.1:0").unwrap();network_trap.set_nonblocking(true).unwrap();
    let base=std::env::current_dir().unwrap().join("aiTemp/native-audit")
        .join(format!("{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let root=base.join("workspace");let outside=base.join("outside");let home=base.join("home");
    for d in [&root,&outside,&home] {std::fs::create_dir_all(d).unwrap();}
    let sentinel="unchanged sentinel";
    for d in [&root,&outside] {std::fs::write(d.join("sentinel.txt"),sentinel).unwrap();}
    // No windows.sandbox preconfiguration: the command's own read-only profile must suffice.
    std::fs::write(home.join("config.toml"),format!("model = \"no-model\"\nmodel_provider = \"no_inference\"\napproval_policy = \"on-request\"\n[model_providers.no_inference]\nname = \"No inference\"\nbase_url = \"http://{}/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n",model_trap.local_addr().unwrap())).unwrap();
    let child=PathBuf::from(std::env::var("BOUNDARY_CHILD").unwrap()).canonicalize().unwrap();
    let args=|suffix:&str|vec![child.to_string_lossy().into_owned(),root.to_string_lossy().into_owned(),outside.to_string_lossy().into_owned(),network_trap.local_addr().unwrap().to_string(),suffix.into(),sentinel.into()];
    let control_args=args("control");
    let positive=std::process::Command::new(&child).args(&control_args[1..]).output().unwrap();
    assert!(positive.status.success());
    let positive:Value=serde_json::from_slice(&positive.stdout).unwrap();
    for k in ["read","outside_read","overwrite_access","create","outside_create","network"] {
        assert_eq!(positive[k],true,"Positive control failed: {k} {positive}");
    }
    #[cfg(windows)] assert_eq!(positive["delete_access"],true,"Positive DELETE-access check must succeed; no actual deletion is performed");
    assert!(network_trap.accept().is_ok(),"Raw socket positive control was not accepted");
    let hub=Hub::default();
    hub.connect(&root.canonicalize().unwrap(),Connection {
        executable:PathBuf::from(std::env::var("NATIVE_CODEX_PROBE_BIN").unwrap()),
        expected_sha256:std::env::var("NATIVE_CODEX_PROBE_SHA256").unwrap(),
        codex_home:home.canonicalize().unwrap(),allow_model_usage:false,allow_command_execution:true,
        model:"no-model".into(),request_limit:1,lifetime_seconds:120,
    }).unwrap();hub.initialize().unwrap();
    let request=CommandRequest {request_id:"boundary-check".into(),argv:args("sandbox"),timeout_ms:10000};
    let result=hub.admit_command(request.clone()).unwrap().run().unwrap();
    assert_eq!(result["ok"],true,"{result}");assert_eq!(result["exit_code"],0,"{result}");
    let observed:Value=serde_json::from_str(result["stdout"].as_str().unwrap().trim()).unwrap();
    println!("NATIVE_BOUNDARY_OBSERVED {observed}");
    assert_eq!(hub.admit_command(request).unwrap().run().unwrap(),result,"Replay must not execute again");
    assert_eq!(observed["read"],true,"Cannot count a failed executable as isolation proof");
    for k in ["overwrite_access","create","outside_create","network","delete_access"] {
        assert_eq!(observed[k],false,"NATIVE_BOUNDARY_FAILED: {k}: {observed}");
    }
    assert!(network_trap.accept().is_err(),"Sandboxed raw socket escaped network denial");
    for d in [&root,&outside] {assert_eq!(std::fs::read_to_string(d.join("sentinel.txt")).unwrap(),sentinel);assert!(!d.join("probe-sandbox").exists());}
    let started=Instant::now();
    let timeout=hub.admit_command(CommandRequest {request_id:"timeout".into(),argv:vec![child.to_string_lossy().into_owned(),"sleep".into()],timeout_ms:300}).unwrap().run().unwrap();
    assert!(started.elapsed()<Duration::from_secs(8),"Timeout did not bound execution");
    assert!(timeout["ok"]==false || timeout["exit_code"].as_i64().is_some_and(|n|n!=0),"{timeout}");
    let status=hub.status().unwrap();assert_eq!(status["requests_used"],0);assert!(status["threads"].as_array().unwrap().is_empty());
    assert!(model_trap.accept().is_err(),"Model/provider was contacted");
    hub.cancel("audit_complete");
    assert!(hub.admit_command(CommandRequest {request_id:"stopped".into(),argv:args("stopped"),timeout_ms:1000}).is_err());
    let evidence=json!({"source":std::env::var("SOURCE").unwrap(),"positive_control":positive,"sandbox":observed,"timeout":timeout,
        "runtime_sha256":std::env::var("NATIVE_CODEX_PROBE_SHA256").unwrap(),"model_requests":0,"threads_created":0,
        "existing_sentinels_unchanged":true,"scope":"read-only writes, raw loopback network, timeout, replay and revoked admission; not workspace-only reads or a universal sandbox certificate"});
    std::fs::write("aiTemp/evidence/native-boundary.json",serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    println!("PASS: native positive execution, create/overwrite/DELETE-access denial, raw socket denial, bounded timeout, exact replay, revoked admission, zero model requests");
}
