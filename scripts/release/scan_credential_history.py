#!/usr/bin/env python3
"""Fail-closed credential screening for reachable Git history.

The scanner reports Git blob IDs and credential categories only. It never emits
matched secret bytes. Five historical package-verifier test blobs are accepted
as exact synthetic OpenAI-key fixtures; every other finding remains blocking.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys
from collections.abc import Iterable, Sequence
from typing import Final, TypedDict


class Finding(TypedDict):
    blob: str
    kind: str


KNOWN_SYNTHETIC_FINDINGS: Final[frozenset[str]] = frozenset(
    {
        "ca6aace6e2e7e236ffe18a8b3447f4b6e4d8e168",
        "79f44f0363fbca255525cbb5efbe3062625cfdfc",
        "f3137dc08c41bb9d5d4e273aa54b79d2a9d7c355",
        "a9ba427524ed0dcc9b1934e448533c1101d8feb0",
        "5329ab49df852b7b2c9c949ebc7cbe7e7c9d1494",
    }
)
KNOWN_SYNTHETIC_KIND: Final[str] = "openai-key"

PATTERNS: Final[dict[str, re.Pattern[bytes]]] = {
    "github-token": re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{36,255}\b"),
    "github-fine-grained-token": re.compile(
        rb"\bgithub_pat_[A-Za-z0-9_]{70,255}\b"
    ),
    "private-key-material": re.compile(
        rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"
        rb"\s+[A-Za-z0-9+/=\r\n]{100,}"
        rb"-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"
    ),
    "aws-access-key": re.compile(rb"\bAKIA[A-Z0-9]{16}\b"),
    "openai-key": re.compile(rb"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,255}\b"),
}


def partition_findings(
    findings: Sequence[Finding],
) -> tuple[list[Finding], list[Finding]]:
    """Split exact synthetic fixtures from release-blocking findings."""
    accepted: list[Finding] = []
    unexpected: list[Finding] = []
    for finding in findings:
        if (
            finding["kind"] == KNOWN_SYNTHETIC_KIND
            and finding["blob"] in KNOWN_SYNTHETIC_FINDINGS
        ):
            accepted.append(finding)
        else:
            unexpected.append(finding)
    return accepted, unexpected


def git_output(repo_root: pathlib.Path, *args: str) -> bytes:
    return subprocess.check_output(
        ["git", "-C", str(repo_root), *args],
        stderr=subprocess.PIPE,
    )


def reachable_object_ids(repo_root: pathlib.Path) -> list[bytes]:
    lines = git_output(repo_root, "rev-list", "--objects", "--all").splitlines()
    return list(dict.fromkeys(line.split(b" ", 1)[0] for line in lines if line))


def scan_objects(
    repo_root: pathlib.Path,
    object_ids: Iterable[bytes],
) -> tuple[int, list[Finding]]:
    process = subprocess.Popen(
        ["git", "-C", str(repo_root), "cat-file", "--batch"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if process.stdin is None or process.stdout is None or process.stderr is None:
        raise RuntimeError("Git object scanner pipes were not created")

    findings: list[Finding] = []
    blobs_scanned = 0
    try:
        for oid in object_ids:
            process.stdin.write(oid + b"\n")
            process.stdin.flush()
            header = process.stdout.readline().split()
            if len(header) != 3:
                raise RuntimeError("Git object could not be read")
            object_type = header[1]
            size = int(header[2])
            content = process.stdout.read(size)
            separator = process.stdout.read(1)
            if len(content) != size or separator != b"\n":
                raise RuntimeError("Incomplete Git object")
            if object_type != b"blob":
                continue
            blobs_scanned += 1
            blob_id = oid.decode("ascii")
            for kind, pattern in PATTERNS.items():
                if pattern.search(content):
                    findings.append({"blob": blob_id, "kind": kind})
    finally:
        process.stdin.close()

    stderr = process.stderr.read()
    return_code = process.wait()
    if return_code != 0:
        message = stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Git object scan failed: {message}")
    return blobs_scanned, findings


def build_report(repo_root: pathlib.Path) -> dict[str, object]:
    object_ids = reachable_object_ids(repo_root)
    blobs_scanned, findings = scan_objects(repo_root, object_ids)
    accepted, unexpected = partition_findings(findings)
    return {
        "scope": (
            "reachable Git history; selected high-confidence patterns, not proof "
            "that every secret is absent"
        ),
        "objects_scanned": len(object_ids),
        "blobs_scanned": blobs_scanned,
        "findings": findings,
        "accepted_synthetic_fixtures": [
            {
                **finding,
                "reason": (
                    "exact historical package-verifier fixture containing a "
                    "nonfunctional synthetic OpenAI key"
                ),
            }
            for finding in accepted
        ],
        "unexpected_findings": unexpected,
    }


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=pathlib.Path, default=pathlib.Path.cwd())
    parser.add_argument("--output", type=pathlib.Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    repo_root = args.repo_root.resolve()
    report = build_report(repo_root)
    serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        output = args.output.resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(serialized, encoding="utf-8")
    sys.stdout.write(serialized)
    return 1 if report["unexpected_findings"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
