# Upstream provenance and modifications — development only

**Release status: withheld_pending_native_verification. No native command helper binaries are bundled or executable in v0.3.6-rc.1.** The independent remembered/background computer-control and vision features do not depend on this prototype. See `docs/features/native-command-sandbox.md` for the current release boundary.

The preserved experimental Windows command sandbox adapts Apache-2.0 source from https://github.com/openai/codex at `3caf9f9586baedb4158a7b91545ead3dd320c348`. LICENSE-Codex contains the upstream license. This project is not an official OpenAI distribution.

`prepare_upstream.py` is a development adapter for a sandbox-only JSON binary. It namespaces OS accounts/group, requires local explicit preparation before provisioning, bounds captured output, and omits command arguments from ordinary command log previews. The upstream workspace dependency pins remain intact. It does not build or invoke the Codex CLI/agent.

`restrict_reads.py`, `desktop_boundary.py`, and `namespace_objects.py` preserve the experimental read-capability, private-desktop, and separate object-namespace changes for review. Their presence is not proof of successful native isolation or runtime compatibility; those release checks have not all passed. They are not applied during the control-only release build.

A future native command release would require validated helper binaries hash-bound into the installer, not runtime downloads. This candidate contains no such binaries. The prototype would apply only to `sandbox_exec`; it does not enclose graphical applications or retrofit existing command tools.

## 繁體中文

此目錄只保留實驗性原生命令沙箱的來源及授權資料。`v0.3.6-rc.1` 不打包或執行這些輔助程式，因為 Windows 執行環境／隔離驗證尚未全部通過。程式碼存在不代表已啟用或已驗證；電腦操作及視覺功能獨立運作，也不代表既有程式受到作業系統沙箱限制。
