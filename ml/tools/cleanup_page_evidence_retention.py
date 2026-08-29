#!/usr/bin/env python3
"""Dry-run-first retention cleanup for validated private page evidence runs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from private_page_evidence_collector import (
    MAX_TARGET_BUNDLE_BYTES,
    FilesystemPolicyError,
    assert_no_symlink_chain,
    canonical_json_bytes,
    inside_git_worktree,
    load_json_file,
    validate_run_id,
)
from validate_page_evidence_contract import ValidationError, validate_run

RECEIPT_NAME = "retention_deletion_receipts.jsonl"


def _strict_time(value: Any) -> datetime:
    if not isinstance(value, str):
        raise FilesystemPolicyError("retentionUntil is not a timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise FilesystemPolicyError("retentionUntil is not a timestamp") from exc
    if parsed.tzinfo is None:
        raise FilesystemPolicyError("retentionUntil requires timezone")
    return parsed.astimezone(timezone.utc)


def validated_output_root(value: str | Path) -> Path:
    raw = Path(value).expanduser()
    if not raw.is_absolute() or raw.is_symlink() or not raw.is_dir():
        raise FilesystemPolicyError("output root must be an absolute non-symlink directory")
    root = raw.resolve()
    if inside_git_worktree(root):
        raise FilesystemPolicyError("private output root cannot be inside Git")
    if stat.S_IMODE(root.stat().st_mode) != 0o700:
        raise FilesystemPolicyError("private output root must be mode 0700")
    return root


def append_reduced_receipt(root: Path, receipt: dict[str, Any]) -> None:
    path = root / RECEIPT_NAME
    if path.exists() and (path.is_symlink() or not path.is_file()):
        raise FilesystemPolicyError("deletion receipt path is unsafe")
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        os.write(descriptor, canonical_json_bytes(receipt) + b"\n")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def cleanup_expired_runs(
    output_root: str | Path,
    *,
    schema_path: Path,
    now: datetime | None = None,
    confirm_delete: bool = False,
) -> list[dict[str, Any]]:
    root = validated_output_root(output_root)
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    results: list[dict[str, Any]] = []
    for candidate in sorted(root.iterdir(), key=lambda path: path.name):
        if candidate.name == RECEIPT_NAME:
            continue
        if candidate.is_symlink() or not candidate.is_dir():
            raise FilesystemPolicyError("unexpected output-root entry")
        validate_run_id(candidate.name)
        metadata = load_json_file(
            candidate / "run_metadata.json", MAX_TARGET_BUNDLE_BYTES
        )
        retention_until = _strict_time(metadata.get("retentionUntil"))
        expired = retention_until <= current
        if not expired:
            results.append({"runId": candidate.name, "decision": "retained"})
            continue
        validate_run(candidate, schema_path, require_complete=True)
        run_hash = hashlib.sha256(canonical_json_bytes(metadata)).hexdigest()
        if not confirm_delete:
            results.append(
                {
                    "runId": candidate.name,
                    "decision": "would_delete",
                    "runMetadataHash": run_hash,
                }
            )
            continue
        assert_no_symlink_chain(candidate, stop_at=root)
        shutil.rmtree(candidate)
        receipt = {
            "contractVersion": "page-evidence-deletion-receipt-v1",
            "runIdHash": hashlib.sha256(candidate.name.encode("utf-8")).hexdigest(),
            "runMetadataHash": run_hash,
            "retentionUntil": retention_until.isoformat(),
            "deletedAt": current.isoformat(),
            "reason": "retention_expired",
        }
        append_reduced_receipt(root, receipt)
        results.append({"runId": candidate.name, "decision": "deleted"})
    return results


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", required=True)
    parser.add_argument(
        "--schema",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "schemas"
        / "page-evidence-v1.schema.json",
    )
    parser.add_argument("--confirm-delete", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        results = cleanup_expired_runs(
            args.output_root,
            schema_path=args.schema,
            confirm_delete=args.confirm_delete,
        )
    except (FilesystemPolicyError, ValidationError) as exc:
        print(json.dumps({"status": "blocked", "reason": str(exc)}), file=sys.stderr)
        return 2
    print(json.dumps({"status": "ok", "dryRun": not args.confirm_delete, "runs": results}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
