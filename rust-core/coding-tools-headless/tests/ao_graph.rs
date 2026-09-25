use coding_tools_core::{data::AppData, integrations::ao::*};
use serde_json::json;

fn fixture() -> (AppData, Run) {
    let mut data = AppData::default();
    data.control_board = serde_json::from_value(json!({"revision":2,"tasks":[{
        "id":"task","workspace_id":"qa","title":"Mission","description":"",
        "state":"backlog","step":0,"created_at":1,"updated_at":1,"evidence":[]
    }]}))
    .unwrap();
    let web = Route {
        harness_id: "codex-native".into(),
        provider_id: "chatgpt-web".into(),
        account_id: "web-account".into(),
        model: "chatgpt-web/high".into(),
        permission_profile: ":read-only".into(),
    };
    let worker = Route {
        harness_id: "codex-native".into(),
        provider_id: "cliproxyapi-antigravity".into(),
        account_id: "worker-account".into(),
        model: "gemini-3.8-flash-high".into(),
        permission_profile: ":workspace".into(),
    };
    let node = |id: &str, role: Role, parents: Vec<&str>, route: Route| Node {
        id: id.into(),
        task_id: "task".into(),
        clause_id: None,
        role,
        parents: parents.into_iter().map(str::to_string).collect(),
        x: 0,
        y: 0,
        state: State::Pending,
        route,
        request_key: None,
    };
    let run = Run {
        id: "run".into(),
        workspace_id: "qa".into(),
        project_id: "project".into(),
        revision: 0,
        cancelled: false,
        nodes: vec![
            node("planner", Role::Planner, vec![], web.clone()),
            node("worker-a", Role::Worker, vec!["planner"], worker.clone()),
            node("worker-b", Role::Worker, vec!["planner"], worker),
            node(
                "reviewer",
                Role::Reviewer,
                vec!["worker-a", "worker-b"],
                web,
            ),
        ],
    };
    (data, run)
}

#[test]
fn graph_checks_scope_cycles_joins_and_stale_revisions() {
    let (mut data, run) = fixture();
    assert!(create(&mut data, 1, run.clone()).is_err());
    assert!(data.ao_runs.is_empty());
    let created = create(&mut data, 2, run).unwrap();
    assert_eq!(created.revision, 1);
    let before = serde_json::to_value(&data).unwrap();
    assert!(update_graph(
        &mut data,
        "other",
        "run",
        1,
        GraphChange::MoveNode {
            node_id: "worker-a".into(),
            x: 5,
            y: 5
        }
    )
    .is_err());
    assert!(update_graph(
        &mut data,
        "qa",
        "run",
        0,
        GraphChange::MoveNode {
            node_id: "worker-a".into(),
            x: 5,
            y: 5
        }
    )
    .is_err());
    assert!(update_graph(
        &mut data,
        "qa",
        "run",
        1,
        GraphChange::SetParents {
            node_id: "worker-a".into(),
            parents: vec!["foreign".into()]
        }
    )
    .is_err());
    assert_eq!(serde_json::to_value(&data).unwrap(), before);
    let changed = update_graph(
        &mut data,
        "qa",
        "run",
        1,
        GraphChange::SetParents {
            node_id: "worker-a".into(),
            parents: vec!["planner".into(), "worker-b".into()],
        },
    )
    .unwrap();
    assert_eq!(changed.revision, 2);
    assert!(update_graph(
        &mut data,
        "qa",
        "run",
        2,
        GraphChange::SetParents {
            node_id: "worker-b".into(),
            parents: vec!["planner".into(), "worker-a".into()]
        }
    )
    .is_err());
    assert!(!parents_finished(&data.ao_runs[0], "reviewer"));
    data.ao_runs[0].nodes[0].state = State::Finished;
    data.ao_runs[0].nodes[1].state = State::Finished;
    assert!(!parents_finished(&data.ao_runs[0], "reviewer"));
    data.ao_runs[0].nodes[2].state = State::Finished;
    assert!(parents_finished(&data.ao_runs[0], "reviewer"));
    let reserved = reserve(&mut data, "qa", "run", "reviewer", 2, "request-1".into()).unwrap();
    assert_eq!(reserved.nodes[3].state, State::Reserved);
    let cancelled = cancel(&mut data, "qa", "run", 3).unwrap();
    assert!(cancelled.cancelled);
    assert_eq!(cancelled.nodes[3].state, State::Reserved);
    assert!(reserve(&mut data, "qa", "run", "worker-a", 4, "request-2".into()).is_err());
}
