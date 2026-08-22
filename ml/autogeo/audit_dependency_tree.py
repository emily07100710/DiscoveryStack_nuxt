"""Emit the installed dependency metadata for the controlled AutoGEO smoke set."""

from __future__ import annotations

import importlib.metadata
import json


CONTROLLED = (
    "anthropic",
    "datasets",
    "google-generativeai",
    "huggingface-hub",
    "jsonlines",
    "nltk",
    "openai",
    "pandas",
    "python-dotenv",
    "torch",
    "transformers",
)


def main() -> None:
    payload = {}
    for name in CONTROLLED:
        dist = importlib.metadata.distribution(name)
        payload[name] = {"version": dist.version, "requires": sorted(dist.requires or [])}
    print(json.dumps(payload, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
