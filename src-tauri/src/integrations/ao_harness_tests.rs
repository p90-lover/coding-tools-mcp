//! Controller regressions for adaptive worker selection and host-observed acceptance.
use super::*;
use serde_json::json;
use std::path::Path;

fn fixture(review_parts: bool) -> (tempfile::TempDir, AppData) {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .find(|path| path.join("src-tauri").is_dir())
        .expect("repository");
    let dir = tempfile::Builder::new()
        .prefix("ao-harness-")
        .tempdir_in(repo.join("aiTemp"))
        .unwrap();
    let mut data: AppData = serde_json::from_value(json!({
        "profiles":[{"id":"qa","name":"QA","path":dir.path().to_string_lossy(),
            "tunnel":{},"auth":{"type":"bearer"},"runtime":{},"actions":{}}],
        "control_board":{"revision":1,"tasks":[{"id":"task","workspace_id":"qa",
            "title":"Check the implementation","description":"Implement and verify the requested change",
            "state":"pending","step":0,"created_at":0,"updated_at":0,"clauses":[],"evidence":[]}]}
    })).unwrap();
    let route = json!({"harness_id":"ao:codex","provider_id":"agent-orchestrator",
        "account_id":"ao-local","model":"cpa/test-model","permission_profile":":ao-default"});
    let mut nodes: Vec<Node> = ["planner", "gate", "w1", "w2", "reviewer"]
        .iter()
        .zip(["planner", "approver", "worker", "worker", "reviewer"])
        .map(|(id, role)| {
            serde_json::from_value(json!({
                "id":id,"task_id":"task","role":role,"parents":[],
                "x":0,"y":0,"state":"pending","route":route
            }))
            .unwrap()
        })
        .collect();
    if review_parts {
        for id in ["sub-a", "sub-b"] {
            nodes.push(
                serde_json::from_value(json!({
                    "id":id,"task_id":"task","role":"sub_reviewer","parents":[],
                    "x":0,"y":0,"state":"pending","route":route
                }))
                .unwrap(),
            );
        }
    }
    super::super::ao_team::normalize_roles(&mut nodes);
    let run: Run = serde_json::from_value(json!({
        "id":"run","workspace_id":"qa","project_id":"p","revision":0,"nodes":nodes
    }))
    .unwrap();
    create(&mut data, 1, run).unwrap();
    grant_run(&mut data, "qa", "run", 1, &"a".repeat(64), 1_000).unwrap();
    (dir, data)
}

fn turn(data: &mut AppData, id: &str, answer: &str) -> Run {
    let observed = data.profiles[0].path.clone();
    turn_at_workspace(data, id, answer, Some(&observed))
}

fn turn_at_workspace(data: &mut AppData, id: &str, answer: &str, observed: Option<&str>) -> Run {
    let revision = data.ao_runs[0].revision;
    let key = format!("{id}-{revision}");
    let thread = format!("thread-{key}");
    reserve(data, "qa", "run", id, revision, key.clone(), Some(1_001)).unwrap();
    record_submission(data, "qa", "run", id, &key, Some(&thread)).unwrap();
    record_terminal_at_workspace(
        data,
        "qa",
        "run",
        id,
        &thread,
        Some(&format!("turn-{key}")),
        Some(answer),
        true,
        None,
        observed,
    )
    .unwrap()
}

fn plan(items: serde_json::Value) -> String {
    format!("Plan\n```assignments\n{items}\n```")
}

#[test]
fn ao_adaptive_plan_skips_only_explicit_workers_and_keeps_all_review_gates() {
    let (_dir, mut data) = fixture(true);
    let planned = turn(
        &mut data,
        "planner",
        &plan(json!([
            {"worker":"w1","task":"Implement the small change","acceptance":"Verified result"},
            {"worker":"w2","skip_reason":"One implementation owner is sufficient"}
        ])),
    );
    let skipped = planned.nodes.iter().find(|node| node.id == "w2").unwrap();
    assert_eq!(skipped.state, State::Finished);
    assert!(skipped.receipt.is_none() && skipped.request_key.is_none());
    assert_eq!(planned.grant.as_ref().unwrap().turns_started, 1);
    assert!(reserve(
        &mut data,
        "qa",
        "run",
        "w2",
        planned.revision,
        "unused".into(),
        Some(1_001)
    )
    .is_err());
    assert!(prompt_for_node(&data, &planned, "gate")
        .unwrap()
        .contains("One implementation owner"));
    turn(&mut data, "gate", "APPROVED: scoped plan");
    turn(
        &mut data,
        "w1",
        "Implementation and verification are complete",
    );
    let split = data.ao_runs[0]
        .nodes
        .iter()
        .find(|node| node.role == Role::ReviewSplit)
        .unwrap()
        .id
        .clone();
    let roster = review_split_roster(&data.ao_runs[0]);
    assert!(roster.contains("Worker cards: `w1`"));
    assert!(!roster.contains("`w2`"));
    turn(&mut data, &split, "Split\n```review-parts\n[{\"sub_reviewer\":\"sub-a\",\"workers\":[\"w1\"]},{\"sub_reviewer\":\"sub-b\",\"workers\":[\"w1\"]}]\n```");
    for id in ["sub-a", "sub-b"] {
        assert!(prompt_for_node(&data, &data.ao_runs[0], id).is_ok());
        turn(&mut data, id, "PART_OK: checked the selected work");
    }
    let reviewed = turn(
        &mut data,
        "reviewer",
        "CHANGES_REQUIRED: improve the result",
    );
    let key = reviewed
        .nodes
        .iter()
        .find(|node| node.id == "reviewer")
        .unwrap()
        .receipt
        .as_ref()
        .unwrap()
        .request_key
        .clone();
    assert_eq!(reviewed.grant.as_ref().unwrap().turns_started, 7);
    let rework =
        super::super::ao_team::queue_rework(&mut data, "qa", "run", "reviewer", &key, 1_001)
            .unwrap()
            .unwrap();
    assert_eq!(
        rework
            .nodes
            .iter()
            .find(|node| node.id == "w1")
            .unwrap()
            .state,
        State::Pending
    );
    let skipped = rework.nodes.iter().find(|node| node.id == "w2").unwrap();
    assert_eq!(skipped.state, State::Finished);
    assert!(skipped.receipt.is_none() && skipped.history.is_empty());
    assert_eq!(
        rework
            .nodes
            .iter()
            .find(|node| node.id == "gate")
            .unwrap()
            .state,
        State::Finished
    );
}

#[test]
fn ao_approver_replan_can_keep_or_activate_previously_skipped_workers() {
    for activate in [false, true] {
        let (_dir, mut data) = fixture(false);
        turn(
            &mut data,
            "planner",
            &plan(json!([
                {"worker":"w1","task":"Selected work"},{"worker":"w2","skip_reason":"Unneeded in first plan"}
            ])),
        );
        let rejected = turn(&mut data, "gate", "CHANGES_REQUIRED: clarify the plan");
        let key = rejected
            .nodes
            .iter()
            .find(|node| node.id == "gate")
            .unwrap()
            .receipt
            .as_ref()
            .unwrap()
            .request_key
            .clone();
        let queued =
            super::super::ao_team::queue_rework(&mut data, "qa", "run", "gate", &key, 1_001)
                .unwrap()
                .unwrap();
        let unused = queued.nodes.iter().find(|node| node.id == "w2").unwrap();
        assert_eq!(unused.state, State::Pending);
        assert!(unused.receipt.is_none() && unused.history.is_empty());
        let worker2 = if activate {
            json!({"worker":"w2","task":"Newly required independent verification"})
        } else {
            json!({"worker":"w2","skip_reason":"Still unnecessary"})
        };
        let replanned = turn(
            &mut data,
            "planner",
            &plan(json!([
                {"worker":"w1","task":"Clarified implementation"}, worker2
            ])),
        );
        assert_eq!(
            replanned
                .nodes
                .iter()
                .find(|node| node.id == "planner")
                .unwrap()
                .state,
            State::Finished
        );
        assert_eq!(
            replanned
                .nodes
                .iter()
                .find(|node| node.id == "w2")
                .unwrap()
                .state,
            if activate {
                State::Pending
            } else {
                State::Finished
            }
        );
        turn(&mut data, "gate", "APPROVED: replacement plan");
        turn(&mut data, "w1", "Implementation complete");
        if activate {
            turn(&mut data, "w2", "Independent verification complete");
        }
        assert!(prompt_for_node(&data, &data.ao_runs[0], "reviewer").is_ok());
        let done = turn(&mut data, "reviewer", "APPROVED: selected work verified");
        assert_eq!(
            done.nodes
                .iter()
                .find(|node| node.id == "reviewer")
                .unwrap()
                .state,
            State::Finished
        );
    }
}

#[test]
fn ao_adaptive_selection_rejects_hidden_dependencies_and_preserves_legacy_assignments() {
    let (_dir, data) = fixture(false);
    let run = &data.ao_runs[0];
    let legacy = parse_assignments(
        &plan(json!([{"worker":"w1","task":"Legacy partial plan"}])),
        run,
    )
    .unwrap();
    assert_eq!(legacy.len(), 1);
    assert!(legacy["w1"].skip_reason.is_none());
    assert_eq!(
        serde_json::to_value(&legacy["w1"]).unwrap(),
        json!({"task":"Legacy partial plan","acceptance":""})
    );
    let adaptive = plan(json!([
        {"worker":"w1","task":"Selected work"},{"worker":"w2","skip_reason":"Unneeded"}
    ]));
    let mut dependency = run.clone();
    dependency
        .nodes
        .iter_mut()
        .find(|node| node.id == "w1")
        .unwrap()
        .parents
        .push("w2".into());
    assert!(parse_assignments(&adaptive, &dependency).is_err());
    let mut explicit_clause = run.clone();
    explicit_clause
        .nodes
        .iter_mut()
        .find(|node| node.id == "w2")
        .unwrap()
        .clause_id = Some("required-step".into());
    assert!(parse_assignments(&adaptive, &explicit_clause).is_err());
    assert!(parse_assignments(
        &plan(json!([
            {"worker":"w1","skip_reason":"Unneeded"},{"worker":"w2","skip_reason":"Unneeded"}
        ])),
        run
    )
    .is_err());
    assert!(parse_assignments(&plan(json!([
        {"worker":"w1","task":"Work","skip_reason":"Contradictory"},{"worker":"w2","task":"Work"}
    ])), run).is_err());
}

#[test]
fn ao_host_acceptance_rejects_missing_failed_stale_and_changed_artifact_evidence() {
    let (dir, mut data) = fixture(false);
    let expected = format!("{:x}", Sha256::digest(b"expected bytes"));
    turn(
        &mut data,
        "planner",
        &plan(json!([
            {"worker":"w1","task":"Produce the exact fixture","acceptance":"Expected artifact bytes",
                "checks":[{"kind":"artifact_sha256","path":"out.txt","sha256":expected}]},
            {"worker":"w2","skip_reason":"Only one output is needed"}
        ])),
    );
    turn(&mut data, "gate", "APPROVED: local bounded artifact check");
    let missing = turn(&mut data, "w1", "Done, tests passed");
    let receipt = missing
        .nodes
        .iter()
        .find(|node| node.id == "w1")
        .unwrap()
        .receipt
        .as_ref()
        .unwrap();
    assert_eq!(
        receipt.status, "held",
        "prose cannot replace missing host evidence"
    );
    assert_eq!(receipt.acceptance_evidence.len(), 1);
    assert!(!receipt.acceptance_evidence[0].passed);
    let old_attempt = receipt.request_key.clone();
    super::super::ao_team::control_selected(&mut data, "qa", "run", "retry", Some("w1")).unwrap();
    std::fs::write(dir.path().join("out.txt"), b"expected bytes").unwrap();
    let completed = turn(&mut data, "w1", "Created the expected artifact");
    let worker = completed.nodes.iter().find(|node| node.id == "w1").unwrap();
    assert_eq!(worker.state, State::Finished);
    let receipt = worker.receipt.as_ref().unwrap();
    assert!(receipt.acceptance_evidence[0].passed);
    assert_ne!(
        receipt.acceptance_evidence[0].worker_request_key,
        old_attempt
    );
    assert_eq!(worker.history.len(), 1);
    let ready = data.clone();
    for mode in ["missing", "failed", "stale-worker", "stale-plan"] {
        let mut invalid = ready.clone();
        let run = &mut invalid.ao_runs[0];
        let worker = run.nodes.iter_mut().find(|node| node.id == "w1").unwrap();
        let evidence = &mut worker.receipt.as_mut().unwrap().acceptance_evidence;
        match mode {
            "missing" => evidence.clear(),
            "failed" => evidence[0].passed = false,
            "stale-worker" => evidence[0].worker_request_key = "old-worker".into(),
            "stale-plan" => {
                run.assignments.get_mut("w1").unwrap().planner_request_key = Some("old-plan".into())
            }
            _ => unreachable!(),
        }
        let held = turn(&mut invalid, "reviewer", "APPROVED: looks correct");
        let reviewer = held
            .nodes
            .iter()
            .find(|node| node.id == "reviewer")
            .unwrap();
        assert_eq!(reviewer.state, State::Held, "{mode}");
        assert_eq!(
            reviewer.receipt.as_ref().unwrap().verdict.as_deref(),
            Some("CHANGES_REQUIRED"),
            "{mode}"
        );
    }
    std::fs::write(
        dir.path().join("out.txt"),
        b"changed after worker verification",
    )
    .unwrap();
    let mut changed = ready.clone();
    let held = turn(
        &mut changed,
        "reviewer",
        "APPROVED: reviewed an earlier snapshot",
    );
    assert_eq!(
        held.nodes
            .iter()
            .find(|node| node.id == "reviewer")
            .unwrap()
            .state,
        State::Held
    );
    std::fs::write(dir.path().join("out.txt"), b"expected bytes").unwrap();
    let mut valid = ready;
    let done = turn(
        &mut valid,
        "reviewer",
        "APPROVED: expected bytes and semantic review complete",
    );
    assert_eq!(
        done.nodes
            .iter()
            .find(|node| node.id == "reviewer")
            .unwrap()
            .state,
        State::Finished
    );
    assert!(validate(Some(&valid), &done).is_ok());
}

#[test]
fn ao_artifact_review_context_shares_one_budget_across_workers_and_checks() {
    let (dir, mut data) = fixture(false);
    let mut extra = data.ao_runs[0]
        .nodes
        .iter()
        .find(|node| node.id == "w2")
        .unwrap()
        .clone();
    extra.id = "w3".into();
    data.ao_runs[0].nodes.push(extra);
    super::super::ao_team::normalize_roles(&mut data.ao_runs[0].nodes);
    data.ao_runs[0].grant = None;
    let revision = data.ao_runs[0].revision;
    grant_run(&mut data, "qa", "run", revision, &"a".repeat(64), 1_000).unwrap();
    let expected = format!("{:x}", Sha256::digest(b"expected bytes"));
    let mut assignments = Vec::new();
    for worker in ["w1", "w2", "w3"] {
        let mut checks = Vec::new();
        for index in 0..8 {
            let path = format!("{worker}-artifact-{index}.txt");
            std::fs::write(dir.path().join(&path), b"expected bytes").unwrap();
            checks.push(json!({"kind":"artifact_sha256","path":path,"sha256":expected}));
        }
        assignments.push(json!({"worker":worker,"task":"Produce verified artifacts",
            "acceptance":"Exact expected bytes", "checks":checks}));
    }
    turn(&mut data, "planner", &plan(json!(assignments)));
    turn(&mut data, "gate", "APPROVED: bounded file checks");
    let long_output = "Implementation and verification details. ".repeat(250);
    for worker in ["w1", "w2", "w3"] {
        let completed = turn(&mut data, worker, &long_output);
        assert_eq!(
            completed
                .nodes
                .iter()
                .find(|node| node.id == worker)
                .unwrap()
                .state,
            State::Finished
        );
    }
    let prompt = prompt_for_node(&data, &data.ao_runs[0], "reviewer").unwrap();
    assert!(prompt.len() <= 16_000);
    assert!(prompt.contains("Parent excerpts may be truncated"));
    assert!(prompt.contains("failed_check_indexes"));
    for worker in ["w1", "w2", "w3"] {
        assert!(prompt.contains(&format!("\"worker\":\"{worker}\"")));
    }
    let done = turn(
        &mut data,
        "reviewer",
        "APPROVED: independent semantic review complete",
    );
    assert_eq!(
        done.nodes
            .iter()
            .find(|node| node.id == "reviewer")
            .unwrap()
            .state,
        State::Finished
    );
}

#[test]
fn ao_typed_checks_require_confirmed_folder_root_and_do_not_fall_back_to_primary() {
    let (primary, mut data) = fixture(false);
    let (outside, _unused) = fixture(false);
    std::fs::write(primary.path().join("out.txt"), b"primary bytes").unwrap();
    std::fs::write(outside.path().join("out.txt"), b"worktree bytes").unwrap();
    let expected = format!("{:x}", Sha256::digest(b"primary bytes"));
    turn(
        &mut data,
        "planner",
        &plan(json!([
            {"worker":"w1","task":"Produce exact artifact","checks":[
                {"kind":"artifact_sha256","path":"out.txt","sha256":expected}
            ]},
            {"worker":"w2","skip_reason":"One artifact owner"}
        ])),
    );
    turn(&mut data, "gate", "APPROVED: scoped folder checks");
    let ready = data.clone();
    let outside_root = outside.path().to_string_lossy().into_owned();
    for observed in [None, Some("relative/root"), Some(outside_root.as_str())] {
        let mut invalid = ready.clone();
        let held = turn_at_workspace(
            &mut invalid,
            "w1",
            "Completed in worker workspace",
            observed,
        );
        let worker = held.nodes.iter().find(|node| node.id == "w1").unwrap();
        assert_eq!(worker.state, State::Held, "{observed:?}");
        let receipt = worker.receipt.as_ref().unwrap();
        assert!(
            receipt.acceptance_evidence.is_empty(),
            "unknown/different root must fail before opening artifacts"
        );
        assert!(receipt.acceptance_workspace_root.is_none());
        assert!(receipt.error.as_deref().unwrap().contains("workspace"));
    }
    let mut valid = ready;
    let completed = turn(&mut valid, "w1", "Completed in the confirmed folder");
    let worker = completed.nodes.iter().find(|node| node.id == "w1").unwrap();
    assert_eq!(worker.state, State::Finished);
    assert_eq!(
        worker
            .receipt
            .as_ref()
            .unwrap()
            .acceptance_workspace_root
            .as_deref(),
        Some(
            primary
                .path()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .as_ref()
        )
    );
    // The reviewer started under the old registered root, which changes before its final turn.
    let revision = valid.ao_runs[0].revision;
    reserve(
        &mut valid,
        "qa",
        "run",
        "reviewer",
        revision,
        "review-root".into(),
        Some(1_001),
    )
    .unwrap();
    record_submission(
        &mut valid,
        "qa",
        "run",
        "reviewer",
        "review-root",
        Some("review-root-thread"),
    )
    .unwrap();
    // Matching bytes at a different root cannot revive evidence recorded against the first root.
    std::fs::write(outside.path().join("out.txt"), b"primary bytes").unwrap();
    valid.profiles[0].path = outside_root;
    let held = record_terminal_at_workspace(
        &mut valid,
        "qa",
        "run",
        "reviewer",
        "review-root-thread",
        Some("review-root-turn"),
        Some("APPROVED: bytes match"),
        true,
        None,
        None,
    )
    .unwrap();
    let reviewer = held
        .nodes
        .iter()
        .find(|node| node.id == "reviewer")
        .unwrap();
    assert_eq!(reviewer.state, State::Held);
    assert!(reviewer
        .receipt
        .as_ref()
        .unwrap()
        .error
        .as_deref()
        .unwrap()
        .contains("workspace"));
}

#[test]
fn ao_native_typed_checks_use_the_controller_registered_root_without_external_claims() {
    let (dir, mut data) = fixture(false);
    let worker = data.ao_runs[0]
        .nodes
        .iter_mut()
        .find(|node| node.id == "w1")
        .unwrap();
    worker.route = serde_json::from_value(json!({
        "harness_id":"codex-native","provider_id":"cliproxyapi-antigravity",
        "account_id":"shared-cpa-pool","model":"test-model","permission_profile":":workspace"
    }))
    .unwrap();
    data.ao_runs[0].grant = None;
    let revision = data.ao_runs[0].revision;
    grant_run(&mut data, "qa", "run", revision, &"a".repeat(64), 1_000).unwrap();
    std::fs::write(dir.path().join("out.txt"), b"native bytes").unwrap();
    turn(
        &mut data,
        "planner",
        &plan(json!([
            {"worker":"w1","task":"Create known bytes","checks":[
                {"kind":"artifact_sha256","path":"out.txt","sha256":format!("{:x}", Sha256::digest(b"native bytes"))}
            ]},
            {"worker":"w2","skip_reason":"One output"}
        ])),
    );
    turn(&mut data, "gate", "APPROVED: native local check");
    let revision = data.ao_runs[0].revision;
    reserve(
        &mut data,
        "qa",
        "run",
        "w1",
        revision,
        "native-worker".into(),
        Some(1_001),
    )
    .unwrap();
    record_submission(
        &mut data,
        "qa",
        "run",
        "w1",
        "native-worker",
        Some("native-thread"),
    )
    .unwrap();
    // This is the existing native API, with no externally supplied root.
    let done = record_terminal(
        &mut data,
        "qa",
        "run",
        "w1",
        "native-thread",
        Some("native-turn"),
        Some("Native output complete"),
        true,
        None,
    )
    .unwrap();
    let worker = done.nodes.iter().find(|node| node.id == "w1").unwrap();
    assert_eq!(worker.state, State::Finished);
    assert!(worker.receipt.as_ref().unwrap().acceptance_evidence[0].passed);
    assert!(worker
        .receipt
        .as_ref()
        .unwrap()
        .acceptance_workspace_root
        .is_some());
}
