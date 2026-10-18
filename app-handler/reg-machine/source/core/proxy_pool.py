"""代理池 - 从数据库读取代理，支持轮询和按区域选取"""
from typing import Optional
from sqlmodel import Session, select
from .db import ProxyModel, engine
import time, threading, random
import os
from datetime import datetime, timezone


class ProxyPool:
    def __init__(self):
        self._index = 0
        self._lock = threading.Lock()

    def get_next(self, region: str = "") -> Optional[str]:
        """获取下一个可用代理。

        优先级:
          1. 动态代理 provider（如果已配置且启用）
          2. 静态代理池（数据库中的固定代理列表）
        """
        forced = os.environ.get("ANY_AUTO_PROXY_URL", "").strip()
        if forced:
            return forced

        # 1. 尝试动态代理
        try:
            from core.proxy_providers import get_dynamic_proxy
            dynamic = get_dynamic_proxy()
            if dynamic:
                return dynamic
        except Exception:
            pass

        # 2. 回退到静态代理池
        with Session(engine) as s:
            q = select(ProxyModel).where(ProxyModel.is_active == True)
            if region:
                q = q.where(ProxyModel.region == region)
            proxies = s.exec(q).all()
            if not proxies:
                return None
            proxies.sort(
                key=lambda p: p.success_count / max(p.success_count + p.fail_count, 1),
                reverse=True
            )
            with self._lock:
                idx = self._index % len(proxies)
                self._index += 1
            return proxies[idx].url

    def report_success(self, url: str) -> None:
        with Session(engine) as s:
            p = s.exec(select(ProxyModel).where(ProxyModel.url == url)).first()
            if p:
                p.success_count += 1
                p.last_checked = datetime.now(timezone.utc)
                s.add(p)
                s.commit()

    def report_fail(self, url: str) -> None:
        with Session(engine) as s:
            p = s.exec(select(ProxyModel).where(ProxyModel.url == url)).first()
            if p:
                p.fail_count += 1
                p.last_checked = datetime.now(timezone.utc)
                # 连续失败超过10次自动禁用
                if p.fail_count > 0 and p.success_count == 0 and p.fail_count >= 5:
                    p.is_active = False
                s.add(p)
                s.commit()

    def check_all(self, *, cancelled=None, progress=None) -> dict:
        """检测所有代理；取消时保留已完成的检测结果。"""
        import requests
        with Session(engine) as s:
            proxies = s.exec(select(ProxyModel)).all()
        results = {"ok": 0, "fail": 0}
        if progress:
            progress(0, len(proxies), dict(results))
        for index, p in enumerate(proxies):
            if cancelled and cancelled():
                break
            available = False
            try:
                response = requests.get("https://httpbin.org/ip",
                    proxies={"http": p.url, "https": p.url}, timeout=8)
                available = response.status_code == 200
            except Exception:
                pass
            if available:
                self.report_success(p.url)
                results["ok"] += 1
            else:
                self.report_fail(p.url)
                results["fail"] += 1
            if progress:
                progress(index + 1, len(proxies), dict(results))
        return results


proxy_pool = ProxyPool()
