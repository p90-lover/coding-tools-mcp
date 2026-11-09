//! Native pixels only. No path, file, thumbnail, recorder, or persistent image cache.
use super::{error, unix_ms, Bounds, Lease, Result, Target};
use crate::tools::image_tool::{render_image, validate_dimensions, vision_guard, ViewOptions};
use base64::Engine;
use image::DynamicImage;
use serde_json::{json, Value};

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
    let args = json!({"max_width":max_side,"max_height":max_side,"max_bytes":3_500_000,"output":"mcp_image"});
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

pub(super) fn codex_frame(lease: &Lease, bounds: Bounds, max_side: u32) -> Result<Value> {
    let state = super::codex::request(
        lease,
        "get_window_state",
        json!({"include_screenshot":true,"include_text":true}),
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
    let args = json!({"max_width":max_side,"max_height":max_side,"max_bytes":3_500_000,"output":"mcp_image"});
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
            "coordinate_space":"image pixels for legacy steps; documented Codex logical window coordinates for method+params"
        }),
    )
}
