# Compatibility shims

Canonical in-process handlers live in [`app-handler/`](../app-handler/).

These files re-export that tree so older simon / asar packs that still
`require("../../modules/host.cjs")` keep working mid-cut. Do not add a
second registry here. No extra listen ports.
