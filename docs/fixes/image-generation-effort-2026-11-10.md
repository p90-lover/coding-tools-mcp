# Image generation must not inherit chat reasoning effort

## Confirmed failure

The affected chat's saved route was `ao:claude-code`, `cpa/gpt-6.1-sol`, effort `xhigh`. Its turn ended with:

> API Error: Complexity 'xhigh' is not supported for this image model.

This was a hosted image-generation incompatibility, not missing chat reasoning or an approval failure. Upstream CLIProxyAPI issue [#7270](https://github.com/router-for-me/CLIProxyAPI/issues/7270) reproduces the same rejection even with `medium` reasoning. Its standalone Images endpoint succeeds without chat complexity. Merely lowering every chat's effort is not a reliable fix.

## Change

- Add `generate_image` to the existing session-scoped agent tool group. It uses the configured CPA connection's `/v1/images/generations` endpoint and its own `gpt-image-*` model, size and quality. The parent chat's model and effort are not read or changed.
- Reject effort, reasoning, complexity, chat-model suffixes and caller-provided endpoint/credential fields. Request exactly one inline image; never follow redirects or retry a potentially billable request.
- Return bounded PNG/JPEG/WebP bytes as MCP image content, without writing an image or log to disk. Do not fetch provider-returned URLs.
- Retain normal tool opt-out, session lifetime and workspace-root validation. The service credential stays in the main process.
- Include `chat-images.cjs` in the backend bundle's required module closure.
- Pin the bundled CPA to official **8.0.63**, including all six supported-platform archive checksums. This release contains upstream hosted-image compatibility fixes `8fb60326` and `714f0526`; it does not blindly inject an incompatible hosted image tool into a reasoning request.

## Verification

- New image tests: **8 passed**, including a complete MCP transport call that returns image bytes and checks typed failure metadata, cancellation, opt-out, no disk writes, no redirects, no replay and secret-safe errors.
- Focused image/tool-lease/backend/CPA-update/main-thread checks: **197 passed** when run serially.
- Complete desktop test files covered in four serial shards. Final corrected result: **4,620 checks, 4,600 passed, 20 platform skips, no remaining failures**. Initial fixture failures were corrected by using a temporary root outside the Git checkout on G:, a same-drive Node runtime, `CODING_TOOLS_AO_TEST_SOURCE_ROOT`, the existing runtime-web dependencies in `NODE_PATH`, and the real Python runtime instead of a broken shim. The three affected files then passed **92/92** without product-code changes.
- One live request through the already-running CPA returned PNG bytes in **16,686 ms**, with **929,726 decoded bytes**, dimensions **1536 × 1024**, SHA-256 `71494381e9828605730a48c882c0f1f27ecf41703013285e89266d580d8f5259`. The captured request had neither reasoning nor complexity. No image was persisted and the request was not retried. This verifies the request path; the requested image-model identifier is not independent proof of the provider's served model.
- `git diff --check` passed.

GitNexus is **unavailable, not clean**: the main checkout has no usable index, scoped analysis timed out before producing one, and `detect-changes --scope all` reported no indexed repositories. Manual impact review confirmed the production caller is main's `createChatAgentTools` construction, the only new dependency is the image module in the required backend closure, existing exports/IPC contracts do not change, and preview-only leases cannot acquire the image tool. No zero-caller or clean-graph claim is made.

## Release inspection

- `resources/app.asar`: `electron/chat-images.cjs` must contain `createChatImageGenerator`; `electron/chat-agent-tools.cjs` must register `generate_image`; `electron/backend-bundle.cjs` must name `chat-images.cjs`.
- `resources/app.asar`: `vendor/upstream/cpa.json` must name version `8.0.63`.
- `resources/five-stack-runtime/cpa/BUNDLE.json` must identify `CLIProxyAPI_8.0.63_windows_amd64.zip`, SHA-256 `5d8c7a093580c25cace076344dd650c9318ecb9990d9e2147bcee0c515a24b2a`. Verify the actual archive bytes, not just the label; the packaging validator rejects a stale archive against the new pin.
- Source/build publication remains distinct from installation. This work does not patch or restart the user's running application or CPA process.
