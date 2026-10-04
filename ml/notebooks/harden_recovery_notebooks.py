#!/usr/bin/env python3
"""Apply fail-closed recovery gates to source-only notebooks without running ML."""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path


def harden_notebook(source: dict) -> dict:
    notebook = copy.deepcopy(source)
    for cell in notebook.get("cells", []):
        if cell.get("cell_type") != "code":
            continue
        text = "".join(cell.get("source", []))
        if "smoke_loss.backward()" in text and "assert bool(torch.isfinite(smoke_loss).item())" not in text:
            text = text.replace("smoke_loss.backward()", "assert bool(torch.isfinite(smoke_loss).item()), 'FAIL-CLOSED: smoke loss must be finite'\nsmoke_loss.backward()")
        if "RUN_MODE = 'fast_path'" in text:
            if "full ablation requires CUDA GPU" not in text:
                text = text.replace("if RUN_MODE == 'full_ablation':\n", "if RUN_MODE == 'full_ablation':\n    assert DEVICE.type == 'cuda', 'FAIL-CLOSED: full ablation requires CUDA GPU'\n")
            text = text.replace("else:\n    configs = [('stage_branch_weighted'", "elif RUN_MODE == 'fast_path':\n    configs = [('stage_branch_weighted'")
            if "FAIL-CLOSED: unsupported RUN_MODE" not in text:
                text = text.replace("    TRAIN_MAX_EPOCHS = 2\n", "    TRAIN_MAX_EPOCHS = 2\nelse:\n    raise ValueError('FAIL-CLOSED: unsupported RUN_MODE')\n")
            if "tempfile.mkdtemp(" not in text:
                lines = text.splitlines()
                for index, line in enumerate(lines):
                    if line.startswith("run_root = Path(") and "shutil.rmtree(run_root" in line:
                        base_path = line.split(";", 1)[0].split(" = ", 1)[1]
                        lines[index] = f"import tempfile\nrun_parent = {base_path}\nrun_parent.mkdir(parents=True, exist_ok=True)\nrun_root = Path(tempfile.mkdtemp(prefix='attempt-', dir=run_parent))"
                text = "\n".join(lines) + "\n"
            if "run_records.json" not in text:
                text = text.replace("        run_records.append(record); run_paths.append(str(path))", "        run_records.append(record); run_paths.append(str(path))\n        (run_root / 'run_records.json').write_text(json.dumps({'runMode': RUN_MODE, 'records': run_records, 'paths': run_paths}, allow_nan=False), encoding='utf-8')")
            if "selected.json" not in text:
                text = text.replace("selected = run_records[best_index]; selected_path = Path(run_paths[best_index])", "selected = run_records[best_index]; selected_path = Path(run_paths[best_index])\n(run_root / 'selected.json').write_text(json.dumps({'runMode': RUN_MODE, 'record': selected, 'checkpoint': str(selected_path)}, allow_nan=False), encoding='utf-8')")
        cell["source"] = text.splitlines(keepends=True)
        cell["outputs"] = []
        cell["execution_count"] = None
    notebook.setdefault("metadata", {}).setdefault("discoverystackTraining", {})["recoverySafetyVersion"] = "fail-closed-preserved-attempts-v1"
    return notebook


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("notebook", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    notebook = harden_notebook(json.loads(args.notebook.read_text(encoding="utf-8")))
    with args.output.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(notebook, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"sourceHardened": True, "executed": False, "outputsCleared": True}))


if __name__ == "__main__":
    main()
