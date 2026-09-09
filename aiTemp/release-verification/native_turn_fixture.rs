//! Test-only loopback Responses provider. No external model, credentials, tools or cleanup.
//! Wire shapes checked against OpenAI's rust-v0.153.4 Python SDK harness.
use super::*;
use std::net::{TcpListener, TcpStream};
struct Fixture {
    address: String,
    calls: Arc<AtomicU64>,
    delay: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
fn serve(stream: &mut TcpStream, count: &AtomicU64, delay: &AtomicBool) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut headers = String::new();
    while !headers.ends_with("\r\n\r\n") {
        let mut line = String::new();
        reader.by_ref().take(32769).read_line(&mut line)?;
        if line.is_empty() {
            return Ok(());
        }
        headers.push_str(&line);
        if headers.len() > 32768 {
            return Ok(());
        }
    }
    let route = headers.lines().next().unwrap_or("").to_owned();
    let length = headers
        .lines()
        .find_map(|l| {
            l.split_once(':')
                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    if length > 4 * 1024 * 1024 {
        return Ok(());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    if route.starts_with("POST /v1/responses/compact ")
        || route.starts_with("POST /responses/compact ")
    {
        let response=json!({"output":[{"type":"compaction","encrypted_content":"fixture-summary"}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}).to_string();
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response)?;
        return stream.flush();
    }
    if route.starts_with("GET ") {
        let response = "{\"data\":[]}";
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response)?;
        return stream.flush();
    }
    if !(route.starts_with("POST /v1/responses ") || route.starts_with("POST /responses ")) {
        write!(
            stream,
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )?;
        return Ok(());
    }
    let n = count.fetch_add(1, Ordering::SeqCst) + 1;
    if delay.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_secs(1));
    }
    let text = if n == 3 {
        "{\"findings\":[],\"overall_correctness\":\"patch is correct\",\"overall_explanation\":\"Synthetic protocol fixture, not an actual review.\",\"overall_confidence_score\":1.0}".to_owned()
    } else {
        format!("Synthetic native response {n}")
    };
    let events = [
        json!({"type":"response.created","response":{"id":format!("resp-{n}")}}),
        json!({"type":"response.output_item.done","item":{"id":format!("msg-{n}"),"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}}),
        json!({"type":"response.completed","response":{"id":format!("resp-{n}"),"usage":{"input_tokens":1,"input_tokens_details":null,"output_tokens":1,"output_tokens_details":null,"total_tokens":2}}}),
    ];
    let data = events
        .into_iter()
        .map(|e| format!("event: {}\ndata: {}\n\n", e["type"].as_str().unwrap(), e))
        .collect::<String>();
    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",data.len(),data)?;
    stream.flush()
}
impl Fixture {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = format!("http://{}/v1", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicU64::new(0));
        let delay = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (c, d, s) = (calls.clone(), delay.clone(), stop.clone());
        let worker = std::thread::spawn(move || {
            while !s.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = serve(&mut stream, &c, &d);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            address,
            calls,
            delay,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn go(
    hub: &Hub,
    b: &Binding,
    operation: &str,
    id: &str,
    thread: Option<&str>,
    text: Option<&str>,
) -> Value {
    hub.control(
        b,
        Control {
            operation: operation.into(),
            request_id: id.into(),
            thread_id: thread.map(str::to_owned),
            text: text.map(str::to_owned),
        },
    )
    .unwrap()
}
fn terminal(hub: &Hub, b: &Binding, id: &str) -> Value {
    let until = Instant::now() + Duration::from_secs(12);
    loop {
        let snapshot = hub.snapshot(b);
        let thread = snapshot["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id)
            .unwrap()
            .clone();
        let state = thread["status"].as_str().unwrap();
        if !matches!(state, "starting" | "in_progress" | "compacting") {
            return thread;
        }
        assert!(
            Instant::now() < until,
            "native turn did not complete: {snapshot}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
// Diagnostics run only after a failed test, against its credential-free synthetic provider.
// No production error payload, user configuration, API token or raw reasoning is logged.
fn diagnose(hub: &Hub) {
    let bridge = hub.current.lock().unwrap().as_ref().unwrap().clone();
    let raw = |method: &str, params: Value| -> Value {
        let id = bridge.sequence.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::sync_channel(1);
        bridge.pending.lock().unwrap().insert(id, tx);
        bridge
            .send(json!({"id":id,"method":method,"params":params}))
            .unwrap();
        rx.recv_timeout(Duration::from_secs(15))
            .unwrap_or_else(|e| json!({"diagnostic_timeout":e.to_string()}))
    };
    let params = json!({"cwd":bridge.root,"model":bridge.model,"sandbox":"read-only","approvalPolicy":"on-request","approvalsReviewer":"user","ephemeral":true});
    let result = raw("thread/start", params);
    eprintln!(
        "Isolated thread/start diagnostic: {}",
        result.get("error").unwrap_or(&json!({"error":null}))
    );
    if let Some(id) = result["result"]["thread"]["id"].as_str() {
        let result = raw(
            "turn/start",
            json!({"threadId":id,"input":[{"type":"text","text":"Synthetic diagnostic. Do not use tools."}],"cwd":bridge.root,"model":bridge.model,"approvalPolicy":"on-request","sandboxPolicy":{"type":"readOnly","access":{"type":"restricted","includePlatformDefaults":true,"readableRoots":[bridge.root]}}}),
        );
        eprintln!(
            "Isolated turn/start diagnostic: {}",
            result.get("error").unwrap_or(&json!({"error":null}))
        );
    }
}
#[test]
#[ignore = "requires exact official native binary; no real provider is used"]
fn native_bridge_actual_turns_against_loopback_fixture() {
    let executable =
        PathBuf::from(std::env::var("NATIVE_CODEX_PROBE_BIN").expect("native package path"));
    let sha = std::env::var("NATIVE_CODEX_PROBE_SHA256").expect("verified native package SHA");
    let fixture = Fixture::new();
    let base = std::env::current_dir()
        .unwrap()
        .join("aiTemp/native-turn-probe")
        .join(std::process::id().to_string());
    let root = base.join("workspace");
    let home = base.join("home");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let config=format!("model = \"mock-model\"\napproval_policy = \"on-request\"\nsandbox_mode = \"read-only\"\nmodel_provider = \"mock_provider\"\n[model_providers.mock_provider]\nname = \"Isolated protocol fixture, no AI\"\nbase_url = \"{}\"\nwire_api = \"responses\"\nrequest_max_retries = 0\nstream_max_retries = 0\nrequires_openai_auth = false\n",fixture.address);
    std::fs::write(home.join("config.toml"), config).unwrap();
    let binding = Binding {
        root: root.canonicalize().unwrap(),
        revision: 0,
    };
    let hub = Hub::default();
    hub.connect(
        binding.clone(),
        Connection {
            executable,
            expected_sha256: sha,
            codex_home: home,
            allow_model_usage: true,
            model: "mock-model".into(),
            request_limit: 6,
            lifetime_seconds: 120,
        },
    )
    .unwrap();
    let result = go(
        &hub,
        &binding,
        "start",
        "fixture-start",
        None,
        Some("Protocol fixture only; do not invoke any tools"),
    );
    if result["ok"] != true {
        diagnose(&hub);
    }
    assert_eq!(result["ok"], true, "{result}");
    let id = result["thread_id"].as_str().unwrap();
    let done = terminal(&hub, &binding, id);
    assert_eq!(done["status"], "completed", "{done}");
    assert_eq!(done["text"], "Synthetic native response 1", "{done}");
    assert_eq!(
        go(
            &hub,
            &binding,
            "start",
            "fixture-start",
            None,
            Some("Protocol fixture only; do not invoke any tools")
        ),
        result
    );
    assert_eq!(
        fixture.calls.load(Ordering::SeqCst),
        1,
        "retry invoked model twice"
    );
    assert_eq!(
        go(
            &hub,
            &binding,
            "send",
            "fixture-send",
            Some(id),
            Some("Second synthetic response; no tools")
        )["ok"],
        true
    );
    assert_eq!(terminal(&hub, &binding, id)["status"], "completed");
    let review = go(
        &hub,
        &binding,
        "review",
        "fixture-review",
        Some(id),
        Some("Return the synthetic empty review; do not run tools"),
    );
    assert_eq!(review["ok"], true, "{review}");
    assert_eq!(terminal(&hub, &binding, id)["status"], "completed");
    let compact = go(&hub, &binding, "compact", "fixture-compact", Some(id), None);
    assert_eq!(compact["ok"], true, "{compact}");
    assert_eq!(terminal(&hub, &binding, id)["status"], "completed");
    fixture.delay.store(true, Ordering::SeqCst);
    assert_eq!(
        go(
            &hub,
            &binding,
            "send",
            "fixture-delayed",
            Some(id),
            Some("Delayed synthetic response; no tools")
        )["ok"],
        true
    );
    let interrupt = go(
        &hub,
        &binding,
        "interrupt",
        "fixture-interrupt",
        Some(id),
        None,
    );
    assert_eq!(interrupt["ok"], true, "{interrupt}");
    let stopped = terminal(&hub, &binding, id);
    assert!(
        matches!(
            stopped["status"].as_str(),
            Some("interrupted" | "completed")
        ),
        "{stopped}"
    );
    let closed = go(&hub, &binding, "close", "fixture-close", Some(id), None);
    assert_eq!(closed["ok"], true, "{closed}");
    assert_eq!(hub.snapshot(&binding)["threads"][0]["status"], "closed");
    assert_eq!(hub.snapshot(&binding)["requests_used"], 5);
    assert!(hub
        .control(
            &binding,
            Control {
                operation: "send".into(),
                request_id: "foreign".into(),
                thread_id: Some("not-owned".into()),
                text: Some("never send".into())
            }
        )
        .is_err());
    hub.cancel();
    println!("PASS: real native start/send/review/compact/interrupt/unsubscribe; duplicate not replayed; loopback synthetic Responses only, no paid model or tool execution");
}
