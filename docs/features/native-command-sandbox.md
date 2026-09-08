# Native command sandbox — withheld from v0.3.6-rc.1

The upstream-derived native command sandbox is not included or executable in this release. Native runtime/isolation verification did not fully pass, and a subsequent privileged diagnostic change was blocked by tool safety checks. No unverified helper binaries, administrator provisioning, or unsandboxed fallback are provided.

`sandbox_status` explicitly returns `available:false`, `enabled_for_workspace:false`, `native_sandbox_verified:false`, and `release_status:"withheld_pending_native_verification"`. `sandbox_exec` and local setup reject without starting a process or accessing a helper file. Previously stored sandbox approval can be revoked without deleting files or OS accounts.

Original executor source is preserved as `src-tauri/src/tools/native_sandbox_prototype.rs`; it is not declared as a compiled module. The pinned upstream adapters and Apache-2.0 provenance remain in `native-helpers/` for review. Their presence in the source repository is not proof of an enabled, verified, or released sandbox.

Windows computer-control permissions and RAM-only vision are separate features. They do not sandbox already-running graphical applications or retrofit existing command tools. The independent full-sandbox validation workflow remains unchanged and must pass before that backend can be considered for a future release.

## 繁體中文

此版本不包含或執行上游衍生的原生命令沙箱。Windows 執行環境／隔離驗證尚未全部通過，後續一項特權診斷變更亦被工具安全檢查攔截。沒有打包未驗證的輔助程式，不會進行管理員設定或退回無沙箱執行。

狀態工具明確回報不可用；執行及本機準備請求均直接拒絕，不啟動程序。原始執行器及上游程式碼保留作審查，未編入此版本。電腦操作及記憶體視覺工具獨立運作，但不代表 GUI 應用程式或既有命令工具已受作業系統沙箱保護。
