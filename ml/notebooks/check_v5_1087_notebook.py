#!/usr/bin/env python3
"""Static checker for an output-free DiscoveryStack v5-1087 notebook."""
from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path

MANIFEST_HASH = "08931b3827f37d9254c9d8d0555aa635babc26d6c94c218bac523cc4a86f2003"
DATASET_DIGEST = "c787aad7f775a3f4db705c171b22f968bd1fff09b3ee3ee7e99557afccea60a6"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("notebook", type=Path)
    args = parser.parse_args()
    notebook = json.loads(args.notebook.read_text(encoding="utf-8"))
    cells = notebook.get("cells", [])
    assert len(cells) == 15, len(cells)
    assert notebook["metadata"]["status"] in {"training_not_started", "run_interrupted"}
    assert notebook["metadata"]["training_mode"] == "cpu_fallback_fast_path"
    training_meta = notebook["metadata"]["discoverystackTraining"]
    assert training_meta["executionBackend"] == "cpu_fallback_allowed"
    assert training_meta["rowCount"] == 1087
    assert training_meta["addedRows"] == 587
    assert training_meta["manifestHash"] == MANIFEST_HASH
    assert training_meta["datasetDigest"] == DATASET_DIGEST

    code_count = 0
    for index, cell in enumerate(cells):
        if cell.get("cell_type") != "code":
            continue
        code_count += 1
        assert not cell.get("outputs"), f"cell {index} has outputs"
        assert cell.get("execution_count") is None, f"cell {index} has execution count"
        source = "".join(cell.get("source", []))
        py_source = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith(("!", "%")))
        ast.parse(py_source, filename=f"v5-cell-{index}.py")

    all_source = "\n".join("".join(cell.get("source", [])) for cell in cells)
    checks = {
        "rowCount": "EXPECTED_ROW_COUNT = 1087" in all_source,
        "manifestHash": MANIFEST_HASH in all_source,
        "datasetDigest": DATASET_DIGEST in all_source,
        "splits": "'train': 761, 'validation': 163, 'test_legacy_v1': 32, 'test_v2': 131" in all_source,
        "rightsStatuses": "{'approved', 'public_access_only_pending_human_review'}" in all_source,
        "reviewGate": "review_states.get('needs_adjudication', 0) >= 1" in all_source,
        "developmentOnly": "'developmentOnly':True" in all_source,
        "runRoot": "/content/optimized_runs_v5_1087" in all_source,
        "artifactRoot": "/content/discoverystack-training-artifacts-v5-1087" in all_source,
        "v5Model": "seo-geo-multitask-colab-v5-1087-cpu-fallback" in all_source,
        "cpuFallback": "EXECUTION_BACKEND = 'cuda' if DEVICE.type == 'cuda' else 'cpu_fallback'" in all_source and "!nvidia-smi || true" in all_source,
        "rawNotPackaged": "'containsRawDataset':False" in all_source and "'containsHtml':False" in all_source,
    }
    assert all(checks.values()), checks
    assert "discoverystack-manifest-v4-500" not in all_source
    print({"valid": True, "codeCells": code_count, "outputsCleared": True, "checks": checks})


if __name__ == "__main__":
    main()
