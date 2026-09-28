#!/usr/bin/env python3
"""Locate selected Git blobs without reading or emitting their contents."""

from __future__ import annotations

import json
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
TARGETS = {
    "d23defc0909cc32314272135d4e09d4f743bd3ba",
    "c32549ef3ff736ceff8aaae026657c70abff5120",
    "ad88631f3124c58730dbe666dbfd23590e4eec3a",
    "5329ab49df852b7b2c9c949ebc7cbe7e7c9d1494",
    "af51b2e406e77316b42c65ef2712e64b4acb7447",
}


def git(*args: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(REPO), *args],
        stderr=subprocess.PIPE,
        text=True,
    )


def object_paths() -> dict[str, list[str]]:
    matches = {blob: [] for blob in TARGETS}
    for line in git("rev-list", "--objects", "--all").splitlines():
        blob, separator, path = line.partition(" ")
        if blob in matches and separator:
            matches[blob].append(path)
    return matches


def introducing_commits(blob: str) -> list[dict[str, str]]:
    output = git(
        "log",
        "--all",
        f"--find-object={blob}",
        "--format=%H%x09%ad%x09%s",
        "--date=iso-strict",
        "--no-renames",
    )
    commits: list[dict[str, str]] = []
    for line in output.splitlines():
        commit, date, subject = line.split("\t", 2)
        commits.append({"commit": commit, "date": date, "subject": subject})
    return commits


def main() -> None:
    paths = object_paths()
    report = {
        blob: {
            "paths": sorted(set(paths[blob])),
            "introducing_commits": introducing_commits(blob),
        }
        for blob in sorted(TARGETS)
    }
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
