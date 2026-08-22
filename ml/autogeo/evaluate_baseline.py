#!/usr/bin/env python3
"""Produce a truthfully incomplete fixture-only baseline evaluation record."""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    args = parser.parse_args()
    runner = pathlib.Path(__file__).with_name("rewrite_document.py")
    result = subprocess.run([sys.executable, str(runner), "--fixture", args.fixture, "--engine", "vanilla"], check=True, capture_output=True, text=True)
    metadata = json.loads(result.stdout)
    metadata.update({"evaluation": "vanilla_fixture_pipeline", "generative_engine_response": "not_requested", "geo_score": None, "geu_score": None, "result_interpretation": "Pipeline integrity only; this is not a model effectiveness result."})
    print(json.dumps(metadata, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
