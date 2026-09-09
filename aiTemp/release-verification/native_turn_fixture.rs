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
        count.fetch_add(1, Ordering::SeqCst);
        let response=json!({"output":[{"type":"compaction","encrypted_content":"fixture-summary"}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}).to_string();
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response)?;
        return stream.flush();
    }
    if route.starts_with("GET ") {
        let response=json!({"object":"list","data":[{"id":"mock-model","object":"model","created":0,"owned_by":"fixture"}]}).to_string();
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
fn go(hub: &Hub, operation: &str, id: &str, thread: Option<&str>, text: Option<&str>) -> Value {
    hub.admit(Control {
        operation: operation.into(),
        request_id: id.into(),
        thread_id: thread.map(str::to_owned),
        text: text.map(str::to_owned),
    })
    .unwrap()
    .run()
    .unwrap()
}
fn terminal(hub: &Hub, id: &str) -> Value {
    let until = Instant::now() + Duration::from_secs(12);
    loop {
        let thread = hub.read(id).unwrap();
        let state = thread["status"].as_str().unwrap();
        if matches!(state, "completed" | "interrupted" | "idle") {
            return thread;
        }
        assert_ne!(state, "failed", "native turn failed: {thread}");
        assert!(
            Instant::now() < until,
            "native turn did not complete: {thread}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
// Failure-only diagnostics use a separate credential-free native process, with a hard
// watchdog and the exact fixture home. No production error payload or reasoning is logged.
fn diagnose(hub: &Hub) {
    let bridge = hub.bridge().unwrap();
    let mut command = Command::new(&bridge.options.executable);
    command
        .arg("app-server")
        .current_dir(&bridge.options.codex_home)
        .env_clear();
    for key in [
        "SystemRoot",
        "SystemDrive",
        "WINDIR",
        "PATH",
        "HOME",
        "USERPROFILE",
        "LANG",
        "LC_ALL",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let temp = bridge.options.codex_home.join("aiTemp");
    command
        .env("CODEX_HOME", &bridge.options.codex_home)
        .env("TMPDIR", &temp)
        .env("TEMP", &temp)
        .env("TMP", &temp)
        .env("OTEL_SDK_DISABLED", "true")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    OwnedProcess::configure(&mut command);
    let mut child = command.spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let process = Arc::new(Mutex::new(OwnedProcess::attach(child).unwrap()));
    let weak = Arc::downgrade(&process);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(12));
        if let Some(process) = weak.upgrade() {
            process.lock().unwrap().stop();
        }
    });
    let mut reader = BufReader::new(output);
    let mut rpc = |id: u64, method: &str, params: Value| -> Value {
        writeln!(
            input,
            "{}",
            json!({"id":id,"method":method,"params":params})
        )
        .unwrap();
        input.flush().unwrap();
        loop {
            let mut line = Vec::new();
            (&mut reader)
                .take((MAX_FRAME + 1) as u64)
                .read_until(b'\n', &mut line)
                .unwrap();
            if line.is_empty() || line.len() > MAX_FRAME {
                return json!({"error":"diagnostic ended"});
            }
            let value: Value = serde_json::from_slice(&line).unwrap();
            if value["id"] == id {
                return value;
            }
        }
    };
    let initialized = rpc(
        100,
        "initialize",
        json!({"clientInfo":{"name":"isolated_fixture_diagnostic","version":"0.1.0"},"capabilities":{"experimentalApi":false}}),
    );
    eprintln!(
        "Isolated initialize error: {}",
        initialized.get("error").unwrap_or(&Value::Null)
    );
    // The server accepts requests after its initialize result; initialized is a notification.
    let result = rpc(
        101,
        "thread/start",
        json!({"cwd":bridge.root,"model":bridge.options.model,"sandbox":"read-only","approvalPolicy":"on-request","approvalsReviewer":"user","ephemeral":true}),
    );
    eprintln!(
        "Isolated thread/start error: {}",
        result.get("error").unwrap_or(&Value::Null)
    );
    if let Some(id) = result["result"]["thread"]["id"].as_str() {
        let result = rpc(
            102,
            "turn/start",
            json!({"threadId":id,"input":[{"type":"text","text":"Synthetic diagnostic. Do not use tools."}],"cwd":bridge.root,"model":bridge.options.model,"approvalPolicy":"on-request","sandboxPolicy":{"type":"readOnly","access":{"type":"restricted","includePlatformDefaults":true,"readableRoots":[bridge.root]}}}),
        );
        eprintln!(
            "Isolated turn/start error: {}",
            result.get("error").unwrap_or(&Value::Null)
        );
    }
    drop(rpc);
    process.lock().unwrap().stop();
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
    let home = base.join("native-home");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let config=format!("model = \"mock-model\"\napproval_policy = \"on-request\"\nmodel_provider = \"mock_provider\"\n[model_providers.mock_provider]\nname = \"Isolated protocol fixture, no AI\"\nbase_url = \"{}\"\nwire_api = \"responses\"\nrequest_max_retries = 0\nstream_max_retries = 0\nrequires_openai_auth = false\n",fixture.address);
    std::fs::write(home.join("config.toml"), config).unwrap();
    let hub = Hub::default();
    hub.connect(
        &root.canonicalize().unwrap(),
        Connection {
            executable,
            expected_sha256: sha,
            codex_home: home.canonicalize().unwrap(),
            allow_model_usage: true,
            model: "mock-model".into(),
            request_limit: 6,
            lifetime_seconds: 120,
        },
    )
    .unwrap();
    hub.initialize().unwrap();
    let result = go(
        &hub,
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
    let done = terminal(&hub, id);
    assert_eq!(done["status"], "completed", "{done}");
    assert_eq!(done["answer"], "Synthetic native response 1", "{done}");
    assert_eq!(
        go(
            &hub,
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
            "send",
            "fixture-send",
            Some(id),
            Some("Second synthetic response; no tools")
        )["ok"],
        true
    );
    terminal(&hub, id);
    let review = go(
        &hub,
        "review",
        "fixture-review",
        Some(id),
        Some("Return the synthetic empty review; do not run tools"),
    );
    assert_eq!(review["ok"], true, "{review}");
    terminal(&hub, id);
    let compact = go(&hub, "compact", "fixture-compact", Some(id), None);
    assert_eq!(compact["ok"], true, "{compact}");
    terminal(&hub, id);
    fixture.delay.store(true, Ordering::SeqCst);
    assert_eq!(
        go(
            &hub,
            "send",
            "fixture-delayed",
            Some(id),
            Some("Delayed synthetic response; no tools")
        )["ok"],
        true
    );
    let interrupt = go(&hub, "interrupt", "fixture-interrupt", Some(id), None);
    assert_eq!(interrupt["ok"], true, "{interrupt}");
    terminal(&hub, id);
    let closed = go(&hub, "close", "fixture-close", Some(id), None);
    assert_eq!(closed["ok"], true, "{closed}");
    assert_eq!(hub.read(id).unwrap()["status"], "closed");
    assert_eq!(hub.status().unwrap()["requests_used"], 5);
    assert!(hub
        .admit(Control {
            operation: "send".into(),
            request_id: "foreign".into(),
            thread_id: Some("not-owned".into()),
            text: Some("never send".into())
        })
        .is_err());
    hub.cancel("fixture_complete");
    println!("PASS: real native start/send/review/compact/interrupt/unsubscribe; duplicate not replayed; loopback synthetic Responses only, no paid model or tool execution");
}
