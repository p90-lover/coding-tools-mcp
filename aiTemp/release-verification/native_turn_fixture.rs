//! Test-only loopback Responses provider. No external model, credentials, tools or cleanup.
//! Wire shapes checked against OpenAI's rust-v0.153.4 Python SDK harness.
use super::*;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::AtomicUsize;

struct Fixture {
    url: String,
    running: Arc<AtomicBool>,
    count: Arc<AtomicUsize>,
    delay: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Fixture {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let count = Arc::new(AtomicUsize::new(0));
        let delay = Arc::new(AtomicBool::new(false));
        let (r, c, d) = (running.clone(), count.clone(), delay.clone());
        let worker = std::thread::spawn(move || {
            while r.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = serve(stream, &c, &d);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            url,
            running,
            count,
            delay,
            worker: Some(worker),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn serve(mut stream: TcpStream, count: &AtomicUsize, delay: &AtomicBool) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        reader.by_ref().take(16_385).read_line(&mut line)?;
        if line.is_empty() {
            return Ok(());
        }
        headers.push_str(&line);
        if headers.len() > 32_768 {
            return Ok(());
        }
        if line == "\r\n" {
            break;
        }
    }
    let first = headers.lines().next().unwrap_or("");
    let length = headers
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    if length > 4 * 1024 * 1024 {
        return Ok(());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let (content_type, output) = if first.starts_with("GET ") && first.contains("/models") {
        ("application/json",json!({"object":"list","data":[{"id":"mock-model","object":"model","created":0,"owned_by":"fixture"}]}).to_string())
    } else if first.starts_with("POST ") && first.contains("/responses") {
        let n = count.fetch_add(1, Ordering::SeqCst) + 1;
        if delay.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_secs(1));
        }
        if first.contains("/responses/compact") {
            ("application/json",json!({"output":[{"type":"compaction","encrypted_content":"fixture-summary"}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}).to_string())
        } else {
            let text = if n == 3 {
                r#"{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"Synthetic protocol fixture, not an actual review.","overall_confidence_score":1.0}"#.to_string()
            } else {
                format!("Synthetic native response {n}")
            };
            let id = format!("fixture-response-{n}");
            let events = [
                json!({"type":"response.created","response":{"id":id}}),
                json!({"type":"response.output_item.done","item":{"id":format!("fixture-message-{n}"),"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}}),
                json!({"type":"response.completed","response":{"id":id,"usage":{"input_tokens":1,"input_tokens_details":null,"output_tokens":1,"output_tokens_details":null,"total_tokens":2}}}),
            ];
            (
                "text/event-stream",
                events
                    .iter()
                    .map(|e| format!("event: {}\ndata: {}\n\n", e["type"].as_str().unwrap(), e))
                    .collect::<String>(),
            )
        }
    } else {
        (
            "application/json",
            json!({"error":"Unexpected fixture endpoint"}).to_string(),
        )
    };
    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{output}",output.len())?;
    stream.flush()
}
fn terminal(hub: &Hub, id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        let state = hub.read(id).unwrap();
        if matches!(
            state["status"].as_str(),
            Some("completed" | "interrupted" | "idle")
        ) {
            return state;
        }
        assert_ne!(state["status"], "failed", "native turn failed: {state}");
        assert!(
            Instant::now() < deadline,
            "native fixture completion timed out: {state}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
#[test]
#[ignore = "requires official native Codex; routes all responses to an isolated loopback fixture"]
fn native_bridge_actual_turns_against_loopback_fixture() {
    let server = Fixture::start();
    let base = std::env::current_dir()
        .unwrap()
        .join("aiTemp/native-turn-probe")
        .join(std::process::id().to_string());
    let root = base.join("workspace");
    let home = base.join("native-home");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let config=format!("model = \"mock-model\"\napproval_policy = \"on-request\"\nsandbox_mode = \"read-only\"\nmodel_provider = \"mock_provider\"\n[model_providers.mock_provider]\nname = \"Isolated protocol fixture, no AI\"\nbase_url = \"{}/v1\"\nwire_api = \"responses\"\nrequest_max_retries = 0\nstream_max_retries = 0\nrequires_openai_auth = false\n",server.url);
    std::fs::write(home.join("config.toml"), config).unwrap();
    let hub = Hub::default();
    hub.connect(
        &root.canonicalize().unwrap(),
        Connection {
            executable: std::env::var_os("NATIVE_CODEX_PROBE_BIN")
                .expect("official native binary required")
                .into(),
            expected_sha256: std::env::var("NATIVE_CODEX_PROBE_SHA256").unwrap(),
            codex_home: home.canonicalize().unwrap(),
            allow_model_usage: true,
            model: "mock-model".into(),
            request_limit: 6,
            lifetime_seconds: 120,
        },
    )
    .unwrap();
    hub.initialize().unwrap();
    let first = Control {
        operation: "start".into(),
        request_id: "fixture-start".into(),
        thread_id: None,
        text: Some("Protocol fixture only; do not invoke any tools.".into()),
    };
    let started = hub.admit(first.clone()).unwrap().run().unwrap();
    assert_eq!(started["ok"], true, "{started}");
    let id = started["thread_id"].as_str().unwrap().to_string();
    let state = terminal(&hub, &id);
    assert_eq!(state["answer"], "Synthetic native response 1");
    assert_eq!(hub.admit(first).unwrap().run().unwrap(), started);
    assert_eq!(
        server.count.load(Ordering::SeqCst),
        1,
        "duplicate request must not reach provider fixture"
    );
    for (operation, text) in [
        ("send", Some("Second protocol response.")),
        ("review", Some("Return a synthetic empty review.")),
        ("compact", None),
    ] {
        let result = hub
            .admit(Control {
                operation: operation.into(),
                request_id: format!("fixture-{operation}"),
                thread_id: Some(id.clone()),
                text: text.map(str::to_string),
            })
            .unwrap()
            .run()
            .unwrap();
        assert_eq!(result["ok"], true, "{operation}: {result}");
        terminal(&hub, &id);
    }
    // Hold one synthetic provider reply briefly, then request a real native interruption.
    server.delay.store(true, Ordering::SeqCst);
    let sent = hub
        .admit(Control {
            operation: "send".into(),
            request_id: "fixture-interrupt-turn".into(),
            thread_id: Some(id.clone()),
            text: Some("Delayed protocol fixture only.".into()),
        })
        .unwrap()
        .run()
        .unwrap();
    assert_eq!(sent["ok"], true, "{sent}");
    let interrupt = hub
        .admit(Control {
            operation: "interrupt".into(),
            request_id: "fixture-interrupt".into(),
            thread_id: Some(id.clone()),
            text: None,
        })
        .unwrap()
        .run()
        .unwrap();
    assert_eq!(interrupt["ok"], true, "{interrupt}");
    terminal(&hub, &id);
    let closed = hub
        .admit(Control {
            operation: "close".into(),
            request_id: "fixture-close".into(),
            thread_id: Some(id.clone()),
            text: None,
        })
        .unwrap()
        .run()
        .unwrap();
    assert_eq!(closed["ok"], true, "{closed}");
    assert_eq!(hub.read(&id).unwrap()["status"], "closed");
    assert_eq!(hub.status().unwrap()["requests_used"], 5);
    assert!(hub
        .admit(Control {
            operation: "send".into(),
            request_id: "fixture-foreign".into(),
            thread_id: Some("foreign".into()),
            text: Some("Not submitted".into())
        })
        .is_err());
    hub.cancel("fixture_complete");
    assert_eq!(hub.status().unwrap()["connected"], false);
    println!("PASS: real native start/send/review/compact/interrupt/unsubscribe; duplicate not replayed; loopback synthetic Responses only, no paid model or tool execution");
}
