#!/usr/bin/env python3
"""Retire the legacy macOS publisher or prove that GitHub has no workflow object for it."""

from __future__ import annotations

import json
import os
import pathlib
import sys
from http import HTTPStatus
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

API_ROOT = "https://api.github.com"
TARGET_PATH = ".github/workflows/macos-release.yml"
TARGET_FILENAME = "macos-release.yml"
PER_PAGE = 100


def fail(message: str) -> "NoReturn":
    raise SystemExit(message)


def api_request(
    method: str,
    route: str,
    token: str,
    *,
    data: bytes | None = None,
) -> tuple[int, bytes]:
    request = Request(
        f"{API_ROOT}{route}",
        data=data,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "coding-tools-mcp-stable-release",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except HTTPError as error:
        return error.code, error.read()


def decode_json(body: bytes, label: str) -> Any:
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} did not return valid UTF-8 JSON: {error}")


def write_json(path: pathlib.Path, value: Any) -> None:
    path.write_text(f"{json.dumps(value, indent=2, sort_keys=True)}\n", encoding="utf-8")


def main() -> None:
    if len(sys.argv) > 2:
        fail("usage: retire_legacy_macos_workflow.py [evidence-directory]")

    repository = os.environ.get("GITHUB_REPOSITORY", "").strip()
    token = os.environ.get("GH_TOKEN", "").strip() or os.environ.get(
        "GITHUB_TOKEN", ""
    ).strip()
    if not repository or repository.count("/") != 1:
        fail("GITHUB_REPOSITORY must be set to owner/repository")
    if not token:
        fail("GH_TOKEN or GITHUB_TOKEN is required")

    evidence_dir = pathlib.Path(
        sys.argv[1] if len(sys.argv) == 2 else "aiTemp/legacy-workflow-retirement"
    )
    evidence_dir.mkdir(parents=True, exist_ok=True)

    workflows: list[dict[str, Any]] = []
    page = 1
    while True:
        route = (
            f"/repos/{repository}/actions/workflows?per_page=100&page={page}"
        )
        status, body = api_request("GET", route, token)
        if status != HTTPStatus.OK:
            fail(f"Workflow registry request failed with HTTP {status}")
        payload = decode_json(body, f"workflow registry page {page}")
        batch = payload.get("workflows") if isinstance(payload, dict) else None
        if not isinstance(batch, list):
            fail(f"Workflow registry page {page} is missing a workflows list")
        workflows.extend(item for item in batch if isinstance(item, dict))
        if len(batch) < PER_PAGE:
            break
        page += 1
        if page > 100:
            fail("Workflow registry pagination exceeded 100 pages")

    matches = [workflow for workflow in workflows if workflow.get("path") == TARGET_PATH]
    write_json(
        evidence_dir / "workflow-registry.json",
        {
            "target_path": TARGET_PATH,
            "matches": matches,
            "workflows": workflows,
        },
    )

    if len(matches) > 1:
        fail(f"Expected at most one {TARGET_PATH} workflow object, found {len(matches)}")

    if len(matches) == 1:
        workflow_id = matches[0].get("id")
        if not isinstance(workflow_id, int):
            fail("Registered legacy macOS workflow is missing a numeric ID")
        status, body = api_request(
            "PUT",
            f"/repos/{repository}/actions/workflows/{workflow_id}/disable",
            token,
            data=b"",
        )
        if status != HTTPStatus.NO_CONTENT:
            fail(
                f"Disabling legacy macOS workflow {workflow_id} failed with HTTP {status}: "
                f"{body.decode('utf-8', errors='replace')}"
            )
        status, body = api_request(
            "GET", f"/repos/{repository}/actions/workflows/{workflow_id}", token
        )
        if status != HTTPStatus.OK:
            fail(f"Reading disabled workflow {workflow_id} failed with HTTP {status}")
        workflow = decode_json(body, "disabled workflow")
        state = workflow.get("state") if isinstance(workflow, dict) else None
        if state != "disabled_manually":
            fail(
                f"Legacy macOS workflow {workflow_id} was not disabled_manually; "
                f"observed {state!r}"
            )
        identity = str(workflow_id)
        probe = {"status": status, "workflow": workflow}
    else:
        status, body = api_request(
            "GET",
            f"/repos/{repository}/actions/workflows/{TARGET_FILENAME}",
            token,
        )
        probe_body = decode_json(body, "unregistered workflow probe") if body else None
        if status != HTTPStatus.NOT_FOUND:
            fail(
                f"Workflow registry omitted {TARGET_PATH}, but its filename endpoint returned "
                f"HTTP {status}; refusing to treat it as unregistered"
            )
        state = "unregistered"
        identity = "unregistered"
        probe = {"status": status, "response": probe_body}

    write_json(evidence_dir / "legacy-macos-workflow-probe.json", probe)
    (evidence_dir / "legacy-macos-workflow-id.txt").write_text(
        f"{identity}\n", encoding="utf-8"
    )
    (evidence_dir / "legacy-macos-workflow-state.txt").write_text(
        f"{state}\n", encoding="utf-8"
    )
    print(f"Legacy macOS workflow retirement state: {state} ({identity})")


if __name__ == "__main__":
    main()
