//! Allowlisted upstream operations; no arbitrary endpoint, shell, environment,
//! permission-bypass, daemon shutdown or deletion request is accepted.
use super::model::{identifier, Action, Engine, Spec};
use serde::Serialize;
use serde_json::{json, Value};
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub enum Wire {
    Socket {
        message: Value,
        response: String,
        status: Option<String>,
    },
    Http {
        method: String,
        path: String,
        body: Value,
    },
}
#[derive(Clone, Debug, Serialize)]
pub struct Request {
    pub engine: Engine,
    pub action: Action,
    pub request_id: String,
    pub record_id: Option<String>,
    pub run_id: Option<String>,
    pub wire: Wire,
}
pub fn endpoint(engine: Engine, value: &str) -> Result<url::Url, String> {
    if value.len() > 512
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
        || value.contains('\\')
    {
        return Err("Use a bounded literal loopback endpoint".into());
    }
    let mut u = url::Url::parse(value).map_err(|_| "Invalid endpoint")?;
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.port().is_none()
    {
        return Err("Endpoint needs an explicit port and no credentials, query or fragment".into());
    }
    let local = match u.host() {
        Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
        _ => false,
    };
    if !local {
        return Err("Only 127.0.0.1 or [::1] is allowed; no DNS or remote endpoints".into());
    }
    match engine {
        Engine::Paseo if u.scheme() == "ws" && matches!(u.path(), "" | "/" | "/ws") => {
            u.set_path("/ws")
        }
        Engine::Anneal if u.scheme() == "http" && matches!(u.path(), "" | "/") => u.set_path("/"),
        _ => {
            return Err("Paseo requires ws loopback /ws; Anneal requires http loopback root".into())
        }
    };
    Ok(u)
}
pub fn build(
    spec: &Spec,
    record: Option<&str>,
    run: Option<&str>,
    action: Action,
    key: &str,
) -> Result<Request, String> {
    spec.validate()?;
    identifier(key)?;
    for id in [record, run].into_iter().flatten() {
        identifier(id)?;
    }
    if action != Action::Create && record.is_none() {
        return Err("Action requires a previously bound owned record".into());
    }
    let id = record.unwrap_or("");
    let wire = match spec.engine {
        Engine::Paseo => {
            let (mut message, response, status) = match action {
                Action::Create => (
                    json!({"type":"create_agent_request","idempotencyKey":spec.mission_id,
      "config":{"provider":spec.provider,"cwd":spec.cwd,"modeId":spec.mode,"model":spec.model,"title":spec.title},
      "autoArchive":false,"labels":{"coding-tools-mission":spec.mission_id,"coding-tools-workspace":spec.workspace_id,"coding-tools-task":spec.task_id}}),
                    "status",
                    Some("agent_created"),
                ),
                Action::Start | Action::Resume => (
                    json!({"type":"send_agent_message_request","agentId":id,"text":spec.brief,"messageId":key}),
                    "send_agent_message_response",
                    None,
                ),
                Action::Inspect => (
                    json!({"type":"fetch_agent_request","agentId":id}),
                    "fetch_agent_response",
                    None,
                ),
                Action::Events => (
                    json!({"type":"fetch_agent_timeline_request","agentId":id,"direction":"tail","limit":50,"projection":"projected"}),
                    "fetch_agent_timeline_response",
                    None,
                ),
                Action::Hold | Action::Cancel => (
                    json!({"type":"cancel_agent_request","agentId":id}),
                    "cancel_agent_response",
                    None,
                ),
                Action::Close => (
                    json!({"type":"close_items_request","agentIds":[id],"terminalIds":[]}),
                    "close_items_response",
                    None,
                ),
            };
            message["requestId"] = json!(key);
            Wire::Socket {
                message,
                response: response.into(),
                status: status.map(str::to_owned),
            }
        }
        Engine::Anneal => {
            let (method, path, body) = match action {
                Action::Create => (
                    "POST",
                    format!(
                        "/projects/{}/tasks",
                        spec.project_id.as_deref().ok_or("Missing project")?
                    ),
                    json!({
      "name":spec.title,"description":format!("[coding-tools-mcp:{}]\n{}",spec.mission_id,spec.brief),
      "status":"BACKLOG","workingDirectory":spec.cwd,"repoId":spec.repo_id,"assigneeType":"AGENT","assigneeAgentId":spec.assignee_id,
      "approvalGate":true,"opensPullRequest":false,"maxDurationMin":spec.max_duration_min,"stallTimeoutMin":10,"maxSessionsPerTask":1,
      "scheduleKind":"NOW","chainId":spec.mission_id,"chainIndex":0}),
                ),
                Action::Start => ("POST", format!("/tasks/{id}/start"), json!({})),
                Action::Inspect => ("GET", format!("/tasks/{id}"), Value::Null),
                Action::Events => ("GET", format!("/tasks/{id}/activity"), Value::Null),
                Action::Hold => (
                    "POST",
                    format!("/tasks/{id}/chain/hold"),
                    json!({"requestId":key,"reason":"MCP coordinator requested a dispatch hold; current run may continue"}),
                ),
                Action::Resume => (
                    "POST",
                    format!("/tasks/{id}/chain/resume"),
                    json!({"requestId":key}),
                ),
                Action::Cancel => (
                    "POST",
                    format!(
                        "/runs/{}/cancel",
                        run.ok_or("Cancellation requires the owned run ID")?
                    ),
                    json!({"requestId":key,"reason":"MCP coordinator requested cancellation","parkTask":true}),
                ),
                Action::Close => ("POST", format!("/tasks/{id}/archive"), json!({})),
            };
            Wire::Http {
                method: method.into(),
                path,
                body,
            }
        }
    };
    Ok(Request {
        engine: spec.engine,
        action,
        request_id: key.into(),
        record_id: record.map(str::to_owned),
        run_id: run.map(str::to_owned),
        wire,
    })
}

pub fn build_timeline_before(
    spec: &Spec,
    record: &str,
    key: &str,
    epoch: &str,
    seq: u64,
) -> Result<Request, String> {
    if spec.engine != Engine::Paseo
        || epoch.trim().is_empty()
        || epoch.len() > 128
        || epoch.chars().any(char::is_control)
        || seq == 0
    {
        return Err("Invalid Paseo timeline cursor".into());
    }
    let mut request = build(spec, Some(record), None, Action::Events, key)?;
    let Wire::Socket { message, .. } = &mut request.wire else {
        return Err("Paseo timeline needs a socket request".into());
    };
    message["direction"] = json!("before");
    message["cursor"] = json!({"epoch":epoch,"seq":seq});
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paseo_before_page_uses_the_owned_cursor() {
        let spec = Spec {
            engine: Engine::Paseo,
            mission_id: "mission".into(),
            workspace_id: "qa".into(),
            task_id: "task".into(),
            cwd: "C:/qa".into(),
            provider: "codex".into(),
            model: "gemini-3.1-pro-low".into(),
            mode: "default".into(),
            project_id: None,
            repo_id: None,
            assignee_id: None,
            title: "Read".into(),
            brief: "Read only".into(),
            max_duration_min: 10,
        };
        let request = build_timeline_before(&spec, "agent-1", "page-1", "epoch:1", 51).unwrap();
        assert_eq!(request.action, Action::Events);
        match request.wire {
            Wire::Socket { message, .. } => assert_eq!(
                message,
                json!({
                    "type": "fetch_agent_timeline_request",
                    "agentId": "agent-1",
                    "direction": "before",
                    "cursor": {"epoch": "epoch:1", "seq": 51},
                    "limit": 50,
                    "projection": "projected",
                    "requestId": "page-1"
                })
            ),
            Wire::Http { .. } => panic!("Paseo timeline must use a socket"),
        }
        assert!(build_timeline_before(&spec, "agent-1", "page-2", "", 51).is_err());
        assert!(build_timeline_before(&spec, "agent-1", "page-3", "epoch:1", 0).is_err());
    }
}
