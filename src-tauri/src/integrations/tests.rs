use super::*;

#[test]
fn control_center_boundaries_and_lossless_board() {
    for raw in [
        "https://example.com",
        "http://localhost:3000",
        "http://127.0.0.2:3000",
        "http://user:pass@127.0.0.1:3000",
        "http://127.0.0.1:3000/tasks",
        "http://127.0.0.1:3000/?token=x",
    ] {
        assert!(endpoint(Source::Anneal, raw).is_err(), "{raw}");
    }
    assert_eq!(
        endpoint(Source::Paseo, "ws://127.0.0.1:6767")
            .unwrap()
            .path(),
        "/ws"
    );
    assert!(endpoint(Source::Anneal, "http://[::1]:3000/").is_ok());
    for (status, phase, expected) in [
        ("DONE", "finished", false),
        ("TODO", "queued", false),
        ("REVIEW", "finished", true),
        ("DOING", "waiting-inbox", true),
        ("DOING", "executing", false),
    ] {
        let row = item(
            &json!({"id":"gate","status":status,"approvalGate":true,"latestRun":{"phase":phase}}),
            Source::Anneal,
        )
        .unwrap();
        assert_eq!(row.requires_attention, expected, "{status}/{phase}");
    }
    let mut b = board::Board::default();
    board::apply(
        &mut b,
        0,
        board::Change::Create {
            workspace_id: "w".into(),
            title: "Deliver".into(),
            description: "Spec".into(),
            state: None,
        },
    )
    .unwrap();
    let id = b.tasks[0].id.clone();
    assert!(board::apply(&mut b, 0, board::Change::Start { id: id.clone() }).is_err());
    board::apply(&mut b, 1, board::Change::Start { id: id.clone() }).unwrap();
    assert!(board::apply(
        &mut b,
        2,
        board::Change::RecordStep {
            id: id.clone(),
            note: " ".into()
        }
    )
    .is_err());
    for n in 0..12 {
        let r = b.revision;
        board::apply(
            &mut b,
            r,
            board::Change::RecordStep {
                id: id.clone(),
                note: format!("Operator evidence {n}"),
            },
        )
        .unwrap();
    }
    assert_eq!(b.tasks[0].state, "done");
    let r = b.revision;
    board::apply(&mut b, r, board::Change::Archive { id: id.clone() }).unwrap();
    assert_eq!(b.tasks.len(), 1);
    assert_eq!(b.tasks[0].evidence.len(), 12);
    let r = b.revision;
    board::apply(&mut b, r, board::Change::Restore { id }).unwrap();
    assert_eq!(b.tasks[0].state, "done");
    assert!(b.tasks[0]
        .evidence
        .iter()
        .all(|e| e.source == "operator_attestation"));
    assert!(
        serde_json::from_value::<board::Change>(json!({"operation":"run","provider":"codex"}))
            .is_err()
    );
    let migrated: crate::data::AppData = serde_json::from_value(json!({"profiles":[]})).unwrap();
    assert!(migrated.control_board.tasks.is_empty());
}

#[tokio::test]
async fn control_center_anneal_read_is_retired_before_network() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let error = tokio::time::timeout(Duration::from_millis(250), read(Source::Anneal, &url, ""))
        .await
        .expect("retired read returns before network")
        .unwrap_err();
    assert!(error.to_string().contains("retired"), "{error}");
    assert!(matches!(
        listener.accept(),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
    ));
}

#[tokio::test]
async fn control_center_paseo_read_is_retired_before_network() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let error = tokio::time::timeout(Duration::from_millis(250), read(Source::Paseo, &url, ""))
        .await
        .expect("retired read returns before network")
        .unwrap_err();
    assert!(error.to_string().contains("retired"), "{error}");
    assert!(matches!(
        listener.accept(),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
    ));
}
#[test]
fn original_function_allowlists_are_explicit() {
    assert!(actions::allowed_paseo_ops().contains(&"send_agent_message_request"));
    assert!(actions::allowed_paseo_ops().contains(&"agent_permission_response"));
    assert!(actions::allowed_paseo_ops().contains(&"create_agent_request"));
    assert!(!actions::allowed_paseo_ops()
        .iter()
        .any(|op| op.contains("shutdown")));
    assert!(actions::allowed_anneal_posts().contains(&"/tasks/{id}/start"));
    assert!(actions::allowed_anneal_posts().contains(&"/inbox/messages/{id}/decision"));
    assert!(!actions::allowed_anneal_posts()
        .iter()
        .any(|p| p.contains("merge-tail")));
}

#[test]
fn paseo_directory_payload_maps_persistence_and_permission() {
    let snap = snapshot_from_paseo_payload(
        "ws://127.0.0.1:6767/ws".into(),
        Some("test".into()),
        &json!({
            "entries": [{
                "agent": {
                    "id": "a1",
                    "title": "Existing session",
                    "status": "idle",
                    "provider": "codex",
                    "persistence": { "provider": "codex", "sessionId": "sess-1" },
                    "pendingPermissions": [{ "id": "perm-1" }]
                }
            }],
            "pageInfo": { "hasMore": false }
        }),
    )
    .unwrap();
    assert_eq!(snap.items[0].persistence_session.as_deref(), Some("sess-1"));
    assert_eq!(
        snap.items[0].pending_permission_id.as_deref(),
        Some("perm-1")
    );
    assert!(snap.read_only);
}

#[test]
fn integration_leases_are_additive_on_old_profiles() {
    let migrated: crate::data::AppData = serde_json::from_value(json!({"profiles":[]})).unwrap();
    assert!(!migrated.integration_leases.paseo.keep_alive);
    assert_eq!(
        migrated.integration_leases.commandcode.status,
        "disconnected"
    );
}

#[tokio::test]
async fn control_center_paseo_action_is_retired_before_network() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let error = tokio::time::timeout(
        Duration::from_millis(250),
        actions::act(
            &url,
            "",
            actions::ActRequest {
                source: "paseo".into(),
                op: "send".into(),
                agent_id: "a1".into(),
                task_id: String::new(),
                message_id: String::new(),
                text: "hello".into(),
                provider: String::new(),
                session_id: String::new(),
                request_id: String::new(),
                cwd: String::new(),
                behavior: String::new(),
            },
        ),
    )
    .await
    .expect("retired action returns before network")
    .unwrap_err();
    assert!(error.to_string().contains("retired"), "{error}");
    assert!(matches!(
        listener.accept(),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
    ));
}
#[test]
fn old_paseo_records_remain_readable() {
    let data: crate::data::AppData = serde_json::from_value(json!({
        "integration_leases": {"paseo": {
            "endpoint": "ws://127.0.0.1:6768/ws",
            "client_id": "old-client",
            "keep_alive": true
        }, "anneal": {
            "endpoint": "http://127.0.0.1:3000/", "keep_alive": true
        }, "commandcode": {
            "endpoint": "http://127.0.0.1:7000/", "keep_alive": true
        }},
        "execution_book": {"bindings": [{
            "id": "old-binding", "workspace_id": "qa", "root": "C:/qa",
            "roots_revision": "roots", "policy_stamp": "policy",
            "generation": "old-generation", "engine": "paseo",
            "endpoint": "ws://127.0.0.1:6768/ws",
            "provider": "codex", "model": "legacy", "mode": "default",
            "project_id": null, "repo_id": null, "assignee_id": null,
            "max_duration_min": 10, "allow_codex": false, "enabled": true
        }, {
            "id": "old-anneal-binding", "workspace_id": "qa", "root": "C:/qa",
            "roots_revision": "roots", "policy_stamp": "policy",
            "generation": "old-generation", "engine": "anneal",
            "endpoint": "http://127.0.0.1:3000/",
            "provider": "legacy", "model": "legacy", "mode": "default",
            "project_id": null, "repo_id": null, "assignee_id": null,
            "max_duration_min": 10, "allow_codex": false, "enabled": true
        }]}
    }))
    .unwrap();
    assert_eq!(
        data.integration_leases.paseo.client_id.as_deref(),
        Some("old-client")
    );
    assert!(data.integration_leases.paseo.keep_alive);
    assert!(data.integration_leases.anneal.keep_alive);
    assert!(data.integration_leases.commandcode.keep_alive);
    assert_eq!(
        serde_json::from_value::<Source>(json!("anneal")).unwrap(),
        Source::Anneal
    );
    assert_eq!(
        data.execution_book.bindings[0].engine,
        execution::model::Engine::Paseo
    );
    assert_eq!(
        data.execution_book.bindings[0].endpoint,
        "ws://127.0.0.1:6768/ws"
    );
    assert_eq!(
        data.execution_book.bindings[1].engine,
        execution::model::Engine::Anneal
    );
    assert_eq!(
        data.execution_book.bindings[1].endpoint,
        "http://127.0.0.1:3000/"
    );
}

#[tokio::test]
async fn control_center_anneal_action_is_retired_before_network() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let error = tokio::time::timeout(
        Duration::from_millis(250),
        actions::act(
            &url,
            "fixture-token",
            actions::ActRequest {
                source: "anneal".into(),
                op: "start".into(),
                agent_id: String::new(),
                task_id: "t1".into(),
                message_id: String::new(),
                text: String::new(),
                provider: String::new(),
                session_id: String::new(),
                request_id: String::new(),
                cwd: String::new(),
                behavior: String::new(),
            },
        ),
    )
    .await
    .expect("retired action returns before network")
    .unwrap_err();
    assert!(error.to_string().contains("retired"), "{error}");
    let commandcode = actions::act(
        &url,
        "",
        actions::ActRequest {
            source: "commandcode".into(),
            op: "start".into(),
            agent_id: String::new(),
            task_id: "t1".into(),
            message_id: String::new(),
            text: String::new(),
            provider: String::new(),
            session_id: String::new(),
            request_id: String::new(),
            cwd: String::new(),
            behavior: String::new(),
        },
    )
    .await
    .unwrap_err();
    assert!(commandcode.to_string().contains("retired"), "{commandcode}");
    let direct = tokio::time::timeout(
        Duration::from_millis(250),
        actions::anneal_post(&url, "", "/tasks/t1/start", json!({})),
    )
    .await
    .expect("retired helper returns before network")
    .unwrap_err();
    assert!(direct.to_string().contains("retired"), "{direct}");
    assert!(actions::anneal_inbox(&url, "")
        .await
        .unwrap_err()
        .to_string()
        .contains("retired"));
    assert!(matches!(
        listener.accept(),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
    ));
}
