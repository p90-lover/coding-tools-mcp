from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> bool:
    source = path.read_text(encoding="utf-8")
    old_count = source.count(old)
    new_count = source.count(new)
    if old_count == 1:
        path.write_text(source.replace(old, new, 1), encoding="utf-8", newline="\n")
        print(f"PASEO_ANNEAL_BRIDGE_APPLIED:{label}")
        return True
    if old_count == 0 and new_count == 1:
        print(f"PASEO_ANNEAL_BRIDGE_ALREADY_APPLIED:{label}")
        return False
    raise SystemExit(
        f"PASEO_ANNEAL_BRIDGE_REFUSED:{label}:old={old_count}:new={new_count}"
    )


def main() -> None:
    desktop_lib = Path("src-tauri/src/lib.rs")
    headless = Path("rust-core/coding-tools-headless/src/lib.rs")

    replace_once(
        desktop_lib,
        "mod integrations;",
        "pub mod integrations;",
        "public-desktop-integrations",
    )

    replace_once(
        headless,
        "use coding_tools_core::{data::AppData, tools, CoreState};",
        "use coding_tools_core::{data::AppData, integrations, tools, CoreState};",
        "headless-integration-import",
    )

    replace_once(
        headless,
        '''#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolCallRequest {
    request_id: String,
    workspace_id: String,
    tool: String,
    #[serde(default)]
    arguments: Value,
}
''',
        '''#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolCallRequest {
    request_id: String,
    workspace_id: String,
    tool: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IntegrationReadRequest {
    source: integrations::Source,
    endpoint: String,
    #[serde(default)]
    credential: String,
}
''',
        "integration-read-request",
    )

    replace_once(
        headless,
        '''async fn operation_read(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    AxumPath(request_id): AxumPath<String>,
) -> Response {
''',
        '''async fn integration_read(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Json(body): Json<IntegrationReadRequest>,
) -> Response {
    if let Err(response) = auth(&headers, &state) {
        return *response;
    }
    let _lease = match admit(&state, "integration_read") {
        Ok(lease) => lease,
        Err(response) => return *response,
    };
    match integrations::read(body.source, &body.endpoint, &body.credential).await {
        Ok(snapshot) => Json(json!({"ok":true,"snapshot":snapshot})).into_response(),
        Err(error) => json_error(
            StatusCode::BAD_REQUEST,
            "INTEGRATION_READ_FAILED",
            text_error(error),
        ),
    }
}

async fn operation_read(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    AxumPath(request_id): AxumPath<String>,
) -> Response {
''',
        "integration-read-handler",
    )

    replace_once(
        headless,
        '''        .route("/api/v1/workspaces", get(workspace_list))
        .route("/api/v1/tools/catalog", get(tool_catalog))
''',
        '''        .route("/api/v1/workspaces", get(workspace_list))
        .route("/api/v1/integrations/read", post(integration_read))
        .route("/api/v1/tools/catalog", get(tool_catalog))
''',
        "integration-read-route",
    )


if __name__ == "__main__":
    main()
