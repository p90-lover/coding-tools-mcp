from pathlib import Path

path = Path('src-tauri/src/codex_bridge/native_command.rs')
text = path.read_text()

old = '''    let fingerprint = serde_json::to_string(request).map_err(|_| "Cannot encode command")?;
    if let Some((before, result)) = memory.ledger.get(&key) {
        if before != &fingerprint {
            return Err("Command request ID was reused with different arguments".into());
        }
        return result
            .clone()
            .map(Some)
            .ok_or_else(|| "Command outcome is pending or unknown; do not replay".into());
    }
'''
new = '''    let fingerprint = serde_json::to_string(request).map_err(|_| "Cannot encode command")?;
    prune_ledger(memory, Instant::now());
    if let Some(entry) = memory.ledger.get(&key) {
        if entry.fingerprint != fingerprint {
            return Err("Command request ID was reused with different arguments".into());
        }
        return entry
            .result
            .clone()
            .map(Some)
            .ok_or_else(|| "Command outcome is pending or unknown; do not replay".into());
    }
'''
assert old in text, 'native command replay lookup changed'
text = text.replace(old, new, 1)

old = '''    if memory.ledger.len() >= MAX_LEDGER {
        return Err("Native request ledger is full; reconnect locally before new commands".into());
    }
    memory.ledger.insert(key, (fingerprint, None));
'''
new = '''    make_ledger_room(memory)?;
    memory.ledger.insert(
        key,
        LedgerEntry {
            fingerprint,
            result: None,
            completed_at: None,
        },
    );
'''
assert old in text, 'native command ledger admission changed'
text = text.replace(old, new, 1)

old = '''        if bridge.started.elapsed() >= Duration::from_secs(bridge.options.lifetime_seconds) {
            bridge.stop("local_consent_expired");
        }
'''
new = '''        if bridge.options.lifetime_seconds != 0
            && bridge.started.elapsed() >= Duration::from_secs(bridge.options.lifetime_seconds)
        {
            bridge.stop("local_consent_expired");
        }
'''
assert old in text, 'native command lifetime check changed'
text = text.replace(old, new, 1)

old = '''            if let Some(entry) = memory
                .ledger
                .get_mut(&format!("command/{}", self.request.request_id))
            {
                entry.1 = Some(stored.clone());
            }
'''
new = '''            if let Some(entry) = memory
                .ledger
                .get_mut(&format!("command/{}", self.request.request_id))
            {
                entry.result = Some(stored.clone());
                entry.completed_at = Some(Instant::now());
            }
'''
assert old in text, 'native command ticket result storage changed'
text = text.replace(old, new, 1)

old = '''        memory.ledger.get_mut("command/fixture-1").unwrap().1 =
            Some(json!({"ok":true,"exit_code":0}));
'''
new = '''        let entry = memory.ledger.get_mut("command/fixture-1").unwrap();
        entry.result = Some(json!({"ok":true,"exit_code":0}));
        entry.completed_at = Some(Instant::now());
'''
assert old in text, 'native command replay test storage changed'
text = text.replace(old, new, 1)

path.write_text(text)
