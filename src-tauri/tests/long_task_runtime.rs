use coding_tools_mcp_desktop_lib::tools::{call_tool, ToolContext};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

// Retain every fixture under aiTemp; no cleanup or provider/model calls.
fn py(arguments: &str) -> String {
    format!(
        "{} {arguments}",
        if cfg!(windows) { "python" } else { "python3" }
    )
}
fn fixture() -> (ToolContext, PathBuf) {
    let base = std::env::current_dir()
        .unwrap()
        .join("aiTemp/long-runtime")
        .join(uuid::Uuid::new_v4().to_string());
    let root = base.join("project");
    fs::create_dir_all(root.join("aiTemp")).unwrap();
    (
        ToolContext::for_test(root, base.join("store")).unwrap(),
        base,
    )
}
fn wait(ctx: &ToolContext, id: &str) -> Value {
    let until = Instant::now() + Duration::from_secs(8);
    loop {
        let value = call_tool(
            ctx,
            "write_stdin",
            &json!({"command_id":id,"chars":"","yield_time_ms":0,"max_output_bytes":1024}),
        );
        assert_eq!(value["ok"], true, "{value}");
        if value["status"] == "exited" && value["finalization_pending"] != true {
            return value;
        }
        assert!(Instant::now() < until, "command did not terminate: {value}");
        thread::sleep(Duration::from_millis(30));
    }
}

#[test]
fn zero_wait_delivers_stdin_and_completed_clock_stops() {
    let (ctx, _) = fixture();
    fs::write(
        ctx.workspace.root().join("aiTemp/stdin.py"),
        "import sys\nprint(sys.stdin.readline().strip(), flush=True)\n",
    )
    .unwrap();
    let launched = call_tool(
        &ctx,
        "exec_command",
        &json!({"cmd":py("-X utf8 aiTemp/stdin.py"), "stdin":"received\n", "yield_time_ms":0, "timeout_ms":2500}),
    );
    assert_eq!(launched["ok"], true, "{launched}");
    let id = launched["command_id"].as_str().unwrap();
    let first = wait(&ctx, id);
    assert_eq!(first["command_ok"], true, "{first}");
    assert!(
        first["stdout"].as_str().unwrap().contains("received"),
        "{first}"
    );
    thread::sleep(Duration::from_millis(120));
    let second = wait(&ctx, id);
    assert_eq!(
        first["elapsed_ms"], second["elapsed_ms"],
        "finished commands must not accumulate caller/poll delay"
    );
}

#[test]
fn output_cursor_survives_rollover_and_kill_retains_evidence() {
    let (ctx, _) = fixture();
    fs::write(ctx.workspace.root().join("aiTemp/output.py"), "import sys,time\nsys.stdout.buffer.write(b'x'*1100000+b'END')\nsys.stdout.flush()\ntime.sleep(30)\n").unwrap();
    let launched = call_tool(
        &ctx,
        "exec_command",
        &json!({"cmd":py("-X utf8 aiTemp/output.py"),"yield_time_ms":0}),
    );
    assert_eq!(launched["ok"], true, "{launched}");
    let id = launched["command_id"].as_str().unwrap();
    let output_ref = format!("command:{id}:stdout");
    let until = Instant::now() + Duration::from_secs(8);
    let page = loop {
        let v = call_tool(
            &ctx,
            "read_output",
            &json!({"output_ref":output_ref,"offset":1099998,"limit":10}),
        );
        if v["total_stream_bytes"].as_u64().unwrap_or(0) == 1100003 {
            break v;
        }
        assert!(Instant::now() < until, "{v}");
        thread::sleep(Duration::from_millis(30));
    };
    let killed = call_tool(
        &ctx,
        "kill_command",
        &json!({"command_id":id,"wait_ms":1000}),
    );
    assert_eq!(killed["ok"], true, "{killed}");
    assert_eq!(
        page["content"], "xxEND",
        "absolute cursors must not be interpreted as offsets into the rolling tail: {page}"
    );
    let retained = call_tool(
        &ctx,
        "read_output",
        &json!({"output_ref":output_ref,"offset":1100000,"limit":3}),
    );
    assert_eq!(
        retained["content"], "END",
        "cancellation must preserve diagnostic output: {retained}"
    );
}

#[test]
fn explicit_linked_project_tasks_do_not_share_baselines() {
    let (ctx, base) = fixture();
    let linked = base.join("other-project");
    fs::create_dir_all(&linked).unwrap();
    fs::write(linked.join("source.txt"), "linked baseline").unwrap();
    fs::write(ctx.workspace.root().join("code.txt"), "primary baseline").unwrap();
    fs::write(
        ctx.workspace.root().join("AGENTS.md"),
        "Preserve project files.\n",
    )
    .unwrap();
    fs::create_dir_all(linked.join("aiTemp")).unwrap();
    let worker="from pathlib import Path\nimport time\nwhile not Path('aiTemp/release').exists(): time.sleep(0.02)\nprint(Path.cwd(),flush=True)\n";
    fs::write(ctx.workspace.root().join("aiTemp/wait.py"), worker).unwrap();
    fs::write(linked.join("aiTemp/wait.py"), worker).unwrap();
    fs::create_dir_all(ctx.workspace.root().join(".mcp-paths")).unwrap();
    fs::write(
        ctx.workspace.root().join(".mcp-paths/peer.txt"),
        format!("name=peer\npath={}\nmode=read-write\n", linked.display()),
    )
    .unwrap();
    let a = call_tool(
        &ctx,
        "start_task",
        &json!({"objective":"primary","project_root":".","baseline_roots":["code.txt"]}),
    );
    let b = call_tool(
        &ctx,
        "start_task",
        &json!({"objective":"linked","project_root":"@peer","baseline_roots":["source.txt"]}),
    );
    assert_eq!(a["ok"], true, "{a}");
    assert_eq!(b["ok"], true, "{b}");
    assert_ne!(
        a["task"]["workspace_id"], b["task"]["workspace_id"],
        "linked tasks must bind to their own approved project"
    );
    let job_a = call_tool(
        &ctx,
        "exec_command",
        &json!({"cmd":py("aiTemp/wait.py"),"project_root":".","task_id":a["task"]["id"],"yield_time_ms":0,"timeout_ms":5000}),
    );
    let job_b = call_tool(
        &ctx,
        "exec_command",
        &json!({"cmd":py("aiTemp/wait.py"),"project_root":"@peer","workdir":".","task_id":b["task"]["id"],"yield_time_ms":0,"timeout_ms":5000}),
    );
    assert_eq!(job_a["status"], "running", "{job_a}");
    assert_eq!(job_b["status"], "running", "{job_b}");
    fs::write(ctx.workspace.root().join("aiTemp/release"), "go").unwrap();
    fs::write(linked.join("aiTemp/release"), "go").unwrap();
    let done_a = wait(&ctx, job_a["command_id"].as_str().unwrap());
    let done_b = wait(&ctx, job_b["command_id"].as_str().unwrap());
    assert_eq!(done_a["command_ok"], true, "{done_a}");
    assert_eq!(done_b["command_ok"], true, "{done_b}");
    assert!(
        done_b["stdout"]
            .as_str()
            .unwrap()
            .trim_end()
            .ends_with("other-project"),
        "explicit relative workdir escaped the linked project: {done_b}"
    );
    let initial = call_tool(&ctx, "read_file", &json!({"path":"AGENTS.md"}));
    let revision = initial["project_instructions"]["revision"].clone();
    let acknowledged = call_tool(
        &ctx,
        "read_file",
        &json!({"path":"AGENTS.md","known_project_instructions_revision":revision}),
    );
    assert_eq!(
        acknowledged["project_instructions"]["instructions_omitted"], true,
        "{acknowledged}"
    );
    fs::write(
        ctx.workspace.root().join("AGENTS.md"),
        "New instruction revision.\n",
    )
    .unwrap();
    let changed = call_tool(
        &ctx,
        "read_file",
        &json!({"path":"AGENTS.md","known_project_instructions_revision":revision}),
    );
    assert_eq!(
        changed["project_instructions"]["unchanged"], false,
        "{changed}"
    );
    let current = call_tool(
        &ctx,
        "task_context",
        &json!({"project_root":"@peer","task_id":b["task"]["id"]}),
    );
    assert_eq!(current["task"]["objective"], "linked", "{current}");
    let foreign = call_tool(
        &ctx,
        "task_context",
        &json!({"project_root":"@peer","task_id":a["task"]["id"]}),
    );
    assert_eq!(
        foreign["ok"], false,
        "foreign project IDs must not silently fall back: {foreign}"
    );
    let foreign_patch = call_tool(
        &ctx,
        "apply_patch",
        &json!({"project_root":".","task_id":a["task"]["id"],"patch":"*** Begin Patch\n*** Update File: @peer/source.txt\n@@\n-linked baseline\n+wrong project\n*** End Patch"}),
    );
    assert_eq!(
        foreign_patch["ok"], false,
        "a patch was attributed to the wrong task: {foreign_patch}"
    );
    assert_eq!(
        fs::read_to_string(linked.join("source.txt")).unwrap(),
        "linked baseline"
    );
}

#[test]
fn cancellation_stops_descendants_and_releases_only_owned_work() {
    let (ctx, _) = fixture();
    let root = ctx.workspace.root();
    fs::write(root.join("aiTemp/descendant.py"), "from pathlib import Path\nimport time\ntime.sleep(2)\nPath('aiTemp/escaped.txt').write_text('unexpected child survived')\n").unwrap();
    fs::write(root.join("aiTemp/parent.py"), "import subprocess,sys,time\nsubprocess.Popen([sys.executable,'aiTemp/descendant.py'])\nprint('READY',flush=True)\ntime.sleep(10)\n").unwrap();
    let launched = call_tool(
        &ctx,
        "exec_command",
        &json!({"cmd":py("aiTemp/parent.py"),"yield_time_ms":0}),
    );
    assert_eq!(launched["ok"], true, "{launched}");
    assert!(
        launched["max_runtime_ms"].is_null(),
        "ordinary jobs must not get an implicit deadline: {launched}"
    );
    assert_eq!(launched["cache_storage"], "ram_only");
    assert_eq!(launched["cache_max_age_seconds"], 5400);
    let id = launched["command_id"].as_str().unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let observed = call_tool(
            &ctx,
            "write_stdin",
            &json!({"command_id":id,"chars":"","yield_time_ms":0,"max_output_bytes":1024}),
        );
        if observed["stdout"].as_str().unwrap_or("").contains("READY") {
            break;
        }
        assert!(Instant::now() < until, "{observed}");
        thread::sleep(Duration::from_millis(20));
    }
    let overlapping = call_tool(
        &ctx,
        "exec_command",
        &json!({"cmd":py("-V"),"yield_time_ms":0,"timeout_ms":2000}),
    );
    let cancel = call_tool(
        &ctx,
        "kill_command",
        &json!({"command_id":id,"wait_ms":1000}),
    );
    assert_eq!(cancel["ok"], true, "{cancel}");
    thread::sleep(Duration::from_millis(2300));
    assert!(
        !root.join("aiTemp/escaped.txt").exists(),
        "a descendant survived cancellation and continued modifying the workspace"
    );
    assert_eq!(
        overlapping["error"]["code"], "PROJECT_WRITE_BUSY",
        "overlapping command was admitted: {overlapping}"
    );
    let next = call_tool(
        &ctx,
        "exec_command",
        &json!({"cmd":py("-V"),"yield_time_ms":1000,"timeout_ms":5000}),
    );
    assert_eq!(
        next["ok"], true,
        "owned write lease not released after confirmed termination: {next}"
    );
    let completed = wait(&ctx, next["command_id"].as_str().unwrap());
    assert_eq!(completed["command_ok"], true, "{completed}");
}
