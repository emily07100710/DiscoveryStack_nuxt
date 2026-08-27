#!/usr/bin/env python3
"""Create an output-free v5-1087 recovery notebook from the tracked v4 template.

Raw datasets, source cards, executed notebooks, OAuth material and model
artifacts are intentionally outside this repository. Supply the template and
output paths explicitly when running this utility.
"""
from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path

MANIFEST_HASH = "08931b3827f37d9254c9d8d0555aa635babc26d6c94c218bac523cc4a86f2003"
DATASET_DIGEST = "c787aad7f775a3f4db705c171b22f968bd1fff09b3ee3ee7e99557afccea60a6"


def source_text(cell: dict) -> str:
    return "".join(cell.get("source", []))


def replace_all(text: str, pairs: list[tuple[str, str]]) -> str:
    for old, new in pairs:
        text = text.replace(old, new)
    return text


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True, help="tracked v4 notebook template")
    parser.add_argument("--output", type=Path, required=True, help="new v5 output-free notebook")
    args = parser.parse_args()

    notebook = json.loads(args.source.read_text(encoding="utf-8"))
    pairs = [
        ("DiscoveryStack SEO/GEO 500", "DiscoveryStack SEO/GEO 1087"),
        ("DiscoveryStack SEO GEO 500", "DiscoveryStack SEO GEO 1087"),
        ("manifest-v4-500", "manifest-v5-1087"),
        ("discoverystack-manifest-v4-500-private.jsonl", "discoverystack-manifest-v5-1087-private.jsonl"),
        ("discoverystack-manifest-v4-500.jsonl", "discoverystack-manifest-v5-1087.jsonl"),
        ("discoverystack-training-artifacts-v4", "discoverystack-training-artifacts-v5-1087"),
        ("seo-geo-multitask-colab-v4-optimized", "seo-geo-multitask-colab-v5-1087-cpu-fallback"),
        ("artifact-v4-500-optimized", "artifact-v5-1087-fastpath"),
        ("discoverystack-ml-v4-500-", "discoverystack-ml-v5-1087-"),
        ("Owner-only DiscoveryStack v4 optimized 500-row artifact", "Owner-only DiscoveryStack v5 fast-path 1087-row artifact"),
        ("EXPECTED_ROW_COUNT = 500", "EXPECTED_ROW_COUNT = 1087"),
        ("!nvidia-smi", "!nvidia-smi || true"),
        ("EXPECTED_MANIFEST_HASH = 'd1868ebd13ebf5b489e551afba2c047c19af5022e83c101e23a9927beaf02977'", f"EXPECTED_MANIFEST_HASH = '{MANIFEST_HASH}'"),
        ("EXPECTED_DATASET_DIGEST = '6aaf9e6c57f4d930ba220575bc1a5f7cb0ba6145373e7a8b629f89403c85c474'", f"EXPECTED_DATASET_DIGEST = '{DATASET_DIGEST}'"),
        ("EXPECTED_SPLITS = {'train': 350, 'validation': 75, 'test_legacy_v1': 32, 'test_v2': 43}", "EXPECTED_SPLITS = {'train': 761, 'validation': 163, 'test_legacy_v1': 32, 'test_v2': 131}"),
        ("'train':350, 'validation':75, 'test_legacy_v1':32, 'test_v2':43", "'train':761, 'validation':163, 'test_legacy_v1':32, 'test_v2':131"),
        ("assert len(matches) == 1, f'FAIL-CLOSED: expected one private v4 snapshot, found {len(matches)}'", "assert len(matches) == 1, f'FAIL-CLOSED: expected one private v5-1087 snapshot, found {len(matches)}'"),
        ("assert row['governance']['rightsStatus'] == 'approved'", "assert row['governance']['rightsStatus'] in {'approved', 'public_access_only_pending_human_review'}"),
        ("optimized_runs_v4_recovery", "optimized_runs_v5_1087"),
        ("'selectedSeed':selected['seed'],'stageLossWeight':2.0", "'selectedSeed':selected['seed'],'stageLossWeight':2.0,'developmentOnly':True,'rightsReviewPending':True,'humanAdjudicationRequiredBeforeProduction':True,'allowedRightsStatuses':['approved','public_access_only_pending_human_review']"),
        ("'artifactVersion':'artifact-v5-1087-fastpath','manifestHash'", "'artifactVersion':'artifact-v5-1087-fastpath','developmentOnly':True,'rightsReviewPending':True,'humanAdjudicationRequiredBeforeProduction':True,'manifestHash'"),
    ]

    for cell in notebook.get("cells", []):
        text = replace_all(source_text(cell), pairs)
        if cell.get("cell_type") == "markdown":
            text = text.replace(
                "尚未取得可信 checkpoint、metrics、final evaluation 或 trained artifact ZIP。",
                "本 Notebook 是 v5-1087 的 bounded fast-path／full-ablation 執行入口；完整結果須以實際 outputs 為準。",
            )
            text = text.replace("Recovery environment", "Recovery environment (CPU fallback allowed)")
        cell["source"] = text.splitlines(keepends=True)
        if cell.get("cell_type") == "code":
            cell["outputs"] = []
            cell["execution_count"] = None

    all_source = "\n".join(source_text(cell) for cell in notebook.get("cells", []))
    if "DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')" in all_source and "assert DEVICE.type == 'cuda'" in all_source:
        all_source = all_source.replace(
            "DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')\nassert DEVICE.type == 'cuda', 'FAIL-CLOSED: CUDA GPU is required'",
            "DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')\nEXECUTION_BACKEND = 'cuda' if DEVICE.type == 'cuda' else 'cpu_fallback'\nprint({'executionBackend': EXECUTION_BACKEND, 'cudaAvailable': torch.cuda.is_available()}, flush=True)",
        )
        for cell in notebook.get("cells", []):
            cell["source"] = replace_all(source_text(cell), [("DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')\nassert DEVICE.type == 'cuda', 'FAIL-CLOSED: CUDA GPU is required'", "DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')\nEXECUTION_BACKEND = 'cuda' if DEVICE.type == 'cuda' else 'cpu_fallback'\nprint({'executionBackend': EXECUTION_BACKEND, 'cudaAvailable': torch.cuda.is_available()}, flush=True)")]).splitlines(keepends=True)

    metadata = notebook.setdefault("metadata", {})
    metadata["status"] = "training_not_started"
    metadata["training_mode"] = "cpu_fallback_fast_path"
    metadata["discoverystackTraining"] = {
        "version": "v5",
        "status": "training_not_started",
        "rowCount": 1087,
        "addedRows": 587,
        "manifestHash": MANIFEST_HASH,
        "datasetDigest": DATASET_DIGEST,
        "containsRawData": False,
        "containsSecrets": False,
        "runModeDefault": "fast_path",
        "executionBackend": "cpu_fallback_allowed",
        "sourcePolicy": "development_only_rights_review_pending",
        "governanceValidation": "approved_or_public_access_only_pending_human_review",
    }

    for index, cell in enumerate(notebook.get("cells", [])):
        if cell.get("cell_type") == "code":
            py_source = "\n".join(line for line in source_text(cell).splitlines() if not line.lstrip().startswith(("!", "%")))
            ast.parse(py_source, filename=f"v5-cell-{index}.py")
            assert not cell.get("outputs"), f"cell {index} has outputs"
            assert cell.get("execution_count") is None, f"cell {index} has an execution count"

    all_source = "\n".join(source_text(cell) for cell in notebook.get("cells", []))
    required = [MANIFEST_HASH, DATASET_DIGEST, "EXPECTED_ROW_COUNT = 1087", "/content/optimized_runs_v5_1087"]
    assert all(token in all_source for token in required), "v5 constants missing"
    assert "discoverystack-manifest-v4-500" not in all_source, "v4 snapshot residue"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(notebook, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print({"output": str(args.output), "cells": len(notebook.get("cells", [])), "outputsCleared": True, "status": metadata["status"]})


if __name__ == "__main__":
    main()
