//! Background window metadata/observation; activation is a distinct explicit action.
use super::*;

pub fn list(ctx: &ToolContext, args: &Value) -> Result<Value> {
    if !ctx.policy.allow_screen_capture
        || !matches!(ctx.auth.auth_type.as_str(), "bearer" | "oauth")
    {
        return Err(error(
            "CONTROL_POLICY_DISABLED",
            "Authenticated capture-enabled MCP is required for window discovery",
        ));
    }
    let own_target = state()
        .lease
        .as_ref()
        .filter(|l| {
            l.validate(ctx.workspace.root(), &l.id, Instant::now(), true)
                .is_ok()
        })
        .map(|l| l.target.clone());
    let grant = permissions::for_root(ctx.workspace.root()).map_err(|_| {
        error(
            "PERMISSION_STORE_UNAVAILABLE",
            "Cannot read local permissions",
        )
    })?;
    let desktop_titles = grant
        .as_ref()
        .is_some_and(|g| g.discovery_enabled && !g.suspended);
    if own_target.is_none() && !desktop_titles {
        return Err(error(
            "DISCOVERY_NOT_ALLOWED",
            "Enable background window discovery locally first; no titles were read",
        ));
    }
    let _busy = exclusive()?;
    let filter = args.get("query").and_then(Value::as_str).unwrap_or("");
    if filter.len() > 256 {
        return Err(error("INVALID_INPUT", "Window query exceeds 256 bytes"));
    }
    let entries = native::window_catalog()?;
    let limit = entries.len() >= 100;
    let windows:Vec<Value>=entries.into_iter().filter(|e|desktop_titles || own_target.as_ref().is_some_and(|t|t.pid==e.target.pid))
        .filter(|e|e.target.title.to_lowercase().contains(&filter.to_lowercase())).map(|e| {
            let selected=own_target.as_ref()==Some(&e.target);
            json!({"window_id":e.target.window_id,"pid":e.target.pid,"title":e.target.title,
                "foreground":e.foreground,"minimized":e.minimized,"selected":selected,
                "capture_supported":!e.minimized,"activation_performed":false,
                "permission":"Selected target or an exact remembered executable must be verified before selection; listing is not authorization"})
        }).collect();
    Ok(tool_ok(
        json!({"windows":windows,"truncated":limit,"background_discovery":true,
        "activation_performed":false,"screenshots_saved":false}),
    ))
}
pub(super) fn select(lease: &Lease, args: &Value) -> Result<Value> {
    check_same_lease(lease, true)?;
    let wid = args["window_id"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= u32::MAX as u64)
        .ok_or_else(|| error("INVALID_INPUT", "Valid window_id required"))? as u32;
    let pid = args["pid"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= u32::MAX as u64)
        .ok_or_else(|| error("INVALID_INPUT", "Valid pid required"))? as u32;
    let target = native::targets()?
        .into_iter()
        .find(|t| t.window_id == wid && t.pid == pid)
        .ok_or_else(|| {
            error(
                "TARGET_UNAVAILABLE",
                "Window is missing or minimized; no window was restored or activated",
            )
        })?;
    let same_process =
        target.pid == lease.target.pid && native::validate_identity(&lease.target, false).is_ok();
    if !same_process && !permissions::is_approved(&lease.root, &target)? {
        return Err(error(
            "APP_NOT_APPROVED",
            "This executable has not been explicitly approved locally, or its bytes changed",
        ));
    }
    // A new target gets a new request window. Never erase uncertainty to permit a replay.
    {
        let s = state();
        if s.sequence
            .as_ref()
            .is_some_and(|p| p.uncertain || p.next != p.steps.len())
            || s.receipts
                .iter()
                .any(|r| r.2.get("outcome").and_then(Value::as_str) != Some("input_submitted"))
        {
            return Err(error(
                "REOBSERVATION_REQUIRED",
                "Resolve incomplete/uncertain operations before switching targets",
            ));
        }
    }
    native::validate_target(&target, false)?;
    let activate = args
        .get("activate")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if activate {
        check_same_lease(lease, true)?;
        native::focus(&target)?;
    }
    check_same_lease(lease, true)?;
    let mut s = state();
    let current = s
        .lease
        .as_mut()
        .ok_or_else(|| error("CONTROL_NOT_ARMED", "Control was stopped"))?;
    current.validate(&lease.root, &lease.id, Instant::now(), true)?;
    current.target = target;
    current.id = uuid::Uuid::new_v4().to_string();
    s.frame = None;
    s.sequence = None;
    s.receipts.clear();
    let mut result = s.summary();
    result["activation_performed"] = json!(activate);
    result["background_observation"] = json!(!activate);
    result["instruction"]=json!("Use this returned session_id. Old IDs are invalid. Background observations do not focus the window. Physical input requires the target foreground.");
    Ok(tool_ok(result))
}
