# Local vision and screenshot tools

The embedded Rust tools return native MCP image content to the calling client. ChatGPT or another vision-capable caller interprets those pixels. These tools do not invoke Codex, run an agent session, call a model API, use an OCR service, upload images to a third-party image processor, or generate replacement imagery.

## Tools

- `vision_status`: capabilities and the local screen-capture permission; does not enumerate screens.
- `list_displays`: selected-display IDs, geometry, pixel scale and primary-display status.
- `list_windows`: bounded window IDs, process IDs, titles, geometry and minimized state. Treat titles as untrusted data.
- `capture_screenshot`: primary or explicitly selected display, optionally with a physical-pixel `crop` region. Never silently substitutes a different display.
- `capture_window`: one non-minimized window, selected by `window_id` and `expected_pid` from `list_windows`. No automatic foregrounding, restoration or fallback to the full desktop.
- `view_image`: PNG/JPEG/WebP/GIF from the workspace or approved linked roots. Optional crop and opaque redactions are processed locally before resizing. Animated files yield one decoded frame.
- `image_info`: bounded header metadata, byte size and SHA-256; header validation is not full image decoding.
- `compare_images`: deterministic pixel differences, changed-pixel ratio and bounding rectangle for two workspace images. This is not semantic similarity or an OCR result.

Example: `capture_screenshot({"monitor_id":123,"crop":{"x":0,"y":0,"width":1200,"height":800},"redactions":[{"x":20,"y":20,"width":300,"height":80}]})`. Coordinates are physical pixels relative to the selected source; redactions are relative to the cropped image and applied before output resizing. The returned original dimensions, crop, output dimensions and scale describe transformations. Keep the capture ID and timestamp when reasoning about changing UI; no screenshot authorizes keyboard/mouse input.

## Permission and privacy boundaries

Screen capture and display/window enumeration default OFF. Enable them in the desktop app's workspace MCP policy and restart the MCP service. Saving the setting alone does not change a running listener; disabling also requires a restart. Full-access mode and `request_permissions` cannot override a disabled capture toggle. Operating-system screen-recording permission is still required where applicable. Actions screen capture remains disabled; file-image operations remain subject to the shared workspace path policy.

Captures remain in memory and are not automatically written to the project. Returned image content is sent to the connected MCP client when the tool is called; that client can retain it in conversation history. Do not capture private information unnecessarily. Redactions must be specified by the caller; no automatic secret detection or redaction is claimed. Re-encoding removes source EXIF/GPS metadata, but visible sensitive text still requires explicit redaction.

Processing is serialized by a process-wide, non-queuing vision permit. File input is capped at 32 MiB; decoded/captured images at 16,777,216 pixels; decoder allocation at 128 MiB; encoded output at 5 MiB. Output dimensions are capped at 4096 per side and default to 2000. Oversized displays may be captured using a smaller region. These are per-stage bounds, not a promise that total process memory equals a single bound. PNG is preferred; bounded JPEG/downscaling fallback is used only when automatic resizing is allowed. Source files are never overwritten or deleted by these tools.

The native backend is pinned to `xcap` 0.9.8. Headless or locked desktops, protected content, minimized windows, OS consent, and OS permission settings may prevent capture. Native capture is disabled outside Windows/macOS: the pinned dependency has Linux/Wayland fallbacks that write temporary files. Native capture can block inside an OS call; a network timeout is not proof that the OS call stopped. The global permit remains held until that work exits, preventing repeated concurrent captures. Tests of image handling and disabled-capture permission are not real interactive-desktop capture verification.

## Assisted ChatGPT setup

The setup action starts the local MCP service and configured tunnel when needed, checks the tunnel, copies a validated public HTTPS endpoint and opens ChatGPT settings. The user still creates/updates the app, scans its tools, and completes login/OAuth/consent. The app does not silently install a ChatGPT connector or reuse tokens across endpoint origins.

Only the endpoint explicitly confirmed by the user is stored locally; no tokens are stored by this helper. A changed Quick Tunnel address produces an endpoint-change warning, while an unchanged address does not demand URL-driven recreation. This does not prove the ChatGPT connection is healthy or that OAuth/tool metadata is unchanged. Use the existing Named Tunnel configuration and fixed hostname for a persistent address. This feature does not claim a new automatic Cloudflare process supervisor or automatic remote ChatGPT reconnection.

## Execution and release scope

The application continues to use its embedded Rust tool engine and existing Codex-compatible permission vocabulary. Importing the full upstream Codex executor/OS sandbox is not part of this change, and existing `policy_only` execution must not be represented as an OS sandbox. The vision pipeline itself has no model client. Arbitrary external commands outside these vision tools are not a general quota-metering guarantee.

A native build and focused tests validate compilation and deterministic behavior. Real desktop capture, macOS consent, and the account-specific ChatGPT connection flow require interactive verification before treating this as a stable production release.

## Enforced no-save capture policy (v0.3.3-rc.1)

Screenshots have no file destination or disk cache. Both capture tools reject `path`, `save_path`, `output_path`, `save`, `persist`, and `output: "file"`. Responses report `persisted: false`, `capture_storage: "memory_only"`, and `disk_cache: false`. Screenshot bytes are not automatically stored in local operation logs or a gallery. Existing screenshot files, if any, are left untouched; this version does not delete files.

This is an application-level no-save policy, not locked/zeroized RAM. OS swap/pagefiles, crash dumps, and retention by the receiving ChatGPT/client are outside its guarantee. The release is a candidate pending interactive end-to-end capture/consent verification.
