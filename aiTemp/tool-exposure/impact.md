# Tool exposure repair scope / 工具公開修正範圍

Base source: aec0c3fce7086a44eff7efdfc1de018a67ae654e.

The pinned project launcher is absent; the offline GitNexus attempt returned ENOTCACHED. No model-backed index or agent was run. Direct callers were inspected instead:
RuntimePolicyForm -> workspace save -> commit_live_permissions; server_info -> shared MCP/Actions dispatch;
new read-only local command -> existing runtime context snapshot; ChatGptSetup -> catalog inspector.

The change corrects core/advanced/full selection and reports actual server metadata. It does not change tool execution policy, the set of MCP tool definitions, model providers, screenshots, authentication, process launch, tunnel lifecycle, or the Actions allowlist. Server_info gains result fields only. Impact is bounded to profile presentation and read-only diagnostics, not a new permission route.

公開目錄與執行授權分開。修正 core／advanced／full 的選單對應，新增唯讀的本機診斷及 server_info 資料；不修改權限、工具定義、模型、截圖、認證或隧道生命週期。
