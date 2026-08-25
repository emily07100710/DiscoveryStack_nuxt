#!/usr/bin/env python3
"""Offline integrity checks for the vendored AutoGEO source snapshot."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
from typing import Any


MAX_FILE_BYTES = 1 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024
MANIFEST_NAME = "UPSTREAM_MANIFEST.json"
ARCHIVE_SUFFIXES = (
    ".7z",
    ".bz2",
    ".dmg",
    ".gz",
    ".iso",
    ".jar",
    ".rar",
    ".tar",
    ".tgz",
    ".whl",
    ".xz",
    ".zip",
)
FORBIDDEN_COMPONENTS = {
    ".git",
    ".github",
    "__pycache__",
    "cache",
    "checkpoints",
    "node_modules",
    "outputs",
    "venv",
    "weights",
}


def _safe_relative_path(value: Any) -> PurePosixPath | None:
    if not isinstance(value, str) or not value:
        return None
    candidate = PurePosixPath(value)
    if candidate.is_absolute() or ".." in candidate.parts or "." in candidate.parts:
        return None
    if candidate.as_posix() != value:
        return None
    return candidate


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_manifest(service_root: Path, errors: list[str]) -> dict[str, Any]:
    manifest_path = service_root / MANIFEST_NAME
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        errors.append(f"cannot read valid {MANIFEST_NAME}: {exc}")
        return {}
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        errors.append("manifest schemaVersion must be 1")
        return {}
    if not isinstance(data.get("files"), list):
        errors.append("manifest files must be a list")
        return {}
    return data


def verify_snapshot(service_root: Path | None = None) -> list[str]:
    root = (service_root or Path(__file__).resolve().parents[1]).resolve()
    errors: list[str] = []
    manifest = _load_manifest(root, errors)
    if not manifest:
        return errors

    all_paths = list(root.rglob("*"))
    for path in all_paths:
        relative = path.relative_to(root)
        lowered_parts = {part.lower() for part in relative.parts}
        if path.is_symlink():
            errors.append(f"symlink is forbidden: {relative.as_posix()}")
            continue
        if FORBIDDEN_COMPONENTS & lowered_parts:
            errors.append(f"forbidden artifact path: {relative.as_posix()}")
        name = path.name.lower()
        if name == "keys.env" or name.startswith(".env"):
            errors.append(f"environment file is forbidden: {relative.as_posix()}")
        if path.is_file() and name.endswith(ARCHIVE_SUFFIXES):
            errors.append(f"archive is forbidden: {relative.as_posix()}")

    snapshot_files = [path for path in all_paths if path.is_file() and not path.is_symlink()]
    total_bytes = sum(path.stat().st_size for path in snapshot_files)
    if total_bytes > MAX_SNAPSHOT_BYTES:
        errors.append(f"snapshot is {total_bytes} bytes; limit is {MAX_SNAPSHOT_BYTES}")
    for path in snapshot_files:
        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            errors.append(
                f"file exceeds {MAX_FILE_BYTES} bytes: {path.relative_to(root).as_posix()} ({size})"
            )

    local_paths: set[str] = set()
    upstream_paths: set[str] = set()
    manifest_paths: set[str] = set()
    for index, entry in enumerate(manifest["files"]):
        label = f"files[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{label} must be an object")
            continue
        local = _safe_relative_path(entry.get("localPath"))
        upstream = _safe_relative_path(entry.get("upstreamPath"))
        if local is None:
            errors.append(f"{label}.localPath is not a normalized relative path")
            continue
        if upstream is None:
            errors.append(f"{label}.upstreamPath is not a normalized relative path")
            continue
        local_text = local.as_posix()
        upstream_text = upstream.as_posix()
        if local_text in local_paths:
            errors.append(f"duplicate localPath: {local_text}")
        if upstream_text in upstream_paths:
            errors.append(f"duplicate upstreamPath: {upstream_text}")
        local_paths.add(local_text)
        upstream_paths.add(upstream_text)
        manifest_paths.add(local_text)

        allowed = local_text == "LICENSE.autogeo"
        allowed = allowed or (
            local_text.startswith("vendor/autogeo/") and local_text.endswith(".py")
        )
        allowed = allowed or (
            local_text.startswith("vendor/rules/") and local_text.endswith(".json")
        )
        if not allowed:
            errors.append(f"manifest path is outside the import policy: {local_text}")

        expected_size = entry.get("byteSize")
        expected_hash = entry.get("sha256")
        if not isinstance(expected_size, int) or expected_size < 0:
            errors.append(f"{label}.byteSize must be a non-negative integer")
            continue
        if (
            not isinstance(expected_hash, str)
            or len(expected_hash) != 64
            or any(char not in "0123456789abcdef" for char in expected_hash)
        ):
            errors.append(f"{label}.sha256 must be lowercase hexadecimal")
            continue

        path = root.joinpath(*local.parts)
        if not path.exists():
            errors.append(f"manifest file is missing: {local_text}")
            continue
        if path.is_symlink() or not path.is_file():
            errors.append(f"manifest path is not a regular file: {local_text}")
            continue
        actual_size = path.stat().st_size
        if actual_size != expected_size:
            errors.append(
                f"size mismatch for {local_text}: expected {expected_size}, got {actual_size}"
            )
        actual_hash = _sha256(path)
        if actual_hash != expected_hash:
            errors.append(
                f"sha256 mismatch for {local_text}: expected {expected_hash}, got {actual_hash}"
            )

    vendor_root = root / "vendor"
    actual_vendor_files = {
        path.relative_to(root).as_posix()
        for path in vendor_root.rglob("*")
        if path.is_file() and not path.is_symlink()
    }
    expected_vendor_files = {path for path in manifest_paths if path.startswith("vendor/")}
    for missing in sorted(expected_vendor_files - actual_vendor_files):
        errors.append(f"vendored file is missing: {missing}")
    for extra in sorted(actual_vendor_files - expected_vendor_files):
        errors.append(f"unmanifested vendored file: {extra}")

    return errors


def main() -> int:
    errors = verify_snapshot()
    if errors:
        print("FAIL: AutoGEO vendor integrity verification")
        for error in errors:
            print(f"- {error}")
        return 1
    print("PASS: AutoGEO vendor integrity verification")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
