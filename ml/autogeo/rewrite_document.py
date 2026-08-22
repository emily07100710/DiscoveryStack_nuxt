#!/usr/bin/env python3
"""Fixture-gated AutoGEO adapter. It never publishes or accepts customer content."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import sys
import time


def fixture_text(path_arg: str) -> tuple[pathlib.Path, str]:
    path = pathlib.Path(path_arg).resolve()
    fixture_dir = pathlib.Path(__file__).resolve().parent / "tests" / "fixtures"
    if fixture_dir not in path.parents:
        raise ValueError("Only synthetic files beneath ml/autogeo/tests/fixtures are permitted.")
    return path, path.read_text(encoding="utf-8")


def record(engine: str, source: str, status: str, output: str | None, model_revision: str | None = None) -> dict:
    return {"engine": engine, "status": status, "input_sha256": hashlib.sha256(source.encode()).hexdigest(), "output_sha256": hashlib.sha256(output.encode()).hexdigest() if output else None, "model_revision": model_revision, "dataset_rule_revision": None, "execution_seconds": None, "geo_score": None, "geu_score": None, "factuality_status": "not_evaluated", "quality_status": "not_evaluated", "auto_publish": False}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--engine", choices=("vanilla", "autogeo_api", "autogeo_mini"), default="vanilla")
    parser.add_argument("--allow-live-api", action="store_true")
    parser.add_argument("--allow-model-load", action="store_true")
    parser.add_argument("--model-path")
    args = parser.parse_args()
    _, source = fixture_text(args.fixture)
    started = time.monotonic()
    if args.engine == "vanilla":
        result = record("vanilla", source, "completed_fixture_baseline", source)
    elif args.engine == "autogeo_api":
        if not args.allow_live_api:
            result = record("autogeo_api", source, "blocked_explicit_opt_in_required", None)
        elif not os.environ.get("AUTOGEO_API_KEY"):
            result = record("autogeo_api", source, "blocked_missing_api_key", None)
        else:
            result = record("autogeo_api", source, "blocked_no_provider_adapter_configured", None)
    else:
        if not args.allow_model_load or not args.model_path:
            result = record("autogeo_mini", source, "blocked_explicit_model_opt_in_required", None)
        else:
            model_path = pathlib.Path(args.model_path).resolve()
            if not model_path.exists():
                result = record("autogeo_mini", source, "blocked_model_path_missing", None)
            else:
                result = record("autogeo_mini", source, "blocked_manual_gpu_smoke_required", None)
    result["execution_seconds"] = round(time.monotonic() - started, 6)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
