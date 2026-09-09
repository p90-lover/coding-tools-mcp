//! Standalone native utilities: no thread/turn creation, model call or unsandboxed fallback.
use super::*;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CommandRequest {
    pub request_id: String,
    pub argv: Vec<String>,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
}
pub(super) const COMMAND_RUNTIME_SHA256: Option<&str> = option_env!("CODING_TOOLS_COMMAND_NATIVE_SHA256");
fn default_timeout() -> u64 { 5000 }
fn validate(request: &CommandRequest) -> Result<()> {
    if !token(&request.request_id) || !(100..=10000).contains(&request.timeout_ms)
        || request.argv.is_empty() || request.argv.len() > 32
        || request.argv[0].trim().is_empty()
        || request.argv.iter().any(|s| s.len() > 8192 || s.contains('\0'))
        || request.argv.iter().map(String::len).sum::<usize>() > 16000 {
        return Err("Use a unique request_id, 1–32 bounded argv strings and a 100–10000 ms timeout".into());
    }
    Ok(())
}
fn reserve_command(memory: &mut Memory, options: &Connection, request: &CommandRequest,
                   live: bool, ready: bool) -> Result<Option<Value>> {
    validate(request)?;
    // The slash cannot occur in normal Control IDs; the two ledgers cannot collide.
    let key = format!("command/{}", request.request_id);
    let fingerprint = serde_json::to_string(request).map_err(|_| "Cannot encode command")?;
    if let Some((before, result)) = memory.ledger.get(&key) {
        if before != &fingerprint { return Err("Command request ID was reused with different arguments".into()); }
        return result.clone().map(Some).ok_or_else(|| "Command outcome is pending or unknown; do not replay".into());
    }
    if !live || !ready { return Err("Native session is not connected".into()); }
    if !options.allow_command_execution { return Err("Native commands need their own local consent; model consent is not command consent".into()); }
    if memory.ledger.len() >= MAX_LEDGER { return Err("Native request ledger is full; reconnect locally before new commands".into()); }
    memory.ledger.insert(key, (fingerprint, None));
    Ok(None)
}
pub struct CommandTicket { bridge: Arc<Bridge>, request: CommandRequest, replay: Option<Value> }
impl Hub {
    /// Admission is protected by the caller's current live-policy fence, not the long RPC.
    pub fn admit_command(&self, request: CommandRequest) -> Result<CommandTicket> {
        let bridge = self.bridge()?;
        let pinned=COMMAND_RUNTIME_SHA256.ok_or("This build has no verified native command runtime digest; no command submitted")?;
        if pinned.len()!=64 || !bridge.options.expected_sha256.eq_ignore_ascii_case(pinned) {
            return Err("Standalone commands require the exact official native executable verified for this release; no compatibility fallback".into());
        }
        if bridge.started.elapsed() >= Duration::from_secs(bridge.options.lifetime_seconds) {
            bridge.stop("local_consent_expired");
        }
        let replay = { let mut memory=lock(&bridge.memory)?; reserve_command(&mut memory, &bridge.options, &request,
            bridge.live.load(Ordering::SeqCst), bridge.ready.load(Ordering::SeqCst))? };
        Ok(CommandTicket { bridge, request, replay })
    }
}
impl CommandTicket {
    pub fn run(self) -> Result<Value> {
        if let Some(value) = self.replay { return Ok(value); }
        let result = match self.bridge.operation.try_lock() {
            Ok(_permit) => self.execute(),
            Err(_) => Err("Another native operation is active; this command was not queued".into()),
        };
        let stored = result.unwrap_or_else(|message| json!({"ok":false,"request_id":self.request.request_id,
            "error":message,"outcome":if self.bridge.live.load(Ordering::SeqCst){"rejected_or_native_error"}else{"unknown_or_stopped"},
            "model_requests":0,"replayed":false}));
        if let Ok(mut memory) = self.bridge.memory.lock() {
            if let Some(entry) = memory.ledger.get_mut(&format!("command/{}", self.request.request_id)) { entry.1 = Some(stored.clone()); }
        }
        Ok(stored)
    }
    fn execute(&self) -> Result<Value> {
        // No caller-supplied cwd, environment, permission profile, unlimited time or output.
        let mut params = json!({"command":self.request.argv,
            "cwd":self.bridge.root,"permissionProfile":":read-only",
            "timeoutMs":self.request.timeout_ms,
            "tty":false,"streamStdin":false,"streamStdoutStderr":false});
        // Codex 0.153.4 rejects custom outputBytesCap inside the Windows sandbox.
        // Retain its bounded native default there, never disable the cap or sandbox.
        // The bridge's frame reader and returned text bounds apply on both platforms.
        if !cfg!(windows) { params["outputBytesCap"] = json!(16384); }
        let value = self.bridge.rpc("command/exec", params)?;
        let exit = value["exitCode"].as_i64().filter(|n| i32::try_from(*n).is_ok())
            .ok_or("Native command response omitted a valid exit code")?;
        let stdout = value["stdout"].as_str().ok_or("Native command response omitted stdout")?;
        let stderr = value["stderr"].as_str().ok_or("Native command response omitted stderr")?;
        Ok(json!({"ok":true,"request_id":self.request.request_id,"exit_code":exit,
            "stdout":bounded(stdout,16384),"stderr":bounded(stderr,16384),
            "output_may_be_truncated":stdout.len()>=16384||stderr.len()>=16384,
            "requested_permission_profile":":read-only","native_sandbox_verified":false,
            "model_requests":0,"thread_created":false,"no_unsandboxed_fallback":true,
            "replayed":false,"outcome":"completed"}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn options() -> Connection {
        serde_json::from_value(json!({"executable":"/not-executed/codex","expected_sha256":"0".repeat(64),
            "codex_home":"/not-opened/home","allow_model_usage":false,"allow_command_execution":true,
            "model":"unused","request_limit":1,"lifetime_seconds":60})).unwrap()
    }
    #[test]
    fn native_043_command_consent_bounds_and_replay_are_independent() {
        let mut memory=Memory::default(); let mut options=options();
        let r=CommandRequest{request_id:"fixture-1".into(),argv:vec!["tool".into(),"literal arg".into()],timeout_ms:1000};
        options.allow_command_execution=false; options.allow_model_usage=true;
        assert!(reserve_command(&mut memory,&options,&r,true,true).is_err());
        assert!(memory.ledger.is_empty());
        options.allow_model_usage=false; options.allow_command_execution=true;
        assert!(reserve_command(&mut memory,&options,&r,true,true).unwrap().is_none());
        assert_eq!(memory.requests_used,0); assert!(memory.threads.is_empty());
        assert!(reserve_command(&mut memory,&options,&r,true,true).is_err());
        memory.ledger.get_mut("command/fixture-1").unwrap().1=Some(json!({"ok":true,"exit_code":0}));
        assert_eq!(reserve_command(&mut memory,&options,&r,false,false).unwrap().unwrap()["exit_code"],0);
        let mut bad=r.clone(); bad.argv.push("different".into());
        assert!(reserve_command(&mut memory,&options,&bad,true,true).is_err());
        for timeout in [0,10001,u64::MAX] { bad.timeout_ms=timeout; assert!(validate(&bad).is_err()); }
        bad=r; bad.argv[0]="bad\0program".into(); assert!(validate(&bad).is_err());
    }
}

#[cfg(test)]
#[path="../../../aiTemp/release-043/native_command_fixture.rs"]
mod real_fixture;
