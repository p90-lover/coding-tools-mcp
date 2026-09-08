//! Memory-only GDI capture with a physical-pixel DWM crop, before any resizing.
//! Never resize to visible bounds and then crop: that changes coordinate geometry.
use super::{error, Bounds, Result, Target};
use image::RgbaImage;
use std::mem::size_of;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
};

pub(super) struct DpiGuard(DPI_AWARENESS_CONTEXT);
pub(super) fn physical_dpi() -> Result<DpiGuard> {
    let prior = unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    if prior.0.is_null() {
        return Err(error(
            "DPI_CONTEXT_UNAVAILABLE",
            "Cannot establish physical-pixel coordinates; capture/input stays disabled",
        ));
    }
    Ok(DpiGuard(prior))
}
impl Drop for DpiGuard {
    fn drop(&mut self) {
        let _ = unsafe { SetThreadDpiAwarenessContext(self.0) };
    }
}
fn handle(t: &Target) -> HWND {
    HWND(t.window_id as usize as *mut std::ffi::c_void)
}
fn identity(t: &Target) -> Result<()> {
    super::require_unlocked_desktop()?;
    let w = handle(t);
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(w, Some(&mut pid)) };
    if pid != t.pid || !unsafe { IsWindowVisible(w) }.as_bool() || unsafe { IsIconic(w) }.as_bool()
    {
        return Err(error(
            "TARGET_CHANGED",
            "The selected capture target changed or became unavailable",
        ));
    }
    Ok(())
}
fn raw_rect(t: &Target) -> Result<RECT> {
    let mut r = RECT::default();
    unsafe { GetWindowRect(handle(t), &mut r) }.map_err(|_| {
        error(
            "CAPTURE_UNAVAILABLE",
            "Cannot inspect the selected window rectangle",
        )
    })?;
    Ok(r)
}
fn checked_bounds(r: RECT) -> Result<Bounds> {
    let w = i64::from(r.right) - i64::from(r.left);
    let h = i64::from(r.bottom) - i64::from(r.top);
    if w <= 0 || h <= 0 || w > 32768 || h > 32768 {
        return Err(error(
            "INVALID_GEOMETRY",
            "Window geometry exceeds capture bounds",
        ));
    }
    crate::tools::image_tool::validate_dimensions(w as u32, h as u32)?;
    Ok(Bounds {
        x: r.left,
        y: r.top,
        width: w as u32,
        height: h as u32,
    })
}
pub(super) fn bounds(t: &Target) -> Result<Bounds> {
    let _dpi = physical_dpi()?;
    identity(t)?;
    let mut r = RECT::default();
    let dwm = unsafe {
        DwmGetWindowAttribute(
            handle(t),
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&mut r as *mut RECT).cast(),
            size_of::<RECT>() as u32,
        )
    };
    if dwm.is_err() {
        r = raw_rect(t)?;
    }
    checked_bounds(r)
}
struct Surface {
    window: HWND,
    source: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    selected: bool,
}
impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            if self.selected {
                let _ = SelectObject(self.memory, self.previous);
            }
            if !self.bitmap.0.is_null() {
                let _ = DeleteObject(self.bitmap.into());
            }
            if !self.memory.0.is_null() {
                let _ = DeleteDC(self.memory);
            }
            if !self.source.0.is_null() {
                let _ = ReleaseDC(Some(self.window), self.source);
            }
        }
    }
}
pub(super) fn pixels(t: &Target, expected: Bounds) -> Result<RgbaImage> {
    let _dpi = physical_dpi()?;
    if bounds(t)? != expected {
        return Err(error(
            "TARGET_GEOMETRY_CHANGED",
            "Target moved before capture",
        ));
    }
    let raw = raw_rect(t)?;
    let full = checked_bounds(raw)?;
    let x = i64::from(expected.x) - i64::from(full.x);
    let y = i64::from(expected.y) - i64::from(full.y);
    if x < 0
        || y < 0
        || x + i64::from(expected.width) > i64::from(full.width)
        || y + i64::from(expected.height) > i64::from(full.height)
    {
        return Err(error(
            "UNSUPPORTED_CAPTURE_GEOMETRY",
            "DWM bounds do not fit the physical window surface; no approximate mapping was used",
        ));
    }
    let mut surface = Surface {
        window: handle(t),
        source: HDC::default(),
        memory: HDC::default(),
        bitmap: HBITMAP::default(),
        previous: HGDIOBJ::default(),
        selected: false,
    };
    surface.source = unsafe { GetWindowDC(Some(surface.window)) };
    if surface.source.0.is_null() {
        return Err(error(
            "CAPTURE_UNAVAILABLE",
            "Window device context unavailable",
        ));
    }
    surface.memory = unsafe { CreateCompatibleDC(Some(surface.source)) };
    if surface.memory.0.is_null() {
        return Err(error(
            "CAPTURE_UNAVAILABLE",
            "Memory device context unavailable",
        ));
    }
    surface.bitmap =
        unsafe { CreateCompatibleBitmap(surface.source, full.width as i32, full.height as i32) };
    if surface.bitmap.0.is_null() {
        return Err(error(
            "CAPTURE_UNAVAILABLE",
            "Bounded memory bitmap unavailable",
        ));
    }
    surface.previous = unsafe { SelectObject(surface.memory, surface.bitmap.into()) };
    if surface.previous.0.is_null() || surface.previous.0 as isize == -1 {
        return Err(error(
            "CAPTURE_UNAVAILABLE",
            "Cannot select capture surface",
        ));
    }
    surface.selected = true;
    // Clear the fresh surface so unwritten pixels cannot expose old graphics memory.
    if !unsafe {
        PatBlt(
            surface.memory,
            0,
            0,
            full.width as i32,
            full.height as i32,
            BLACKNESS,
        )
    }
    .as_bool()
    {
        return Err(error(
            "CAPTURE_UNAVAILABLE",
            "Cannot initialize capture surface",
        ));
    }
    if !unsafe { PrintWindow(surface.window, surface.memory, PRINT_WINDOW_FLAGS(2)) }.as_bool() {
        return Err(error(
            "CAPTURE_UNAVAILABLE",
            "Selected window refused capture; no whole-desktop fallback was attempted",
        ));
    }
    // GetDIBits requires this bitmap to be deselected from every device context.
    unsafe { SelectObject(surface.memory, surface.previous) };
    surface.selected = false;
    let size = (full.width as usize)
        .checked_mul(full.height as usize)
        .and_then(|v| v.checked_mul(4))
        .ok_or_else(|| error("IMAGE_TOO_LARGE", "Capture allocation overflow"))?;
    let mut data = Vec::<u8>::new();
    data.try_reserve_exact(size)
        .map_err(|_| error("CAPTURE_UNAVAILABLE", "Capture memory allocation refused"))?;
    data.resize(size, 0);
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: full.width as i32,
            biHeight: -(full.height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biSizeImage: size as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let lines = unsafe {
        GetDIBits(
            surface.memory,
            surface.bitmap,
            0,
            full.height,
            Some(data.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    if lines != full.height as i32 {
        return Err(error(
            "CAPTURE_UNAVAILABLE",
            "Windows returned an incomplete capture",
        ));
    }
    for pixel in data.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }
    let image = RgbaImage::from_raw(full.width, full.height, data)
        .ok_or_else(|| error("CAPTURE_UNAVAILABLE", "Invalid capture buffer"))?;
    identity(t)?;
    if checked_bounds(raw_rect(t)?)? != full || bounds(t)? != expected {
        return Err(error(
            "TARGET_GEOMETRY_CHANGED",
            "Target geometry changed during capture; no frame was returned",
        ));
    }
    Ok(
        image::imageops::crop_imm(&image, x as u32, y as u32, expected.width, expected.height)
            .to_image(),
    )
}
