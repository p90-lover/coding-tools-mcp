from __future__ import annotations

from domain.proxies import ProxyBulkCreateCommand, ProxyCreateCommand, ProxyRecord
from infrastructure.proxies_repository import ProxiesRepository


class ProxiesService:
    def __init__(self, repository: ProxiesRepository | None = None):
        self.repository = repository or ProxiesRepository()

    def list_proxies(self) -> list[dict]:
        return [self._serialize(item) for item in self.repository.list()]

    def create_proxy(self, command: ProxyCreateCommand) -> dict | None:
        item = self.repository.create(command)
        return self._serialize(item) if item else None

    def bulk_create_proxies(self, command: ProxyBulkCreateCommand) -> dict:
        added = self.repository.bulk_create(command.proxies, command.region)
        return {"added": added}

    def delete_proxy(self, proxy_id: int) -> dict:
        return {"ok": self.repository.delete(proxy_id)}

    def toggle_proxy(self, proxy_id: int) -> dict | None:
        value = self.repository.toggle(proxy_id)
        if value is None:
            return None
        return {"is_active": value}

    def get_check_status(self) -> dict:
        from application.tasks import get_active_proxy_check_task
        return {"task": get_active_proxy_check_task()}

    def trigger_check(self) -> dict:
        from application.tasks import create_proxy_check_task
        from services.task_runtime import task_runtime
        task = create_proxy_check_task()
        task_runtime.wake_up()
        return {"message": "检测任务已启动", **task}

    @staticmethod
    def _serialize(item: ProxyRecord) -> dict:
        return {
            "id": item.id,
            "url": item.url,
            "region": item.region,
            "success_count": item.success_count,
            "fail_count": item.fail_count,
            "is_active": item.is_active,
            "last_checked": item.last_checked,
        }
