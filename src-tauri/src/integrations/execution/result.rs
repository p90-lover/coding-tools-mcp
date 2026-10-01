use super::model::identifier;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_RESULT_TEXT_BYTES: usize = 16 * 1024;
const MAX_EPOCH_BYTES: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaseoStartResult {
    pub agent_id: String,
    pub turn_id: String,
    pub epoch: String,
    pub seq_start: u64,
    pub seq_end: u64,
    pub text: String,
}

pub fn parse_paseo_start_result(
    value: &Value,
    expected_agent_id: &str,
    start_key: &str,
) -> Result<Option<PaseoStartResult>, String> {
    identifier(expected_agent_id)?;
    identifier(start_key)?;

    let payload = value
        .as_object()
        .ok_or_else(|| "Malformed Paseo timeline payload".to_string())?;
    let agent_id = payload
        .get("agentId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Malformed Paseo agent ID".to_string())?;
    identifier(agent_id)?;
    if agent_id != expected_agent_id {
        return Err("Paseo timeline belongs to another agent".into());
    }

    for flag in ["reset", "staleCursor", "gap"] {
        match payload.get(flag).and_then(Value::as_bool) {
            Some(false) => {}
            Some(true) => return Err("Paseo timeline continuity is not trustworthy".into()),
            None => return Err("Malformed Paseo timeline continuity fields".into()),
        }
    }
    match payload.get("error") {
        Some(Value::Null) => {}
        Some(Value::String(_)) => return Err("Paseo timeline reported an error".into()),
        _ => return Err("Malformed Paseo timeline error field".into()),
    }

    let direction = payload
        .get("direction")
        .and_then(Value::as_str)
        .ok_or_else(|| "Malformed Paseo timeline direction".to_string())?;
    if !matches!(direction, "tail" | "before" | "after") {
        return Err("Malformed Paseo timeline direction".into());
    }
    let projection = payload
        .get("projection")
        .and_then(Value::as_str)
        .ok_or_else(|| "Malformed Paseo timeline projection".to_string())?;
    if !matches!(projection, "projected" | "canonical") {
        return Err("Malformed Paseo timeline projection".into());
    }
    let has_newer = payload
        .get("hasNewer")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Malformed Paseo timeline window".to_string())?;
    let epoch = payload
        .get("epoch")
        .and_then(Value::as_str)
        .ok_or_else(|| "Malformed Paseo timeline epoch".to_string())?;
    if epoch.trim().is_empty()
        || epoch.len() > MAX_EPOCH_BYTES
        || epoch.chars().any(char::is_control)
    {
        return Err("Invalid Paseo timeline epoch".into());
    }

    let entries = payload
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| "Malformed Paseo timeline entries".to_string())?;
    let mut anchor = None;
    let mut assistants = Vec::new();

    for raw in entries {
        let entry = raw
            .as_object()
            .ok_or_else(|| "Malformed Paseo timeline entry".to_string())?;
        let seq_start = entry
            .get("seqStart")
            .and_then(Value::as_u64)
            .ok_or_else(|| "Malformed Paseo timeline sequence".to_string())?;
        let seq_end = entry
            .get("seqEnd")
            .and_then(Value::as_u64)
            .ok_or_else(|| "Malformed Paseo timeline sequence".to_string())?;
        if seq_end < seq_start {
            return Err("Malformed Paseo timeline sequence".into());
        }

        let turn_id = match entry.get("turnId") {
            Some(Value::String(value)) => Some(value.as_str()),
            Some(_) => return Err("Malformed Paseo timeline turn ID".into()),
            None => None,
        };
        let item = entry
            .get("item")
            .and_then(Value::as_object)
            .ok_or_else(|| "Malformed Paseo timeline item".to_string())?;
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "Malformed Paseo timeline item type".to_string())?;

        match item_type {
            "user_message" => {
                if item.get("text").and_then(Value::as_str).is_none() {
                    return Err("Malformed Paseo user message".into());
                }
                for field in ["messageId", "clientMessageId"] {
                    if item.get(field).is_some_and(|value| !value.is_string()) {
                        return Err("Malformed Paseo user message identity".into());
                    }
                }
                if item.get("clientMessageId").and_then(Value::as_str) == Some(start_key) {
                    let turn_id = turn_id
                        .ok_or_else(|| "Start message is missing its turn ID".to_string())?;
                    if turn_id.is_empty()
                        || turn_id.len() > 256
                        || turn_id.chars().any(char::is_control)
                    {
                        return Err("Invalid Paseo turn ID".into());
                    }
                    if anchor.replace((turn_id, seq_end)).is_some() {
                        return Err("Duplicate Paseo Start message identity".into());
                    }
                }
            }
            "assistant_message" => {
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Malformed Paseo assistant message".to_string())?;
                if item
                    .get("messageId")
                    .is_some_and(|value| !value.is_string())
                {
                    return Err("Malformed Paseo assistant message identity".into());
                }
                if let Some(turn_id) = turn_id {
                    assistants.push((seq_start, seq_end, turn_id, text));
                }
            }
            _ => {}
        }
    }

    let Some((turn_id, user_seq_end)) = anchor else {
        return Ok(None);
    };
    assistants.retain(|(seq_start, _, candidate_turn, _)| {
        *seq_start > user_seq_end && *candidate_turn == turn_id
    });
    assistants.sort_unstable_by_key(|(seq_start, _, _, _)| *seq_start);
    if assistants.is_empty() {
        return Ok(None);
    }
    if assistants.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
        return Err("Ambiguous Paseo assistant sequence".into());
    }

    let mut total = 0usize;
    for (index, (_, _, _, text)) in assistants.iter().enumerate() {
        if text.trim().is_empty()
            || text
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
        {
            return Err("Paseo assistant text is empty or contains controls".into());
        }
        total = total
            .checked_add(text.len())
            .and_then(|size| size.checked_add(usize::from(index > 0)))
            .ok_or_else(|| "Paseo assistant text is too large".to_string())?;
        if total > MAX_RESULT_TEXT_BYTES {
            return Err("Paseo assistant text is too large".into());
        }
    }

    if direction != "tail" || has_newer {
        return Ok(None);
    }

    let seq_start = assistants[0].0;
    let seq_end = assistants
        .iter()
        .map(|(_, seq_end, _, _)| *seq_end)
        .max()
        .expect("non-empty assistant rows");
    let text = assistants
        .into_iter()
        .map(|(_, _, _, text)| text)
        .collect::<Vec<_>>()
        .join("\n");

    Ok(Some(PaseoStartResult {
        agent_id: agent_id.into(),
        turn_id: turn_id.into(),
        epoch: epoch.into(),
        seq_start,
        seq_end,
        text,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn response(entries: Vec<Value>) -> Value {
        json!({
            "requestId": "request-1",
            "agentId": "agent-1",
            "agent": null,
            "direction": "tail",
            "projection": "projected",
            "epoch": "epoch-1",
            "reset": false,
            "staleCursor": false,
            "gap": false,
            "window": {"minSeq": 1, "maxSeq": 20, "nextSeq": 21},
            "startCursor": null,
            "endCursor": null,
            "hasOlder": true,
            "hasNewer": false,
            "entries": entries,
            "error": null
        })
    }

    fn entry(item: Value, turn_id: &str, seq_start: u64, seq_end: u64) -> Value {
        json!({
            "provider": "codex",
            "item": item,
            "turnId": turn_id,
            "timestamp": "2026-09-23T00:00:00.000Z",
            "seqStart": seq_start,
            "seqEnd": seq_end,
            "sourceSeqRanges": [{"startSeq": seq_start, "endSeq": seq_end}],
            "collapsed": []
        })
    }

    #[test]
    fn selects_only_assistant_text_after_the_matching_start() {
        let value = response(vec![
            entry(
                json!({"type": "assistant_message", "text": "stale"}),
                "turn-1",
                2,
                2,
            ),
            entry(
                json!({
                    "type": "user_message",
                    "text": "old",
                    "clientMessageId": "old-start"
                }),
                "turn-1",
                3,
                3,
            ),
            entry(
                json!({
                    "type": "user_message",
                    "text": "start",
                    "messageId": "provider-message",
                    "clientMessageId": "start-1"
                }),
                "turn-2",
                10,
                12,
            ),
            entry(
                json!({"type": "assistant_message", "text": "overlap"}),
                "turn-2",
                11,
                11,
            ),
            entry(
                json!({"type": "assistant_message", "text": "first"}),
                "turn-2",
                13,
                13,
            ),
            entry(
                json!({"type": "tool_call", "status": "completed"}),
                "turn-2",
                14,
                14,
            ),
            entry(
                json!({"type": "assistant_message", "text": "second"}),
                "turn-2",
                15,
                16,
            ),
            entry(
                json!({"type": "assistant_message", "text": "future"}),
                "turn-3",
                20,
                20,
            ),
        ]);

        assert_eq!(
            parse_paseo_start_result(&value, "agent-1", "start-1").unwrap(),
            Some(PaseoStartResult {
                agent_id: "agent-1".into(),
                turn_id: "turn-2".into(),
                epoch: "epoch-1".into(),
                seq_start: 13,
                seq_end: 16,
                text: "first\nsecond".into(),
            })
        );
    }

    #[test]
    fn message_id_alone_is_not_the_start_identity() {
        let value = response(vec![
            entry(
                json!({
                    "type": "user_message",
                    "text": "old",
                    "messageId": "start-1"
                }),
                "turn-old",
                1,
                1,
            ),
            entry(
                json!({"type": "assistant_message", "text": "stale"}),
                "turn-old",
                2,
                2,
            ),
        ]);

        assert_eq!(
            parse_paseo_start_result(&value, "agent-1", "start-1").unwrap(),
            None
        );
    }

    #[test]
    fn accepts_bounded_upstream_turn_ids_with_punctuation() {
        let turn = "turn:2.0";
        let value = response(vec![
            entry(
                json!({"type": "user_message", "text": "start", "clientMessageId": "start-1"}),
                turn,
                1,
                1,
            ),
            entry(
                json!({"type": "assistant_message", "text": "reply"}),
                turn,
                2,
                2,
            ),
        ]);
        assert_eq!(
            parse_paseo_start_result(&value, "agent-1", "start-1")
                .unwrap()
                .unwrap()
                .turn_id,
            turn
        );
        for invalid in ["", "turn\n2"] {
            let value = response(vec![entry(
                json!({"type": "user_message", "text": "start", "clientMessageId": "start-1"}),
                invalid,
                1,
                1,
            )]);
            assert!(parse_paseo_start_result(&value, "agent-1", "start-1").is_err());
        }
    }

    #[test]
    fn incomplete_windows_do_not_claim_a_result() {
        let anchor = entry(
            json!({
                "type": "user_message",
                "text": "start",
                "clientMessageId": "start-1"
            }),
            "turn-2",
            10,
            10,
        );
        assert_eq!(
            parse_paseo_start_result(&response(vec![]), "agent-1", "start-1").unwrap(),
            None
        );
        assert_eq!(
            parse_paseo_start_result(&response(vec![anchor.clone()]), "agent-1", "start-1")
                .unwrap(),
            None
        );

        let mut partial = response(vec![
            anchor,
            entry(
                json!({"type": "assistant_message", "text": "partial"}),
                "turn-2",
                11,
                11,
            ),
        ]);
        partial["hasNewer"] = json!(true);
        assert_eq!(
            parse_paseo_start_result(&partial, "agent-1", "start-1").unwrap(),
            None
        );
    }

    #[test]
    fn rejects_wrong_source_and_discontinuous_timeline() {
        let base = response(vec![]);
        let mut cases = Vec::new();

        let mut missing_agent = base.clone();
        missing_agent["agentId"] = Value::Null;
        cases.push(missing_agent);

        let mut wrong_agent = base.clone();
        wrong_agent["agentId"] = json!("agent-2");
        cases.push(wrong_agent);

        for field in ["reset", "staleCursor", "gap"] {
            let mut value = base.clone();
            value[field] = json!(true);
            cases.push(value);
        }

        let mut upstream_error = base;
        upstream_error["error"] = json!("secret upstream detail");
        cases.push(upstream_error);

        for value in cases {
            assert!(parse_paseo_start_result(&value, "agent-1", "start-1").is_err());
        }
    }

    #[test]
    fn rejects_malformed_empty_and_oversized_selected_text() {
        let anchor = entry(
            json!({
                "type": "user_message",
                "text": "start",
                "clientMessageId": "start-1"
            }),
            "turn-2",
            10,
            10,
        );

        let mut malformed = response(vec![anchor.clone()]);
        malformed["entries"][0]["seqStart"] = json!("ten");
        assert!(parse_paseo_start_result(&malformed, "agent-1", "start-1").is_err());

        for text in ["", "   "] {
            let value = response(vec![
                anchor.clone(),
                entry(
                    json!({"type": "assistant_message", "text": text}),
                    "turn-2",
                    11,
                    11,
                ),
            ]);
            assert!(parse_paseo_start_result(&value, "agent-1", "start-1").is_err());
        }

        let value = response(vec![
            anchor,
            entry(
                json!({"type": "assistant_message", "text": "x".repeat(16 * 1024 + 1)}),
                "turn-2",
                11,
                11,
            ),
        ]);
        assert!(parse_paseo_start_result(&value, "agent-1", "start-1").is_err());
    }
}
