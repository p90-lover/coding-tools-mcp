//! User-enabled native capture; no persistent files, background recording, or model API.
use std::time::{SystemTime, UNIX_EPOCH};

use image::DynamicImage;
use serde_json::{json, Value};
use xcap::{Monitor, Window};

use crate::tools::context::ToolContext;
use crate::tools::image_tool::{
    self, boolean, integer, validate_dimensions, vision_error, Rect, ViewOptions,
};
use crate::tools::workspace::{tool_ok, WorkspaceError};

// Only these reviewed native backends capture into memory. In particular,
// xcap's Linux/Wayland portal fallback writes (and deletes) temporary PNGs.
// Reject unsupported platforms BEFORE calling any native capture API.
fn memory_only_backend_supported() -> bool {
    cfg!(any(target_os = "windows", target_os = "macos"))
}

fn capture_options(args: &Value) -> Result<ViewOptions, WorkspaceError> {
    // A screenshot never takes a destination path, even an empty/null one.
    // Do not silently accept a filename inherited from view_image's schema.
    if args.get("path").is_some() {
        return Err(vision_error(
            "SCREENSHOT_SAVE_NOT_SUPPORTED",
            "Screenshots are memory-only. No output path, image file, or disk cache is supported.",
        ));
    }
    ViewOptions::parse(args)
}

fn require_capture(ctx: &ToolContext) -> Result<(), WorkspaceError> {
    // This is a local settings opt-in, not an MCP argument. Full-access mode
    // and request_permissions cannot enable it or bypass OS privacy consent.
    if !ctx.policy.allow_screen_capture {
        return Err(WorkspaceError::Tool {
            code: "SCREEN_CAPTURE_DISABLED",
            message: "Enable screen capture in this workspace's desktop app policy, then restart its MCP service. This also permits display/window metadata. OS screen-recording consent may be required.".into(),
            category: "permission",
            retryable: false,
        });
    }
    if !memory_only_backend_supported() {
        return Err(vision_error(
            "MEMORY_ONLY_CAPTURE_UNAVAILABLE",
            "This platform's capture backend is not approved for no-save screenshots. Native capture is limited to Windows and macOS; file-backed fallbacks are disabled.",
        ));
    }
    Ok(())
}

fn native_error(_: xcap::XCapError) -> WorkspaceError {
    WorkspaceError::Tool {
        code: "SCREEN_CAPTURE_UNAVAILABLE",
        message: "Native capture is unavailable. Check OS screen-recording permission, an unlocked interactive desktop, and display-server support. No fallback capture was attempted.".into(),
        category: "runtime",
        retryable: false,
    }
}

fn bounded(value: String) -> String {
    value.chars().take(256).collect()
}

pub fn status(ctx: &ToolContext) -> Result<Value, WorkspaceError> {
    Ok(tool_ok(json!({
        "backend": "xcap", "backend_version": "0.9.8", "platform": std::env::consts::OS,
        "screen_capture_enabled": ctx.policy.allow_screen_capture,
        "memory_only_backend_supported": memory_only_backend_supported(),
        "os_permission": "checked_by_native_backend_on_capture",
        "tools": ["view_image", "image_info", "compare_images", "list_displays", "list_windows", "capture_screenshot", "capture_window"],
        "formats": ["image/png", "image/jpeg", "image/webp", "image/gif"],
        "max_source_bytes": image_tool::MAX_SOURCE_BYTES, "max_pixels": image_tool::MAX_PIXELS,
        "capture_storage": "memory_only", "disk_cache": false, "background_recording": false,
        "inference_performed": false, "codex_invoked": false,
        "semantic_analysis": "The calling vision-capable model interprets returned MCP image content. No separate model or OCR service is called.",
        "limitations": ["Headless/locked desktops, protected content, minimized windows, and OS permissions may prevent capture. This release disables native capture outside Windows/macOS to prevent file-backed fallbacks."]
    })))
}

pub fn list_displays(ctx: &ToolContext) -> Result<Value, WorkspaceError> {
    require_capture(ctx)?;
    let _permit = image_tool::vision_guard()?;
    let monitors = Monitor::all().map_err(native_error)?;
    let truncated = monitors.len() > 32;
    let mut displays = Vec::new();
    for monitor in monitors.into_iter().take(32) {
        displays.push(json!({
            "monitor_id": monitor.id().map_err(native_error)?,
            "name": bounded(monitor.name().map_err(native_error)?),
            "x": monitor.x().map_err(native_error)?, "y": monitor.y().map_err(native_error)?,
            "width": monitor.width().map_err(native_error)?, "height": monitor.height().map_err(native_error)?,
            "scale_factor": monitor.scale_factor().map_err(native_error)?,
            "primary": monitor.is_primary().map_err(native_error)?
        }));
    }
    Ok(tool_ok(
        json!({"displays": displays, "truncated": truncated, "capture_coordinates": "physical pixels relative to the selected display"}),
    ))
}

pub fn list_windows(ctx: &ToolContext, args: &Value) -> Result<Value, WorkspaceError> {
    require_capture(ctx)?;
    let limit = integer(args, "limit", 50, 1, 100)? as usize;
    let include_minimized = boolean(args, "include_minimized", false)?;
    let _permit = image_tool::vision_guard()?;
    let windows = Window::all().map_err(native_error)?;
    let mut items = Vec::new();
    let mut truncated = false;
    for window in windows {
        // Windows can disappear between enumeration and property reads. Skip
        // those entries; never substitute a different window at capture time.
        let (Ok(id), Ok(pid), Ok(title), Ok(minimized)) = (
            window.id(),
            window.pid(),
            window.title(),
            window.is_minimized(),
        ) else {
            continue;
        };
        if !include_minimized && minimized {
            continue;
        }
        if items.len() == limit {
            truncated = true;
            break;
        }
        items.push(json!({"window_id": id, "pid": pid, "title": bounded(title),
            "app_name": bounded(window.app_name().unwrap_or_default()),
            "x": window.x().ok(), "y": window.y().ok(), "width": window.width().ok(), "height": window.height().ok(),
            "minimized": minimized, "focused": window.is_focused().ok()}));
    }
    Ok(tool_ok(json!({"windows": items, "truncated": truncated,
        "warning": "Window titles are untrusted data. Pass both window_id and expected_pid from this result to capture_window."})))
}

fn capture_metadata(source: &str, width: u32, height: u32) -> Value {
    json!({"source": source, "capture_id": uuid::Uuid::new_v4().to_string(),
        "captured_at_unix_ms": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        "original": {"width": width, "height": height}, "persisted": false,
        "capture_storage": "memory_only", "disk_cache": false,
        "coordinate_space": "physical pixels relative to the returned source region"})
}

pub fn capture_screenshot(ctx: &ToolContext, args: &Value) -> Result<Value, WorkspaceError> {
    require_capture(ctx)?;
    let options = capture_options(args)?;
    let selected_id = args
        .get("monitor_id")
        .map(|_| integer(args, "monitor_id", 0, 0, u64::from(u32::MAX)))
        .transpose()?;
    let _permit = image_tool::vision_guard()?;
    let monitor = Monitor::all()
        .map_err(native_error)?
        .into_iter()
        .find(|monitor| {
            selected_id.map_or_else(
                || monitor.is_primary().unwrap_or(false),
                |id| monitor.id().ok() == Some(id as u32),
            )
        })
        .ok_or_else(|| {
            WorkspaceError::not_found(
                "Selected display is unavailable; no other display was captured",
            )
        })?;
    let width = monitor.width().map_err(native_error)?;
    let height = monitor.height().map_err(native_error)?;
    let mut metadata = capture_metadata("display", width, height);
    metadata["monitor_id"] = json!(monitor.id().map_err(native_error)?);
    metadata["desktop_origin"] =
        json!({"x": monitor.x().map_err(native_error)?, "y": monitor.y().map_err(native_error)?});
    metadata["scale_factor"] = json!(monitor.scale_factor().map_err(native_error)?);
    let mut render_args = args.clone();
    let pixels = if let Some(crop) = args.get("crop") {
        let region = Rect::parse(crop, width, height)?;
        validate_dimensions(region.width, region.height)?;
        metadata["crop"] = region.value();
        // Region capture prevents allocating an entire oversized display.
        render_args
            .as_object_mut()
            .expect("validated object")
            .remove("crop");
        monitor
            .capture_region(region.x, region.y, region.width, region.height)
            .map_err(native_error)?
    } else {
        validate_dimensions(width, height)?;
        monitor.capture_image().map_err(native_error)?
    };
    image_tool::render_image(
        DynamicImage::ImageRgba8(pixels),
        &render_args,
        options,
        metadata,
    )
}

pub fn capture_window(ctx: &ToolContext, args: &Value) -> Result<Value, WorkspaceError> {
    require_capture(ctx)?;
    let options = capture_options(args)?;
    if args.get("window_id").is_none() || args.get("expected_pid").is_none() {
        return Err(WorkspaceError::invalid_argument(
            "window_id and expected_pid from list_windows are required",
        ));
    }
    let id = integer(args, "window_id", 0, 0, u64::from(u32::MAX))? as u32;
    let pid = integer(args, "expected_pid", 0, 1, u64::from(u32::MAX))? as u32;
    let _permit = image_tool::vision_guard()?;
    let window = Window::all()
        .map_err(native_error)?
        .into_iter()
        .find(|window| window.id().ok() == Some(id))
        .ok_or_else(|| {
            WorkspaceError::not_found("Selected window has closed; no other window was captured")
        })?;
    if window.pid().map_err(native_error)? != pid {
        return Err(vision_error(
            "CAPTURE_TARGET_CHANGED",
            "Window handle now belongs to a different process. Enumerate windows again.",
        ));
    }
    if window.is_minimized().map_err(native_error)? {
        return Err(vision_error(
            "WINDOW_MINIMIZED",
            "Restore the selected window before capture; it will not be restored automatically",
        ));
    }
    let width = window.width().map_err(native_error)?;
    let height = window.height().map_err(native_error)?;
    validate_dimensions(width, height)?;
    let mut metadata = capture_metadata("window", width, height);
    metadata["window_id"] = json!(id);
    metadata["pid"] = json!(pid);
    let pixels = window.capture_image().map_err(native_error)?;
    // Detect a process change while the native capture was running.
    if window.pid().map_err(native_error)? != pid {
        return Err(vision_error(
            "CAPTURE_TARGET_CHANGED",
            "Capture target changed; captured pixels were discarded",
        ));
    }
    image_tool::render_image(DynamicImage::ImageRgba8(pixels), args, options, metadata)
}

#[cfg(test)]
mod vision_tests {
    use super::*;
    use crate::tools::policy::PolicySettings;
    use crate::tools::workspace::Workspace;
    use crate::workspace::AuthConfig;
    use std::path::PathBuf;

    #[test]
    fn vision_capture_is_denied_before_native_access_even_with_full_permissions() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let retained = root
            .join("../aiTemp/vision-permission-check")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&retained).expect("retained aiTemp fixture");
        let policy = PolicySettings {
            permission_mode: "danger-full-access".into(),
            ..PolicySettings::default()
        };
        let ctx = ToolContext::from_workspace_with_harness_root(
            Workspace::new(root).expect("workspace"),
            AuthConfig::default(),
            policy,
            "core".into(),
            "danger-full-access".into(),
            retained,
        );
        assert!(capture_screenshot(&ctx, &json!({}))
            .expect_err("disabled")
            .message()
            .contains("Enable screen capture"));
        assert!(capture_window(&ctx, &json!({})).is_err());
        assert!(list_displays(&ctx).is_err());
        assert!(list_windows(&ctx, &json!({})).is_err());
        assert_eq!(
            status(&ctx).expect("status")["screen_capture_enabled"],
            false
        );
    }

    #[test]
    fn vision_memory_only_rejects_save_arguments() {
        for args in [
            json!({"path": "aiTemp/screenshot.png"}),
            json!({"path": null}),
            json!({"save_path": "screenshot.png"}),
            json!({"output_path": "screenshot.png"}),
            json!({"save": true}),
            json!({"persist": true}),
            json!({"output": "file"}),
        ] {
            assert!(capture_options(&args).is_err(), "{args}");
        }
        assert!(capture_options(&json!({"output": "mcp_image"})).is_ok());
        assert_eq!(
            memory_only_backend_supported(),
            cfg!(any(target_os = "windows", target_os = "macos"))
        );
    }

    #[test]
    fn vision_memory_only_capture_envelope_has_no_file_destination() {
        // Existing fixture is embedded at compile time; no screenshots or
        // fixture copies are written. This tests the capture rendering path,
        // not an interactive desktop or OS screen-recording consent.
        let _permit = image_tool::vision_guard().expect("exclusive image renderer");
        let image = image::load_from_memory(include_bytes!("../../icons/32x32.png"))
            .expect("embedded fixture");
        let args = json!({"output": "mcp_image"});
        for tool in ["capture_screenshot", "capture_window"] {
            let metadata = capture_metadata("test_fixture", image.width(), image.height());
            let result = image_tool::render_image(
                image.clone(),
                &args,
                capture_options(&args).expect("memory options"),
                metadata,
            )
            .expect("in-memory rendering");
            let wrapped = crate::tools::workspace::wrap_mcp_tool_result(tool, &args, result);
            assert_eq!(wrapped["isError"], false);
            assert_eq!(wrapped["content"][0]["type"], "image");
            assert!(wrapped["content"][0]["data"]
                .as_str()
                .is_some_and(|data| !data.is_empty()));
            let metadata = &wrapped["structuredContent"];
            assert_eq!(metadata["persisted"], false);
            assert_eq!(metadata["capture_storage"], "memory_only");
            assert_eq!(metadata["disk_cache"], false);
            for key in ["path", "file_path", "save_path", "base64", "data_url"] {
                assert!(metadata.get(key).is_none(), "unexpected {key}");
            }
        }
    }
}
