//! Durable owned sessions and unexpired local grants; never replay prompts or approvals.
use super::*;

// Includes JSON escaping of bounded thread answers, policy metadata and command receipts.
const MAX_SAVED_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedReceipt {
    id: String,
    fingerprint: String,
    result: Option<Value>,
    completed_at_ms: Option<u64>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedSession {
    version: u32,
    root: PathBuf,
    connection: Connection,
    enabled: bool,
    consent_until_ms: Option<u64>,
    threads: Vec<ThreadState>,
    receipts: Vec<SavedReceipt>,
    requests_used: u32,
}

fn read(path: &Path) -> Result<Option<SavedSession>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect saved native session".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_SAVED_BYTES
    {
        return Err("Saved native session is linked, oversized or not a file".into());
    }
    let saved: SavedSession = serde_json::from_slice(
        &std::fs::read(path).map_err(|_| "Cannot read saved native session")?,
    )
    .map_err(|_| "Saved native session is corrupt; preserve it for recovery")?;
    if saved.version != 1 || saved.threads.len() > MAX_THREADS || saved.receipts.len() > MAX_LEDGER
    {
        return Err("Saved native session exceeds its ownership limits".into());
    }
    Ok(Some(saved))
}

pub(super) fn default_path(home: &Path) -> PathBuf {
    home.join("coding-tools-native-session.json")
}

pub(super) fn claim_session(path: &Path) -> Result<std::fs::File> {
    use fs2::FileExt;
    let parent = path
        .parent()
        .ok_or("Native session directory unavailable")?;
    std::fs::create_dir_all(parent).map_err(|_| "Cannot create native session directory")?;
    let lock_path = path.with_extension("lock");
    if std::fs::symlink_metadata(&lock_path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Native session ownership lock must not be linked".into());
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|_| "Cannot open native session ownership lock")?;
    file.try_lock_exclusive()
        .map_err(|_| "This saved chat is already owned by another active native connection")?;
    Ok(file)
}

pub(super) fn resumable_stop(reason: Option<&str>) -> bool {
    reason.is_none_or(|reason| {
        matches!(
            reason,
            "native_output_disconnected"
                | "native_input_disconnected"
                | "bridge_dropped"
                | "desktop_exiting"
                | "native_request_timeout_outcome_unknown"
        )
    })
}

pub(super) fn connection(path: &Path, root: &Path) -> Result<Option<(Connection, Option<u64>)>> {
    let Some(saved) = read(path)? else {
        return Ok(None);
    };
    if saved.root != root || !saved.enabled {
        return Ok(None);
    }
    let mut connection = saved.connection;
    if let Some(until) = saved.consent_until_ms {
        let remaining = until.saturating_sub(unix_ms()) / 1000;
        // Recovery cannot renew a grant or round a nearly expired grant up to the minimum.
        if remaining < 30 {
            return Ok(None);
        }
        connection.lifetime_seconds = remaining.min(900);
    }
    Ok(Some((connection, saved.consent_until_ms)))
}

fn write(path: &Path, saved: &SavedSession) -> Result<()> {
    let bytes = serde_json::to_vec(saved).map_err(|_| "Cannot encode native session")?;
    if bytes.len() as u64 > MAX_SAVED_BYTES {
        return Err("Native session exceeds its storage limit".into());
    }
    let parent = path
        .parent()
        .ok_or("Native session directory unavailable")?;
    std::fs::create_dir_all(parent).map_err(|_| "Cannot create native session directory")?;
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Native session record must not be linked".into());
    }
    let temp = parent.join("aiTemp");
    std::fs::create_dir_all(&temp).map_err(|_| "Cannot prepare native session staging")?;
    let stage = temp.join(format!(
        "native-session-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&stage)
        .map_err(|_| "Cannot stage native session")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot flush native session")?;
    drop(file);
    std::fs::rename(&stage, path).map_err(|_| "Cannot replace native session record")?;
    Ok(())
}

pub(super) fn prepare(
    path: &Path,
    root: &Path,
    options: &Connection,
    recovering: bool,
) -> Result<()> {
    let Some(saved) = read(path)? else {
        return Ok(());
    };
    let matches = saved.root == root
        && saved.connection.codex_home == options.codex_home
        && saved.connection.permission_profile == options.permission_profile
        && saved.connection.expected_sha256 == options.expected_sha256
        && saved.connection.approval_policy == options.approval_policy
        && saved.connection.approvals_reviewer == options.approvals_reviewer;
    if matches {
        return Ok(());
    }
    if recovering {
        return Err("Saved native session does not match the original recovery scope".into());
    }
    // Only a newly approved Connect can replace a scope. Keep the previous journal recoverable.
    let archive = path
        .parent()
        .ok_or("Native session directory unavailable")?
        .join("Trash")
        .join("native-sessions");
    std::fs::create_dir_all(&archive).map_err(|_| "Cannot preserve previous native session")?;
    std::fs::rename(path, archive.join(format!("{}.json", uuid::Uuid::new_v4())))
        .map_err(|_| "Cannot archive previous native session")?;
    Ok(())
}

pub(super) fn revoke(path: &Path) -> Result<()> {
    let _lease = claim_session(path)?;
    if let Some(mut saved) = read(path)? {
        saved.enabled = false;
        write(path, &saved)?;
    }
    Ok(())
}

impl Hub {
    pub fn with_state_file(path: PathBuf) -> Self {
        Self {
            state_file: Some(path),
            current: Mutex::new(None),
            recovery: Mutex::new(()),
        }
    }

    /// Rejoin an existing locally approved process/session; this never starts a model turn.
    pub fn restore_workspace(&self, root: &Path, writable: bool) -> Result<bool> {
        let Some(path) = &self.state_file else {
            return Ok(false);
        };
        let Ok(_recovery) = self.recovery.try_lock() else {
            return Ok(false);
        };
        if lock(&self.current)?
            .as_ref()
            .is_some_and(|bridge| bridge.live.load(Ordering::SeqCst))
        {
            return Ok(false);
        }
        let Some((options, deadline)) = connection(path, root)? else {
            return Ok(false);
        };
        if options.permission_profile == ":workspace" && !writable {
            return Err(
                "Saved native session requires its original workspace-write permission".into(),
            );
        }
        // Replacing a stopped child must not revoke its still-valid saved grant.
        lock(&self.current)?.take();
        self.connect_inner(root, options, None, false, deadline, true)?;
        Ok(true)
    }

    pub fn saved_connection(root: &Path, home: &Path) -> Result<Option<Connection>> {
        Ok(connection(&default_path(home), root)?.map(|(options, _)| options))
    }

    pub fn recover_ao_web(&self, root: &Path, options: Connection) -> Result<Value> {
        {
            let _recovery = lock(&self.recovery)?;
            let Some((_, deadline)) = connection(&default_path(&options.codex_home), root)? else {
                return Err("Saved AO native grant no longer permits recovery".into());
            };
            self.connect_inner(root, options, None, true, deadline, true)?;
        }
        self.initialize()
    }
}

impl Bridge {
    pub(super) fn save_session(&self) -> Result<()> {
        let _save = lock(&self.session_write)?;
        let memory = lock(&self.memory)?;
        let now = unix_ms();
        let enabled = resumable_stop(memory.stop_reason.as_deref());
        if !enabled {
            // Revocation must work even before load or if current output cannot be serialized.
            if let Some(mut saved) = read(&self.session_file)? {
                saved.enabled = false;
                drop(memory);
                return write(&self.session_file, &saved);
            }
            return Ok(());
        }
        if !self.state_loaded.load(Ordering::SeqCst) {
            return Ok(());
        }
        let saved = SavedSession {
            version: 1,
            root: self.root.clone(),
            connection: self.options.clone(),
            enabled,
            consent_until_ms: self.consent_until_ms,
            threads: memory.threads.values().cloned().collect(),
            receipts: memory
                .ledger
                .iter()
                .map(|(id, entry)| SavedReceipt {
                    id: id.clone(),
                    fingerprint: entry.fingerprint.clone(),
                    result: entry.result.clone(),
                    completed_at_ms: entry.completed_at.map(|at| {
                        now.saturating_sub(
                            u64::try_from(at.elapsed().as_millis()).unwrap_or(u64::MAX),
                        )
                    }),
                })
                .collect(),
            requests_used: memory.requests_used,
        };
        drop(memory);
        write(&self.session_file, &saved)
    }

    pub(super) fn restore_sessions(&self) -> Result<()> {
        let Some(saved) = read(&self.session_file)? else {
            self.state_loaded.store(true, Ordering::SeqCst);
            return Ok(());
        };
        if saved.root != self.root
            || saved.connection.codex_home != self.options.codex_home
            || saved.connection.permission_profile != self.options.permission_profile
            || saved.connection.expected_sha256 != self.options.expected_sha256
            || saved.connection.approval_policy != self.options.approval_policy
            || saved.connection.approvals_reviewer != self.options.approvals_reviewer
        {
            return Err(
                "Saved native session belongs to different workspace, executable or permissions"
                    .into(),
            );
        }
        let now = unix_ms();
        let mut memory = lock(&self.memory)?;
        if self.preserve_budget.load(Ordering::SeqCst) {
            memory.requests_used = saved.requests_used;
        }
        for receipt in saved.receipts {
            if receipt
                .completed_at_ms
                .is_some_and(|at| now.saturating_sub(at) >= LEDGER_RETENTION.as_millis() as u64)
            {
                continue;
            }
            if memory.ledger.contains_key(&receipt.id) {
                return Err("Duplicate saved native request identity".into());
            }
            let result = receipt.result.or_else(|| Some(json!({"ok":false,"request_id":receipt.id,
                "outcome":"unknown_or_stopped","error":"Previous process ended before this request settled; inspect its owned thread instead of replaying it"})));
            memory.ledger.insert(
                receipt.id,
                LedgerEntry {
                    fingerprint: receipt.fingerprint,
                    result,
                    completed_at: receipt.completed_at_ms.and_then(|at| {
                        Instant::now().checked_sub(Duration::from_millis(now.saturating_sub(at)))
                    }),
                },
            );
        }
        for mut thread in saved.threads {
            if !token(&thread.id)
                || !model_id(&thread.model)
                || thread.answer.len() > MAX_TEXT
                || memory.threads.contains_key(&thread.id)
            {
                return Err("Invalid or duplicate saved native thread identity".into());
            }
            thread.restored = true;
            memory.threads.insert(thread.id.clone(), thread);
        }
        let ids = memory.threads.keys().cloned().collect::<Vec<_>>();
        drop(memory);
        self.state_loaded.store(true, Ordering::SeqCst);
        for id in ids {
            let (model, context_window) = {
                let memory = lock(&self.memory)?;
                (
                    memory.threads[&id].model.clone(),
                    memory.threads[&id].context_window,
                )
            };
            let mut params = json!({"threadId":id, "cwd":self.root, "excludeTurns":true,
                "model":model,"permissions":self.options.permission_profile,"approvalPolicy":self.codex_approval_policy(),
                "approvalsReviewer":self.codex_approvals_reviewer()});
            if let Some(tokens) = context_window {
                params["config"] = json!({"model_context_window":tokens});
            }
            let resumed = self.rpc("thread/resume", params)?;
            if resumed["thread"]["id"] != id {
                return Err(
                    "Native resume did not confirm the original thread and permissions".into(),
                );
            }
            let effective = permissions::effective_policy(
                &resumed,
                &self.options.permission_profile,
                self.codex_approval_policy(),
                self.codex_approvals_reviewer(),
                self.explicit_policy(),
            )?;
            // Read one summarized turn rather than returning an unbounded full history.
            let turns = self.rpc(
                "thread/turns/list",
                json!({"threadId":id,"limit":1,
                "sortDirection":"desc","itemsView":"summary"}),
            )?;
            let mut memory = lock(&self.memory)?;
            let thread = memory
                .threads
                .get_mut(&id)
                .ok_or("Restored thread ownership changed")?;
            thread.effective_policy = Some(effective);
            if let Some(turn) = turns["data"].as_array().and_then(|turns| turns.first()) {
                hydrate_turn(thread, turn);
            }
            if matches!(
                thread.status.as_str(),
                "starting"
                    | "inProgress"
                    | "interrupt_requested"
                    | "compacting"
                    | "unknown_stopped"
            ) {
                thread.status = "interrupted".into();
                thread.notice = Some("Original chat restored after restart. The previous turn was interrupted; send a follow-up to continue from its saved history.".into());
            }
        }
        Ok(())
    }
}

fn hydrate_turn(thread: &mut ThreadState, turn: &Value) {
    if let Some(id) = turn["id"].as_str().filter(|id| token(id)) {
        thread.turn_id = Some(id.into())
    }
    thread.status = match turn["status"].as_str() {
        Some("completed") => "completed",
        Some("failed") => "failed",
        _ => "interrupted",
    }
    .into();
    if let Some(items) = turn["items"].as_array() {
        thread.clear_messages();
        for (index, item) in items.iter().enumerate() {
            if item["type"] == "agentMessage" {
                if let Some(text) = item["text"].as_str() {
                    let id = item["id"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("history-{index}"));
                    if let Some(message) = thread.message(&id, item["phase"].as_str()) {
                        thread.complete_message(message, text);
                    }
                }
            } else if matches!(
                item["type"].as_str(),
                Some(
                    "commandExecution"
                        | "fileChange"
                        | "mcpToolCall"
                        | "dynamicToolCall"
                        | "webSearch"
                )
            ) {
                thread.tool_step = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_bridge_saved_identity_and_consent_are_scoped() {
        let temp_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../aiTemp");
        let base = temp_root.join("native-sessions-test").join(format!(
            "{}-{}",
            std::process::id(),
            unix_ms()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let root = base.join("workspace");
        let file = base.join("session.json");
        let mut saved = SavedSession {
            version: 1,
            root: root.clone(),
            enabled: true,
            consent_until_ms: Some(unix_ms() + 60_000),
            connection: Connection {
                executable: PathBuf::from("codex.exe"),
                expected_sha256: "a".repeat(64),
                codex_home: base.join("home"),
                allow_model_usage: true,
                allow_command_execution: false,
                permission_profile: ":read-only".into(),
                approval_policy: None,
                approvals_reviewer: None,
                model: "fixture".into(),
                request_limit: 3,
                lifetime_seconds: 60,
                effort: None,
                context_window: None,
            },
            threads: vec![ThreadState {
                id: "owned".into(),
                model: "chatgpt-web/high".into(),
                ..Default::default()
            }],
            receipts: vec![],
            requests_used: 1,
        };
        std::fs::write(&file, serde_json::to_vec(&saved).unwrap()).unwrap();
        assert!(connection(&file, &root).unwrap().is_some());
        assert!(connection(&file, &base.join("foreign")).unwrap().is_none());
        assert_eq!(
            read(&file).unwrap().unwrap().threads[0].model,
            "chatgpt-web/high"
        );
        Hub::with_state_file(file.clone()).disconnect();
        assert!(
            connection(&file, &root).unwrap().is_none(),
            "Stop also revokes a chat before recovery starts"
        );
        assert_eq!(
            read(&file).unwrap().unwrap().threads.len(),
            1,
            "revocation preserves saved history"
        );
        std::fs::write(&file, serde_json::to_vec(&saved).unwrap()).unwrap();
        saved.consent_until_ms = Some(unix_ms() - 1);
        std::fs::write(&file, serde_json::to_vec(&saved).unwrap()).unwrap();
        assert!(connection(&file, &root).unwrap().is_none());
        saved.consent_until_ms = None;
        saved.enabled = false;
        std::fs::write(&file, serde_json::to_vec(&saved).unwrap()).unwrap();
        assert!(connection(&file, &root).unwrap().is_none());
        saved.enabled = true;
        saved.threads = (0..MAX_THREADS)
            .map(|index| ThreadState {
                id: format!("quoted-{index}"),
                model: "fixture".into(),
                answer: "\"".repeat(MAX_TEXT),
                ..Default::default()
            })
            .collect();
        write(&file, &saved).unwrap();
        assert_eq!(
            read(&file).unwrap().unwrap().threads.len(),
            MAX_THREADS,
            "all bounded answers must fit after JSON escaping"
        );
        let mut changed = saved.connection.clone();
        changed.permission_profile = ":workspace".into();
        assert!(
            prepare(&file, &root, &changed, true).is_err(),
            "automatic recovery cannot replace scope"
        );
        prepare(&file, &root, &changed, false).unwrap();
        assert!(
            !file.exists(),
            "explicitly approved new scope can initialize a fresh journal"
        );
        let archives = std::fs::read_dir(base.join("Trash/native-sessions"))
            .unwrap()
            .collect::<Vec<_>>();
        assert_eq!(
            archives.len(),
            1,
            "the previous journal remains recoverable"
        );
        let canonical = base.canonicalize().unwrap();
        assert!(canonical.starts_with(temp_root.canonicalize().unwrap()));
        std::fs::remove_dir_all(canonical).unwrap();
    }

    #[test]
    fn native_bridge_rehydrates_final_answer_without_replaying_a_turn() {
        let mut thread = ThreadState::default();
        hydrate_turn(
            &mut thread,
            &json!({"id":"original-turn","status":"completed","items":[
            {"type":"agentMessage","phase":"commentary","text":"working"},
            {"type":"agentMessage","phase":"final_answer","text":"APPROVED first segment"},
            {"type":"reasoning"},
            {"type":"agentMessage","phase":"final_answer","text":"verified result"}]}),
        );
        assert_eq!(thread.status, "completed");
        assert_eq!(thread.turn_id.as_deref(), Some("original-turn"));
        assert_eq!(thread.answer, "APPROVED first segment\n\nverified result");
    }

    #[test]
    #[ignore = "requires an explicitly selected native binary; uses only a synthetic loopback provider"]
    fn native_bridge_restart_restores_models_and_receipts_without_new_inference() {
        let executable =
            PathBuf::from(std::env::var("NATIVE_CODEX_PROBE_BIN").expect("native binary required"));
        let expected_sha256 = format!("{:x}", Sha256::digest(std::fs::read(&executable).unwrap()));
        let fixture = super::super::native_turn_fixture::Fixture::new();
        let temp_root = PathBuf::from(
            std::env::var("CODEX_TEST_TEMP_ROOT").expect("task aiTemp root required"),
        );
        let base = tempfile::Builder::new()
            .prefix("native-session-restart-")
            .tempdir_in(&temp_root)
            .unwrap();
        let root = base.path().join("workspace");
        let home = base.path().join("native-home");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("config.toml"), format!(
            "model_provider = \"fixture\"\n[model_providers.fixture]\nname = \"Local synthetic provider\"\nbase_url = {:?}\nwire_api = \"responses\"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n", fixture.address)).unwrap();
        let root = root.canonicalize().unwrap();
        let home = home.canonicalize().unwrap();
        let file = default_path(&home);
        let hub = Hub::with_state_file(file.clone());
        hub.connect(
            &root,
            Connection {
                executable,
                expected_sha256,
                codex_home: home,
                allow_model_usage: true,
                allow_command_execution: false,
                permission_profile: ":read-only".into(),
                approval_policy: None,
                approvals_reviewer: None,
                model: "mock-default".into(),
                request_limit: 6,
                lifetime_seconds: 120,
                effort: None,
                context_window: None,
            },
        )
        .unwrap();
        hub.initialize().unwrap();
        let original_deadline = read(&file).unwrap().unwrap().consent_until_ms;
        let wait = |hub: &Hub, id: &str| {
            let until = Instant::now() + Duration::from_secs(15);
            loop {
                let thread = hub.read(id).unwrap();
                if thread["status"] == "completed" {
                    return thread;
                }
                assert!(
                    Instant::now() < until && thread["status"] != "failed",
                    "native fixture: {thread}"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        let mut requests = Vec::new();
        let mut receipts = Vec::new();
        for model in ["mock-a", "mock-b"] {
            let request: Control = serde_json::from_value(
                json!({"operation":"start","request_id":format!("start-{model}"),
                "text":"Return the synthetic fixture answer without tools.","model":model}),
            )
            .unwrap();
            let receipt = hub.admit(request.clone()).unwrap().run().unwrap();
            assert_eq!(receipt["ok"], true, "{receipt}");
            wait(&hub, receipt["thread_id"].as_str().unwrap());
            requests.push(request);
            receipts.push(receipt);
        }
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
        hub.cancel("desktop_exiting");
        drop(hub);
        let restored = Hub::with_state_file(file.clone());
        assert!(restored.restore_workspace(&root, false).unwrap());
        restored.initialize().unwrap();
        assert_eq!(
            fixture.calls.load(Ordering::SeqCst),
            2,
            "resume must not submit inference"
        );
        assert_eq!(
            restored.status().unwrap()["requests_used"],
            2,
            "restart must not reset the approved budget"
        );
        assert_eq!(
            read(&file).unwrap().unwrap().consent_until_ms,
            original_deadline,
            "recovery preserves the absolute grant deadline across validation and startup"
        );
        for (index, model) in ["mock-a", "mock-b"].iter().enumerate() {
            let thread = restored
                .read(receipts[index]["thread_id"].as_str().unwrap())
                .unwrap();
            assert_eq!(thread["model"], *model);
            assert_eq!(thread["status"], "completed");
            assert_eq!(thread["restored"], true);
            assert_eq!(
                restored
                    .admit(requests[index].clone())
                    .unwrap()
                    .run()
                    .unwrap(),
                receipts[index]
            );
        }
        let send: Control = serde_json::from_value(json!({"operation":"send","request_id":"follow-up",
            "thread_id":receipts[1]["thread_id"],"text":"One more synthetic answer, without tools."})).unwrap();
        let sent = restored.admit(send).unwrap().run().unwrap();
        assert_eq!(sent["ok"], true, "{sent}");
        wait(&restored, receipts[1]["thread_id"].as_str().unwrap());
        assert_eq!(
            *fixture.models.lock().unwrap(),
            vec!["mock-a", "mock-b", "mock-b"]
        );
        // Reproduce Stop arriving before asynchronous initialization has loaded the journal.
        restored
            .bridge()
            .unwrap()
            .state_loaded
            .store(false, Ordering::SeqCst);
        restored.disconnect();
        assert!(
            !Hub::with_state_file(file)
                .restore_workspace(&root, false)
                .unwrap(),
            "Stop revokes restart consent"
        );
    }
}
