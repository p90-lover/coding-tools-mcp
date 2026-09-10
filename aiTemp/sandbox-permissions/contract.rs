//! Three scoped groups; every fixture retained under aiTemp, no user configuration.
use super::*;
use crate::{
    data::with_test_file,
    tools::{approval::ApprovalStore, live_policy, policy::PolicySettings},
};
use std::{
    fs,
    sync::Arc,
    time::{Duration, Instant},
};
static TEST_SERIAL: Mutex<()> = Mutex::new(());
fn fixture() -> (PathBuf, PathBuf, WorkspaceProfile, Arc<ToolContext>) {
    let base = std::env::current_dir()
        .unwrap()
        .join("aiTemp/snapshot-contract")
        .join(uuid::Uuid::new_v4().to_string());
    let root = base.join("workspace");
    fs::create_dir_all(&root).unwrap();
    let mut p = WorkspaceProfile::new(
        root.to_string_lossy().into_owned(),
        Some("Synthetic".into()),
    );
    p.auth.auth_type = "oauth".into();
    p.runtime.permission_mode = "workspace-write".into();
    p.runtime.approval_mode = "on-request".into();
    p.runtime.tool_profile = "full".into();
    let mut ctx = ToolContext::for_test(root, base.join("harness")).unwrap();
    ctx.auth = p.auth.clone();
    ctx.workspace_id = Some(p.id.clone());
    let file = base.join("data/profiles.json");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    let mut data = AppData::default();
    data.profiles.push(p.clone());
    fs::write(&file, serde_json::to_vec(&data).unwrap()).unwrap();
    (base, file, p, Arc::new(ctx))
}
#[test]
fn snapshot_contract_grants_are_scoped_persisted_and_sensitive_input_is_rejected() {
    let _serial = TEST_SERIAL.lock().unwrap();
    let (base, file, p, ctx) = fixture();
    with_test_file(file.clone(), || {
        if !available() {
            assert!(local_setup(p, ctx.workspace.root().to_path_buf()).is_err());
            return;
        }
        local_setup(p.clone(), ctx.workspace.root().to_path_buf()).unwrap();
        assert!(permitted(&p.id, ctx.workspace.root()).unwrap());
        let data: AppData = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert!(
            grant_matches(&data, &p.id, ctx.workspace.root()),
            "persisted consent must survive reload"
        );
        let mut other = p.clone();
        other.id = "different-workspace-same-root".into();
        DataStore::update_file(|d| {
            d.profiles.push(other.clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            local_status_for(&other.id, ctx.workspace.root()).unwrap()["enabled_for_workspace"],
            false
        );
        let mut forged = (*ctx).clone();
        forged.workspace_id = Some(other.id);
        assert!(call(&forged, "sandbox_exec", &json!({"argv":["missing.exe"]})).is_err());
        let mut legacy = data.clone();
        legacy.sandbox_permissions[0].helper_sha256.clear();
        assert!(!grant_matches(&legacy, &p.id, ctx.workspace.root()));
        let mut changed = data;
        changed.profiles[0].runtime.approval_mode = "ask".into();
        assert!(!grant_matches(&changed, &p.id, ctx.workspace.root()));
        fs::write(ctx.workspace.root().join("source.txt"), "SOURCE_UNCHANGED").unwrap();
        let run = snapshot::prepare(
            ctx.workspace.root(),
            &base.join("snapshots"),
            &["source.txt".into()],
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(run.input.join("source.txt")).unwrap(),
            "SOURCE_UNCHANGED"
        );
        for path in [
            "../private.txt",
            ".env",
            "profiles.json",
            "private.key",
            "@external/file.txt",
        ] {
            assert!(
                snapshot::prepare(
                    ctx.workspace.root(),
                    &base.join("snapshots"),
                    &[path.into()]
                )
                .is_err(),
                "{path}"
            );
        }
        let target = base.join("outside");
        fs::create_dir(&target).unwrap();
        let link = base.join("storage-link");
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&target, &link).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(snapshot::prepare(ctx.workspace.root(), &link.join("new-child"), &[]).is_err());
        assert!(
            !target.join("new-child").exists(),
            "do not follow link even during storage creation"
        );
        local_disable(&p.id).unwrap();
        assert!(!permitted(&p.id, ctx.workspace.root()).unwrap());
        let saved: AppData = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        assert!(!saved.sandbox_permissions[0].enabled);
        println!("SNAPSHOT_CONTRACT: workspace identity, reload, old/helper/policy grants, inputs and revocation verified");
    });
}
#[test]
fn snapshot_contract_shared_approval_and_readonly_cannot_enable_native_execution() {
    let _serial = TEST_SERIAL.lock().unwrap();
    let (_, file, p, ctx) = fixture();
    with_test_file(file, || {
        let args = json!({"argv":["anything.exe"],"confirm":true});
        let store = ApprovalStore::default();
        for mode in ["ask", "never"] {
            assert!(store
                .preflight("sandbox_exec", &mut args.clone(), mode, "workspace-write")
                .is_err());
        }
        assert!(store
            .preflight(
                "sandbox_exec",
                &mut args.clone(),
                "on-request",
                "workspace-write"
            )
            .is_ok());
        // Full access can only skip the soft prompt, never manufacture local consent.
        assert!(store
            .preflight(
                "sandbox_exec",
                &mut args.clone(),
                "never",
                "danger-full-access"
            )
            .is_ok());
        let mut full = (*ctx).clone();
        full.policy.permission_mode = "danger-full-access".into();
        assert!(call(&full, "sandbox_exec", &args).is_err());
        let mut readonly = p.clone();
        readonly.runtime.permission_mode = "read-only".into();
        DataStore::update_file(|d| {
            d.profiles[0] = readonly.clone();
            Ok(())
        })
        .unwrap();
        assert!(local_setup(readonly, ctx.workspace.root().to_path_buf()).is_err());
        let mut policy = PolicySettings::default();
        policy.permission_mode = "read-only".into();
        assert!(crate::tools::policy::validate_tool_arguments_for_workspace(
            "sandbox_exec",
            &args,
            &policy,
            Some(&ctx.workspace)
        )
        .is_err());
        assert!(
            !live_policy::fence_entire_call("sandbox_exec"),
            "revocation must not be blocked for the execution lifetime"
        );
        println!("SNAPSHOT_CONTRACT: shared ask/never/full policies cannot bypass local or read-only permission");
    });
}
#[cfg(all(windows, feature = "native-snapshot"))]
#[test]
fn snapshot_contract_actual_executor_and_live_revocation_stop_owned_descendants() {
    let _serial = TEST_SERIAL.lock().unwrap();
    let (base, file, p, ctx) = fixture();
    with_test_file(file.clone(), || {
        assert!(available());
        let probe = PathBuf::from(std::env::var("CODING_TOOLS_SNAPSHOT_PROBE").unwrap());
        fs::copy(probe, ctx.workspace.root().join("probe.exe")).unwrap();
        fs::write(ctx.workspace.root().join("source.txt"), "SOURCE_UNCHANGED").unwrap();
        local_setup(p.clone(), ctx.workspace.root().to_path_buf()).unwrap();
        // A real executable can run with an empty environment and copied inputs.
        let system = std::env::var("SystemRoot").unwrap();
        let result = crate::tools::call_tool(
            &ctx,
            "sandbox_exec",
            &json!({"argv":[format!("{system}\\System32\\cmd.exe"),"/d","/s","/c","type %MCP_SANDBOX_INPUT%\\source.txt"],"input_files":["source.txt"]}),
        );
        assert_eq!(result["ok"], true, "{result}");
        assert!(result["stdout"]
            .as_str()
            .unwrap()
            .contains("SOURCE_UNCHANGED"));
        assert_eq!(result["appcontainer_token_verified"], true);
        assert_eq!(result["requested_identity_verified"], true);
        let run_dir = PathBuf::from(result["retained_directory"].as_str().unwrap());
        assert!(run_dir.exists());
        // Wait for actual child activity in scratch, then revoke through the same
        // live-policy entry used by Desktop. No guessed timer is proof of launch.
        let child_ctx = ctx.clone();
        let thread_file = file.clone();
        let start = Instant::now();
        let worker = std::thread::spawn(move || {
            with_test_file(thread_file, || {
                crate::tools::call_tool(
                    &child_ctx,
                    "sandbox_exec",
                    &json!({"argv":["probe.exe","hold"],"input_files":["probe.exe"],"timeout_ms":10000}),
                )
            })
        });
        let mut marker = None;
        while start.elapsed() < Duration::from_secs(6) {
            let runs = home().unwrap().join("runs");
            if let Ok(entries) = fs::read_dir(runs) {
                for e in entries.flatten() {
                    let m = e.path().join("work/started.txt");
                    if m.exists() {
                        marker = Some(m);
                        break;
                    }
                }
            }
            if marker.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        let marker = marker.expect("trusted helper must actually start the controlled child");
        let mut policy = ctx.for_request().unwrap().policy;
        policy.permission_mode = "read-only".into();
        let revision_before = ctx.current_policy_revision().unwrap();
        live_policy::commit_updates(vec![(ctx.clone(), policy, "full".into())], || Ok(())).unwrap();
        let stopped = worker.join().unwrap();
        assert_eq!(stopped["ok"], false, "{stopped}");
        assert!(start.elapsed() < Duration::from_secs(9));
        assert_eq!(ctx.current_policy_revision().unwrap(), revision_before + 1);
        assert!(!permitted(&p.id, ctx.workspace.root()).unwrap());
        std::thread::sleep(Duration::from_millis(2200));
        assert!(
            !marker.parent().unwrap().join("late-marker.txt").exists(),
            "descendant survived live revocation"
        );
        assert_eq!(
            fs::read_to_string(ctx.workspace.root().join("source.txt")).unwrap(),
            "SOURCE_UNCHANGED"
        );
        println!("SNAPSHOT_CONTRACT: real Rust/helper execution, live permission revocation and descendant termination passed; retained {}",base.display());
    });
}
