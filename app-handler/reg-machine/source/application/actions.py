from __future__ import annotations

from domain.actions import ActionExecutionCommand
from core.verification_hold import get_verification_hold, can_resume_verification_hold, verification_hold_result
from application.tasks import create_platform_action_task, get_chatgpt_recovery_ids, get_chatgpt_refresh_ids
from services.task_runtime import task_runtime
from infrastructure.platform_runtime import PlatformRuntime


class ActionsService:
    def __init__(self, runtime: PlatformRuntime | None = None):
        self.runtime = runtime or PlatformRuntime()

    def list_actions(self, platform: str) -> dict:
        actions = self.runtime.list_actions(platform)
        return {
            "actions": [
                {
                    "id": action.id,
                    "label": action.label,
                    "sync": action.sync,
                    "params": [
                        {
                            "key": param.key,
                            "label": param.label,
                            "type": param.type,
                            "options": param.options,
                        }
                        for param in action.params
                    ],
                }
                for action in actions
            ]
        }
    
    def list_capabilities(self, platform: str) -> list[str]:
        return self.runtime.list_capabilities(platform)

    def _is_sync_action(self, platform: str, action_id: str) -> bool:
        actions = self.runtime.list_actions(platform)
        return any(a.id == action_id and a.sync for a in actions)

    def execute_bulk_recovery(self, platform: str, account_ids: list[int], params: dict) -> dict:
        if platform != "chatgpt":
            raise ValueError("批量恢复仅支持 ChatGPT")
        if (not 1 <= len(account_ids) <= 100 or
                any(type(account_id) is not int or account_id <= 0 for account_id in account_ids) or
                len(set(account_ids)) != len(account_ids)):
            raise ValueError("请选择 1 至 100 个不同的有效账号 ID")
        hold = get_verification_hold()
        if hold:
            return verification_hold_result(hold)
        if params.get("resume_verification_hold"):
            raise ValueError("手机验证暂停只能手动恢复当前单个账号")
        eligible_ids = get_chatgpt_recovery_ids(account_ids)
        if not eligible_ids:
            raise ValueError("所选账号没有 phone_required / 2fa_required 待恢复账号")
        task = create_platform_action_task({
            "platform": platform, "account_ids": eligible_ids,
            "action_id": "complete_registration", "params": params,
        })
        task_runtime.wake_up()
        return task

    def execute_bulk_refresh(self, platform: str, account_ids: list[int], params: dict) -> dict:
        if platform != "chatgpt":
            raise ValueError("批量刷新 Token 仅支持 ChatGPT")
        if (not 1 <= len(account_ids) <= 100 or
                any(type(account_id) is not int or account_id <= 0 for account_id in account_ids) or
                len(set(account_ids)) != len(account_ids)):
            raise ValueError("请选择 1 至 100 个不同的有效账号 ID")
        get_chatgpt_refresh_ids(account_ids)  # Validate the entire selection, including skipped accounts.
        if params.get("resume_verification_hold"):
            raise ValueError("手机验证暂停只能手动恢复当前单个账号")
        task = create_platform_action_task({
            "platform": platform, "account_ids": list(account_ids),
            "action_id": "refresh_token", "params": dict(params),
        })
        task_runtime.wake_up()
        return task

    def execute_action(self, command: ActionExecutionCommand) -> dict:
        if command.platform == "chatgpt" and command.action_id == "complete_registration":
            hold = get_verification_hold()
            requested = (command.params or {}).get("resume_verification_hold")
            if hold and not can_resume_verification_hold(hold, command.account_id, requested, hold["detected_at"]):
                return verification_hold_result(hold)
            if requested and not hold:
                return {"ok": False, "error": "没有可恢复的手机验证暂停",
                        "data": {"error_type": "verification_hold", "requires_user_action": True}}
        if self._is_sync_action(command.platform, command.action_id):
            result = self.runtime.execute_action(command)
            return {"sync": True, "ok": result.ok, "data": result.data, "error": result.error}
        params = dict(command.params or {})
        if command.platform == "chatgpt" and command.action_id == "complete_registration" and params.get("resume_verification_hold") is True:
            params["_verification_hold_detected_at"] = hold["detected_at"]
        task = create_platform_action_task(
            {
                "platform": command.platform,
                "account_id": command.account_id,
                "action_id": command.action_id,
                "params": params,
            }
        )
        task_runtime.wake_up()
        return task
