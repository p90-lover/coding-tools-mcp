//! Native pixels only. No path, file, thumbnail, recorder, or persistent image cache.
use super::{error, unix_ms, Bounds, Result, Target};
use crate::tools::image_tool::{render_image, validate_dimensions, vision_guard, ViewOptions};
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
    let window = xcap::Window::all()
        .map_err(|_| error("CAPTURE_UNAVAILABLE", "Cannot enumerate capture target"))?
        .into_iter()
        .find(|w| w.id().ok() == Some(target.window_id) && w.pid().ok() == Some(target.pid))
        .ok_or_else(|| error("TARGET_CHANGED", "Selected window no longer exists"))?;
    if window.is_minimized().unwrap_or(true) {
        return Err(error(
            "TARGET_UNAVAILABLE",
            "Minimized targets are never restored automatically",
        ));
    }
    let pixels = window.capture_image().map_err(|_| {
        error(
            "CAPTURE_UNAVAILABLE",
            "The native capture failed; no fallback was attempted",
        )
    })?;
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
            "codex_invoked":false
        }),
    )
}
