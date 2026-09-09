//! Actual standalone Codex command path. No model endpoint may be contacted.
use super::*;
use std::net::TcpListener;
use std::sync::atomic::AtomicUsize;
struct Trap {
    url: String,
    stop: Arc<AtomicBool>,
    calls: Arc<AtomicUsize>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Trap {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicUsize::new(0));
        let stopped = stop.clone();
        let count = calls.clone();
        let thread = std::thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                if let Ok((mut socket, _)) = listener.accept() {
                    count.fetch_add(1, Ordering::SeqCst);
                    let _ = socket.write_all(
                        b"HTTP/1.1 503 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                } else {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        });
        Self {
            url,
            stop,
            calls,
            thread: Some(thread),
        }
    }
}
impl Drop for Trap {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
fn echo() -> Vec<String> {
    if cfg!(windows) {
        vec![
            "cmd.exe".into(),
            "/d".into(),
            "/c".into(),
            "echo NATIVE_COMMAND_ONLY".into(),
        ]
    } else {
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf NATIVE_COMMAND_ONLY".into(),
        ]
    }
}
#[test]
#[ignore = "requires verified official native executable on an isolated CI runner"]
fn native_043_actual_commands_no_model_and_write_denial() {
    let trap = Trap::new();
    let base = std::env::current_dir()
        .unwrap()
        .join("aiTemp/command-043")
        .join(format!("{}", std::process::id()));
    let root = base.join("workspace");
    let home = base.join("native-home");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let config=format!("model = \"no-model\"\nmodel_provider = \"disabled_fixture\"\napproval_policy = \"on-request\"\n[model_providers.disabled_fixture]\nname = \"No inference allowed\"\nbase_url = \"{}\"\nwire_api = \"responses\"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[windows]\nsandbox = \"unelevated\"\n",trap.url);
    std::fs::write(home.join("config.toml"), config).unwrap();
    let hub = Hub::default();
    hub.connect(
        &root.canonicalize().unwrap(),
        Connection {
            executable: PathBuf::from(std::env::var("NATIVE_CODEX_PROBE_BIN").unwrap()),
            expected_sha256: std::env::var("NATIVE_CODEX_PROBE_SHA256").unwrap(),
            codex_home: home.canonicalize().unwrap(),
            allow_model_usage: false,
            allow_command_execution: true,
            model: "no-model".into(),
            request_limit: 1,
            lifetime_seconds: 120,
        },
    )
    .unwrap();
    hub.initialize().unwrap();
    assert!(hub
        .admit(Control {
            operation: "start".into(),
            request_id: "denied-model".into(),
            thread_id: None,
            text: Some("must never be sent".into())
        })
        .is_err());
    let request = CommandRequest {
        request_id: "echo-1".into(),
        argv: echo(),
        timeout_ms: 10000,
    };
    let first = hub.admit_command(request.clone()).unwrap().run().unwrap();
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["exit_code"], 0, "{first}");
    assert!(first["stdout"]
        .as_str()
        .unwrap()
        .contains("NATIVE_COMMAND_ONLY"));
    assert_eq!(hub.admit_command(request).unwrap().run().unwrap(), first);
    let file = root.join("must-not-be-created.txt");
    assert!(!file.exists());
    let argv = if cfg!(windows) {
        vec![
            "cmd.exe".into(),
            "/d".into(),
            "/c".into(),
            format!("echo prohibited>\"{}\"", file.display()),
        ]
    } else {
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf prohibited > \"$1\"".into(),
            "fixture".into(),
            file.to_string_lossy().into_owned(),
        ]
    };
    let denied = hub
        .admit_command(CommandRequest {
            request_id: "write-denied".into(),
            argv,
            timeout_ms: 10000,
        })
        .unwrap()
        .run()
        .unwrap();
    assert!(
        !file.exists(),
        "Native read-only command wrote a file: {denied}"
    );
    assert!(
        denied["ok"] == false || denied["exit_code"].as_i64().is_some_and(|c| c != 0),
        "{denied}"
    );
    let status = hub.status().unwrap();
    assert_eq!(status["requests_used"], 0);
    assert!(status["threads"].as_array().unwrap().is_empty());
    assert_eq!(
        trap.calls.load(Ordering::SeqCst),
        0,
        "A model/provider endpoint was contacted"
    );
    hub.cancel("policy_changed");
    assert_eq!(hub.status().unwrap()["connected"], false);
    assert!(hub
        .admit_command(CommandRequest {
            request_id: "after-stop".into(),
            argv: echo(),
            timeout_ms: 1000
        })
        .is_err());
    println!("PASS: real native command/exec, read-only write denial, exact replay receipt, zero model/provider requests, zero threads, and Stop revocation");
}
