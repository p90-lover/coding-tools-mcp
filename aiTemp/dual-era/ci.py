from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path.cwd()
RUN = os.environ.get("GITHUB_RUN_ID", "local")
TRASH = ROOT / "aiTemp" / "Trash" / "dual-era-before" / RUN
EVIDENCE = ROOT / "aiTemp" / "evidence"
VERSION = "0.4.1-rc.3"


def backup(path: str) -> Path:
    src = ROOT / path
    assert src.exists() and not src.is_symlink(), path
    dst = TRASH / path
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists():
        shutil.copy2(src, dst)
    return src


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    assert count == 1, f"{label}: expected one match, got {count}"
    return text.replace(old, new, 1)


def append_contract_tests() -> None:
    p = backup("aiTemp/connection-tests/http.rs")
    text = p.read_text(encoding="utf-8")
    marker = "connection_dual_era_modern_discovery_and_full_catalog"
    if marker in text:
        return
    text += r'''

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_dual_era_modern_discovery_and_full_catalog() {
    let f = Fixture::new(false).await;
    let meta = json!({
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{},
        "io.modelcontextprotocol/clientInfo":{"name":"modern-fixture","version":"1"}
    });
    let discover = f.client.post(&f.endpoint).bearer_auth(&f.token)
        .header("MCP-Protocol-Version","2026-07-28")
        .header("Mcp-Method","server/discover")
        .json(&json!({"jsonrpc":"2.0","id":10,"method":"server/discover","params":{"_meta":meta.clone()}}))
        .send().await.unwrap();
    assert_eq!(discover.status().as_u16(),200);
    let discover:Value=discover.json().await.unwrap();
    assert_eq!(discover["result"]["resultType"],"complete");
    assert_eq!(discover["result"]["ttlMs"],0);
    assert_eq!(discover["result"]["cacheScope"],"private");
    assert!(discover["result"]["supportedVersions"].as_array().unwrap().iter().any(|v|v=="2026-07-28"));
    assert!(discover["result"]["supportedVersions"].as_array().unwrap().iter().any(|v|v=="2025-11-25"));
    assert_eq!(discover["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],"coding-tools-mcp");

    let mut policy=f.context.for_request().unwrap().policy;
    policy.permission_mode="on-request".into();
    commit_updates(vec![(f.context.clone(),policy,"full".into())],||Ok(())).unwrap();
    let listed=f.client.post(&f.endpoint).bearer_auth(&f.token)
        .header("MCP-Protocol-Version","2026-07-28")
        .header("Mcp-Method","tools/list")
        .json(&json!({"jsonrpc":"2.0","id":11,"method":"tools/list","params":{"_meta":meta.clone()}}))
        .send().await.unwrap();
    assert_eq!(listed.status().as_u16(),200);
    let listed:Value=listed.json().await.unwrap();
    assert_eq!(listed["result"]["resultType"],"complete");
    assert_eq!(listed["result"]["ttlMs"],0);
    assert_eq!(listed["result"]["cacheScope"],"private");
    let names:Vec<_>=listed["result"]["tools"].as_array().unwrap().iter().filter_map(|t|t["name"].as_str()).collect();
    for expected in ["codex_tools_status","update_plan","harness_status","start_task","capture_screenshot","computer_action"] {
        assert!(names.contains(&expected),"full catalog missing {expected}");
    }

    let mismatch=f.client.post(&f.endpoint).bearer_auth(&f.token)
        .header("MCP-Protocol-Version","2026-07-28")
        .header("Mcp-Method","ping")
        .json(&json!({"jsonrpc":"2.0","id":12,"method":"tools/list","params":{"_meta":meta.clone()}}))
        .send().await.unwrap();
    assert_eq!(mismatch.status().as_u16(),400);
    let mismatch:Value=mismatch.json().await.unwrap();
    assert_eq!(mismatch["error"]["code"],-32020);

    let missing_method=f.client.post(&f.endpoint).bearer_auth(&f.token)
        .header("MCP-Protocol-Version","2026-07-28")
        .json(&json!({"jsonrpc":"2.0","id":13,"method":"tools/list","params":{"_meta":meta.clone()}}))
        .send().await.unwrap();
    assert_eq!(missing_method.status().as_u16(),400);
    let missing_method:Value=missing_method.json().await.unwrap();
    assert_eq!(missing_method["error"]["code"],-32020);

    let unsupported=f.client.post(&f.endpoint).bearer_auth(&f.token)
        .header("MCP-Protocol-Version","2099-01-01")
        .header("Mcp-Method","tools/list")
        .json(&json!({"jsonrpc":"2.0","id":14,"method":"tools/list","params":{"_meta":{
            "io.modelcontextprotocol/protocolVersion":"2099-01-01",
            "io.modelcontextprotocol/clientCapabilities":{}
        }}})).send().await.unwrap();
    assert_eq!(unsupported.status().as_u16(),400);
    let unsupported:Value=unsupported.json().await.unwrap();
    assert_eq!(unsupported["error"]["code"],-32022);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_legacy_version_negotiation_is_spec_compliant() {
    let f=Fixture::new(false).await;
    for requested in ["2025-11-25","2025-06-18"] {
        let response:Value=f.rpc(json!({"jsonrpc":"2.0","id":20,"method":"initialize","params":{
            "protocolVersion":requested,"capabilities":{},"clientInfo":{"name":"legacy-fixture","version":"1"}
        }})).await.json().await.unwrap();
        assert_eq!(response["result"]["protocolVersion"],requested);
    }
    let downgraded:Value=f.rpc(json!({"jsonrpc":"2.0","id":21,"method":"initialize","params":{
        "protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"legacy-fixture","version":"1"}
    }})).await.json().await.unwrap();
    assert_eq!(downgraded["result"]["protocolVersion"],"2025-11-25");
}
'''
    p.write_text(text, encoding="utf-8")


def red() -> None:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    append_contract_tests()
    proc = subprocess.run(
        [
            "cargo",
            "test",
            "--locked",
            "--release",
            "--manifest-path",
            "src-tauri/Cargo.toml",
            "--lib",
            "connection_dual_era_",
            "--",
            "--test-threads=1",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    (EVIDENCE / "red.txt").write_text(proc.stdout, encoding="utf-8")
    if proc.returncode == 0:
        raise SystemExit("contract tests unexpectedly passed before implementation")
    if not any(word in proc.stdout for word in ("FAILED", "panicked", "assertion")):
        raise SystemExit("red test failed for a non-contract reason")


def materialize_server() -> None:
    p = backup("src-tauri/src/mcp/server.rs")
    s = p.read_text(encoding="utf-8")
    marker = "pub type SharedState = SharedToolContext;\n"
    insert = r'''pub type SharedState = SharedToolContext;

pub const MODERN_PROTOCOL: &str = "2026-07-28";
pub const LEGACY_PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18"];
pub const SUPPORTED_PROTOCOLS: &[&str] = &[MODERN_PROTOCOL, "2025-11-25", "2025-06-18"];

fn server_info() -> Value {
    json!({"name":"coding-tools-mcp","title":"Coding Tools MCP","version":env!("CARGO_PKG_VERSION")})
}
fn instructions() -> &'static str {
    "Use these tools only for local coding operations inside the configured workspace. When the client supplies _meta.openai/session, the server automatically creates or resumes the matching bounded history session before the first non-history tool call and reports the stable target under history_session. The same conversation identifier resumes the same Markdown archive after a server restart. history_session_bootstrap remains available for clients without session metadata and whenever verbatim initial_user_input must be captured. Use history_session_search followed by history_session_read only when exact earlier context is needed; follow next_cursor with the returned content hash until the relevant archive page is complete. Preserve session_key and current_path, then pass them unchanged as session_key and expected_path to history_session_checkpoint. After completing each user-requested task, call history_session_checkpoint before the final response and pass that user's verbatim request as raw_user_input. Only state that progress was saved after checkpoint returns ok=true with the same target. The server cannot access ChatGPT transcript text that was not provided as a tool argument, so per-turn checkpoint text remains model-mediated rather than automatic background persistence. Every tool result also includes the bounded project_instructions selected from the addressed workspace or linked-project path."
}
fn request_protocol(body: &Value) -> Option<&str> {
    body.pointer("/params/_meta/io.modelcontextprotocol~1protocolVersion").and_then(Value::as_str)
}
fn protocol_error(requested: &str) -> Value {
    json!({"code":-32022,"message":"Unsupported protocol version","data":{"supported":SUPPORTED_PROTOCOLS,"requested":requested}})
}
fn validate_request_protocol(body: &Value) -> Result<bool, Value> {
    let Some(version)=request_protocol(body) else { return Ok(false); };
    if !SUPPORTED_PROTOCOLS.contains(&version) { return Err(protocol_error(version)); }
    if version==MODERN_PROTOCOL {
        let caps=body.pointer("/params/_meta/io.modelcontextprotocol~1clientCapabilities");
        if caps.is_none_or(|v|!v.is_object()) {
            return Err(json!({"code":-32021,"message":"Modern MCP requests require clientCapabilities"}));
        }
        if let Some(info)=body.pointer("/params/_meta/io.modelcontextprotocol~1clientInfo") {
            if !info.is_object() {
                return Err(json!({"code":-32602,"message":"clientInfo must be an object when provided"}));
            }
        }
        return Ok(true);
    }
    Ok(false)
}
fn modernize_result(method: &str, mut result: Value) -> Value {
    if let Some(object)=result.as_object_mut() {
        object.entry("resultType").or_insert(Value::String("complete".into()));
        if matches!(method,"server/discover"|"tools/list") {
            object.entry("ttlMs").or_insert(json!(0));
            object.entry("cacheScope").or_insert(Value::String("private".into()));
        }
        let meta=object.entry("_meta").or_insert_with(||json!({}));
        if let Some(meta)=meta.as_object_mut() {
            meta.insert("io.modelcontextprotocol/serverInfo".into(),server_info());
        }
    }
    result
}
'''
    s = replace_once(s, marker, insert, "server constants")
    start = s.index("fn handle_current_request(")
    end = s.index("\nfn handle_tools_call", start)
    replacement = r'''fn handle_current_request(state: &SharedState, body: &Value) -> Value {
    let method = body.get("method").and_then(Value::as_str).unwrap_or("");
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let params = body.get("params").cloned().unwrap_or(Value::Null);

    if id.is_null() && method.starts_with("notifications/") {
        return Value::Null;
    }
    let modern = match validate_request_protocol(body) {
        Ok(value) => value,
        Err(error) => return json!({"jsonrpc":"2.0","id":id,"error":error}),
    };
    let result = match method {
        "initialize" => Ok(initialize_result(&params)),
        "server/discover" => {
            if !modern {
                Err(json!({"code":-32602,"message":"server/discover requires MCP 2026-07-28 request metadata"}))
            } else {
                Ok(discover_result())
            }
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools":list_tools_for_profile(&state.tool_profile)})),
        "tools/call" => handle_tools_call(state, &params),
        _ => Err(json!({"code":-32601,"message":format!("Method not found: {method}")})),
    };
    match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":if modern {modernize_result(method,result)} else {result}}),
        Err(error) => json!({"jsonrpc":"2.0","id":id,"error":error}),
    }
}

fn initialize_result(params: &Value) -> Value {
    let requested=params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    let negotiated=if LEGACY_PROTOCOLS.contains(&requested) { requested } else { LEGACY_PROTOCOLS[0] };
    json!({
        "protocolVersion":negotiated,
        "capabilities":{"tools":{"listChanged":false},"logging":{}},
        "serverInfo":server_info(),
        "instructions":instructions()
    })
}

fn discover_result() -> Value {
    modernize_result("server/discover",json!({
        "supportedVersions":SUPPORTED_PROTOCOLS,
        "capabilities":{"tools":{"listChanged":false},"logging":{}},
        "instructions":instructions()
    }))
}
'''
    s = s[:start] + replacement + s[end:]
    s = s.replace(
        "use super::{handle_request, initialize_result, tool_arguments};",
        "use super::{discover_result, handle_request, initialize_result, tool_arguments};",
    )
    s = s.replace(
        "let initialized = initialize_result();",
        'let initialized = initialize_result(&json!({"protocolVersion":"2025-11-25"}));',
    )
    target = "    #[test]\n    fn workspace_prompt_initializes_or_restores_a_chatgpt_session() {"
    add = r'''    #[test]
    fn modern_discover_advertises_dual_era_versions_without_fake_list_notifications() {
        let result = discover_result();
        assert_eq!(result["resultType"], "complete");
        assert_eq!(result["ttlMs"], 0);
        assert_eq!(result["cacheScope"], "private");
        assert!(result["supportedVersions"].as_array().unwrap().iter().any(|v| v == "2026-07-28"));
        assert!(result["supportedVersions"].as_array().unwrap().iter().any(|v| v == "2025-11-25"));
        assert_eq!(result["capabilities"]["tools"]["listChanged"], false);
    }

'''
    s = replace_once(s, target, add + target, "discover unit test")
    p.write_text(s, encoding="utf-8")


def materialize_registry() -> None:
    p = backup("src-tauri/src/tools/registry_definitions.rs")
    s = p.read_text(encoding="utf-8")
    old = r'''pub fn normalize_tool_profile(profile: &str) -> &'static str {
    match profile {
        "advanced" => "advanced",
        "read-only" => "read-only",
        "compat-readonly-all" => "compat-readonly-all",
        _ => "core",
    }
}'''
    new = r'''pub fn normalize_tool_profile(profile: &str) -> &'static str {
    match profile {
        "advanced" | "full" => "advanced",
        "read-only" => "read-only",
        "compat-readonly-all" => "compat-readonly-all",
        _ => "core",
    }
}'''
    s = replace_once(s, old, new, "full profile normalization")
    target = "    #[test]\n    fn core_catalog_exposes_chatgpt_compatible_tools() {"
    add = r'''    #[test]
    fn full_profile_really_exposes_the_complete_catalog() {
        let full = list_tools_for_profile("full");
        let advanced = list_tools_for_profile("advanced");
        assert_eq!(full, advanced);
        let names: Vec<_> = full.iter().filter_map(|tool| tool["name"].as_str()).collect();
        for expected in ["codex_tools_status", "harness_status", "start_task", "update_plan", "capture_screenshot", "computer_action"] {
            assert!(names.contains(&expected), "missing {expected}");
        }
    }

'''
    s = replace_once(s, target, add + target, "full catalog unit test")
    p.write_text(s, encoding="utf-8")


def materialize_transport() -> None:
    p = backup("src-tauri/src/mcp/transport.rs")
    s = p.read_text(encoding="utf-8")
    insert_at = s.index("\n#[cfg(test)]")
    helper = r'''

fn protocol_error(code: i64, message: &str, data: Value) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({"jsonrpc":"2.0","error":{"code":code,"message":message,"data":data}}))).into_response()
}
pub(super) fn validate_protocol_headers(headers: &HeaderMap, body: &Value) -> Option<Response> {
    const MODERN: &str = "2026-07-28";
    const SUPPORTED: &[&str] = &[MODERN, "2025-11-25", "2025-06-18"];
    let body_version=body.pointer("/params/_meta/io.modelcontextprotocol~1protocolVersion").and_then(Value::as_str);
    let header_version=headers.get("mcp-protocol-version").and_then(|v|v.to_str().ok());
    for version in [body_version,header_version].into_iter().flatten() {
        if !SUPPORTED.contains(&version) {
            return Some(protocol_error(-32022,"Unsupported protocol version",json!({"supported":SUPPORTED,"requested":version})));
        }
    }
    if let (Some(body_version),Some(header_version))=(body_version,header_version) {
        if body_version != header_version {
            return Some(protocol_error(-32020,"MCP protocol header/body mismatch",json!({"header":header_version,"body":body_version})));
        }
    }
    if body_version==Some(MODERN) || header_version==Some(MODERN) {
        if body_version!=Some(MODERN) || header_version!=Some(MODERN) {
            return Some(protocol_error(-32020,"Modern MCP requires matching protocol metadata and header",json!({"expected":MODERN})));
        }
        let method=body.get("method").and_then(Value::as_str).unwrap_or("");
        let Some(method_header)=headers.get("mcp-method").and_then(|v|v.to_str().ok()) else {
            return Some(protocol_error(-32020,"Modern MCP requires Mcp-Method",json!({"method":method})));
        };
        if method_header!=method {
            return Some(protocol_error(-32020,"Mcp-Method header/body mismatch",json!({"header":method_header,"body":method})));
        }
        if method=="tools/call" {
            let name=body.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
            let Some(name_header)=headers.get("mcp-name").and_then(|v|v.to_str().ok()) else {
                return Some(protocol_error(-32020,"Modern tools/call requires Mcp-Name",json!({"name":name})));
            };
            if name_header!=name {
                return Some(protocol_error(-32020,"Mcp-Name header/body mismatch",json!({"header":name_header,"body":name})));
            }
        }
    }
    None
}
'''
    s = s[:insert_at] + helper + s[insert_at:]
    p.write_text(s, encoding="utf-8")


def materialize_listener() -> None:
    p = backup("src-tauri/src/mcp/listener.rs")
    s = p.read_text(encoding="utf-8")
    old = '        "protocolVersion": "2025-06-18"\n'
    if old in s:
        s = s.replace(
            old,
            '        "protocolVersion": "2026-07-28",\n        "supportedVersions": ["2026-07-28", "2025-11-25", "2025-06-18"]\n',
            1,
        )
    needle = "        return response;\n    }\n    let Json(body) = match Json::<Value>::from_request(request, &state).await {"
    repl = "        return response;\n    }\n    let protocol_headers = request.headers().clone();\n    let Json(body) = match Json::<Value>::from_request(request, &state).await {"
    s = replace_once(s, needle, repl, "preserve protocol headers")
    needle = "    if let Some(response) = transport::early_response(&body) {"
    repl = "    if let Some(response) = transport::validate_protocol_headers(&protocol_headers, &body) {\n        return response;\n    }\n    if let Some(response) = transport::early_response(&body) {"
    s = replace_once(s, needle, repl, "protocol header validation")
    p.write_text(s, encoding="utf-8")


def bump_versions() -> None:
    for name in [
        "package.json",
        "package-lock.json",
        "src-tauri/Cargo.toml",
        "src-tauri/Cargo.lock",
        "src-tauri/tauri.conf.json",
    ]:
        p = backup(name)
        text = p.read_text(encoding="utf-8")
        assert "0.4.1-rc.2" in text, name
        p.write_text(text.replace("0.4.1-rc.2", VERSION), encoding="utf-8")


def materialize() -> None:
    append_contract_tests()
    materialize_server()
    materialize_registry()
    materialize_transport()
    materialize_listener()
    bump_versions()


def main() -> None:
    action = sys.argv[1]
    if action == "red":
        red()
    elif action == "materialize":
        materialize()
    else:
        raise SystemExit(f"unknown action: {action}")


if __name__ == "__main__":
    main()
