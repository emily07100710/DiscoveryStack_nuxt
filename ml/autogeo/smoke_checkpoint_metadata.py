"""Load one pinned checkpoint's config and tokenizer without loading model weights."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from transformers import AutoConfig, AutoTokenizer


WEIGHT_SUFFIXES = {".bin", ".pt", ".pth", ".safetensors"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--cache-dir", required=True, type=Path)
    args = parser.parse_args()
    args.cache_dir.mkdir(parents=True, exist_ok=True)

    config = AutoConfig.from_pretrained(args.model_id, revision=args.revision, cache_dir=args.cache_dir)
    tokenizer = AutoTokenizer.from_pretrained(args.model_id, revision=args.revision, cache_dir=args.cache_dir)
    weights = sorted(str(path.relative_to(args.cache_dir)) for path in args.cache_dir.rglob("*") if path.suffix in WEIGHT_SUFFIXES)
    if weights:
        raise SystemExit(f"Unexpected weight artifacts in metadata-only cache: {weights}")

    print(json.dumps({
        "model_id": args.model_id,
        "revision": args.revision,
        "config_model_type": config.model_type,
        "tokenizer_vocab_size": tokenizer.vocab_size,
        "weight_files": weights,
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
