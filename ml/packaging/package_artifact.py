#!/usr/bin/env python3
"""Create a fail-closed DiscoveryStack ML artifact bundle.

The packager is intentionally allow-list based. It never copies raw JSONL, HTML,
secrets, browser profiles, or arbitrary files from the source directory.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import zipfile
from pathlib import Path

REQUIRED_ROOT_FILES = {"training-config.json", "metrics.json", "run-summary.json"}
OPTIONAL_ROOT_FILES = {"test-predictions.json", "README.md", "feature-contract.json"}
CHECKPOINT_ALLOWED = {
    "config.json",
    "generation_config.json",
    "model.safetensors",
    "model.safetensors.index.json",
    "model_state_dict.pt",  # legacy v3 only; never load implicitly
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.txt",
    "sentencepiece.bpe.model",
    "model-definition.py",
}
SAFE_DIRS = {"data-contract", "governance", "checksums"}
FORBIDDEN_SUFFIXES = {".jsonl", ".html", ".htm", ".env", ".pem", ".key"}
FORBIDDEN_NAMES = {"cookies", "history", "browser-profile", ".git"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_copy(src: Path, dst: Path) -> None:
    if src.suffix.lower() in FORBIDDEN_SUFFIXES or src.name in FORBIDDEN_NAMES:
        raise ValueError(f"refusing forbidden file: {src.name}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def load_source(source: Path, temp_root: Path) -> Path:
    if source.is_dir():
        return source
    if source.suffix.lower() != ".zip":
        raise ValueError("--source must be an artifact directory or .zip")
    extracted = temp_root / "extracted"
    extracted.mkdir()
    with zipfile.ZipFile(source) as archive:
        for member in archive.infolist():
            target = (extracted / member.filename).resolve()
            if not str(target).startswith(str(extracted.resolve()) + "/"):
                raise ValueError(f"unsafe zip member: {member.filename}")
        archive.extractall(extracted)
    dirs = [path for path in extracted.iterdir() if path.is_dir()]
    return dirs[0] if len(dirs) == 1 else extracted


def copy_allowlist(source: Path, bundle: Path) -> list[str]:
    copied: list[str] = []
    for name in sorted(REQUIRED_ROOT_FILES | OPTIONAL_ROOT_FILES):
        src = source / name
        if src.exists():
            if src.is_file():
                safe_copy(src, bundle / name)
                copied.append(name)
    missing = sorted(REQUIRED_ROOT_FILES - set(copied))
    if missing:
        raise ValueError(f"missing required root files: {missing}")

    checkpoint = source / "checkpoint"
    if not checkpoint.is_dir():
        raise ValueError("missing checkpoint/ directory")
    checkpoint_files = []
    for src in sorted(checkpoint.rglob("*")):
        if not src.is_file():
            continue
        relative = src.relative_to(checkpoint)
        if relative.name not in CHECKPOINT_ALLOWED:
            continue
        safe_copy(src, bundle / "checkpoint" / relative)
        checkpoint_files.append(str(Path("checkpoint") / relative))
    if not checkpoint_files:
        raise ValueError("checkpoint/ contains no allow-listed model/tokenizer files")

    for directory in ("data-contract", "governance"):
        src_dir = source / directory
        if not src_dir.is_dir():
            continue
        for src in sorted(src_dir.rglob("*")):
            if src.is_file() and src.suffix.lower() not in FORBIDDEN_SUFFIXES:
                relative = src.relative_to(source)
                safe_copy(src, bundle / relative)
                copied.append(str(relative))
    return sorted(set(copied + checkpoint_files))


def write_readme(bundle: Path, run_id: str, legacy_pt: bool) -> None:
    checkpoint_note = (
        "This bundle contains the legacy model_state_dict.pt checkpoint from v3. "
        "Do not load it from untrusted sources; v4+ should use safetensors."
        if legacy_pt
        else "The checkpoint is stored in a Transformers-compatible format."
    )
    text = f"""# DiscoveryStack ML artifact bundle

- Run ID: `{run_id}`
- Bundle type: versioned development artifact
- Raw training data: intentionally excluded
- {checkpoint_note}

Load only after verifying `checksums/SHA256SUMS` and `artifact-manifest.json`. The
bundle is not a production deployment package and must not be used to infer a
model release without passing the validation gates in `ML_250_TO_500_PLAN.md`.
"""
    (bundle / "README.md").write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--manifest-hash", required=True)
    parser.add_argument("--dataset-digest", required=True)
    parser.add_argument("--example-count", type=int, required=True)
    parser.add_argument("--legacy-pt", action="store_true")
    args = parser.parse_args()

    if len(args.manifest_hash) != 64 or len(args.dataset_digest) != 64:
        raise SystemExit("manifest and dataset digests must be 64-character SHA-256 values")
    if args.example_count <= 0:
        raise SystemExit("example count must be positive")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="discoverystack-pack-") as temp_dir:
        source = load_source(args.source.resolve(), Path(temp_dir))
        staging = Path(temp_dir) / f"discoverystack-artifact-{args.run_id}"
        staging.mkdir()
        copied = copy_allowlist(source, staging)
        write_readme(staging, args.run_id, args.legacy_pt or (staging / "checkpoint/model_state_dict.pt").exists())

        run_summary_path = staging / "run-summary.json"
        run_summary = json.loads(run_summary_path.read_text(encoding="utf-8"))
        run_summary["artifactPackaging"] = {
            "packager": "discoverystack-ml-packager-v1",
            "rawDataIncluded": False,
            "allowListedFiles": copied,
        }
        run_summary_path.write_text(json.dumps(run_summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        files = []
        for path in sorted(staging.rglob("*")):
            if path.is_file():
                relative = path.relative_to(staging).as_posix()
                files.append({"path": relative, "bytes": path.stat().st_size, "sha256": sha256(path)})
        artifact_manifest = {
            "schemaVersion": "artifact-manifest-v1",
            "runId": args.run_id,
            "manifestHash": args.manifest_hash,
            "datasetDigest": args.dataset_digest,
            "exampleCount": args.example_count,
            "rawDataIncluded": False,
            "legacyCheckpoint": (staging / "checkpoint/model_state_dict.pt").exists(),
            "files": files,
        }
        (staging / "artifact-manifest.json").write_text(json.dumps(artifact_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        checksum_lines = []
        for path in sorted(staging.rglob("*")):
            if path.is_file() and path.relative_to(staging).as_posix() != "checksums/SHA256SUMS":
                checksum_lines.append(f"{sha256(path)}  {path.relative_to(staging).as_posix()}")
        checksums = staging / "checksums/SHA256SUMS"
        checksums.parent.mkdir(exist_ok=True)
        checksums.write_text("\n".join(checksum_lines) + "\n", encoding="utf-8")

        if args.out.exists():
            args.out.unlink()
        shutil.make_archive(str(args.out.with_suffix("")), "zip", root_dir=staging.parent, base_dir=staging.name)
        print(json.dumps({"bundle": str(args.out), "runId": args.run_id, "files": len(checksum_lines), "rawDataIncluded": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()
