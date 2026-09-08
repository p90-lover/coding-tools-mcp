# Read-confined command boundary

The optional `sandbox_exec` integration is read-only and restricted to the locally approved workspace, Windows System32 runtime, and this release's verified helper directories. It does not grant read access across all Program Files, the entire Windows directory, the user's profile, or arbitrary installed tools. Tools outside these roots must be deliberately made available in the approved workspace; there is no automatic unsandboxed retry.

The adapter uses full restricted-token read/write checks and per-root capabilities instead of the upstream write-only restriction/shared read capability. Setup grants are synchronous; setup status alone is not proof. The release requires a real native workspace read and Windows command positive control, denied write handles, denied outside reads (including junction aliases and files created after setup), and denied network with an unsandboxed positive control.

First-time local preparation changes sandbox account/ACL/firewall configuration after user approval. Remote calls cannot perform that preparation. These controls apply to `sandbox_exec`, not the legacy shell tools or graphical applications. This is a reviewed adaptation of pinned upstream code, not the entire Codex agent or a claim of universal sandbox-escape prevention.

## 繁體中文

`sandbox_exec` 只允許唯讀取已於本機批准的工作區、Windows System32 執行環境及此版本已核對的輔助程式目錄；不會開放整個 Program Files、整個 Windows 目錄、使用者資料夾或任意已安裝工具。範圍以外的工具須明確放入工作區，不會自動退回無沙箱執行。

發佈必須通過真正的允許讀取／Windows 命令測試，以及拒絕寫入、工作區外讀取、目錄連接別名、新建私有檔案及網絡存取的檢查。這只適用於獨立的 `sandbox_exec` 工具，不會自動沙箱化既有命令或圖形程式，也不呼叫 Codex Agent。
