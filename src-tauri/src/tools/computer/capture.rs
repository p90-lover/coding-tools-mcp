//! Native pixels only. No path, file, thumbnail, recorder, or persistent image cache.
use super::{error, unix_ms, Bounds, Lease, Result, Target};
use crate::tools::image_tool::{render_image, validate_dimensions, vision_guard, ViewOptions};
use base64::Engine;
use image::DynamicImage;
use serde_json::{json, Value};

// Base64 expands the image by a third; leave room for controls and the action receipt.
const MAX_FRAME_BYTES: usize = 128 * 1024;

pub fn frame(target: &Target, bounds: Bounds, max_side: u32) -> Result<Value> {
    if !cfg!(target_os = "windows") {
        return Err(error(
            "COMPUTER_USE_UNSUPPORTED",
            "Computer control capture is Windows-only",
        ));
    }
    let _permit = vision_guard()?;
    validate_dimensions(bounds.width, bounds.height)?;
    let pixels = super::native::capture_pixels(target, bounds)?;
    if pixels.width() != bounds.width || pixels.height() != bounds.height {
        return Err(error(
            "TARGET_GEOMETRY_CHANGED",
            "Window geometry changed during capture; request a fresh snapshot",
        ));
    }
    let args = json!({"max_width":max_side,"max_height":max_side,"max_bytes":MAX_FRAME_BYTES,"output":"mcp_image"});
    render_image(
        DynamicImage::ImageRgba8(pixels),
        &args,
        ViewOptions::parse(&args)?,
        json!({
            "snapshot_id":uuid::Uuid::new_v4().to_string(),"captured_at_unix_ms":unix_ms(),
            "window_id":target.window_id,"pid":target.pid,"desktop_bounds":bounds,
            "capture_storage":"memory_only","persisted":false,"disk_cache":false,
            "coordinate_space":"image pixels for computer_action; transform and foreground checks are enforced locally",
            "codex_invoked":false,"capture_backend":"windows_gdi_physical_dwm_crop"
        }),
    )
}

struct ReplyBudget(usize);

impl std::io::Write for ReplyBudget {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_sub(bytes.len())
            .ok_or(std::io::ErrorKind::WriteZero)?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(super) fn fit_result(mut result: Value, limit: usize) -> Value {
    let capture = result.get("base64").and_then(Value::as_str).is_some();
    let text = result.pointer("/native_result/accessibility").is_some();
    if (!capture && !text) || serde_json::to_writer(ReplyBudget(limit), &result).is_ok() {
        return result;
    }
    let observation = json!({"unavailable":"Accessibility text exceeded the reply limit. Request a smaller application view or use the image."});
    if result.get("accessibility").is_some_and(|v| !v.is_null()) {
        result["accessibility"] = observation.clone();
    }
    for pointer in [
        "/native_result/accessibility",
        "/operation/native_result/accessibility",
    ] {
        if let Some(text) = result.pointer_mut(pointer).filter(|value| !value.is_null()) {
            *text = observation.clone();
        }
    }
    if serde_json::to_writer(ReplyBudget(limit), &result).is_ok() {
        return result;
    }
    if let Some(controls) = result.get_mut("controls").and_then(Value::as_array_mut) {
        controls.clear();
        result["uia_truncated"] = json!(true);
        if serde_json::to_writer(ReplyBudget(limit), &result).is_ok() {
            return result;
        }
    }
    let message = "The computer observation was too large for the tool reply. Reobserve a smaller application view; do not replay input.";
    let mut bounded = match result.get_mut("operation").map(Value::take) {
        Some(mut operation)
            if operation.get("input_sent").and_then(Value::as_bool) != Some(false)
                || operation.get("outcome").and_then(Value::as_str) == Some("not_sent") =>
        {
            if let Some(details) = operation.get_mut("native_result") {
                *details = Value::Null;
            }
            json!({"ok":result["ok"], "operation":operation,
                "post_capture_error":message,"requires_reobserve":true})
        }
        _ => crate::tools::workspace::tool_err_code("OUTPUT_TOO_LARGE", message, "computer_use"),
    };
    for field in [
        "project_instructions",
        "project_scope",
        "server_dispatch_ms",
    ] {
        if let Some(value) = result.get_mut(field).map(Value::take) {
            bounded[field] = value;
        }
    }
    bounded
}

/// The control bar's copy of a frame the agent was given: the same pixels, scaled down to
/// `max_side` and JPEG-encoded, in memory only. No new capture, and no vision permit: that permit
/// refuses rather than waits, so holding it here could fail an agent's own capture.
pub(super) fn bar_preview(frame: &Value, max_side: u32) -> Result<Value> {
    let unavailable = || error("PREVIEW_UNAVAILABLE", "The agent's last frame has no image");
    let encoded = frame["base64"].as_str().ok_or_else(unavailable)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| unavailable())?;
    let mut image = image::load_from_memory(&bytes).map_err(|_| unavailable())?;
    if image.width() > max_side || image.height() > max_side {
        image = image.thumbnail(max_side, max_side);
    }
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 72)
        .encode_image(&image.to_rgb8())
        .map_err(|_| unavailable())?;
    Ok(json!({
        "snapshot_id": frame["snapshot_id"], "captured_at_unix_ms": frame["captured_at_unix_ms"],
        "width": image.width(), "height": image.height(),
        "data_url": format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&jpeg)),
        "input_available": frame.get("input_available").and_then(Value::as_bool).unwrap_or(true),
        "capture_storage": "memory_only", "persisted": false,
    }))
}

pub(super) fn codex_frame(
    lease: &Lease,
    bounds: Bounds,
    max_side: u32,
    include_text: bool,
) -> Result<Value> {
    let state = super::codex::request(
        lease,
        "get_window_state",
        json!({"include_screenshot":true,"include_text":include_text}),
    )?;
    render_codex_state(lease, bounds, max_side, &state)
}

pub(super) fn render_codex_state(
    lease: &Lease,
    bounds: Bounds,
    max_side: u32,
    state: &Value,
) -> Result<Value> {
    let _permit = vision_guard()?;
    let screenshot = state["screenshots"]
        .as_array()
        .and_then(|items| items.first())
        .ok_or_else(|| {
            error(
                "INVALID_CODEX_RESPONSE",
                "Codex returned no screenshot for the approved window",
            )
        })?;
    let url = screenshot["url"].as_str().ok_or_else(|| {
        error(
            "INVALID_CODEX_RESPONSE",
            "Codex screenshot is not an in-memory image",
        )
    })?;
    if url.len() > 12 * 1024 * 1024 {
        return Err(error(
            "OUTPUT_TOO_LARGE",
            "Codex screenshot exceeded the image budget",
        ));
    }
    let encoded = url
        .strip_prefix("data:image/png;base64,")
        .or_else(|| url.strip_prefix("data:image/jpeg;base64,"))
        .ok_or_else(|| {
            error(
                "INVALID_CODEX_RESPONSE",
                "Codex screenshot must be a PNG/JPEG data URL",
            )
        })?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| {
            error(
                "INVALID_CODEX_RESPONSE",
                "Codex screenshot encoding is invalid",
            )
        })?;
    let reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| {
            error(
                "INVALID_CODEX_RESPONSE",
                "Codex screenshot header is invalid",
            )
        })?;
    let (width, height) = reader.into_dimensions().map_err(|_| {
        error(
            "INVALID_CODEX_RESPONSE",
            "Codex screenshot dimensions are invalid",
        )
    })?;
    validate_dimensions(width, height)?;
    let image = image::load_from_memory(&bytes).map_err(|_| {
        error(
            "INVALID_CODEX_RESPONSE",
            "Codex screenshot cannot be decoded",
        )
    })?;
    super::check_same_lease(lease, true)?;
    if super::native::validate_target(&lease.target, false)? != bounds {
        return Err(error(
            "TARGET_GEOMETRY_CHANGED",
            "The approved window moved during the Codex capture; request a fresh snapshot",
        ));
    }
    let args = json!({"max_width":max_side,"max_height":max_side,"max_bytes":MAX_FRAME_BYTES,"output":"mcp_image"});
    render_image(
        image,
        &args,
        ViewOptions::parse(&args)?,
        json!({
            "snapshot_id":uuid::Uuid::new_v4().to_string(),"captured_at_unix_ms":unix_ms(),
            "window_id":lease.target.window_id,"pid":lease.target.pid,"desktop_bounds":bounds,
            "capture_storage":"memory_only","persisted":false,"disk_cache":false,
            "engine":"codex_sky","codex_agent_invoked":false,"capture_backend":"installed_codex_sky_windows",
            "native_screenshot_id":screenshot["id"],"window":state["window"],"accessibility":state["accessibility"],
            "native_screenshot_dimensions":{"width":screenshot["width"],"height":screenshot["height"]},
            "coordinate_space":"Use returned image pixels for legacy steps. For native method+params, multiply x by native_screenshot_dimensions.width / width and y by native_screenshot_dimensions.height / height, with native_screenshot_id."
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::workspace::MAX_SERIALIZED_TOOL_RESULT_BYTES as LIMIT;

    #[test]
    fn computer_capture_reply_fit_keeps_pixels_and_receipt_when_text_is_large() {
        let image = "A".repeat(4 * MAX_FRAME_BYTES.div_ceil(3));
        let long_text = "x".repeat(LIMIT);
        let original = json!({"ok":true,"snapshot_id":"frame","base64":image,"mime_type":"image/png",
            "accessibility":{"tree":long_text},"operation":{"request_id":"click-1","input_sent":true,
                "native_result":{"accessibility":{"tree":long_text}}},
            "project_instructions":{"instructions":"Keep the current window approved."}});
        let fitted = fit_result(original.clone(), LIMIT);
        assert!(serde_json::to_writer(ReplyBudget(LIMIT), &fitted).is_ok());
        assert_eq!(fitted["base64"], original["base64"]);
        assert_eq!(fitted["snapshot_id"], "frame");
        assert_eq!(fitted["operation"]["request_id"], "click-1");
        assert!(fitted["accessibility"]["unavailable"].is_string());
        assert!(fitted["operation"]["native_result"]["accessibility"]["unavailable"].is_string());
        assert_eq!(
            fitted["project_instructions"],
            original["project_instructions"]
        );
    }

    #[test]
    fn computer_capture_reply_fit_returns_action_receipt_when_pixels_cannot_fit() {
        for (operation, ok) in [
            (
                json!({"ok":true,"request_id":"click-1","input_sent":true,"outcome":"input_submitted"}),
                true,
            ),
            (
                json!({"ok":false,"request_id":"click-2","outcome":"unknown"}),
                false,
            ),
            (
                json!({"ok":false,"request_id":"click-3","input_sent":false,"outcome":"not_sent"}),
                false,
            ),
            (
                json!({"ok":false,"sequence_id":"plan-1","next_step":1,"resume_allowed":false}),
                false,
            ),
        ] {
            let fitted = fit_result(
                json!({"ok":ok,"base64":"A".repeat(LIMIT),
                "operation":operation,"project_scope":{"root":"."}}),
                LIMIT,
            );
            assert!(serde_json::to_writer(ReplyBudget(LIMIT), &fitted).is_ok());
            assert!(fitted.get("base64").is_none());
            assert_eq!(fitted["ok"], ok);
            assert_eq!(fitted["operation"], operation);
            assert_eq!(fitted["project_scope"]["root"], ".");
            assert_eq!(fitted["requires_reobserve"], true);
            assert!(fitted["post_capture_error"].is_string());
        }
    }

    #[test]
    fn computer_capture_reply_fit_keeps_small_frames_and_marks_large_control_lists() {
        let small = json!({"ok":true,"base64":"AA==","controls":[{"name":"Save"}]});
        assert_eq!(fit_result(small.clone(), LIMIT), small);
        let large = json!({"ok":true,"base64":"AA==","controls":[{"name":"x".repeat(LIMIT)}]});
        let fitted = fit_result(large, LIMIT);
        assert_eq!(fitted["base64"], "AA==");
        assert_eq!(fitted["controls"], json!([]));
        assert_eq!(fitted["uia_truncated"], true);
        let observation = json!({"ok":true,"base64":"A".repeat(LIMIT)});
        let fitted = fit_result(observation, LIMIT);
        assert_eq!(fitted["error"]["code"], "OUTPUT_TOO_LARGE");
        assert!(fitted.get("base64").is_none());
    }
}
