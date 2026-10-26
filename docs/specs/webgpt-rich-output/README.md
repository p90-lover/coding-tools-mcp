# WebGPT rich responses in Codex

## 原则

Keep normal streaming responsive and make rich response content accessible in Codex. Preserve canonical native tool results instead of flattening them. Preserve access to ChatGPT-only interactive content through its owned source conversation, without pretending an unsupported SSE item renders a native widget.

## 子规格索引

| ID | Title | FR | Dependencies |
|---|---|---|---|
| response-capture | Rich response capture and helper transport | FR-1, FR-2, FR-6 | None |
| native-tool-envelope | Native tool metadata and result fidelity | FR-4, FR-5 | None |
| codex-presentation | Codex presentation and verification | FR-3, FR-7 | response-capture, native-tool-envelope |

## 依赖关系

The machine-readable ownership and dependency list is [spec-manifest.json](spec-manifest.json). Cross-module contracts are in [design.md](design.md).

## 里程碑

1. Verify capture and tool-result contracts independently.
2. Carry rich references through the real helper and adapter pipeline.
3. Verify streaming, source preview interaction, privacy and continuation behavior.

## Compatibility boundary

Native rendering requires the actual host's tool/resource capability. Forwarding metadata alone is not proof of rendering. ChatGPT-specific UI remains available through an owned source preview; it can require the same ChatGPT account. This integration does not copy credentials or proprietary widget runtime state.

DOM capture applies to automatic browser turns. The Zero Risk manual route keeps its manual workflow and does not gain automatic DOM capture.

## Response capabilities and verification

| Response family | Bridge presentation | Verification boundary |
|---|---|---|
| Text, code, tables and citations | Existing append-only Markdown stream | Serializer, helper and Responses SSE regressions |
| Public progress and reasoning summaries | Existing commentary/reasoning events | Native harness regressions; no private reasoning extraction |
| Images | Portable HTTP(S) Markdown references; protected/blob content uses the owned source | Capture/formatter and tool-result transport tests; host URL policy still applies |
| Files and downloads | Portable links or authenticated source access | Resource-link/envelope and browser capture regressions |
| Audio and video | Compatible media references or source access | Typed capture and transport tests; actual playback depends on the host and asset accessibility |
| Charts, diagrams and interactive apps | Owned source view; generation and tool fences protect completion | SVG/canvas/iframe fixtures and post-tool completion guards |
| Artifact previews | Portable resource link or owned source view | Capture tests and interactive browser fixture |
| Native MCP components | Supplied descriptor metadata and canonical result envelope | Broker, stdio, parser, compaction and metadata-privacy regressions; original host/resource server must support rendering |

The browser fixture verifies chart interaction, an iframe app control and an artifact preview. It is separate from a live authenticated ChatGPT session or Codex's native component renderer. Native Codex UI automation can be unavailable; do not promote a successful transport test into a claim that a proprietary component rendered inline.

Private result `_meta` remains outside model-visible text. Rich references appear once after successful completion, and Luna checkpoints bind to the exact displayed answer while validating the original browser answer separately. Strict JSON output and compaction summaries retain their exact output contract.

WebGPT usage is a local estimate of visible input/output. Actual cache-hit counts, internal reasoning-token counts and provider-measured per-step usage are unavailable unless a real provider supplies them; never infer those values from response timing.

Luna checkpoint reuse is local history compression, separate from the provider's prompt cache.
