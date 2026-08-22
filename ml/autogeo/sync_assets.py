#!/usr/bin/env python3
"""Create a public-metadata-only AutoGEO asset manifest outside the Git worktree."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import subprocess
import sys
import urllib.parse
import urllib.request

DATASETS = ("cx-cmu/E-commerce", "cx-cmu/GEO-Bench", "cx-cmu/Researchy-GEO")
MODELS = (
    "cx-cmu/AutoGEO_mini_Qwen1.7B_Ecommerce",
    "cx-cmu/AutoGEO_mini_Qwen1.7B_GEOBench",
    "cx-cmu/AutoGEO_mini_Qwen1.7B_ResearchyGEO",
    "Qwen/Qwen3-1.7B-Base",
    "Qwen/Qwen3-1.7B",
)


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "DiscoveryStack-AutoGEO-asset-audit/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def hf_metadata(kind: str, asset_id: str) -> dict:
    query = urllib.parse.urlencode([("blobs", "true"), ("expand[]", "siblings"), ("expand[]", "cardData"), ("expand[]", "sha")])
    return fetch_json(f"https://huggingface.co/api/{kind}/{asset_id}?{query}")


def summarize_files(siblings: list[dict]) -> list[dict]:
    files: list[dict] = []
    for item in siblings:
        lfs = item.get("lfs") or {}
        files.append({
            "path": item["rfilename"],
            "bytes": item.get("size"),
            "blob_id": item.get("blobId"),
            "sha256": lfs.get("sha256"),
            "storage": "lfs" if lfs else "git",
        })
    return files


def dataset_structure(asset_id: str) -> dict:
    encoded = urllib.parse.urlencode({"dataset": asset_id})
    data = fetch_json(f"https://datasets-server.huggingface.co/info?{encoded}")
    result: dict[str, dict] = {}
    for config, info in data.get("dataset_info", {}).items():
        result[config] = {
            "splits": {name: details.get("num_examples") for name, details in info.get("splits", {}).items()},
            "columns": list(info.get("features", {}).keys()),
            "download_bytes": info.get("download_size"),
        }
    return result


def upstream_revision(path: str | None) -> dict:
    if not path:
        return {"status": "not_checked", "reason": "AUTOGEO_UPSTREAM not set"}
    candidate = pathlib.Path(path)
    if not (candidate / ".git").exists():
        return {"status": "not_checked", "reason": f"not a git checkout: {candidate}"}
    sha = subprocess.check_output(["git", "-C", str(candidate), "rev-parse", "HEAD"], text=True).strip()
    submodule_lines = subprocess.check_output(["git", "-C", str(candidate), "ls-files", "--stage"], text=True).splitlines()
    submodules = [line.split(maxsplit=3)[-1] for line in submodule_lines if line.startswith("160000 ")]
    return {"status": "verified", "path": str(candidate), "revision": sha, "submodules": submodules}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, help="Outside-repository output manifest path")
    parser.add_argument("--upstream", default=os.environ.get("AUTOGEO_UPSTREAM"))
    args = parser.parse_args()
    output = pathlib.Path(args.output).resolve()
    repo_root = pathlib.Path(__file__).resolve().parents[2]
    if output.is_relative_to(repo_root):
        raise SystemExit("Refusing repository-local output; use AUTOGEO_CACHE_DIR or another external cache path.")
    datasets = []
    for asset_id in DATASETS:
        metadata = hf_metadata("datasets", asset_id)
        card = metadata.get("cardData") or {}
        datasets.append({"id": asset_id, "revision": metadata.get("sha"), "license": card.get("license"), "files": summarize_files(metadata.get("siblings", [])), "structure": dataset_structure(asset_id)})
    models = []
    for asset_id in MODELS:
        metadata = hf_metadata("models", asset_id)
        card = metadata.get("cardData") or {}
        models.append({"id": asset_id, "revision": metadata.get("sha"), "license": card.get("license"), "library": card.get("library_name"), "base_model": card.get("base_model"), "datasets": card.get("datasets", []), "languages": card.get("language", []), "files": summarize_files(metadata.get("siblings", []))})
    manifest = {"schema_version": "autogeo-asset-manifest-v1", "generated_at_utc": dt.datetime.now(dt.UTC).isoformat(), "network_scope": "public_metadata_only", "upstream": upstream_revision(args.upstream), "datasets": datasets, "models": models}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "datasets": len(datasets), "models": len(models), "upstream": manifest["upstream"].get("status")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
