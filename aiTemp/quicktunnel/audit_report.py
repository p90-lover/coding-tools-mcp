"""Generate the complete ref inventory from the immutable authenticated audit artifact."""
from pathlib import Path
import json,subprocess
base='24396cc79475d477e1dee159f62ef1d660598911'
data=json.loads(Path('aiTemp/branch-audit/branch-audit.json').read_text());assert data['base']==base and data['branch_count']==74
rows=data['branches'];assert len({r['branch'] for r in rows})==74

def disposition(row):
    n=row['branch']
    if row['history']=='included':return 'Already in main; no merge / 已包含，不重複合併'
    if row['history']=='unrelated':return 'Historical upstream snapshot; preserve separately / 舊上游快照，獨立保留'
    if n=='fix/verified-contracts-0.4.4-rc.2':return 'Recover read_file + operation_log schemas selectively; other schemas/archive code pending / 選擇恢復兩個 schema，其餘待驗證'
    if n=='feature/multi-root-workspace':return 'Linked roots present in main with newer fixes; no whole-branch merge / main 已有多根目錄及後續修正'
    if n=='fix/sandbox-audit-20260910':return 'File limits/patch guards already incorporated; Trash retirement still separate candidate / 限制及補丁防護已整合，Trash 退役仍待修復驗證'
    if n.startswith(('feature/native-codex-runtime','release/remembered-control-network','work/runtime-network','release/remembered-control-final','release/remembered-control-publish','release/remembered-control-finish')):
        return 'Native boundary candidate; previous isolation/runtime gates failed; do not revive blindly / 原生隔離候選曾未通過，不盲目重新啟用'
    if n.startswith('feature/native-runtime'):
        return 'Earlier app-server candidate; current codex_bridge is separately opted-in / 舊原生服務候選，現有 bridge 另有本機批准'
    if n.startswith(('integration/paseo-anneal','validation/control-center')):
        return 'Alternate control-center implementation; current adapters retained, autonomous engines absent / 替代控制中心，現有介接保留，自主引擎未加入'
    if n.startswith(('fix/mcp-connection','fix/mcp-dual-era')):
        return 'Transport repair incorporated under later lineage; retain newer OAuth / 傳輸修正已經後續整合，保留新版 OAuth'
    if not row['production_changes_since_divergence']:
        return 'Support/tests/staged payload only after divergence; not another active feature / 分歧後為支援、測試或暫存，不等於已接入功能'
    if n.startswith(('security/','automation/','feature/secure-auto')):
        return 'Legacy auth/approval family superseded by ported and hardened main; no downgrade / 舊認證權限分支已由移植及強化版本取代'
    if n.startswith(('release/codex-local','release/finalize-codex')):
        return 'Local-tool work retained via later verified integration; no old version overwrite / 本機工具經後續整合，避免舊版本覆蓋'
    return 'Distinct source candidate retained for per-change review; no automatic merge / 保留來源差異，逐項審核後才合併'
summary='''# Branch recovery audit / 分支恢復審查

Base / 基準: `24396cc79475d477e1dee159f62ef1d660598911` (v0.4.4-rc.3).
Audit run / 審查紀錄: https://github.com/p90-lover/coding-tools-mcp/actions/runs/34579727505

## English

All 74 branch refs present at capture were paginated and compared: 26 contained in main (including main itself), 47 divergent, and one unrelated historical upstream tree. Of the divergent refs, 20 have only support/test/staged-payload changes and 27 touch production/build paths. Counts include the new audit branch; the subsequent patch branch did not yet exist at capture. This is full ref/commit/file-diff coverage, not a certification that every old function is correct or live-tested. Ahead counts alone do not prove a missing feature: squashed, ported and rewritten implementations have different commits.

Confirmed recoverable gap: fix/verified-contracts-0.4.4-rc.2 adds output_contracts.rs, but does not wire it into active main. This patch selectively restores read_file and operation_log output schemas after actual shared-dispatch verification, retaining the more precise existing event/recovery schemas. Its remaining broad schemas and staged retention controls are not declared verified or automatically applied.

Already preserved: OAuth/refresh tokens, remembered/live permissions, computer control and local vision, linked roots, local coding tools, optional owned native bridge, offline snapshot execution, timeout receipts, read-only Paseo/Anneal adapters and shared board. In particular, the older dual-era transport and ad7a74f patch guards match their current counterpart files; multi-root paths have newer changes. No reset, forced update, branch deletion or replacement by a minimal old tree is appropriate.

Deliberately withheld: docs/releases/v0.3.6-rc.1.md records that the upstream-derived native command sandbox did not pass all runtime/isolation checks. Old network/read-confinement branches must not replace the newer AppContainer snapshot boundary. The optional model-capable bridge is distinct from model-free tools; restoring source does not authorize inference or grant all permissions.

Unfinished, not lost: complete-controls-0.5.0-rc.1 holds a staged native helper subsequently implemented through the snapshot branch. integration-controls-0.4.4-rc.2 has only two of four planned encoded patch segments and is not a complete executable product update. The current board and adapters do not implement autonomous Paseo assignment/review or Anneal's full runner. A new ChatGPT-led coordinator must share one task record, separate operator/reviewer/worker authority, bound provider budgets, reconcile lost acknowledgments, and never label a requested interruption as confirmed paused. Anneal's upstream Windows/support and permission-bypass limitations remain integration work, not silently accepted defaults.

Next candidate deserving a separate security review: f51a0af's managed-file Trash retirement and history temporary-path changes. Its old implementation must be checked for symlink ancestry/atomicity rather than copied wholesale. This release never runs deletion commands; it does not claim all historical app code has been purged of deletion behavior.

Quick Tunnel remains selected. There is no promise of a stable random hostname, SSE support or Cloudflare uptime. This patch improves application-side responsiveness, not ChatGPT conversation permissions or a user's unobserved Windows state. A healthy endpoint cannot force a forbidden conversation to load tools.

## 繁體中文

已分頁讀取並比較擷取時全部 74 個分支：26 個已包含於 main（包括 main 自身）、47 個有分歧，另有一個獨立舊上游歷史。分歧分支中，20 個只有支援／測試／暫存 payload，27 個涉及正式程式或建置路徑。數字包括新審查分支；之後的修補分支在擷取時尚未存在。這是完整 ref／commit／檔案差異覆蓋，不代表每個舊功能已驗證或做過真實操作。領先 commit 數目不等於功能缺失，squash、移植及重寫會產生不同歷史。

已確認可恢復項目：fix/verified-contracts-0.4.4-rc.2 有 output_contracts.rs，但未接入正式 main。這次選擇性恢復 read_file 及 operation_log 的 outputSchema，並驗證真正分派結果；保留現有較精確的事件及逾時查詢 schema。其餘廣泛 schema 及暫存保留控制仍未宣稱通過，不會自動套用。

已保留功能包括 OAuth／refresh token、記住及即時權限、電腦控制、本機視覺、多根目錄、本機編碼工具、需批准的原生 bridge、離線快照沙箱、逾時紀錄、Paseo／Anneal 唯讀介接及共用看板。舊雙版本傳輸及 ad7a74f 補丁防護與現有對應檔案一致，多根目錄則已有後續修改；不應 reset、強制更新、刪除分支或用舊精簡版本覆蓋。

刻意保留但不啟用的部分：v0.3.6 發佈文件已記錄舊原生命令沙箱未通過全部相容／隔離檢查。舊網路／讀取限制分支不能取代現有 AppContainer 快照邊界。可使用模型的原生 bridge 與無模型本機工具不同，恢復原始碼不等於授權推論或授予全部權限。

未完成不等於遺失：complete-controls 分支保存的原生 helper 已透過後續快照分支整合；integration-controls 分支只有規劃四段 payload 中的兩段，並非完整產品更新。現有看板／介接尚未實作完整 Paseo 派工審核或 Anneal runner。ChatGPT 協調層須共用單一任務記錄，分開使用者／審核者／工作 Agent 權限，限制供應商預算，核對遺失回應，且不能把已要求中斷冒稱已暫停。Anneal 上游 Windows 支援及繞過權限的執行方式仍需處理，不能默認接受。

另一項應獨立審查的候選是 f51a0af 的受管理檔案 Trash 退役及歷史暫存路徑。舊實作須先驗證符號連結路徑及原子性，不能整段搬回。本次不執行刪除指令，但也不宣稱所有歷史程式均已完全移除刪除行為。

保留 Quick Tunnel，不保證隨機 hostname 永久固定、SSE 或 Cloudflare uptime。本次改善應用程式回應，不會變更 ChatGPT 對話權限，亦不代表已驗證使用者 Windows 狀態；正常端點不能強迫被平台拒絕的對話載入工具。

## Every branch / 全部分支

| Branch | SHA | Ahead / behind | Source paths since divergence | Disposition / 處理 |
|---|---|---:|---:|---|
'''
for r in rows:
 paths=r.get('production_changes_since_divergence',r.get('production_files',[]))
 summary+=f'| `{r["branch"]}` | `{r["sha"][:10]}` | {r.get("ahead","—")} / {r.get("behind","—")} | {len(paths)} | {disposition(r)} |\n'
summary+='\nSource-path scope: src/, src-tauri/src/, native-helpers/, and package/build/version manifests. Staged source outside those paths is explicitly classified as staging, not absent data. No branch was removed.\n'
out=Path('docs/audits/branch-recovery-2026-09-11.md');out.parent.mkdir(parents=True,exist_ok=True)
assert not out.exists();out.write_text(summary,encoding='utf-8')
print('AUDIT_REPORT: all 74 captured branches classified; source-versus-history distinction preserved')
