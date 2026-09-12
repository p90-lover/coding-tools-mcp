from pathlib import Path

# Backend: allow explicit zero ceilings while preserving bounded replay safety.
path = Path('src-tauri/src/codex_bridge/mod.rs')
text = path.read_text()

text = text.replace(
    'const MAX_LEDGER: usize = 64;\nconst RPC_TIMEOUT: Duration = Duration::from_secs(15);',
    'const MAX_LEDGER: usize = 64;\nconst LEDGER_RETENTION: Duration = Duration::from_secs(90 * 60);\nconst RPC_TIMEOUT: Duration = Duration::from_secs(60);',
    1,
)

old = '''#[derive(Default)]
struct Memory {
    threads: BTreeMap<String, ThreadState>,
    ledger: BTreeMap<String, (String, Option<Value>)>,
    requests_used: u32,
    native_identity: String,
    stop_reason: Option<String>,
}
'''
new = '''struct LedgerEntry {
    fingerprint: String,
    result: Option<Value>,
    completed_at: Option<Instant>,
}
#[derive(Default)]
struct Memory {
    threads: BTreeMap<String, ThreadState>,
    ledger: BTreeMap<String, LedgerEntry>,
    requests_used: u32,
    native_identity: String,
    stop_reason: Option<String>,
}
'''
assert old in text, 'Memory ledger layout changed'
text = text.replace(old, new, 1)

old = '''        || !(1..=20).contains(&options.request_limit)
        || !(30..=900).contains(&options.lifetime_seconds)
'''
new = '''        || options.request_limit > 20
        || (options.lifetime_seconds != 0 && !(30..=900).contains(&options.lifetime_seconds))
'''
assert old in text, 'native option range check changed'
text = text.replace(old, new, 1)
text = text.replace(
    '"Use absolute native paths, a SHA-256, model ID, 1–20 requests and 30–900 seconds"',
    '"Use absolute native paths, a SHA-256 and model ID; request_limit accepts 0 or 1–20, lifetime_seconds accepts 0 or 30–900"',
    1,
)

insert_before = '''fn reserve(
    memory: &mut Memory,
'''
helper = '''fn prune_ledger(memory: &mut Memory, now: Instant) {
    memory.ledger.retain(|_, entry| {
        entry
            .completed_at
            .is_none_or(|completed| now.saturating_duration_since(completed) < LEDGER_RETENTION)
    });
}

fn make_ledger_room(memory: &mut Memory) -> Result<()> {
    while memory.ledger.len() >= MAX_LEDGER {
        let oldest = memory
            .ledger
            .iter()
            .filter_map(|(id, entry)| entry.completed_at.map(|completed| (id.clone(), completed)))
            .min_by_key(|(_, completed)| *completed)
            .map(|(id, _)| id);
        let Some(id) = oldest else {
            return Err("Connection request ledger is full of pending outcomes; no request submitted".into());
        };
        memory.ledger.remove(&id);
    }
    Ok(())
}

'''
assert insert_before in text, 'reserve anchor changed'
text = text.replace(insert_before, helper + insert_before, 1)

old = '''    if let Some((before, result)) = memory.ledger.get(&request.request_id) {
        if before != &fingerprint {
            return Err("request_id already belongs to different arguments".into());
        }
        Ok(Some(result.clone().unwrap_or_else(
            || json!({"state":"pending","request_id":request.request_id,"replayed":false}),
        )))
    } else {
        if !live || !ready {
            return Err(
                "Native connection is stopped or not initialized; do not replay an unknown outcome"
                    .into(),
            );
        }
        if memory.ledger.len() >= MAX_LEDGER {
            return Err("Connection request ledger is full; no request submitted".into());
        }
'''
new = '''    prune_ledger(memory, Instant::now());
    if let Some(entry) = memory.ledger.get(&request.request_id) {
        if entry.fingerprint != fingerprint {
            return Err("request_id already belongs to different arguments".into());
        }
        Ok(Some(entry.result.clone().unwrap_or_else(
            || json!({"state":"pending","request_id":request.request_id,"replayed":false}),
        )))
    } else {
        if !live || !ready {
            return Err(
                "Native connection is stopped or not initialized; do not replay an unknown outcome"
                    .into(),
            );
        }
        make_ledger_room(memory)?;
'''
assert old in text, 'reserve ledger admission changed'
text = text.replace(old, new, 1)

text = text.replace(
    '''            if memory.requests_used >= options.request_limit {
                return Err("Local model-request limit reached".into());
            }
            memory.requests_used += 1;
''',
    '''            if options.request_limit != 0 && memory.requests_used >= options.request_limit {
                return Err("Local model-request limit reached".into());
            }
            memory.requests_used = memory.requests_used.saturating_add(1);
''',
    1,
)
text = text.replace(
    '''        memory
            .ledger
            .insert(request.request_id.clone(), (fingerprint, None));
''',
    '''        memory.ledger.insert(
            request.request_id.clone(),
            LedgerEntry {
                fingerprint,
                result: None,
                completed_at: None,
            },
        );
''',
    1,
)

old = '''        let weak = Arc::downgrade(&bridge);
        let lifetime = bridge.options.lifetime_seconds;
        std::thread::spawn(move || {
            for _ in 0..lifetime {
                std::thread::sleep(Duration::from_secs(1));
                let Some(bridge) = weak.upgrade() else {
                    return;
                };
                if !bridge.live.load(Ordering::SeqCst) {
                    return;
                }
            }
            if let Some(bridge) = weak.upgrade() {
                bridge.stop("local_consent_expired");
            }
        });
'''
new = '''        let lifetime = bridge.options.lifetime_seconds;
        if lifetime != 0 {
            let weak = Arc::downgrade(&bridge);
            std::thread::spawn(move || {
                for _ in 0..lifetime {
                    std::thread::sleep(Duration::from_secs(1));
                    let Some(bridge) = weak.upgrade() else {
                        return;
                    };
                    if !bridge.live.load(Ordering::SeqCst) {
                        return;
                    }
                }
                if let Some(bridge) = weak.upgrade() {
                    bridge.stop("local_consent_expired");
                }
            });
        }
'''
assert old in text, 'lifetime thread changed'
text = text.replace(old, new, 1)

old = '''            "model":bridge.options.model,"requests_used":memory.requests_used,"request_limit":bridge.options.request_limit,
            "seconds_remaining":bridge.options.lifetime_seconds.saturating_sub(bridge.started.elapsed().as_secs()),
'''
new = '''            "model":bridge.options.model,"requests_used":memory.requests_used,
            "request_limit":if bridge.options.request_limit==0 { Value::Null } else { json!(bridge.options.request_limit) },
            "request_limit_unbounded":bridge.options.request_limit==0,
            "seconds_remaining":if bridge.options.lifetime_seconds==0 { Value::Null } else { json!(bridge.options.lifetime_seconds.saturating_sub(bridge.started.elapsed().as_secs())) },
            "lifetime_unbounded":bridge.options.lifetime_seconds==0,
            "replay_retention_seconds":LEDGER_RETENTION.as_secs(),"replay_capacity":MAX_LEDGER,
'''
assert old in text, 'status limit fields changed'
text = text.replace(old, new, 1)
text = text.replace(
    '"limits_note":"Request count and lifetime are not a token, cost or native subagent budget"',
    '"limits_note":"Zero request/lifetime limits mean no app-side ceiling until disconnect; provider quotas still apply. Completed replay receipts are bounded RAM with 90-minute age expiry and oldest-first pressure eviction; pending outcomes are never evicted."',
    1,
)

text = text.replace(
    '''    fn enqueue(&self, value: Value) -> Result<()> {
        if self.started.elapsed() >= Duration::from_secs(self.options.lifetime_seconds) {
            self.stop("local_consent_expired");
        }
''',
    '''    fn enqueue(&self, value: Value) -> Result<()> {
        if self.options.lifetime_seconds != 0
            && self.started.elapsed() >= Duration::from_secs(self.options.lifetime_seconds)
        {
            self.stop("local_consent_expired");
        }
''',
    1,
)

old = '''            if request.operation == "close" {
                // Unsubscribe removes no saved files. The shared process is stopped on local
                // disconnect/expiry; no native thread archive/delete method is exposed.
                self.rpc("thread/unsubscribe", json!({"threadId":id}))?;
                if let Some(thread) = lock(&self.memory)?.threads.get_mut(&id) {
                    thread.status = "closed".into();
                }
            }
'''
new = '''            if request.operation == "close" {
                // Unsubscribe removes no saved files. Once the native runtime confirms it,
                // release this in-memory ownership slot so long-lived connections are not
                // limited to four lifetime threads. The close request remains replay-safe
                // through the bounded request ledger.
                self.rpc("thread/unsubscribe", json!({"threadId":id}))?;
                lock(&self.memory)?.threads.remove(&id);
            }
'''
assert old in text, 'close handling changed'
text = text.replace(old, new, 1)

old = '''        if let Ok(mut memory) = self.bridge.memory.lock() {
            if let Some(entry) = memory.ledger.get_mut(&self.request.request_id) {
                entry.1 = Some(stored.clone());
            }
        }
'''
new = '''        if let Ok(mut memory) = self.bridge.memory.lock() {
            if let Some(entry) = memory.ledger.get_mut(&self.request.request_id) {
                entry.result = Some(stored.clone());
                entry.completed_at = Some(Instant::now());
            }
        }
'''
assert old in text, 'ticket result storage changed'
text = text.replace(old, new, 1)

anchor = '''    #[test]
    fn native_bridge_notifications_preserve_completion_and_owned_scope() {
'''
new_test = '''    #[test]
    fn native_bridge_zero_request_limit_and_rotating_replay_ledger_are_long_lived() {
        let request = Control {
            operation: "start".into(),
            request_id: "unbounded-1".into(),
            thread_id: None,
            text: Some("Review without edits".into()),
        };
        let options = Connection {
            executable: PathBuf::new(),
            expected_sha256: String::new(),
            codex_home: PathBuf::new(),
            allow_model_usage: true,
            allow_command_execution: false,
            model: "fixture".into(),
            request_limit: 0,
            lifetime_seconds: 0,
        };
        let mut memory = Memory::default();
        memory.requests_used = 25;
        assert!(reserve(&mut memory, &request, true, &options, true, true)
            .unwrap()
            .is_none());
        assert_eq!(memory.requests_used, 26);

        let now = Instant::now();
        memory.ledger.clear();
        for index in 0..MAX_LEDGER {
            memory.ledger.insert(
                format!("old-{index:03}"),
                LedgerEntry {
                    fingerprint: format!("fp-{index}"),
                    result: Some(json!({"ok":true})),
                    completed_at: Some(now - LEDGER_RETENTION - Duration::from_secs(1)),
                },
            );
        }
        let fresh = Control {
            request_id: "fresh-after-expiry".into(),
            ..request.clone()
        };
        assert!(reserve(&mut memory, &fresh, true, &options, true, true)
            .unwrap()
            .is_none());
        assert_eq!(memory.ledger.len(), 1);

        memory.ledger.clear();
        for index in 0..MAX_LEDGER {
            memory.ledger.insert(
                format!("pending-{index:03}"),
                LedgerEntry {
                    fingerprint: format!("pending-fp-{index}"),
                    result: None,
                    completed_at: None,
                },
            );
        }
        let blocked = Control {
            request_id: "blocked-by-pending".into(),
            ..request
        };
        assert!(reserve(&mut memory, &blocked, true, &options, true, true).is_err());
        assert_eq!(memory.ledger.len(), MAX_LEDGER);
    }

'''
assert anchor in text, 'test anchor changed'
text = text.replace(anchor, new_test + anchor, 1)

path.write_text(text)

# Frontend: expose zero as existing fields' unlimited value, no separate mode.
path = Path('src/lib/components/CodexRuntimePanel.svelte')
text = path.read_text()
text = text.replace(
    'requests_used?: number; request_limit?: number; seconds_remaining?: number;',
    'requests_used?: number; request_limit?: number | null; request_limit_unbounded?: boolean; seconds_remaining?: number | null; lifetime_unbounded?: boolean;',
    1,
)
text = text.replace('let requestLimit = $state(4);', 'let requestLimit = $state(0);', 1)
text = text.replace('let lifetime = $state(300);', 'let lifetime = $state(0);', 1)
text = text.replace(
    '''<label>{t($locale, 'Model-request limit (not token/cost limit)', '模型請求上限（並非 Token／費用上限）')}<input type="number" bind:value={requestLimit} min="1" max="20" required disabled={busy || !!snapshot?.connected}/></label>
      <label>{t($locale, 'Consent lifetime in seconds', '授權有效秒數')}<input type="number" bind:value={lifetime} min="30" max="900" required disabled={busy || !!snapshot?.connected}/></label>''',
    '''<label>{t($locale, 'Model-request limit · 0 = no app-side ceiling', '模型請求上限 · 0 = 應用程式不設上限')}<input type="number" bind:value={requestLimit} min="0" max="20" required disabled={busy || !!snapshot?.connected}/></label>
      <label>{t($locale, 'Consent lifetime seconds · 0 = until disconnect', '授權有效秒數 · 0 = 直到斷線')}<input type="number" bind:value={lifetime} min="0" max="900" required disabled={busy || !!snapshot?.connected}/></label>''',
    1,
)
text = text.replace(
    "{snapshot.connected ? t($locale, 'Connected', '已連接') : t($locale, 'Not connected', '未連接')} · {snapshot.requests_used ?? 0}/{snapshot.request_limit ?? requestLimit} · {snapshot.seconds_remaining ?? 0}s · {snapshot.stop_reason ?? snapshot.native_identity ?? ''}",
    "{snapshot.connected ? t($locale, 'Connected', '已連接') : t($locale, 'Not connected', '未連接')} · {snapshot.requests_used ?? 0}/{snapshot.request_limit_unbounded ? '∞' : (snapshot.request_limit ?? requestLimit)} · {snapshot.lifetime_unbounded ? t($locale, 'until disconnect', '直到斷線') : `${snapshot.seconds_remaining ?? 0}s`} · {snapshot.stop_reason ?? snapshot.native_identity ?? ''}",
    1,
)
text = text.replace(
    "'I authorize native model usage for this connection. Commands have a separate checkbox; leaving this unchecked prohibits model turns.'",
    "'I authorize native model usage for this connection. Commands have a separate checkbox; leaving this unchecked prohibits model turns. A zero request/lifetime field removes only this app’s ceiling; provider quotas and local Stop still apply.'",
    1,
)
text = text.replace(
    "'我授權這次連接使用原生模型；命令有獨立勾選框；此處未勾選會禁止模型回合。'",
    "'我授權這次連接使用原生模型；命令有獨立勾選框；此處未勾選會禁止模型回合。請求／期限填 0 只代表本程式不設上限；供應商配額及本機停止仍然生效。'",
    1,
)
path.write_text(text)

# Documentation: update only the limit semantics in both languages.
path = Path('docs/features/native-codex-runtime.md')
text = path.read_text()
text = text.replace(
    'Select a trusted native executable and supply its independently checked SHA-256, a dedicated existing Codex home outside the delegated workspace, your configured model ID, a request limit and consent lifetime.',
    'Select a trusted native executable and supply its independently checked SHA-256, a dedicated existing Codex home outside the delegated workspace, your configured model ID, a request limit and consent lifetime. The existing fields accept `0` for no app-side request ceiling and for a connection lifetime that lasts until local disconnect/revocation; this is not a provider-quota bypass.',
    1,
)
text = text.replace(
    'A connection allows at most four lifetime thread records, 64 idempotency records, 1–20 admitted model-control requests and 30–900 seconds of lifetime. These limits are not token/cost caps and do not count every internal native subagent call. One control operation is submitted at a time. Repeated `request_id` values with identical arguments return the stored result without replay; different arguments under the same ID are rejected. Rejected admissions/serialized-control conflicts can conservatively consume a reserved request allowance.',
    'A connection retains at most four currently owned thread records; a confirmed `close`/unsubscribe releases that in-memory slot. The existing request-limit field accepts `0` or 1–20, and the lifetime field accepts `0` or 30–900 seconds. Zero means no app-side request ceiling / until local disconnect or revocation; provider quotas still apply. One control operation is submitted at a time. Completed idempotency receipts live in bounded RAM for up to 90 minutes and are evicted oldest-first under capacity pressure; pending/unknown outcomes are never evicted to make room. Repeated `request_id` values within the retained replay window return the stored result without replay; different arguments under the same retained ID are rejected. Use a fresh UUID for each new operation and never assume an expired receipt means an old effect did not happen.',
    1,
)
text = text.replace('individual RPC waits expire after 15 seconds.', 'individual RPC waits expire after 60 seconds.', 1)
text = text.replace(
    '選擇可信任的原生執行檔、輸入獨立核對的 SHA-256、位於委派工作區以外且已存在的專用 Codex 主目錄、模型 ID、請求上限及授權期限。',
    '選擇可信任的原生執行檔、輸入獨立核對的 SHA-256、位於委派工作區以外且已存在的專用 Codex 主目錄、模型 ID、請求上限及授權期限。現有欄位可填 `0`：請求上限 0 代表本程式不設請求上限，期限 0 代表保持到本機斷線／撤銷；呢個設定唔會繞過供應商配額。',
    1,
)
text = text.replace(
    '每個連接最多保留四個會話紀錄、64 個冪等請求紀錄，允許 1–20 個模型控制請求及 30–900 秒的授權期限。這不是 Token／費用上限，也不會計算原生環境內每次子 Agent 呼叫。同時只提交一個控制操作；相同 `request_id` 加相同參數會回傳已保存結果而不重播，改用不同參數則拒絕。部分被拒絕或遇到控制並行衝突的請求，可能保守地占用已預留的次數。',
    '每個連接最多保留四個目前仍由此連接擁有的會話紀錄；確認 `close`／取消訂閱後會釋放該記憶體位置。現有請求上限欄位可填 0 或 1–20，授權期限可填 0 或 30–900 秒；0 代表本程式不設請求上限／保持至本機斷線或撤銷，供應商配額仍然有效。同時只提交一個控制操作。已完成的冪等回執只存於有限 RAM，最多保留 90 分鐘，容量壓力下優先清除最舊已完成回執；結果未知／仍處理中的回執絕不會為騰空位置而被清除。在保留窗口內，相同 `request_id` 加相同參數會回傳已保存結果而不重播，改用不同參數則拒絕。每個新操作應使用新 UUID；回執過期絕不代表舊操作沒有發生。',
    1,
)
text = text.replace('每次 RPC 最多等候 15 秒。', '每次 RPC 最多等候 60 秒。', 1)
path.write_text(text)
