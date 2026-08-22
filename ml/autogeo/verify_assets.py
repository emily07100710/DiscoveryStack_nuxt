#!/usr/bin/env python3
"""Validate license/revision/file-hash lineage for an AutoGEO asset manifest."""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import sys

SHA1 = re.compile(r"^[0-9a-f]{40}$")
EXPECTED_LICENSES = {"cx-cmu/": "mit", "Qwen/": "apache-2.0"}


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate(manifest: dict, cache: pathlib.Path | None) -> list[str]:
    errors: list[str] = []
    if manifest.get("schema_version") != "autogeo-asset-manifest-v1":
        errors.append("unsupported schema_version")
    for group in ("datasets", "models"):
        for asset in manifest.get(group, []):
            asset_id, revision, license_id = asset.get("id", ""), asset.get("revision", ""), asset.get("license")
            expected = next((value for prefix, value in EXPECTED_LICENSES.items() if asset_id.startswith(prefix)), None)
            if not SHA1.fullmatch(revision or ""):
                errors.append(f"{asset_id}: invalid revision")
            if expected and license_id != expected:
                errors.append(f"{asset_id}: license {license_id!r} does not match expected {expected!r}")
            for entry in asset.get("files", []):
                checksum = entry.get("sha256")
                if checksum and not re.fullmatch(r"[0-9a-f]{64}", checksum):
                    errors.append(f"{asset_id}/{entry.get('path')}: invalid LFS SHA-256")
                if cache and checksum:
                    local = cache / asset_id.replace("/", "__") / entry["path"]
                    if local.exists() and sha256(local) != checksum:
                        errors.append(f"{local}: SHA-256 mismatch")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--cache", help="Optional external cache to verify downloaded files")
    args = parser.parse_args()
    manifest = json.loads(pathlib.Path(args.manifest).read_text(encoding="utf-8"))
    errors = validate(manifest, pathlib.Path(args.cache) if args.cache else None)
    print(json.dumps({"status": "passed" if not errors else "failed", "errors": errors}, ensure_ascii=False))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
