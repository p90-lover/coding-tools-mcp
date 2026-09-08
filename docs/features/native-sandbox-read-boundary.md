# Read-confined command boundary

The optional `sandbox_exec` integration adds read-only grants for the locally approved workspace, Windows System32 runtime, and this release's verified helper directories. It does not grant access across all Program Files, the entire Windows directory, the user's profile, or arbitrary installed tools. It never automatically retries a denied command outside the sandbox.

The adapter uses full restricted-token read/write checks and per-root capabilities instead of the upstream write-only restriction/shared read capability. Windows' standard Restricted Code identity is included to access shared runtime objects such as KnownDlls; it is not added to file ACL grants, the private desktop ACL, or new objects' default DACL. Objects that Windows or an administrator already expressly exposes to Restricted Code remain subject to those ACLs. This is not a filesystem namespace or a VM: the two token access checks and object ACLs remain the security boundary.

Setup grants are synchronous; setup status alone is not proof. The release requires a real native workspace read and Windows command positive control, denied write handles, denied outside reads (including junction aliases and files created after setup), and denied network with an unsandboxed positive control.

First-time local preparation changes sandbox account/ACL/firewall configuration after user approval. Remote calls cannot perform that preparation. These controls apply to `sandbox_exec`, not the legacy shell tools or graphical applications. This is a reviewed adaptation of pinned upstream code, not the entire Codex agent or a claim of universal sandbox-escape prevention.

## 繁體中文

`sandbox_exec` 只新增唯讀權限至本機已批准的工作區、Windows System32 執行環境及此版本已核對的輔助程式目錄；不會開放整個 Program Files、整個 Windows 目錄或使用者資料夾，也不會自動退回無沙箱執行。

執行器使用完整的受限 Token 讀寫檢查及逐根目錄權限。Windows 標準 Restricted Code 身分只用於系統已明確允許的共用執行階段物件，例如 KnownDlls；不會把它加入檔案授權、私人桌面或新物件的預設 ACL。這不是獨立檔案命名空間或虛擬機；Windows 或管理員已明確開放給受限程式碼的物件仍按原有 ACL 處理。

發佈必須通過真正的允許讀取／Windows 命令測試，以及拒絕寫入、工作區外讀取、目錄連接別名、新建私有檔案及網絡存取的檢查。這只適用於獨立的 `sandbox_exec` 工具，不會自動沙箱化既有命令或圖形程式，也不呼叫 Codex Agent。
