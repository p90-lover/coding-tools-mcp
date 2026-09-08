# Upstream provenance and modifications

The optional Windows command sandbox uses Apache-2.0 source from https://github.com/openai/codex at `3caf9f9586baedb4158a7b91545ead3dd320c348`. The LICENSE-Codex file contains the upstream license. This project is not an official OpenAI distribution.

`prepare_upstream.py` adds a sandbox-only JSON adapter binary, namespaces the OS accounts/group to avoid interfering with an installed Codex sandbox, requires local explicit preparation before UAC provisioning, bounds captured output, and omits command arguments from ordinary sandbox command log previews. The upstream workspace dependency pins remain intact. The full Codex CLI/agent is not built as part of this integration. These modified helper binaries are built and verified in GitHub Actions, rather than downloaded from an unverified third party at runtime.
