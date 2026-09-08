# Integration attributions

## Paseo

Repository: https://github.com/getpaseo/paseo
Reviewed commit: da8c1b5c94e752b01d451645e5fa52aba2c1b2f0
License: Apache-2.0 (copy in paseo/LICENSE).

The Rust observer interoperates with Paseo's documented/typed directory protocol. No Paseo daemon, agent provider, relay, branding asset or voice engine is bundled. Protocol paths reviewed: packages/protocol/src/messages.ts, packages/protocol/src/client-capabilities.ts, packages/client/src/connection/index.ts, packages/server/src/server/session.ts. The adapter is independently implemented for read-only operation.

## Anneal

Repository: https://github.com/mosonlab/anneal
Reviewed commit: 088f0d5971a1692134aaa3db0230cc541b014c07
License: MIT (copy in anneal/LICENSE).

src/lib/control-center/vendor/anneal-board.js adapts the five columns and pure status/count/default-tab helpers from apps/web/src/lib/board.ts. Display copy and Traditional Chinese labels were modified. Copyright and license are preserved in the adapted file and accompanying license. The HTTP adapter interoperates with the GET tasks board contract from packages/db/src/board-contract.ts and packages/api/src/routes/tasks.ts. No runner, agent prompt bundle or autonomous merge chain is included.
