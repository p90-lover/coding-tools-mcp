# Upstream provenance and modifications

The optional Windows command sandbox uses Apache-2.0 source from https://github.com/openai/codex at `3caf9f9586baedb4158a7b91545ead3dd320c348`. LICENSE-Codex contains the upstream license. This project is not an official OpenAI distribution.

`prepare_upstream.py` adds a sandbox-only JSON adapter binary, namespaces OS accounts/group, requires local explicit preparation before UAC provisioning, bounds captured output, and omits command arguments from ordinary command log previews. The upstream workspace dependency pins remain intact. The Codex CLI/agent is not built or invoked.

`restrict_reads.py` strengthens the read-only backend: full restricted-token access checks replace write-only checks, and capability SIDs are scoped to each permitted root rather than using a globally shared read capability. Root read/execute ACL grants complete synchronously before setup reports readiness. Unreviewed writable roots or proxy identities are rejected by this adapter. Native positive and negative isolation checks must pass before publication; setup success alone is not evidence of isolation.

Modified helper binaries are built and hash-bound into each installer. They are not fetched from third parties at runtime. This backend applies only to `sandbox_exec`; graphical applications and existing shell tools are not automatically enclosed by it.
