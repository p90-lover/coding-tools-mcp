# Read-confined command boundary — development proposal, not released

**Release status: withheld_pending_native_verification.** The command sandbox described here is a preserved development proposal. It is not bundled, available, or executable in v0.3.6-rc.1. `sandbox_exec` rejects, and its release status reports unavailable. Refer to native-command-sandbox.md for the actual behavior.

The intended boundary is read-only access to a locally approved workspace, explicitly required Windows runtime resources, and verified helper binaries. It must not silently expand to all installed applications, the entire Windows tree, or a user's profile, and must not retry denied commands outside the sandbox.

The experimental adapter uses restricted-token access checks and root-scoped capability identities. Native tests exposed unresolved Windows runtime compatibility and networking initialization problems. A failed initialization is not evidence that network policy works. Neither successful provisioning nor a passing isolated filesystem check proves the whole backend correct.

Any future release of this backend must independently demonstrate permitted workspace reads and ordinary command operation, denied write handles, denied outside reads including reparse aliases and newly created files, bounded process/pipe termination, and network denial with working positive controls. The existing full native verification remains a separate gate, not a gate satisfied by the control-only release.

The independent computer-control and vision tools do not use this prototype and do not sandbox already-running graphical applications or existing command tools.

## 繁體中文

此文件描述的是保留作審查的開發方案，不是 `v0.3.6-rc.1` 的可用功能。此版本不打包或執行原生命令沙箱；`sandbox_exec` 直接拒絕，狀態明確顯示未發佈。

原生驗證發現尚未解決的 Windows 執行環境及網絡初始化問題，初始化失敗不能當作網絡限制成功。未來必須獨立證明允許讀取及一般命令正常、拒絕寫入及工作區外讀取、程序／輸出管道可終止，以及具有有效對照的網絡拒絕效果。電腦操作版本通過驗證，不代表這個獨立沙箱也已通過。
