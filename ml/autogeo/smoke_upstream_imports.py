"""Import every non-training module from a pinned AutoGEO checkout.

The script intentionally skips ``autogeo.training`` because it imports vLLM and
belongs to the prohibited SFT/GRPO execution path.  It never invokes a provider,
loads a model checkpoint or accesses a dataset.
"""

from __future__ import annotations

import argparse
import importlib
import json
import pkgutil
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True, type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.upstream.resolve()))

    package = importlib.import_module("autogeo")
    imported: list[str] = []
    skipped: list[str] = []
    for module in pkgutil.walk_packages(package.__path__, prefix="autogeo."):
        if module.name == "autogeo.training" or module.name.startswith("autogeo.training."):
            skipped.append(module.name)
            continue
        importlib.import_module(module.name)
        imported.append(module.name)

    print(json.dumps({"imported": imported, "skipped": skipped}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
