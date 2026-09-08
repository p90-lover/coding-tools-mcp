use super::{error, Bounds, Control, Result, Target};
fn unavailable<T>() -> Result<T> {
    Err(error("COMPUTER_USE_UNSUPPORTED","Native computer input is currently supported only on Windows. Vision file tools are unchanged."))
}
pub fn targets() -> Result<Vec<Target>> {
    unavailable()
}
pub fn ensure_monitor() -> Result<()> {
    unavailable()
}
pub fn validate_target(_: &Target, _: bool) -> Result<Bounds> {
    unavailable()
}
pub fn focus(_: &Target) -> Result<()> {
    unavailable()
}
pub fn validate_focus(_: &Target) -> Result<()> {
    unavailable()
}
pub fn validate_point(_: &Target, _: i32, _: i32) -> Result<()> {
    unavailable()
}
pub fn inspect(_: &Target) -> Result<(Vec<Control>, bool)> {
    unavailable()
}
pub fn click(_: &Target, _: (i32, i32), _: &str, _: &dyn Fn() -> Result<()>) -> Result<()> {
    unavailable()
}
pub fn move_pointer(_: &Target, _: (i32, i32), _: &dyn Fn() -> Result<()>) -> Result<()> {
    unavailable()
}
pub fn type_text(_: &Target, _: &str, _: &dyn Fn() -> Result<()>) -> Result<()> {
    unavailable()
}
pub fn key(_: &Target, _: &str, _: &dyn Fn() -> Result<()>) -> Result<()> {
    unavailable()
}
pub fn scroll(_: &Target, _: i32, _: &dyn Fn() -> Result<()>) -> Result<()> {
    unavailable()
}

pub fn validate_identity(_: &Target, _: bool) -> Result<()> {
    unavailable()
}

pub fn capture_pixels(_: &Target, _: Bounds) -> Result<image::RgbaImage> {
    unavailable()
}

pub struct WindowEntry {
    pub target: Target,
    pub foreground: bool,
    pub minimized: bool,
}
pub fn window_catalog() -> Result<Vec<WindowEntry>> {
    unavailable()
}
pub fn process_identity(_: u32) -> Result<super::permissions::AppIdentity> {
    unavailable()
}
pub fn set_login_startup(_: bool) -> Result<()> {
    unavailable()
}
pub fn require_unlocked_desktop() -> Result<()> {
    unavailable()
}

pub fn executable_path(_: u32) -> Result<std::path::PathBuf> {
    unavailable()
}
