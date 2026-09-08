# Control center upstream notices

Paseo: https://github.com/getpaseo/paseo, commit da8c1b5c94e752b01d451645e5fa52aba2c1b2f0.
Copyright (c) 2025-present Mohamed Boudra. Apache-2.0; complete license: licenses/Paseo-LICENSE.
Adapted packages/protocol/src/agent-state-bucket.ts to src/lib/control-center/vendor/paseo-agent-state.ts; only type imports were localized. Used for the actual session attention classification and sort order. The read-only Rust WebSocket adapter is new code implementing this pinned public protocol.

Anneal: https://github.com/mosonlab/anneal, commit 088f0d5971a1692134aaa3db0230cc541b014c07.
Copyright (c) 2026 Moson Lab. MIT; complete license: licenses/Anneal-LICENSE.
Copied packages/db/src/chain-order.ts to src/lib/control-center/vendor/anneal-chain-order.ts with attribution. Used by the external task-chain display. Stage names in the new operator-managed checklist follow the documented Full Assurance workflow; no upstream agent prompt texts, scheduler, provider runner or dependencies are included.

Integration is not endorsement by either upstream. Their names identify optional external services. No upstream images, brand artwork or font files are redistributed. This app does not bundle or start either upstream's agent runtime.
